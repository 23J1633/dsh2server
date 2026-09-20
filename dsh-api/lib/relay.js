// 中转核心：实例表 + 帧分发。两种载体（WS / HTTP）共用这里的全部逻辑。
import { EventEmitter } from 'node:events';
import { log } from './log.js';
import { Instance, err } from './instance.js';

export class Relay {
  constructor(cfg, keystore, { baseUrl = '' } = {}) {
    this.cfg = cfg;
    this.keystore = keystore;
    this.baseUrl = baseUrl;
    this.instances = new Map();
    this.bus = new EventEmitter();
    this.bus.setMaxListeners(200);
    this.startedAt = Date.now();
    this.timer = setInterval(() => this.sweep(), 15000);
    this.timer.unref?.();
  }

  // ---------------------------------------------------------------- 实例表

  get(instanceId) {
    return this.instances.get(instanceId) || null;
  }

  /** 取实例，取不到抛 session_not_found 风格的可读错误 */
  must(instanceId) {
    const inst = this.get(instanceId);
    if (!inst) throw err('not_found', `未知实例 "${instanceId}"`, false, { instanceId });
    return inst;
  }

  list() {
    return [...this.instances.values()].map((i) => i.summary());
  }

  /**
   * 认证 + 实例绑定。key 是机器身份，instanceId 只是路由标签（规范 §3.2），
   * 所以这里不允许同一台机器换 key，也不允许一把 key 认领两个 instanceId。
   */
  authorizeKey(candidate) {
    const entry = this.keystore.verify(candidate);
    if (!entry) return null;
    return entry;
  }

  bindInstance({ instanceId, keyEntry, label }) {
    let inst = this.instances.get(instanceId);
    if (!inst) {
      inst = new Instance({ instanceId, relay: this, keyId: keyEntry.id, label: label || keyEntry.label });
      this.instances.set(instanceId, inst);
      this.bus.emit('instances');
      log.info(`[relay] 新实例注册 ${instanceId}（${keyEntry.label}）`);
    } else if (inst.keyId && inst.keyId !== keyEntry.id) {
      // 同一 instanceId 被另一把 key 认领 —— 拒绝，避免跨机器串号
      throw err('unauthorized', `实例 ${instanceId} 已绑定另一把 key`, false, { instanceId });
    }
    if (!inst.keyId) inst.keyId = keyEntry.id;
    // 用户手工改过名字就以白名单为准，否则优先用插件上报的标签
    if (keyEntry.renamed) inst.label = keyEntry.label;
    else if (label || keyEntry.label) inst.label = label || keyEntry.label;
    // 顺带把 key 白名单里的 instanceId 补齐，方便运维排查
    if (keyEntry.instanceId !== instanceId) {
      keyEntry.instanceId = instanceId;
      this.keystore.save();
    }
    return inst;
  }

  // ---------------------------------------------------------------- HTTP 载体取 key

  /**
   * 规范 §2.2 的顺序：Authorization: Bearer → ?key= → 请求体 key → 批内首个 hello 的 auth.key
   */
  extractKey({ headers = {}, query = {}, body = null } = {}) {
    const auth = headers.authorization || headers.Authorization;
    if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
    if (query.key) return String(query.key);
    if (body && typeof body.key === 'string') return body.key;
    const hello = Array.isArray(body?.frames) ? body.frames.find((f) => f?.type === 'hello') : null;
    if (hello?.auth?.key) return hello.auth.key;
    return null;
  }

  // ---------------------------------------------------------------- 入站帧分发

  /** 返回本次处理的结论，供载体制定响应码 */
  handleInbound(link, frame) {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
      return { ok: false, code: 'bad_frame', message: '帧不是 JSON 对象' };
    }
    if (frame.v !== undefined && frame.v !== 1) {
      return { ok: false, code: 'bad_frame', message: `协议版本不匹配：${frame.v}` };
    }
    link.noteInbound();

