// 一台 dsh 机器在中转服务器里的全部内存状态。
// 服务器是无状态的（规范 §1.1）：这里的一切都可以在插件重连后重新长出来。
import crypto from 'node:crypto';
import { log } from './log.js';
import { fingerprint } from './keystore.js';

const SESSION_EVENT_KEEP = 400;

/** 从模型原始 chunk 里尽量抽出可显示的增量文本（结构由适配器决定，见规范 §8.7） */
export function extractChunkText(chunk) {
  if (!chunk || typeof chunk !== 'object') return '';
  const d = chunk.delta ?? chunk.choices?.[0]?.delta ?? chunk.message?.delta ?? chunk;
  const pick = (v) => {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join('');
    if (v && typeof v === 'object' && typeof v.text === 'string') return v.text;
    return '';
  };
  for (const key of ['content', 'text', 'reasoning_content', 'reasoning']) {
    const t = pick(d?.[key]);
    if (t) return t;
  }
  return '';
}

export class Instance {
  constructor({ instanceId, relay, keyId = null, label = null }) {
    this.instanceId = instanceId;
    this.relay = relay;
    this.cfg = relay.cfg;
    this.keyId = keyId;
    this.label = label;

    // hello 带来的身份信息
    this.info = {};              // hello.instance
    this.capabilities = {};
    this.pluginVersion = null;
    this.protocolVersion = 1;
    this.displayName = null;
    this.endpoints = [];

    // 链路
    this.links = new Map();

    // 事件（上行，插件 → 服务器）
    this.lastSeq = 0;            // 已接收的最大 seq，同时也是给插件的补发水位
    this.events = [];            // 环形缓冲，按 seq 升序
    this.seqSet = new Set();
    this.dropped = 0;

    // 下行
    this.serverSeq = 0;
    this.pending = new Map();    // id -> {resolve, reject, timer, method}
    this.nextReqId = 1;

    // 会话与工作目录缓存（全部由事件推导，权威数据仍以插件为准）
    this.sessions = new Map();
    this.sessionEvents = new Map();
    this.sessionStreams = new Map();
    this.snapshots = new Map();
    this.workspaces = null;
    this.jobs = null;
    this.jobsStale = true;
    this.goals = new Map();
    this.todos = new Map();
    this.pendingDecisions = new Map();
    this.pausedSessions = new Set();
    this.approvalPolicies = new Map();

    // 订阅状态（订阅不跨连接保留，每次 hello.ack 之后由服务器重新下发）
    this.subscriptions = { topics: [], sessions: [], assistantStreams: [] };

    // 在线判定
    this.lastSeenAt = Date.now();
    this.online = false;
    this.connectedAt = null;
    this.disconnectedAt = null;
    this.lastDisconnectReason = null;
    this.needsResync = false;
  }

  get isOnline() { return this.online; }

  keyFingerprint() {
    const entry = this.relay.keystore.entries.find((e) => e.id === this.keyId);
    return entry ? fingerprint(entry.key) : null;
  }

  // ---------------------------------------------------------------- 链路管理

  addLink(link) {
    this.links.set(link.id, link);
    link.markConnected();
    this.markSeen();
    this.online = true;
    this.connectedAt = Date.now();
    this.disconnectedAt = null;
    this.relay.bus.emit('link', { instanceId: this.instanceId, link: link.view(this.subscriptions) });
    return link;
  }

