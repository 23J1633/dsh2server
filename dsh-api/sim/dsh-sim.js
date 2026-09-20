#!/usr/bin/env node
// dsh2server 插件侧模拟器。
//
// 用途：在没有真实 dsh 的机器上把中转服务器跑通 —— 它按规范 §6.1 发 hello / event /
// response / ping / bye，并按 §9 实现全部方法。真实插件接上后，测试台的表现应当一致。
//
//   node sim/dsh-sim.js --endpoint https://www.example.com:50443/dsh-api
//   node sim/dsh-sim.js --endpoint http://127.0.0.1:50443/dsh-api --http
//   node sim/dsh-sim.js --endpoint ... --key dshk_xxx --name "我的笔记本"
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 身份文件里是明文 key，绝不能落在网站根目录里（index/ 整个目录是公网可读的）
const IDENTITY_FILE = process.env.DSH_RELAY_DATA_DIR
  ? path.join(process.env.DSH_RELAY_DATA_DIR, 'sim-identity.json')
  : path.join(os.homedir(), '.dsh-relay', 'sim-identity.json');

// ------------------------------------------------------------------ 参数

function parseArgs(argv) {
  const out = { transport: 'auto', verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--endpoint' || a === '-e') out.endpoint = next();
    else if (a === '--key' || a === '-k') out.key = next();
    else if (a === '--name' || a === '-n') out.name = next();
    else if (a === '--instance') out.instanceId = next();
    else if (a === '--http') out.transport = 'http';
    else if (a === '--ws') out.transport = 'websocket';
    else if (a === '--cwd') out.cwd = next();
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--insecure') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    else if (a === '--help' || a === '-h') { out.help = true; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.endpoint) {
  console.log(`用法: node sim/dsh-sim.js --endpoint <URL> [选项]

  --endpoint, -e  服务器基地址，例如 https://www.23j1633.xyz:50443/dsh-api
  --key,      -k  显式指定实例 key（不填则首次生成并写入 sim-identity.json）
  --name,     -n  显示名（会出现在服务器实例列表里）
  --instance      显式指定 instanceId
  --http          强制使用 HTTP 长轮询（默认自动：先 WS，失败回退 HTTP）
  --ws            只用 WebSocket
  --insecure      跳过 TLS 校验（自签证书时用）
  --verbose,  -v  打印全部收发帧
`);
  process.exit(args.help ? 0 : 1);
}
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  console.warn('[sim] 已关闭 TLS 校验（仅用于自签证书联调）');
}

// ------------------------------------------------------------------ 身份

function loadIdentity() {
  try { return JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8')); } catch { return null; }
}

const identity = loadIdentity() || {};
const instanceId = args.instanceId || identity.instanceId || 'dsh-' + crypto.randomBytes(6).toString('hex');
const key = args.key || identity.key || 'dshk_' + crypto.randomBytes(32).toString('base64url');
if (!args.key) {
  fs.mkdirSync(path.dirname(IDENTITY_FILE), { recursive: true });
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify({ instanceId, key }, null, 2) + '\n', { mode: 0o600 });
}

const HOSTNAME = (() => { try { return fs.readFileSync('/etc/hostname', 'utf8').trim(); } catch { return 'sim-host'; } })();

// ------------------------------------------------------------------ 假数据

function newSessionId() { return 'session-' + crypto.randomBytes(6).toString('hex'); }

const now = () => Date.now();