    switch (frame.type) {
      case 'hello':
        return this.handleHello(link, frame);
      case 'ping': {
        // A heartbeat is an authenticated inbound frame too.  Refresh the
        // instance liveness watermark, not just the carrier watermark;
        // otherwise a healthy but idle WebSocket is marked offline after
        // `offlineAfterMs` even though pings keep arriving on time.
        const inst = this.get(link.instanceId);
        if (inst) inst.markSeen();
        link.send({ v: 1, type: 'pong', ts: Date.now() });
        return { ok: true };
      }
      case 'bye':
        return this.handleBye(link, frame);
      case 'event':
      case 'response':
      case 'ack':
      case 'log':
        return this.handleDataFrame(link, frame);
      default:
        return { ok: false, code: 'bad_frame', message: `未知帧类型 ${frame.type}` };
    }
  }

  handleHello(link, hello) {
    const candidate = hello?.auth?.key || link.pendingKey || null;
    const entry = this.authorizeKey(candidate);
    if (!entry) {
      link.rejected = { code: 'unauthorized', message: 'unknown instance key' };
      return { ok: false, code: 'unauthorized', message: 'unknown instance key', fatal: true };
    }
    // instanceId 由插件携带，但身份由 key 决定；两者串号一律拒绝
    const instanceId = hello.instanceId || hello.auth?.instanceId || link.instanceId;
    if (!instanceId) return { ok: false, code: 'invalid_params', message: 'hello 缺少 instanceId', fatal: true };

    let inst;
    try {
      inst = this.bindInstance({ instanceId, keyEntry: entry, label: hello.instance?.displayName });
    } catch (e) {
      link.rejected = { code: e.code, message: e.message };
      return { ok: false, code: e.code, message: e.message, fatal: true };
    }

    link.instanceId = instanceId;
    link.pendingKey = null;
    inst.addLink(link);
    inst.applyHello(hello);

    // hello.ack 必须回，否则插件 30s 后重连（规范 §6.2）
    const ack = {
      v: 1,
      type: 'hello.ack',
      instanceId,
      serverTime: Date.now(),
      heartbeatMs: this.cfg.heartbeatMs,
      serverSeq: inst.serverSeq,
    };
    const resume = inst.resumeFromSeq();
    if (resume != null) ack.resumeFromSeq = resume;
    link.send(ack);

    // 订阅不跨连接保留：每次 hello.ack 之后必须重新下发
    this.applyAutoSubscribe(inst);
    if (inst.needsResync) this.scheduleResync(inst);

    this.bus.emit('frame', { instanceId, frame: hello, at: Date.now() });
    this.bus.emit('instances');
    log.info(`[relay] ${instanceId} 握手成功 transport=${link.transport} resumeFromSeq=${resume ?? '-'} lastSeq=${hello.lastSeq ?? '-'}`);
    return { ok: true, instanceId };
  }

  handleBye(link, frame) {
    const inst = this.get(link.instanceId);
    if (inst) {
      // HTTP 载体没有 socket 关闭信号，只能靠 bye 标记离线；标记而不是删除，
      // 因为紧随其后的重连会与删除抢跑（规范 §12）。
      inst.online = false;
      inst.disconnectedAt = Date.now();
      inst.lastDisconnectReason = frame.reason || 'plugin bye';
      inst.removeLink(link, inst.lastDisconnectReason);
      this.bus.emit('instances');
    }
    log.info(`[relay] ${link.instanceId} 收到 bye：${frame.reason || ''}`);
    return { ok: true };
  }

  handleDataFrame(link, frame) {
    const inst = this.get(link.instanceId);
    if (!inst) return { ok: false, code: 'bad_frame', message: '尚未完成 hello 握手' };
    inst.markSeen();
    switch (frame.type) {
      case 'event': {
        const verdict = inst.ingestEvent(frame);
        if (verdict === 'ok') {
          this.bus.emit('frame', { instanceId: inst.instanceId, frame, at: Date.now() });
          // 会话开始干活时按需补订阅，控制台才能像本地一样看到逐条事件与流式输出
          if (frame.kind === 'session/status' && frame.data?.running) {
            this.maybeAutoSubscribeSession(inst, frame.data.sessionId || frame.sessionId);
          }
        }
        return { ok: true, verdict };
      }
      case 'response':
        inst.handleResponse(frame);
        this.bus.emit('frame', { instanceId: inst.instanceId, frame, at: Date.now() });
        return { ok: true };
      case 'ack':
        if (Number.isFinite(frame.seq)) link.serverAckSeq = Math.max(link.serverAckSeq, frame.seq);
        return { ok: true };
      case 'log':
        log.info(`[plugin:${inst.instanceId}] ${frame.level || 'info'} ${frame.message || ''}`);
        this.bus.emit('frame', { instanceId: inst.instanceId, frame, at: Date.now() });
        return { ok: true };
      default:
        return { ok: false, code: 'bad_frame' };
    }
  }

  // ---------------------------------------------------------------- 订阅与全量刷新

  applyAutoSubscribe(inst) {
    const cfg = this.cfg.autoSubscribe || {};
    const topics = cfg.topics?.length ? cfg.topics : ['instance', 'sessions', 'jobs', 'approvals', 'goals'];
    // sessions 既可以是 none/running/all，也可以直接是一串会话 id
    const explicit = Array.isArray(cfg.sessions)
      ? cfg.sessions.filter((s) => s && s !== 'none')
      : cfg.sessions === 'all'
        ? [...inst.sessions.keys()]
        : [];
    const stream = cfg.assistantStream ?? (cfg.sessions === 'all');
    const payload = { topics, sessions: explicit.length ? explicit : undefined, snapshot: true };
    if (stream && explicit.length) payload.assistantStream = true;
    try {
      inst.subscribe(payload);
      log.info(`[relay] ${inst.instanceId} 自动订阅 topics=${topics.join(',')} sessions=${cfg.sessions ?? 'none'}`);
    } catch (e) {
      log.warn(`[relay] ${inst.instanceId} 自动订阅失败：${e.message}`);
    }
  }

  /**
   * 会话开始运行时补一次逐会话订阅（含流式）。
   * `autoSubscribe.sessions` 的语义与插件侧一致：none | running | all，或一串会话 id。
   */
  maybeAutoSubscribeSession(inst, sessionId) {
    if (!sessionId) return;
    const mode = this.cfg.autoSubscribe?.sessions;
    const allowed = mode === 'all'
      || mode === 'running'
      || (Array.isArray(mode) && mode.includes(sessionId));
    if (!allowed) return;
    if (inst.subscriptions.sessions.includes(sessionId)) return;
    try {
      inst.subscribe({ sessions: [sessionId], assistantStream: true, snapshot: false });
      log.info(`[relay] ${inst.instanceId} 自动订阅运行中的会话 ${sessionId}`);
    } catch (e) {
      log.warn(`[relay] ${inst.instanceId} 订阅 ${sessionId} 失败：${e.message}`);
    }
  }

  /** bridge/resync：插件缓冲区已经盖不住补发点，服务器重新拉全量（规范 §8.1） */
  scheduleResync(inst) {
    if (inst._resyncTimer) return;
    inst._resyncTimer = setTimeout(() => {
      inst._resyncTimer = null;
      this.refreshFull(inst).catch((e) => log.warn(`[relay] ${inst.instanceId} 全量刷新失败：${e.message}`));
    }, 1500);
    inst._resyncTimer.unref?.();
  }

  async refreshFull(inst) {
    log.info(`[relay] ${inst.instanceId} 开始全量刷新`);
    this.applyAutoSubscribe(inst);
    const [sessions, workspaces] = await Promise.allSettled([
      inst.request('session.list', {}),
      inst.request('workspace.list', {}),
    ]);
    if (sessions.status === 'fulfilled') {
      for (const item of sessions.value?.items || []) {
        inst.sessions.set(item.sessionId, { ...(inst.sessions.get(item.sessionId) || {}), ...item });
      }
    } else {
      log.warn(`[relay] ${inst.instanceId} session.list 失败：${sessions.reason?.message}`);
    }
    if (workspaces.status === 'fulfilled') inst.workspaces = workspaces.value;
    inst.needsResync = false;
    this.bus.emit('instances');
    this.bus.emit('frame', { instanceId: inst.instanceId, frame: { v: 1, type: 'resync', at: Date.now() }, at: Date.now() });
  }

  // ---------------------------------------------------------------- 管理面操作

  /** 控制台/管理接口下发请求的统一入口 */
  async call(instanceId, method, params = {}, opts = {}) {
    const inst = this.must(instanceId);
    if (!method || typeof method !== 'string') throw err('bad_request', '缺少 method');
    const result = await inst.request(method, params, opts);
    if (method === 'session.list' && Array.isArray(result?.items)) {
      for (const item of result.items) {
        inst.sessions.set(item.sessionId, { ...(inst.sessions.get(item.sessionId) || {}), ...item });
      }
      this.bus.emit('instances');
    } else if (method === 'workspace.list') {
      inst.workspaces = result;
    } else if (method === 'job.list') {
      inst.jobs = result;
      inst.jobsStale = false;
    } else if (method === 'approval.respond' || method === 'question.answer') {
      if (params.requestId) inst.resolveDecision(params.requestId);
    }
    return result;
  }

  async rotateKey(instanceId, confirm) {
    const inst = this.must(instanceId);
    if (confirm !== instanceId) throw err('invalid_params', 'confirm 必须等于 instanceId', false, { field: 'confirm' });
    const oldEntry = this.keystore.entries.find((e) => e.id === inst.keyId);
    const result = await inst.request('instance.rotateKey', { confirm });
    // 规范 §13.3 的轮换路径：先登记新 key，再删除旧 key
    const entry = this.keystore.register(result.key, { label: inst.label, instanceId });
    if (oldEntry && oldEntry.id !== entry.id) this.keystore.revoke(oldEntry.id);
    inst.keyId = entry.id;
    this.bus.emit('instances');
    log.info(`[relay] ${instanceId} key 已轮换，指纹 ${result.keyFingerprint}`);
    return { instanceId, key: result.key, keyFingerprint: result.keyFingerprint, note: result.note, keyId: entry.id };
  }

  // ---------------------------------------------------------------- 巡检

  sweep() {
    for (const inst of this.instances.values()) inst.sweep();
  }

  stats() {
    return {
      instances: this.instances.size,
      online: [...this.instances.values()].filter((i) => i.online).length,
      uptimeMs: Date.now() - this.startedAt,
      keys: this.keystore.entries.length,
    };
  }

  close() {
    clearInterval(this.timer);
    for (const inst of this.instances.values()) {
      for (const l of [...inst.links.values()]) l.close(1001, 'server shutting down');
    }
  }
}
