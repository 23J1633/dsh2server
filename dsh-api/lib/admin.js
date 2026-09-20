// 管理面：REST + 控制台事件流（SSE）。
// 这里的每个接口都能向机器下发命令，所以鉴权是硬要求（规范 §13.6）。
import { log } from './log.js';
import { readJson } from './carriers.js';

const STATUS_BY_CODE = {
  bad_request: 400,
  invalid_params: 400,
  bad_frame: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  session_not_found: 404,
  unknown_method: 404,
  conflict: 409,
  capability_unavailable: 409,
  disabled: 409,
  agent_busy: 409,
  payload_too_large: 413,
  rate_limited: 429,
  timeout: 504,
  instance_offline: 503,
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

export class AdminApi {
  constructor(ctx) {
    this.ctx = ctx;
    this.sseClients = new Set();
    this.instancesDirty = false;
    this.instancesTimer = null;
    this.router = this.buildRoutes();
  }

  // ---------------------------------------------------------------- 事件流

  start() {
    const { relay } = this.ctx;
    relay.bus.on('frame', (payload) => this.broadcast('frame', payload));
    relay.bus.on('out', (payload) => this.broadcast('frame', { ...payload, dir: 'out' }));
    relay.bus.on('link', (payload) => {
      this.broadcast('link', payload);
      this.markInstancesDirty();
    });
    relay.bus.on('instances', () => this.markInstancesDirty());
  }

  markInstancesDirty() {
    if (this.instancesTimer) return;
    this.instancesTimer = setTimeout(() => {
      this.instancesTimer = null;
      this.broadcast('instances', this.ctx.relay.list());
    }, 200);
    this.instancesTimer.unref?.();
  }

  broadcast(event, data) {
    if (!this.sseClients.size) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of [...this.sseClients]) {
      try {
        res.write(payload);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  // ---------------------------------------------------------------- 鉴权

  isAdmin(req, query) {
    const header = req.headers['x-admin-key'];
    const candidate = (typeof header === 'string' && header) || query.adminKey || null;
    if (!candidate) return false;
    return this.ctx.keystore.adminKeyMatches(candidate);
  }

  // ---------------------------------------------------------------- 路由表

  buildRoutes() {
    const A = this.ctx.cfg.basePath + '/';
    return [
      ['GET', A + 'health', (req, res) => this.health(res)],
      ['GET', A + 'stats', (req, res) => this.guard(req, res, () => this.stats(req, res))],
      ['GET', A + 'instances', (req, res) => this.guard(req, res, () => sendJson(res, 200, { items: this.ctx.relay.list() }))],
      ['GET', A + 'instances/:id', (req, res, p) => this.guard(req, res, () => this.instanceDetail(res, p.id))],
      ['POST', A + 'instances/:id/request', (req, res, p) => this.guard(req, res, (body) => this.doRequest(req, res, p.id, body), true)],
      ['POST', A + 'instances/:id/subscribe', (req, res, p) => this.guard(req, res, (body) => this.doSubscribe(req, res, p.id, body), true)],
      ['POST', A + 'instances/:id/unsubscribe', (req, res, p) => this.guard(req, res, (body) => this.doUnsubscribe(req, res, p.id, body), true)],
      ['GET', A + 'instances/:id/events', (req, res, p) => this.guard(req, res, () => this.events(req, res, p.id))],
      ['GET', A + 'instances/:id/sessions', (req, res, p) => this.guard(req, res, () => this.cachedSessions(res, p.id))],
      ['GET', A + 'instances/:id/archives', (req, res, p) => this.guard(req, res, () => this.archivedSessions(res, p.id))],
      ['POST', A + 'instances/:id/sessions/:sid/archive', (req, res, p) => this.guard(req, res, (body) => this.archiveSession(res, p.id, p.sid, body), true)],
      ['DELETE', A + 'instances/:id/sessions/:sid/archive', (req, res, p) => this.guard(req, res, () => this.restoreSession(res, p.id, p.sid))],
      ['GET', A + 'instances/:id/session-events/:sid', (req, res, p) => this.guard(req, res, () => this.cachedSessionEvents(req, res, p.id, p.sid))],
      ['GET', A + 'instances/:id/snapshot/:sid', (req, res, p) => this.guard(req, res, () => this.cachedSnapshot(res, p.id, p.sid))],
      ['POST', A + 'instances/:id/rotate-key', (req, res, p) => this.guard(req, res, (body) => this.rotate(req, res, p.id, body), true)],
      ['GET', A + 'keys', (req, res) => this.guard(req, res, () => sendJson(res, 200, { items: this.ctx.keystore.list() }))],
      ['POST', A + 'keys', (req, res) => this.guard(req, res, (body) => this.registerKey(req, res, body), true)],
      ['PATCH', A + 'keys/:id', (req, res, p) => this.guard(req, res, (body) => this.updateKey(res, p.id, body), true)],
      ['DELETE', A + 'keys/:id', (req, res, p) => this.guard(req, res, () => this.revokeKey(res, p.id))],
      ['GET', A + 'console/logs', (req, res) => this.guard(req, res, () => sendJson(res, 200, { lines: log.tail(300) }))],
      ['GET', A + 'console/stream', (req, res) => this.guard(req, res, () => this.stream(req, res))],
    ];
  }

  match(method, pathname) {
    for (const [m, pattern, handler] of this.router) {
      if (m !== method) continue;
      const params = matchPath(pattern, pathname);
      if (params) return { handler, params };
    }
    return null;
  }

  guard(req, res, fn, needsBody = false) {
    if (!this.isAdmin(req, this.ctx.query)) {
      sendJson(res, 401, { error: { code: 'unauthorized', message: '管理密钥无效（x-admin-key）' } });
      return;
    }
    const run = (body) => {
      try {
        const out = fn(body);
        if (out && typeof out.catch === 'function') {
          out.catch((e) => {
            log.error('[admin] 处理请求异常', e);
            if (!res.writableEnded) sendJson(res, 500, { ok: false, error: { code: 'internal', message: e?.message || String(e) } });
          });
        }
      } catch (e) {
        log.error('[admin] 处理请求异常', e);
        if (!res.writableEnded) sendJson(res, 500, { ok: false, error: { code: 'internal', message: e?.message || String(e) } });
      }
    };
    if (!needsBody) { run(); return; }
    readJson(req)
      .then((body) => run(body))
      .catch((e) => {
        if (!res.writableEnded) sendJson(res, 400, { error: { code: 'bad_request', message: e.message } });
      });
  }

  // ---------------------------------------------------------------- 处理器

  health(res) {
    const { relay, cfg } = this.ctx;
    sendJson(res, 200, {
      ok: true,
      service: 'dsh-api',
      protocol: 1,
      secure: !!this.ctx.secure,
      basePath: cfg.basePath,
      stats: relay.stats(),
    });
  }

  stats(req, res) {
    sendJson(res, 200, { ...this.ctx.relay.stats(), log: log.tail(50) });
  }

  instanceDetail(res, id) {
    const inst = this.ctx.relay.get(id);
    if (!inst) { sendJson(res, 404, { error: { code: 'not_found', message: `未知实例 ${id}` } }); return; }
    const archivedSessions = this.ctx.archives.list(id);
    const archivedIds = new Set(archivedSessions.map((row) => row.sessionId));
    sendJson(res, 200, {
      ...inst.summary(),
      sessions: inst.sessionList().filter((row) => !archivedIds.has(row.sessionId)),
      archivedSessions,
      workspaces: inst.workspaces,
      jobs: inst.jobs,
    });
  }

  async doRequest(req, res, id, body) {
    const { relay } = this.ctx;
    try {
      const { method, params = {}, timeoutMs, requestId } = body || {};
      const result = await relay.call(id, method, params, { timeoutMs, requestId });
      sendJson(res, 200, { ok: true, result });
    } catch (e) {
      const code = e?.code || 'internal';
      sendJson(res, STATUS_BY_CODE[code] || 500, { ok: false, error: { code, message: e?.message || String(e), retryable: !!e?.retryable, details: e?.details } });
    }
  }

  async doSubscribe(req, res, id, body) {
    const { relay } = this.ctx;
    try {
      const inst = relay.must(id);
      const subs = inst.subscribe({
        topics: body?.topics,
        sessions: body?.sessions,
        assistantStream: body?.assistantStream,
        snapshot: body?.snapshot ?? true,
      });
      sendJson(res, 200, { ok: true, subscriptions: subs });
    } catch (e) {
      sendJson(res, STATUS_BY_CODE[e?.code] || 500, { ok: false, error: { code: e?.code || 'internal', message: e.message } });
    }
  }

  async doUnsubscribe(req, res, id, body) {
    const { relay } = this.ctx;
    try {
      const inst = relay.must(id);
      sendJson(res, 200, { ok: true, subscriptions: inst.unsubscribe({ topics: body?.topics, sessions: body?.sessions }) });
    } catch (e) {
      sendJson(res, STATUS_BY_CODE[e?.code] || 500, { ok: false, error: { code: e?.code || 'internal', message: e.message } });
    }
  }

  events(req, res, id) {
    const inst = this.ctx.relay.get(id);
    if (!inst) { sendJson(res, 404, { error: { code: 'not_found', message: `未知实例 ${id}` } }); return; }
    const since = Number(this.ctx.query.since ?? 0);
    const limit = Math.min(Number(this.ctx.query.limit ?? this.ctx.cfg.consoleBacklogLimit), 2000);
    const items = inst.events.filter((f) => f.seq > since).slice(-limit);
    sendJson(res, 200, { items, lastSeq: inst.lastSeq, dropped: inst.dropped });
  }

  cachedSessions(res, id) {
    const inst = this.ctx.relay.get(id);
    if (!inst) { sendJson(res, 404, { error: { code: 'not_found', message: `未知实例 ${id}` } }); return; }
    const archivedIds = this.ctx.archives.ids(id);
    sendJson(res, 200, {
      items: inst.sessionList().filter((row) => !archivedIds.has(row.sessionId)),
      pausedSessions: [...inst.pausedSessions],
      pendingDecisions: [...inst.pendingDecisions.values()],
      needsResync: inst.needsResync,
    });
  }

  archivedSessions(res, id) {
    const inst = this.ctx.relay.get(id);
    if (!inst) { sendJson(res, 404, { error: { code: 'not_found', message: `未知实例 ${id}` } }); return; }
    sendJson(res, 200, { items: this.ctx.archives.list(id) });
  }

  async archiveSession(res, id, sessionId, body) {
    const inst = this.ctx.relay.get(id);
    if (!inst) { sendJson(res, 404, { error: { code: 'not_found', message: `未知实例 ${id}` } }); return; }
    const scope = body?.scope === 'host' ? 'host' : 'server';
    const session = inst.sessionList().find((row) => row.sessionId === sessionId);
    if (!session && !this.ctx.archives.has(id, sessionId)) {
      sendJson(res, 404, { error: { code: 'session_not_found', message: `未知会话 ${sessionId}` } });
      return;
    }
    try {
      if (scope === 'host') await this.ctx.relay.call(id, 'session.archive', { sessionId });
      const item = this.ctx.archives.archive(id, session || { sessionId }, scope);
      this.broadcast('archives', { instanceId: id, items: this.ctx.archives.list(id) });
      sendJson(res, 200, { ok: true, item });
    } catch (error) {
      const code = error?.code || 'internal';
      sendJson(res, STATUS_BY_CODE[code] || 500, {
        ok: false,
        error: { code, message: error?.message || String(error), retryable: !!error?.retryable, details: error?.details },
      });
    }
  }

  restoreSession(res, id, sessionId) {
    const inst = this.ctx.relay.get(id);
    if (!inst) { sendJson(res, 404, { error: { code: 'not_found', message: `未知实例 ${id}` } }); return; }
    const restored = this.ctx.archives.restore(id, sessionId);
    this.broadcast('archives', { instanceId: id, items: this.ctx.archives.list(id) });
    sendJson(res, 200, { ok: true, restored });
  }

  cachedSessionEvents(req, res, id, sid) {
    const inst = this.ctx.relay.get(id);
    if (!inst) { sendJson(res, 404, { error: { code: 'not_found', message: `未知实例 ${id}` } }); return; }
    const limit = Math.min(Number(this.ctx.query.limit ?? 200), 1000);
    sendJson(res, 200, {
      items: (inst.sessionEvents.get(sid) || []).slice(-limit),
      stream: inst.sessionStreams.get(sid) || null,
      todos: inst.todos.get(sid) || null,
      goal: inst.goals.get(sid) ?? null,
      snapshot: inst.snapshots.get(sid) || null,
      paused: inst.pausedSessions.has(sid),
    });
  }

  cachedSnapshot(res, id, sid) {
    const inst = this.ctx.relay.get(id);
    if (!inst) { sendJson(res, 404, { error: { code: 'not_found', message: `未知实例 ${id}` } }); return; }
    sendJson(res, 200, { snapshot: inst.snapshots.get(sid) || null });
  }

  async rotate(req, res, id, body) {
    try {
      const out = await this.ctx.relay.rotateKey(id, body?.confirm);
      sendJson(res, 200, { ok: true, result: out });
    } catch (e) {
      sendJson(res, STATUS_BY_CODE[e?.code] || 500, { ok: false, error: { code: e?.code || 'internal', message: e.message } });
    }
  }

  registerKey(req, res, body) {
    try {
      const entry = this.ctx.keystore.register(body?.key, { label: body?.label, instanceId: body?.instanceId });
      this.ctx.relay.bus.emit('instances');
      log.info(`[admin] 登记 key ${entry.label}`);
      sendJson(res, 200, { ok: true, item: this.ctx.keystore.list().find((k) => k.id === entry.id) });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: { code: 'invalid_params', message: e.message } });
    }
  }

  /**
   * 编辑一条已登记的 key（改备注名 / 换 key）。
   * 在线实例的内存标签也一并同步，省得等下一次重连才看到新名字。
   */
  updateKey(res, id, body) {
    const { keystore, relay } = this.ctx;
    try {
      const entry = keystore.update(id, body || {});
      if (!entry) {
        sendJson(res, 404, { ok: false, error: { code: 'not_found', message: '没有这条 key' } });
        return;
      }
      if (entry.instanceId) {
        const inst = relay.get(entry.instanceId);
        if (inst) inst.label = entry.label;
      }
      relay.bus.emit('instances');
      log.info(`[admin] 更新 key ${entry.label}（${entry.id}）`);
      sendJson(res, 200, { ok: true, item: keystore.list().find((k) => k.id === id) });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: { code: 'bad_request', message: e.message } });
    }
  }

  revokeKey(res, id) {
    const gone = this.ctx.keystore.revoke(id);
    if (!gone) { sendJson(res, 404, { ok: false, error: { code: 'not_found', message: '没有这条 key' } }); return; }
    this.ctx.relay.bus.emit('instances');
    log.warn(`[admin] 吊销 key ${gone.label}（${gone.id}）`);
    sendJson(res, 200, { ok: true });
  }

  /** 控制台事件流：一个 SSE 连接拿到实例列表变化 + 全部收发帧 */
  stream(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    res.write(`event: ready\ndata: ${JSON.stringify({ serverTime: Date.now(), basePath: this.ctx.cfg.basePath })}\n\n`);
    res.write(`event: instances\ndata: ${JSON.stringify(this.ctx.relay.list())}\n\n`);

    this.sseClients.add(res);
    const ping = setInterval(() => {
      try { res.write(`: ping ${Date.now()}\n\n`); } catch { /* 忽略 */ }
    }, 20000);
    ping.unref?.();

    req.on('close', () => {
      clearInterval(ping);
      this.sseClients.delete(res);
    });
  }
}

/** 极简路径匹配，支持 :param */
function matchPath(pattern, pathname) {
  const p = pattern.split('/');
  const a = pathname.split('/');
  if (p.length !== a.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) {
      params[p[i].slice(1)] = decodeURIComponent(a[i]);
    } else if (p[i] !== a[i]) {
      return null;
    }
  }
  return params;
}