class Sim {
  constructor(opts) {
    this.opts = opts;
    this.endpoint = opts.endpoint.replace(/\/+$/, '');
    this.httpBase = this.endpoint.replace(/^ws(s?):\/\//, 'http$1://');
    this.wsUrl = this.endpoint.replace(/^http(s?):\/\//, 'ws$1://') + '/ws';
    this.seq = 0;
    this.buffer = [];
    this.bufferSize = 2000;
    this.serverAckSeq = 0;
    this.transport = null;
    this.subscriptions = { topics: [], sessions: [] };
    this.assistantStream = false;
    this.running = false;
    this.paused = false;
    this.approvalPolicy = null;
    this.queued = [];
    this.startAt = now();
    this.turns = 0;
    // ---- PLUGIN-EXT.md 里的扩展能力用到的状态
    this.feedback = new Map();          // seq -> like | dislike
    this.permission = 'workspace-write';
    this.attachments = new Map();
    this.workspaces = new Map();
    this.terminals = new Map();
    this.fileNotes = new Map();

    this.sessions = new Map();
    const sid = newSessionId();
    this.sessions.set(sid, {
      sessionId: sid,
      updatedAt: now(),
      running: false,
      blank: true,
      cwd: opts.cwd || process.cwd(),
      parentSessionId: null,
      attached: true,
      agentPreset: 'default',
      title: '模拟会话',
      events: [],
      todos: [],
      goal: null,
      model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: null },
    });
    this.primary = sid;
    this.jobs = [{
      id: 'bash-1', kind: 'bash', label: 'pnpm test', status: 'completed',
      detail: 'exit code: 0', sessionId: sid, startedAt: now() - 60000, finishedAt: now() - 30000, reported: false,
    }, {
      id: 'bash-2', kind: 'bash', label: 'pnpm build --watch', status: 'running',
      detail: '', sessionId: sid, startedAt: now() - 5000, finishedAt: null, reported: false,
    }];
  }

  log(...a) { console.log(`[sim]`, ...a); }
  vlog(...a) { if (this.opts.verbose) console.log(`[sim:v]`, ...a); }

  // -------------------------------------------------------------- 传输

  async connect() {
    const order = this.opts.transport === 'auto' ? ['websocket', 'http'] : [this.opts.transport];
    for (const t of order) {
      try {
        this.transport = t;
        if (t === 'websocket') await this.connectWs();
        else await this.connectHttp();
        return;
      } catch (err) {
        this.log(`${t} 连接失败：${err.message}`);
        this.transport = null;
      }
    }
    setTimeout(() => this.connect(), 3000);
  }

  connectWs() {
    return new Promise((resolve, reject) => {
      const url = `${this.wsUrl}?v=1&instanceId=${encodeURIComponent(instanceId)}`;
      const ws = new WebSocket(url, { rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0' });
      this.ws = ws;
      let opened = false;
      ws.on('open', () => {
        opened = true;
        this.log(`WebSocket 已连接 ${url}`);
        this.sendHello();
        this.startHeartbeat(30000);
        resolve();
      });
      ws.on('message', (raw) => {
        let frame;
        try { frame = JSON.parse(raw.toString('utf8')); } catch { return; }
        this.onFrame(frame);
      });
      ws.on('close', (code) => {
        clearInterval(this.heartbeat);
        this.log(`WebSocket 已断开（code=${code}）`);
        if (!opened) { reject(new Error(`close ${code}`)); return; }
        this.reconnect();
      });
      ws.on('error', (err) => { this.log(`WebSocket 错误：${err.message}`); if (!opened) reject(err); });
    });
  }

  async connectHttp() {
    this.log(`HTTP 长轮询模式 ${this.endpoint}`);
    this.helloAcked = false;
    // Start a conservative cadence before the hello; hello.ack replaces it
    // with the server-advertised value as soon as the handshake completes.
    this.startHeartbeat(20000);
    await this.postBatch([this.buildHello()]);
    this.pollLoop();
  }

  /** Match the real plugin by honoring hello.ack.heartbeatMs. */
  startHeartbeat(period) {
    clearInterval(this.heartbeat);
    const ms = Math.max(250, Number(period) || 30000);
    this.heartbeat = setInterval(() => {
      if (this.transport === 'websocket') this.send({ v: 1, type: 'ping', ts: now() });
      else if (this.transport === 'http') this.postBatch([{ v: 1, type: 'ping', ts: now() }]).catch(() => {});
    }, ms);
  }

  async pollLoop() {
    for (;;) {
      if (this.transport !== 'http') return;
      try {
        const url = `${this.endpoint}/inbox?instanceId=${encodeURIComponent(instanceId)}&cursor=${this.serverSeqCursor || 0}&waitMs=25000`;
        const res = await fetch(url, { headers: { authorization: `Bearer ${key}`, 'x-dsh-instance-id': instanceId } });
        if (res.status === 401 || res.status === 403) {
          this.log(`服务器拒绝认证（HTTP ${res.status}），5s 后重试`);
          await sleep(5000);
          continue;
        }
        const body = await res.json();
        this.serverSeqCursor = body.cursor || this.serverSeqCursor;
        for (const f of body.frames || []) {
          if (Number.isFinite(f.seq)) this.send({ v: 1, type: 'ack', seq: f.seq });
          this.onFrame(f);
        }
      } catch (err) {
        this.log(`inbox 轮询失败：${err.message}`);
        await sleep(3000);
      }
    }
  }

  async postBatch(frames) {
    const res = await fetch(`${this.endpoint}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-dsh-instance-id': instanceId },
      body: JSON.stringify({ v: 1, instanceId, lastServerCursor: this.serverSeqCursor || 0, closing: false, frames }),
    });
    if (res.status === 401 || res.status === 403) {
      const t = await res.text().catch(() => '');
      throw new Error(`服务器拒绝（HTTP ${res.status}）${t.slice(0, 200)}`);
    }
    const body = await res.json().catch(() => ({}));
    if (Number.isFinite(body.accepted)) this.serverAckSeq = Math.max(this.serverAckSeq, body.accepted);
    return body;
  }

  buildHello() {
    return {
      v: 1,
      type: 'hello',
      instanceId,
      ts: now(),
      auth: { type: 'instance-key', key, instanceId },
      lastSeq: this.seq,
      resumeFromSeq: this.serverAckSeq,
      subscriptions: { topics: this.subscriptions.topics, sessions: [...this.sessions.keys()] },
      capabilities: CAPABILITIES,
      instance: {
        hostname: HOSTNAME,
        platform: process.platform,
        arch: process.arch,
        osRelease: 'sim',
        osType: 'sim',
        cpuModel: 'simulated',
        memoryBytes: 16 * 1024 ** 3,
        nodeVersion: process.version,
        pid: process.pid,
        dshHome: path.join(HERE, '..', 'sim-dsh-home'),
        liveSessions: [...this.sessions.values()].filter((s) => s.attached).length,
        displayName: this.opts.name || '模拟机 (dsh-sim)',
        pluginVersion: 'sim-0.1.0',
        protocolVersion: 1,
        identityPersisted: true,
      },
    };
  }

  sendHello() { this.send(this.buildHello()); }

  /** 发一帧（WS 直接写，HTTP 攒批） */
  send(frame) {
    this.vlog('↑', JSON.stringify(frame).slice(0, 400));
    if (this.transport === 'websocket') {
      if (this.ws?.readyState === this.ws?.OPEN) this.ws.send(JSON.stringify(frame));
      return;
    }
    this.httpQueue = this.httpQueue || [];
    this.httpQueue.push(frame);
    if (!this.httpFlushTimer) {
      this.httpFlushTimer = setTimeout(() => {
        this.httpFlushTimer = null;
        const batch = this.httpQueue.splice(0, this.httpQueue.length);
        if (batch.length) this.postBatch(batch).catch((e) => this.log(`上行失败：${e.message}`));
      }, 200);
    }
  }

  emit(topic, kind, data, sessionId = null) {
    const seq = ++this.seq;
    const frame = { v: 1, type: 'event', seq, topic, kind, ts: now(), data, ...(sessionId ? { sessionId } : {}) };
    this.buffer.push(frame);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    this.send(frame);
  }

  // -------------------------------------------------------------- 下行分发

  onFrame(frame) {
    if (frame.v !== 1) return;
    this.vlog('↓', JSON.stringify(frame).slice(0, 400));
    switch (frame.type) {
      case 'hello.ack': {
        this.log(`握手成功 instanceId=${frame.instanceId} resumeFromSeq=${frame.resumeFromSeq ?? '-'}`);
        this.serverAckSeq = Math.max(this.serverAckSeq, frame.resumeFromSeq || 0);
        if (Number.isFinite(frame.heartbeatMs) && frame.heartbeatMs > 0) this.startHeartbeat(frame.heartbeatMs);
        if (this.transport === 'http' && !this.helloAcked) {
          this.helloAcked = true;
          this.postBatch([{ v: 1, type: 'event', seq: ++this.seq, topic: 'instance', kind: 'bridge/connected', ts: now(), data: { instanceId, transport: 'http', protocol: 1, pluginVersion: 'sim-0.1.0', at: now() } }]).catch(() => {});
        } else if (this.transport === 'websocket') {
          this.emit('instance', 'bridge/connected', { instanceId, transport: 'websocket', protocol: 1, pluginVersion: 'sim-0.1.0', at: now() });
        }
        // 按服务器水位补发
        const from = frame.resumeFromSeq ?? 0;
        const missed = this.buffer.filter((f) => f.seq > from);
        if (missed.length) {
          this.log(`补发 ${missed.length} 条事件（seq > ${from}）`);
          for (const f of missed) this.send(f);
        }
        this.startWatchdog();
        break;
      }
      case 'pong':
        break;
      case 'ping':
        this.send({ v: 1, type: 'pong', ts: now() });
        break;
      case 'subscribe': {
        if (frame.topics) this.subscriptions.topics = frame.topics;
        if (frame.sessions) this.subscriptions.sessions = [...new Set([...this.subscriptions.sessions, ...frame.sessions])];
        this.assistantStream = frame.assistantStream ?? this.assistantStream;
        this.log(`收到订阅 topics=${(this.subscriptions.topics || []).join(',') || '-'} sessions=${this.subscriptions.sessions.join(',') || '-'} stream=${this.assistantStream}`);
        if (frame.snapshot !== false) this.pushSnapshots(frame.sessions);
        if (frame.id) this.send({ v: 1, type: 'response', id: frame.id, ok: true, result: { topics: this.subscriptions.topics, sessions: this.subscriptions.sessions, assistantStreams: this.assistantStream ? this.subscriptions.sessions : [] } });
        break;
      }
      case 'unsubscribe': {
        if (frame.topics) this.subscriptions.topics = this.subscriptions.topics.filter((t) => !frame.topics.includes(t));
        if (frame.sessions) this.subscriptions.sessions = this.subscriptions.sessions.filter((s) => !frame.sessions.includes(s));
        if (frame.id) this.send({ v: 1, type: 'response', id: frame.id, ok: true, result: { topics: this.subscriptions.topics, sessions: this.subscriptions.sessions } });
        break;
      }
      case 'request':
        this.handleRequest(frame);
        break;
      default:
        break;
    }
  }

  pushSnapshots(sessionIds) {
    const ids = sessionIds?.length ? sessionIds : [...this.sessions.keys()];
    for (const sid of ids) {
      if (!this.subscriptions.sessions.includes(sid) && sessionIds?.length) this.subscriptions.sessions.push(sid);
      this.emit('session', 'session/snapshot', this.sessionGet(sid), sid);
      const s = this.sessions.get(sid);
      if (s) this.emit('session', 'todos/changed', { sessionId: sid, source: 'projection', seq: this.seq, todos: s.todos }, sid);
    }
  }

  /** 健康看门狗：模拟真实会话的活动，让测试台一直有东西看 */
  startWatchdog() {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      const s = this.sessions.get(this.primary);
      if (s) this.emit('sessions', 'session/activity', { sessionId: s.sessionId, updatedAt: now() }, s.sessionId);
    }, 45000);
  }

  // -------------------------------------------------------------- 方法实现

  handleRequest(frame) {
    const { id, method, params = {} } = frame;
    const done = (result) => this.send({ v: 1, type: 'response', id, ok: true, result });
    const fail = (code, message, retryable = false, details) =>
      this.send({ v: 1, type: 'response', id, ok: false, error: { code, message, retryable, ...(details ? { details } : {}) } });

    try {
      const s = params.sessionId ? this.sessions.get(params.sessionId) : null;
      const needSession = () => {
        if (!s) { fail('session_not_found', `unknown session "${params.sessionId}"`, false, { sessionId: params.sessionId }); return false; }
        return true;
      };

      switch (method) {
        case 'instance.ping': return done({ pong: true, ts: now() });
        case 'instance.info': return done({
          instanceId,
          displayName: this.opts.name || '模拟机 (dsh-sim)',
          keyFingerprint: key.slice(0, 10) + '…' + key.slice(-4),
          keyFile: IDENTITY_FILE,
          keyPersisted: true,
          plugin: { name: 'dsh2server', version: 'sim-0.1.0' },
          protocol: 1,
          uptimeMs: now() - this.startAt,
          capabilities: CAPABILITIES,
          endpoints: [this.endpoint],
          methods: METHODS,
          connection: {
            endpoint: this.endpoint, configuredEndpoint: this.endpoint,
            insecure: this.endpoint.startsWith('http://'),
            state: 'connected', transport: this.transport,
            connectedSince: this.startAt, attempts: 1, wsFailures: 0,
            lastInboundAt: now(), serverAckSeq: this.serverAckSeq,
            subscriptions: { topics: this.subscriptions.topics, sessions: this.subscriptions.sessions, assistantStreams: this.assistantStream ? this.subscriptions.sessions : [] },
            rejected: null, lastError: null,
          },
          subscriptions: { topics: this.subscriptions.topics, sessions: this.subscriptions.sessions, assistantStreams: [] },
          pausedSessions: this.paused ? [...this.sessions.keys()] : [],
          pendingDecisions: [],
          config: { transport: this.transport, note: 'dsh-sim' },
        });
        case 'instance.health': return done({
          ok: true, connected: true, endpoints: [this.endpoint], transport: this.transport,
          links: [{ endpoint: this.endpoint, state: 'connected', transport: this.transport }],
          lastError: null, buffer: { size: this.buffer.length, limit: this.bufferSize, dropped: 0, lastSeq: this.seq },
          liveSessions: [...this.sessions.values()].filter((x) => x.attached).length,
        });
        case 'instance.key': return done({ instanceId, key, keyFingerprint: key.slice(0, 10) + '…' + key.slice(-4), keyFile: IDENTITY_FILE, persisted: true });
        case 'instance.rotateKey':
          if (params.confirm !== instanceId) return fail('invalid_params', 'confirm 必须等于 instanceId', false, { field: 'confirm' });
          return done({ instanceId, key: 'dshk_' + crypto.randomBytes(32).toString('base64url'), keyFingerprint: 'dshk_NEW…key', note: '模拟器轮换：真实插件会断开并用新 key 重连' });

        case 'workspace.list': return done({
          source: 'workspace-registry',
          items: [...new Set([...this.sessions.values()].map((x) => x.cwd))].map((p, i) => ({
            id: `ws-${i + 1}`, path: p, title: path.basename(p), createdAt: new Date(this.startAt).toISOString(), updatedAt: new Date().toISOString(),
            sessionIds: [...this.sessions.values()].filter((x) => x.cwd === p).map((x) => x.sessionId),
            running: [...this.sessions.values()].filter((x) => x.cwd === p && x.running).length,
          })),
        });

        case 'session.list': return done({ items: [...this.sessions.values()].map((x) => this.summary(x)) });
        case 'session.get': if (!needSession()) return; return done(this.sessionGet(params.sessionId));
        case 'session.create': {
          const sid = params.sessionId || newSessionId();
          const created = {
            sessionId: sid, updatedAt: now(), running: false, blank: true, cwd: params.cwd || process.cwd(),
            parentSessionId: null, attached: true, agentPreset: params.agentPreset || 'default', title: '新会话',
            events: [], todos: [], goal: null, model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: null },
          };
          this.sessions.set(sid, created);
          this.emit('sessions', 'session/created', { sessionId: sid, header: { version: 3, id: sid, createdAt: now(), cwd: created.cwd, parentSession: null, isSeeded: false, agentPreset: created.agentPreset } }, sid);
          this.emit('sessions', 'session/added', this.summary(created), sid);
          return done({ sessionId: sid, agentPreset: created.agentPreset });
        }
        case 'session.prompt': {
          if (!needSession()) return;
          const text = params.text ?? (params.content || []).map((c) => c.text).join('');
          if (this.paused && !params.force) {
            this.queued.push({ requestId: params.requestId || `q-${this.queued.length + 1}`, text });
            this.emit('sessions', 'session/paused', { sessionId: s.sessionId, paused: true, queued: this.queued.length, at: now() }, s.sessionId);
            return done({ accepted: true, deferred: true, paused: true, position: this.queued.length, requestId: params.requestId || 'q' });
          }
          const rid = params.requestId || `req-${crypto.randomBytes(4).toString('hex')}`;
          this.runTurn(s.sessionId, text);
          return done({ accepted: true, requestId: rid });
        }
        case 'session.interrupt':
        case 'session.cancel':
          if (!needSession()) return;
          if (this.turnTimer) { clearTimeout(this.turnTimer); this.turnTimer = null; }
          this.running = false; s.running = false;
          this.emit('session', 'session/event', { sessionId: s.sessionId, type: 'turn/end', seq: ++this.seq, time: now(), data: { turn: this.turns, reason: 'aborted' } }, s.sessionId);
          this.emit('sessions', 'session/status', { sessionId: s.sessionId, running: false, status: 'idle' }, s.sessionId);
          if (method === 'session.cancel') this.queued = [];
          return done({ accepted: true });
        case 'session.pause':
          if (!needSession()) return;
          this.paused = true; s.paused = true;
          this.emit('sessions', 'session/paused', { sessionId: s.sessionId, paused: true, interrupted: true, goalPaused: !!s.goal, queued: this.queued.length, at: now() }, s.sessionId);
          return done({ paused: true, interrupted: true, goalPaused: !!s.goal, queued: this.queued.length });
        case 'session.resume': {
          if (!needSession()) return;
          const delivered = this.queued.length;
          const queued = this.queued.splice(0, this.queued.length);
          this.paused = false; s.paused = false;
          this.emit('sessions', 'session/resumed', { sessionId: s.sessionId, paused: false, delivered, goalResumed: false, at: now() }, s.sessionId);
          for (const q of queued) this.runTurn(s.sessionId, q.text);
          return done({ paused: false, delivered, goalResumed: false });
        }
        case 'session.rename':
          if (!needSession()) return;
          s.title = params.title;
          this.emit('sessions', 'session/activity', { sessionId: s.sessionId, updatedAt: now() }, s.sessionId);
          return done({ title: params.title, seq: this.seq });
        case 'session.fork': {
          if (!needSession()) return;
          const nid = newSessionId();
          const forked = { ...structuredClone({ ...s, events: [] }), sessionId: nid, parentSessionId: s.sessionId, title: `${s.title} (fork)`, running: false };
          this.sessions.set(nid, forked);
          this.emit('sessions', 'session/created', { sessionId: nid, header: { version: 3, id: nid, createdAt: now(), cwd: forked.cwd, parentSession: s.sessionId, isSeeded: false } }, nid);
          return done({ sessionId: nid });
        }
        case 'session.history':
          if (!needSession()) return;
          if (!Number.isFinite(params.throughSeq)) return fail('invalid_params', '缺少 throughSeq', false, { field: 'throughSeq' });
          return done({
            records: s.events.slice(-(params.maxMessages || 50)).map((e) => ({ type: 'event', event: e })),
            hasMore: s.events.length > (params.maxMessages || 50),
          });
        case 'session.search':
          return done({
            items: [...this.sessions.values()]
              .filter((x) => JSON.stringify(x.events).toLowerCase().includes(String(params.query || '').toLowerCase()))
              .map((x) => ({ sessionId: x.sessionId, snippet: `…${params.query}…` })),
            hasMore: false,
          });
        case 'session.selectModel':
          if (!needSession()) return;
          s.model = { provider: params.provider, model: params.model, reasoningEffort: params.reasoningEffort ?? null };
          this.emit('sessions', 'session/activity', { sessionId: s.sessionId, updatedAt: now() }, s.sessionId);
          return done({ selected: s.model });
        case 'session.modelCatalog': return done({
          default: { provider: 'deepseek', model: 'deepseek-chat' },
          routableProviders: ['deepseek', 'anthropic', 'openai'],
          groups: [
            { provider: 'deepseek', models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat' }, { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner' }] },
            { provider: 'anthropic', models: [{ id: 'claude-opus-5', label: 'Claude Opus 5' }, { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' }] },
            { provider: 'openai', models: [{ id: 'gpt-5', label: 'GPT-5' }] },
          ],
          failures: [],
        });
        case 'session.queueUpdate': return done({ accepted: true });
        case 'session.approvalPolicy':
          if (!needSession()) return;
          if (params.policy) {
            if (!['ask', 'never'].includes(params.policy)) return fail('invalid_params', 'policy 只能是 ask / never', false, { field: 'policy' });
            this.approvalPolicy = params.policy; s.policy = params.policy;
            this.emit('sessions', 'session/approval-policy', { sessionId: s.sessionId, policy: params.policy, at: now() }, s.sessionId);
          }
          return done({ policy: this.approvalPolicy });

        case 'job.list': return done({
          items: this.jobs.filter((j) => !params.sessionId || j.sessionId === params.sessionId),
        });
        case 'job.read': {
          const job = this.jobs.find((j) => j.id === params.jobId);
          if (!job) return fail('not_found', `未知任务 ${params.jobId}`);
          return done({ text: `$ ${job.label}\n模拟输出：任务 ${job.id} 状态 ${job.status}\n`, job });
        }
        case 'job.kill': {
          const job = this.jobs.find((j) => j.id === params.jobId);
          if (!job) return fail('not_found', `未知任务 ${params.jobId}`);
          if (job.status !== 'running') return done({ result: 'already-finished' });
          job.status = 'killed'; job.finishedAt = now();
          this.emit('jobs', 'jobs/changed', { sessionId: job.sessionId, at: now() }, job.sessionId);
          return done({ result: 'requested' });
        }

        case 'goal.get': if (!needSession()) return; return done({ goal: s.goal });
        case 'goal.pause':
        case 'goal.resume':
        case 'goal.complete':
        case 'goal.clear':
        case 'goal.disarm': {
          if (!needSession()) return;
          if (method === 'goal.clear' || method === 'goal.disarm') {
            s.goal = null;
          } else if (!s.goal) {
            return fail('not_found', '该会话没有目标');
          } else {
            s.goal = { ...s.goal, revision: s.goal.revision + 1, phase: method === 'goal.pause' ? 'paused' : method === 'goal.complete' ? 'complete' : 'active', updatedAt: now() };
          }
          this.emit('goals', 'goal/changed', { sessionId: s.sessionId, source: 'operation', goal: s.goal, seq: this.seq }, s.sessionId);
          return done({ goal: s.goal });
        }

        case 'command.list':
          if (!needSession()) return;
          return done({ items: [
            { name: 'compact', description: '压缩当前会话上下文' },
            { name: 'export', description: '导出会话为 Markdown' },
            { name: 'goal', description: '设置/查看长期目标' },
            { name: 'demo-approval', description: '触发一次远程审批请求（用于测试）' },
          ] });
        case 'command.run': {
          if (!needSession()) return;
          if (!String(params.line || '').startsWith('/')) return fail('invalid_params', 'line 必须以 / 开头', false, { field: 'line' });
          const name = params.line.slice(1).split(/\s+/)[0];
          const known = ['compact', 'export', 'goal', 'demo-approval'];
          if (!known.includes(name)) return fail('not_found', `没有命令 /${name}`);
          if (name === 'demo-approval') this.raiseApproval(s.sessionId, 'bash', '执行 rm -rf ./dist 并重新构建');
          if (name === 'goal') {
            s.goal = { id: 'g1', revision: 1, objective: params.line.slice(6).trim() || '把测试补齐并通过 CI', phase: 'active', blockedReason: null, maxGoalRounds: 10, roundsStarted: 0, createdAt: now(), updatedAt: now(), activation: 'armed' };
            this.emit('goals', 'goal/changed', { sessionId: s.sessionId, source: 'operation', goal: s.goal, seq: this.seq }, s.sessionId);
          }
          return done({ commandId: `cmd-${crypto.randomBytes(3).toString('hex')}`, result: { command: name, output: `/${name} 已执行（模拟）` } });
        }

        case 'approval.respond': {
          const known = this.pendingApprovals?.has(params.requestId);
          this.pendingApprovals?.delete(params.requestId);
          const outcome = params.outcome;
          if (!['allowed-once', 'rejected', 'cancelled'].includes(outcome)) return fail('invalid_params', 'outcome 不合法', false, { field: 'outcome' });
          this.appendEvent(this.primary, 'tool/result', { callId: params.requestId, message: `审批结果：${outcome}`, error: outcome === 'rejected' });
          return done({ accepted: true, matched: !!known });
        }
        case 'question.answer': return done({ accepted: true, matched: false });

        // ---- 以下为 PLUGIN-EXT.md 定义的扩展方法 ----

        case 'session.events': {
          if (!needSession()) return;
          const through = Number.isFinite(params.throughSeq) ? params.throughSeq : Infinity;
          let list = s.events
            .map(({ sessionId, ...rest }) => rest)
            .filter((e) => e.seq <= through);
          if (Array.isArray(params.kinds) && params.kinds.length) {
            list = list.filter((e) => params.kinds.includes(e.type));
          }
          const limit = Math.min(Number(params.limit) || 500, 2000);
          const before = Number.isFinite(params.beforeSeq) ? params.beforeSeq : null;
          if (before != null) list = list.filter((e) => e.seq < before);
          const page = list.slice(-limit);
          return done({
            events: page,
            oldestSeq: page[0]?.seq ?? null,
            newestSeq: page[page.length - 1]?.seq ?? null,
            hasMore: list.length > page.length,
            bufferFloor: s.events[0]?.seq ?? 0,
          });
        }

        case 'message.feedback': {
          if (!needSession()) return;
          if (!['like', 'dislike', 'none'].includes(params.rating)) {
            return fail('invalid_params', 'rating 只能是 like / dislike / none', false, { field: 'rating' });
          }
          if (params.rating === 'none') this.feedback.delete(params.seq);
          else this.feedback.set(params.seq, params.rating);
          this.emit('sessions', 'message/feedback', {
            seq: params.seq, rating: params.rating ?? 'none', at: now(),
          }, s.sessionId);
          return done({ accepted: true, rating: this.feedback.get(params.seq) ?? 'none', updatedAt: now() });
        }
        case 'message.feedback.list':
          if (!needSession()) return;
          return done({ items: [...this.feedback.entries()].map(([seq, rating]) => ({ seq, rating })) });

        case 'session.permission': {
          if (!needSession()) return;
          if (params.preset) {
            if (!PERMISSION_PRESETS.includes(params.preset)) {
              return fail('invalid_params', `preset 只能是 ${PERMISSION_PRESETS.join(' / ')}`, false, { field: 'preset' });
            }
            this.permission = params.preset;
            this.emit('sessions', 'session/permission', { sessionId: s.sessionId, preset: params.preset, at: now() }, s.sessionId);
          }
          return done({ preset: this.permission, available: PERMISSION_PRESETS, locked: false });
        }

        case 'attachment.put': {
          const id = 'att_' + crypto.randomBytes(4).toString('hex');
          const bytes = Buffer.from(String(params.dataBase64 || ''), 'base64');
          this.attachments.set(id, { name: params.name, mime: params.mime, bytes: bytes.length, dataBase64: params.dataBase64 });
          return done({
            attachmentId: id, name: params.name, mime: params.mime, bytes: bytes.length,
            kind: String(params.mime || '').startsWith('image/') ? 'image' : 'file',
          });
        }
        case 'attachment.get': {
          const a = this.attachments.get(params.attachmentId);
          if (!a) return fail('not_found', `未知附件 ${params.attachmentId}`);
          const max = Number(params.maxBytes) || 4194304;
          if (a.bytes > max) return fail('payload_too_large', `附件 ${a.bytes} 字节，超过 maxBytes`, false);
          return done({ attachmentId: params.attachmentId, ...a, truncated: false });
        }

        case 'workspace.create':
        case 'workspace.rename': {
          const p = params.path || [...this.sessions.values()][0]?.cwd;
          if (!p) return fail('invalid_params', '缺少 path');
          if (method === 'workspace.create') this.workspaces.set(p, params.title || path.basename(p));
          else this.workspaces.set(p, params.title || this.workspaces.get(p) || path.basename(p));
          const ws = { id: `ws-${this.workspaces.size}`, path: p, title: this.workspaces.get(p), sessionIds: [] };
          this.emit('sessions', 'workspace/changed', {
            action: method === 'workspace.create' ? 'created' : 'renamed', workspace: ws, at: now(),
          });
          return done({ workspace: ws });
        }
        case 'workspace.remove': {
          const p = params.path || params.id;
          if (!this.workspaces.delete(p)) return fail('not_found', `没有登记过 ${p}`);
          this.emit('sessions', 'workspace/changed', { action: 'removed', workspace: null, at: now() });
          return done({ removed: true });
        }
        case 'workspace.fs.list': {
          const dir = params.path || process.cwd();
          const names = ['README.md', 'package.json', 'src', 'docs', 'relay.log'];
          return done({
            path: dir,
            entries: names.map((n) => {
              const isDir = !n.includes('.');
              return {
                name: n, path: path.join(dir, n), type: isDir ? 'dir' : 'file',
                size: isDir ? undefined : 1024 + n.length * 37,
                mtime: now() - 86400000, binary: false,
              };
            }),
            truncated: false,
          });
        }
        case 'workspace.fs.read': {
          const p = params.path || '';
          if (String(p).includes('..')) return fail('forbidden', '路径越界');
          return done({
            path: p, size: 62, truncated: false, binary: false, mime: 'text/plain',
            text: `// ${path.basename(p)}\n// dsh-sim 的模拟文件内容\nexport const ok = true\n`,
          });
        }

        case 'plugin.list': return done({
          items: [
            { id: 'dsh-shell', name: 'Shell', version: '0.1.0', enabled: true, state: 'active', scope: 'global', configurable: true, description: '终端与命令执行' },
            { id: 'dsh-web', name: 'Web', version: '0.1.0', enabled: true, state: 'active', scope: 'global', configurable: true, description: '网页搜索与抓取' },
            { id: 'dsh2server', name: 'dsh2server', version: '0.1.0', enabled: true, state: 'active', scope: 'global', configurable: true, description: '本控制台用的中转插件' },
            { id: 'dsh-experimental', name: 'Experimental', version: '0.0.1', enabled: false, state: 'disabled', scope: 'session', configurable: false, description: '会话级实验特性' },
          ],
        });
        case 'plugin.config':
          return done({ schema: {
            type: 'object',
            properties: { endpoint: { type: 'string', title: '服务器地址' }, transport: { type: 'string', title: '传输方式', enum: ['auto', 'websocket', 'http'] } },
          }, values: { endpoint: this.endpoint, transport: this.transport } });
        case 'plugin.setEnabled': {
          this.emit('instance', 'plugin/changed', {
            item: { id: params.id, enabled: !!params.enabled, state: params.enabled ? 'active' : 'disabled' }, at: now(),
          });
          return done({ item: { id: params.id, enabled: !!params.enabled, state: params.enabled ? 'active' : 'disabled' } });
        }

        case 'terminal.open': {
          const terminalId = 'term-' + crypto.randomBytes(3).toString('hex');
          this.terminals.set(terminalId, true);
          setTimeout(() => this.emit('terminal', 'terminal/output', { terminalId, data: 'dsh-sim 模拟终端已就绪\r\n$ ', at: now() }), 100);
          return done({ terminalId });
        }
        case 'terminal.write': {
          if (!this.terminals.has(params.terminalId)) return fail('not_found', '终端不存在');
          setTimeout(() => this.emit('terminal', 'terminal/output', {
            terminalId: params.terminalId, data: `dsh-sim: 收到 ${JSON.stringify(params.data)}\r\n$ `, at: now(),
          }), 80);
          return done({ accepted: true });
        }
        case 'terminal.resize': return done({ accepted: true });
        case 'terminal.close':
          this.terminals.delete(params.terminalId);
          this.emit('terminal', 'terminal/exit', { terminalId: params.terminalId, code: 0, at: now() });
          return done({ accepted: true });

        default:
          return fail('unknown_method', `方法 ${method} 不存在`, false, { methods: METHODS });
      }
    } catch (e) {
      return fail('internal', e.message);
    }
  }

  summary(s) {
    return {
      sessionId: s.sessionId, updatedAt: s.updatedAt, running: !!s.running, blank: s.events.length === 0,
      cwd: s.cwd, parentSessionId: s.parentSessionId || null, title: s.title,
      origin: s.parentSessionId ? 'subagent' : undefined,
      attached: !!s.attached,
      projections: { asOfSeq: this.seq, values: { todos: s.todos, goal: s.goal ? { goal: s.goal, roundsStarted: s.goal.roundsStarted } : null } },
    };
  }

  sessionGet(sid) {
    const s = this.sessions.get(sid);
    if (!s) return null;
    return {
      sessionId: sid, attached: !!s.attached, running: !!s.running, status: s.running ? 'running' : 'idle',
      header: { version: 3, id: sid, createdAt: this.startAt, cwd: s.cwd, parentSession: s.parentSessionId || null, isSeeded: false, agentPreset: s.agentPreset },
      seq: this.seq,
      projections: { asOfSeq: this.seq, values: { todos: s.todos, goal: s.goal ? { goal: s.goal, roundsStarted: s.goal.roundsStarted } : null, inbox: { 'next-turn': [], 'next-step': [] }, modelSelection: { lastUsed: s.model, next: s.model } } },
      model: s.model,
      pending: { nextTurn: this.turns, nextStep: 1 },
      paused: !!s.paused,
      queuedPrompts: this.queued.length,
      approvalPolicy: this.approvalPolicy,
      pendingDecisions: [],
    };
  }

  appendEvent(sid, type, data) {
    const s = this.sessions.get(sid);
    if (!s) return;
    const ev = { sessionId: sid, type, seq: ++this.seq, time: now(), data };
    s.events.push(ev);
    s.updatedAt = now();
    this.emit('session', 'session/event', ev, sid);
    return ev;
  }

  /**
   * 跑一轮假的对话：流式输出 + 事件溯源，用来验证测试台的实时性。
   * 同一会话的轮次串行执行 —— 真实 dsh 的日志就是这个顺序
   * （turn N 的 assistant/message 一定排在 turn N+1 的 turn/start 之前），
   * 并发跑会让历史窗口里的事件顺序失真。
   */
  runTurn(sid, text) {
    const s = this.sessions.get(sid);
    if (!s) return;
    const chain = (s.turnChain ?? Promise.resolve()).then(() => this.runTurnNow(sid, text));
    s.turnChain = chain.catch(() => {});
  }

  runTurnNow(sid, text) {
    const s = this.sessions.get(sid);
    if (!s) return Promise.resolve();
    this.turns += 1;
    const turn = this.turns;
    s.running = true;
    this.running = true;
    this.emit('sessions', 'session/status', { sessionId: sid, running: true, status: 'running' }, sid);
    this.appendEvent(sid, 'turn/start', { turn });
    this.appendEvent(sid, 'user/message', {
      turn,
      message: { role: 'user', content: text },
      source: { kind: 'user' },
    });
    // 轨迹视图靠 request/header 拿到 config + 工具目录（真实插件每步都追加一条）
    this.appendEvent(sid, 'request/header', {
      header: {
        config: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
        tools: SIM_TOOLS,
      },
      reason: this.headerSeen ? 'series' : 'initial',
    });
    this.headerSeen = true;
    this.appendEvent(sid, 'step/start', { turn, step: 1 });
    this.emit('sessions', 'session/activity', { sessionId: sid, updatedAt: now() }, sid);

    // 每轮带一次终端工具调用，方便验证工具行与「折叠中间步骤」
    const calls = [];
    const bashArgs = JSON.stringify({ command: 'pnpm run test --filter dsh-api' });
    const bashId = 'call-' + crypto.randomBytes(4).toString('hex');
    calls.push({ id: bashId, name: 'bash', arguments: bashArgs });
    this.appendEvent(sid, 'tool/call', {
      turn, step: 1, callId: bashId, name: 'bash',
      arguments: bashArgs,
      description: '跑一遍 dsh-api 的测试套件',
    });
    setTimeout(() => {
      this.appendEvent(sid, 'tool/result', {
        turn, step: 1, callId: bashId,
        message: toolResultMessage(bashId, '> dsh-api@1.0.0 test\n\n  38 passed (38)\n\nDone in 4.21s\n'),
        meta: { exitCode: 0 },
      });
    }, 180);

    // 提到「改/编辑」时再来一次文件编辑，触发 diff 卡片
    if (/改|编辑|修改|edit|write/i.test(text)) {
      const editId = 'call-' + crypto.randomBytes(4).toString('hex');
      const editArgs = JSON.stringify({ file_path: 'packages/client/ui-chat/src/chat/ChatView.tsx', old_string: 'const FOLLOW_THRESHOLD = 16', new_string: 'const FOLLOW_THRESHOLD = 24' });
      calls.push({ id: editId, name: 'edit', arguments: editArgs });
      this.appendEvent(sid, 'tool/call', {
        turn, step: 1, callId: editId, name: 'edit',
        arguments: editArgs,
        description: '把滚动跟随的阈值从 16 调到 24',
      });
      setTimeout(() => {
        this.appendEvent(sid, 'tool/result', {
          turn, step: 1, callId: editId,
          message: toolResultMessage(editId, '已应用 1 处修改'),
          meta: { added: 1, removed: 1 },
        });
      }, 320);
    }

    if (/审批|approval/i.test(text)) this.raiseApproval(sid, 'bash', `执行：${text}`);

    const reply = simReply(text);
    const attemptId = 'attempt-' + crypto.randomBytes(4).toString('hex');
    const revision = turn;
    const shouldStream = this.assistantStream || this.subscriptions.sessions.includes(sid);
    if (shouldStream) this.emit('session', 'session/assistant-stream', { sessionId: sid, frame: { type: 'start', attemptId, revision, turn, step: 1 } }, sid);

    let i = 0;
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    const tick = () => {
      if (!this.sessions.has(sid)) { finish(); return; }
      if (i >= reply.length) {
        if (shouldStream) {
          this.emit('session', 'session/assistant-stream', { sessionId: sid, frame: { type: 'end', attemptId, revision, index: i, outcome: { kind: 'committed', eventType: 'assistant/message', seq: this.seq + 1 } } }, sid);
        }
        // 真实插件的 assistant/message 把工具调用也带上（tool-call 块），
        // 与独立的 tool/call 事件说的是同一次调用；模拟器照这个形态发。
        const content = [
          { type: 'text', text: reply },
          ...calls.map((c) => ({
            type: 'tool-call', id: c.id, name: c.name, arguments: c.arguments,
          })),
        ];
        const msg = this.appendEvent(sid, 'assistant/message', {
          turn, step: 1,
          message: { role: 'assistant', content, source: { provider: 'deepseek', model: 'deepseek-chat' } },
          usage: { inputTokens: 128, outputTokens: reply.length },
        });
        this.appendEvent(sid, 'step/end', { turn, step: 1 });
        // TurnEndReason 是可辨识联合，`completed` 也是对象形态 —— 真实插件就是这么发的
        this.appendEvent(sid, 'turn/end', {
          turn, reason: { kind: 'completed' },
          files: [{ path: 'packages/client/ui-chat/src/chat/ChatView.tsx', added: 1, removed: 1 }],
        });
        this.emit('sessions', 'session/status', { sessionId: sid, running: false, status: 'idle' }, sid);
        s.running = false;
        this.running = false;
        s.todos = [{ id: 't1', text: '验证中转链路', status: 'completed' }, { id: 't2', text: '验证测试台交互', status: 'in_progress' }];
        this.emit('session', 'todos/changed', { sessionId: sid, source: 'projection', seq: this.seq, todos: s.todos }, sid);
        this.turnTimer = null;
        void msg;
        finish();
        return;
      }
      const chunk = reply.slice(i, i + 3);
      i += 3;
      if (shouldStream) this.emit('session', 'session/assistant-stream', { sessionId: sid, frame: { type: 'chunk', attemptId, revision, index: i, time: now(), chunk: { choices: [{ delta: { content: chunk } }] } } }, sid);
      this.turnTimer = setTimeout(tick, 45);
    };
    setTimeout(tick, 300);
    return done;
  }

  raiseApproval(sid, toolName, reason) {
    this.pendingApprovals = this.pendingApprovals || new Map();
    const requestId = 'apr-' + crypto.randomBytes(4).toString('hex');
    this.pendingApprovals.set(requestId, { sid, toolName });
    this.appendEvent(sid, 'tool/call', { callId: requestId, name: toolName, arguments: JSON.stringify({ reason }) });
    this.emit('approvals', 'approval/request', { requestId, sessionId: sid, toolName, callId: requestId, reason, at: now() }, sid);
  }

  reconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.attempts = (this.attempts || 0) + 1;
    const delay = Math.min(60000, 1000 * 2 ** Math.min(this.attempts - 1, 6)) * (0.8 + Math.random() * 0.4);
    this.log(`退避 ${Math.round(delay / 1000)}s 后重连（第 ${this.attempts} 次）`);
    setTimeout(() => {
      this.reconnecting = false;
      this.connect().catch(() => {});
    }, delay);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 模拟器的工具目录，供 request/header 使用（轨迹视图的「工具」页签读它） */