  removeLink(link, reason) {
    if (!this.links.has(link.id)) return;
    this.links.delete(link.id);
    if (link.state !== 'disposed') link.markDisposed(reason);

    if (!this.primaryLink()) {
      this.online = false;
      this.disconnectedAt = Date.now();
      this.lastDisconnectReason = reason || 'link closed';
      // 插件不在线，未决请求不可能有回音，直接失败，别让调用方白等
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err('instance_offline', `实例 ${this.instanceId} 已离线（${this.lastDisconnectReason}）`, true));
        this.pending.delete(id);
      }
    }
    this.relay.bus.emit('link', { instanceId: this.instanceId, link: link.view(this.subscriptions) });
  }

  /** 优先 WebSocket；没有就退回还活着的 HTTP 链路 */
  primaryLink() {
    const alive = [...this.links.values()].filter(
      (l) => l.state !== 'disposed' && (l.transport === 'websocket' || Date.now() - (l.lastInboundAt || 0) < this.cfg.offlineAfterMs),
    );
    return alive.find((l) => l.transport === 'websocket') || alive[0] || null;
  }

  markSeen() {
    this.lastSeenAt = Date.now();
    if (!this.online) {
      this.online = true;
      this.relay.bus.emit('link', { instanceId: this.instanceId, link: null });
    }
  }

  /** 定期巡检：长时间没有入站帧就判定离线（HTTP 载体尤其需要，规范 §12） */
  sweep(now = Date.now()) {
    const silent = now - this.lastSeenAt > this.cfg.offlineAfterMs;
    if (this.online && silent) {
      this.online = false;
      this.disconnectedAt = now;
      this.lastDisconnectReason = `超过 ${Math.round(this.cfg.offlineAfterMs / 1000)}s 无入站帧`;
      log.warn(`[instance] ${this.instanceId} 判定离线：${this.lastDisconnectReason}`);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err('instance_offline', `实例 ${this.instanceId} 已离线`, true));
      }
      this.pending.clear();
      this.relay.bus.emit('link', { instanceId: this.instanceId, link: null });
    }
    // HTTP 链路自身也要随实例一起离线
    if (!this.online) {
      for (const l of [...this.links.values()]) {
        if (l.transport === 'http' && now - (l.lastInboundAt || 0) > this.cfg.offlineAfterMs) this.removeLink(l, 'idle');
      }
    }
  }

  // ---------------------------------------------------------------- 下行发送

  send(frame) {
    const link = this.primaryLink();
    if (!link) return false;
    if (frame.type !== 'pong' && frame.type !== 'ack') {
      this.serverSeq += 1;
      frame.seq = this.serverSeq;
    }
    frame.v = 1;
    link.send(frame);
    this.relay.bus.emit('out', { instanceId: this.instanceId, frame });
    return true;
  }

  /**
   * 下发一次请求并等待 response（规范 §4.4：有依赖关系的操作必须串行等待）。
   * 幂等/关联用 id 匹配，超时按方法粒度区分。
   */
  request(method, params = {}, { timeoutMs, requestId } = {}) {
    const link = this.primaryLink();
    if (!link) {
      return Promise.reject(err('instance_offline', `实例 ${this.instanceId} 当前离线，无法下发 ${method}`, true));
    }
    const id = requestId || `req-${this.nextReqId++}`;
    const timeout = timeoutMs ?? this.cfg.methodTimeoutMs?.[method] ?? this.cfg.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(err('timeout', `${method} 在 ${timeout}ms 内没有返回`, true, { method }));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      if (!this.send({ v: 1, type: 'request', id, method, params })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err('instance_offline', `实例 ${this.instanceId} 当前离线`, true));
      }
    });
  }

  handleResponse(frame) {
    const p = this.pending.get(frame.id);
    if (!p) {
      log.debug(`[instance] ${this.instanceId} 收到未知 id 的 response: ${frame.id}`);
      return;
    }
    clearTimeout(p.timer);
    this.pending.delete(frame.id);
    if (frame.ok === false) p.reject(frame.error || err('internal', '插件返回失败但没有 error 字段'));
    else p.resolve(frame.result ?? {});
  }

  // ---------------------------------------------------------------- 订阅

  subscribe({ topics, sessions, assistantStream, snapshot = true } = {}) {
    const frame = { v: 1, type: 'subscribe', id: `sub-${this.nextReqId++}` };
    if (topics) frame.topics = topics;
    if (sessions) frame.sessions = sessions;
    if (assistantStream != null) frame.assistantStream = assistantStream;
    if (snapshot != null) frame.snapshot = snapshot;

    if (topics) this.subscriptions.topics = [...new Set(topics)];
    if (sessions) this.subscriptions.sessions = [...new Set([...this.subscriptions.sessions, ...sessions])];
    if (assistantStream === true && sessions) {
      this.subscriptions.assistantStreams = [...new Set([...this.subscriptions.assistantStreams, ...sessions])];
      this.subscriptions.assistantStream = 'partial';
    }
    if (assistantStream === true && !sessions) this.subscriptions.assistantStream = true;

    this.send(frame);
    return this.subscriptions;
  }

  unsubscribe({ topics, sessions } = {}) {
    const frame = { v: 1, type: 'unsubscribe', id: `unsub-${this.nextReqId++}` };
    if (topics) frame.topics = topics;
    if (sessions) frame.sessions = sessions;
    if (topics) this.subscriptions.topics = this.subscriptions.topics.filter((t) => !topics.includes(t));
    if (sessions) {
      this.subscriptions.sessions = this.subscriptions.sessions.filter((s) => !sessions.includes(s));
      this.subscriptions.assistantStreams = this.subscriptions.assistantStreams.filter((s) => !sessions.includes(s));
    }
    this.send(frame);
    return this.subscriptions;
  }

  // ---------------------------------------------------------------- 上行事件

  /**
   * 处理 hello。这里做序号空间重置判定：
   * 插件进程重启后 seq 会从很小的值重新开始，若不重置，后续事件会全部被当成
   * "窗口外旧事件"丢掉。
   */
  applyHello(hello) {
    const incomingLast = Number.isFinite(hello.lastSeq) ? hello.lastSeq : null;
    if (incomingLast != null && incomingLast < this.lastSeq) {
      log.warn(`[instance] ${this.instanceId} 序号空间重置（插件重启？）${this.lastSeq} → ${incomingLast}`);
      this.lastSeq = 0;
      this.events = [];
      this.seqSet.clear();
      this.dropped = 0;
    }
    this.info = hello.instance || this.info;
    this.capabilities = hello.capabilities || this.capabilities;
    this.pluginVersion = this.info.pluginVersion || this.pluginVersion;
    this.protocolVersion = this.info.protocolVersion ?? this.protocolVersion;
    this.displayName = this.info.displayName || this.displayName;
    if (Array.isArray(hello.subscriptions?.topics) && !this.subscriptions.topics.length) {
      // 服务器侧没有订阅记录时，沿用插件回带的上一轮订阅作为起点
      this.subscriptions.topics = hello.subscriptions.topics;
      this.subscriptions.sessions = hello.subscriptions.sessions || [];
    }
    this.markSeen();
  }

  /** 断线补发水位（规范 §11.1）：把服务器真实持有的 seq 回给插件 */
  resumeFromSeq() {
    return this.lastSeq > 0 ? this.lastSeq : null;
  }

  ingestEvent(frame) {
    const seq = frame.seq;
    if (!Number.isInteger(seq)) {
      log.warn(`[instance] ${this.instanceId} 收到没有合法 seq 的 event，已忽略`);
      return 'bad';
    }
    if (this.seqSet.has(seq) || seq <= this.lastSeq) return 'stale';

    let data = frame.data;
    if (data != null && this.cfg.maxPayloadBytes) {
      const size = Buffer.byteLength(JSON.stringify(data));
      if (size > this.cfg.maxPayloadBytes) {
        frame = { ...frame, truncated: { reason: `value exceeds maxPayloadBytes (${this.cfg.maxPayloadBytes})`, bytes: size }, data: null };
        data = null;
      }
    }

    this.events.push(frame);
    this.seqSet.add(seq);
    while (this.events.length > this.cfg.eventBufferSize) {
      const gone = this.events.shift();
      this.seqSet.delete(gone.seq);
      this.dropped += 1;
    }
    this.lastSeq = seq;
    this.markSeen();
    this.applyEvent(frame);
    return 'ok';
  }

  /** 把事件映射进会话缓存。未知 kind 一律透传忽略（规范 §8.6）。 */
  applyEvent(frame) {
    const d = frame.data || {};
    const sessionId = frame.sessionId || d.sessionId || null;
    switch (frame.kind) {
      case 'session/created':
        this.sessions.set(d.sessionId || sessionId, { ...(this.sessions.get(d.sessionId || sessionId) || {}), ...(d.header || {}), sessionId: d.sessionId || sessionId });
        break;
      case 'session/added':
        this.sessions.set(d.sessionId, { ...(this.sessions.get(d.sessionId) || {}), ...d });
        break;
      case 'session/removed':
      case 'session/disposed':
        this.sessions.delete(d.sessionId || sessionId);
        this.sessionEvents.delete(d.sessionId || sessionId);
        this.sessionStreams.delete(d.sessionId || sessionId);
        this.snapshots.delete(d.sessionId || sessionId);
        this.pausedSessions.delete(d.sessionId || sessionId);
        break;
      case 'session/status': {
        if (!sessionId) break;
        const cur = this.sessions.get(sessionId) || { sessionId };
        this.sessions.set(sessionId, { ...cur, sessionId, running: !!d.running, status: d.status });
        break;
      }
      case 'session/activity': {
        if (!sessionId) break;
        const cur = this.sessions.get(sessionId) || { sessionId };
        this.sessions.set(sessionId, { ...cur, sessionId, updatedAt: d.updatedAt ?? frame.ts });
        break;
      }
      case 'session/error': {
        if (!sessionId) break;
        const cur = this.sessions.get(sessionId) || { sessionId };
        this.sessions.set(sessionId, { ...cur, sessionId, lastError: d.message });
        break;
      }
      case 'session/paused':
        if (sessionId) { if (d.paused === false) this.pausedSessions.delete(sessionId); else this.pausedSessions.add(sessionId); }
        break;
      case 'session/resumed':
        if (sessionId) this.pausedSessions.delete(sessionId);
        break;
      case 'session/approval-policy':
        if (sessionId) this.approvalPolicies.set(sessionId, d.policy);
        break;
      case 'session/snapshot': {
        const sid = d.sessionId || sessionId;
        if (sid) {
          this.snapshots.set(sid, d);
          this.sessions.set(sid, { ...(this.sessions.get(sid) || {}), sessionId: sid, ...d });
          if (typeof d.paused === 'boolean') {
            if (d.paused) this.pausedSessions.add(sid); else this.pausedSessions.delete(sid);
          }
        }
        break;
      }
      case 'session/event': {
        const sid = d.sessionId || sessionId;
        if (!sid) break;
        const list = this.sessionEvents.get(sid) || [];
        list.push(d);
        if (list.length > SESSION_EVENT_KEEP) list.splice(0, list.length - SESSION_EVENT_KEEP);
        this.sessionEvents.set(sid, list);
        if (d.type === 'user/message') {
          const cur = this.sessions.get(sid) || { sessionId: sid };
          this.sessions.set(sid, { ...cur, sessionId: sid, updatedAt: d.time ?? frame.ts });
        }
        break;
      }
      case 'session/assistant-stream': {
        const sid = d.sessionId || sessionId;
        const f = d.frame;
        if (!sid || !f) break;
        let st = this.sessionStreams.get(sid);
        if (!st || f.revision !== st.revision) st = { revision: f.revision, attemptId: f.attemptId, text: '', index: -1, startedAt: frame.ts, outcome: null };
        if (f.type === 'start') {
          st.text = '';
          st.index = -1;
        } else if (f.type === 'chunk') {
          if (f.index <= st.index) break;      // 同一 attempt 内 index 必须连续递增
          if (st.index >= 0 && f.index !== st.index + 1) st.gap = true;
          st.index = f.index;
          st.text += extractChunkText(f.chunk);
        } else if (f.type === 'end') {
          st.outcome = f.outcome || null;
          st.index = f.index ?? st.index;
        }
        st.updatedAt = frame.ts;
        this.sessionStreams.set(sid, st);
        break;
      }
      case 'todos/changed':
        if (sessionId) this.todos.set(sessionId, d.todos || []);
        break;
      case 'jobs/changed':
        this.jobsStale = true;
        break;
      case 'goal/changed':
        if (sessionId) this.goals.set(sessionId, d.goal || null);
        break;
      case 'approval/request':
      case 'question/request': {
        const kind = frame.kind === 'approval/request' ? 'approval' : 'question';
        this.pendingDecisions.set(d.requestId, { ...d, kind, raisedAt: frame.ts });
        break;
      }
      case 'bridge/connected':
        this.online = true;
        break;
      case 'bridge/disconnected':
        break;
      case 'bridge/resync':
        // 补发点早于插件缓冲区，服务器必须重新拉全量（规范 §8.1）
        this.needsResync = true;
        this.events = [];
        this.seqSet.clear();
        this.lastSeq = 0;
        this.relay.scheduleResync(this);
        break;
      default:
        break; // 未知 kind：透传 + 忽略，绝不断流
    }
    return frame;
  }

  /** 应答审批/提问后清掉待决项 */
  resolveDecision(requestId) {
    return this.pendingDecisions.delete(requestId);
  }

  // ---------------------------------------------------------------- 视图

  summary() {
    const link = this.primaryLink();
    return {
      instanceId: this.instanceId,
      label: this.label,
      displayName: this.displayName,
      online: this.online,
      transport: link?.transport || null,
      endpoint: link?.endpoint || null,
      insecure: link ? link.insecure : false,
      connectedAt: this.connectedAt,
      disconnectedAt: this.disconnectedAt,
      lastSeenAt: this.lastSeenAt,
      lastDisconnectReason: this.lastDisconnectReason,
      keyFingerprint: this.keyFingerprint(),
      pluginVersion: this.pluginVersion,
      protocolVersion: this.protocolVersion,
      hostname: this.info.hostname || null,
      platform: this.info.platform || null,
      osRelease: this.info.osRelease || null,
      liveSessions: this.info.liveSessions ?? null,
      capabilities: this.capabilities,
      subscriptions: this.subscriptions,
      lastSeq: this.lastSeq,
      bufferedEvents: this.events.length,
      droppedEvents: this.dropped,
      serverSeq: this.serverSeq,
      jobsStale: this.jobsStale,
      pendingRequests: this.pending.size,
      pausedSessions: [...this.pausedSessions],
      pendingDecisions: [...this.pendingDecisions.values()],
      needsResync: this.needsResync,
      links: [...this.links.values()].map((l) => l.view(this.subscriptions)),
    };
  }

  sessionList() {
    return [...this.sessions.values()]
      .map((s) => ({
        ...s,
        stream: this.sessionStreams.get(s.sessionId) || null,
        paused: this.pausedSessions.has(s.sessionId),
      }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
}

/** 统一错误对象（规范 §10：code 是稳定枚举，调用方按 code 分支） */
export function err(code, message, retryable = false, details) {
  return { code, message, retryable, ...(details ? { details } : {}) };
}

export function newInstanceId() {
  return 'dsh-' + crypto.randomBytes(6).toString('hex');
}