const SIM_TOOLS = [
  {
    name: 'bash',
    description: '在会话工作目录里执行一条命令。',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
  {
    name: 'edit',
    description: '按 old_string → new_string 就地修改一个文件。',
    parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
  },
  {
    name: 'read',
    description: '读取文件内容。',
    parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
  },
];

/**
 * 造一条符合 SessionEventMap 的工具结果消息。
 * 真实插件发的是 `message.content[0]` 为 ToolResultBlock 的 ToolResultMessage，
 * 不是裸字符串——模拟器要跟它一致，界面才能被真实地跑一遍。
 * @param {string} callId
 * @param {string} text
 * @param {boolean} [isError]
 * @returns {object}
 */
function toolResultMessage(callId, text, isError = false) {
  return {
    role: 'user',
    content: [{ type: 'tool-result', content: [{ type: 'text', text }], isError }],
    source: { kind: 'tool', callId },
  };
}

/**
 * 模拟助手回复。刻意带上标题、列表、行内代码、代码围栏、表格与链接，
 * 好让控制台的 markdown 管线在每个分支上都被真实跑一遍。
 * @param {string} text 用户下发的原文
 * @returns {string}
 */
function simReply(text) {
  return `收到：「${text}」。

## 模拟回复

这是 **dsh-sim** 生成的回复，用来验证中转链路与控制台渲染。它包含：

- 行内代码 \`session.prompt\`
- 一个列表项
- 一条正常外链 [DeepSeek 开放平台](https://platform.deepseek.com/)

\`\`\`bash
pnpm install
pnpm run test --filter dsh-api
\`\`\`

| 方法 | 作用 |
| --- | --- |
| \`session.list\` | 列出会话 |
| \`session.prompt\` | 下发提示 |
| \`session.pause\` | 暂停运行 |

> 引用块也应该正常渲染。`;
}

// ------------------------------------------------------------------ 能力与方法表

/** 权限预设的三档，对应 PLUGIN-EXT.md §3 */
const PERMISSION_PRESETS = ['read-only', 'workspace-write', 'full-access'];

const CAPABILITIES = {
  agents: true, sessions: true, sessionController: true, jobs: true, goals: true, commands: true,
  approval: true, userQuestions: false, workspaceRegistry: true, sessionProjections: true,
  sessionPersistence: true, sessionList: true, sessionCreate: true, sessionPrompt: true,
  sessionInterrupt: true, sessionHistory: true, sessionFork: true, sessionRename: true,
  sessionSearch: true, sessionSelectModel: true, queueUpdate: true, modelCatalog: true,
  approvalPolicy: true, approvalAnswer: true, questions: false, workspaces: true, projections: true,
  // 以下是 PLUGIN-EXT.md 里定义的扩展能力位。模拟器把它们全打开，
  // 这样控制台的每个扩展面板都有真实数据可跑；真实插件可以只实现其中一部分。
  sessionEvents: true,
  messageFeedback: true,
  permissionPresets: true,
  attachments: true,
  workspaceMutation: true,
  fileBrowser: true,
  terminal: true,
  pluginManagement: true,
};

const METHODS = [
  'instance.info', 'instance.ping', 'instance.health', 'instance.key', 'instance.rotateKey',
  'workspace.list', 'session.list', 'session.get', 'session.create', 'session.prompt',
  'session.interrupt', 'session.cancel', 'session.pause', 'session.resume', 'session.rename',
  'session.fork', 'session.history', 'session.search', 'session.selectModel', 'session.modelCatalog',
  'session.queueUpdate', 'session.approvalPolicy', 'job.list', 'job.read', 'job.kill',
  'goal.get', 'goal.pause', 'goal.resume', 'goal.complete', 'goal.clear', 'goal.disarm',
  'command.list', 'command.run', 'approval.respond', 'question.answer',
  // PLUGIN-EXT.md 定义的扩展方法
  'session.events', 'message.feedback', 'message.feedback.list', 'session.permission',
  'attachment.put', 'attachment.get',
  'workspace.create', 'workspace.rename', 'workspace.remove',
  'workspace.fs.list', 'workspace.fs.read',
  'plugin.list', 'plugin.config', 'plugin.setEnabled',
  'terminal.open', 'terminal.write', 'terminal.resize', 'terminal.close',
];

// ------------------------------------------------------------------ 启动

const sim = new Sim(args);
sim.log(`instanceId=${instanceId}`);
sim.log(`key=${key}`);
sim.log(`（把这把 key 登记到服务器即可配对：POST ${args.endpoint}/keys）`);
sim.connect().catch((e) => { sim.log(`启动失败：${e.message}`); process.exit(1); });

process.on('SIGINT', () => {
  sim.log('收到 SIGINT，发送 bye 后退出');
  sim.send({ v: 1, type: 'bye', reason: 'sim unloading' });
  setTimeout(() => process.exit(0), 300);
});
