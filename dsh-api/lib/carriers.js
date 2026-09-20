// HTTP 长轮询载体（规范 §5）。与 WebSocket 完全相同的帧，只是换了承载方式。
import { log } from './log.js';
import { HttpLink } from './link.js';

const MAX_BODY = 8 * 1024 * 1024;

export function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload_too_large'), { code: 'payload_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function readJson(req, limit = MAX_BODY) {
  const raw = await readBody(req, limit);
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function unauthorized(res, message = 'unknown instance key') {
  sendJson(res, 401, { error: { code: 'unauthorized', message, fatal: true } });
}

/** 按 instanceId 找一条还活着的 HTTP 链路；没有就新建一条 */
function pickHttpLink(relay, instanceId, endpoint, insecure) {
  const inst = relay.get(instanceId);
  const existing = inst && [...inst.links.values()].find((l) => l.transport === 'http' && l.state !== 'disposed');
  if (existing) return existing;
  return new HttpLink({ instanceId, endpoint, insecure });
}

/** POST {basePath}/events —— 插件上行 */
export async function handleEvents(req, res, ctx) {
  const { relay, cfg } = ctx;
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    sendJson(res, e.code === 'payload_too_large' ? 413 : 400, { error: { code: e.code || 'bad_frame', message: e.message } });
    return;
  }

  const key = relay.extractKey({ headers: req.headers, query: ctx.query, body });
  const entry = relay.authorizeKey(key);
  if (!entry) {
    log.warn(`[http] /events 认证失败，来自 ${req.socket.remoteAddress}`);
    unauthorized(res, key ? 'unknown instance key' : 'missing instance key');
    return;
  }

  const frames = Array.isArray(body?.frames) ? body.frames : [];
  const hello = frames.find((f) => f?.type === 'hello');
  const instanceId = hello?.instanceId || body?.instanceId || req.headers['x-dsh-instance-id'] || entry.instanceId;
  if (!instanceId) {
    sendJson(res, 400, { error: { code: 'bad_request', message: '缺少 instanceId（且批次内没有 hello）' } });
    return;
  }

  const link = pickHttpLink(relay, instanceId, ctx.baseUrl, ctx.insecure);
  link.pendingKey = key;

  for (const frame of frames) {
    const verdict = relay.handleInbound(link, frame);
    if (verdict && verdict.fatal) {
      unauthorized(res, verdict.message || 'unauthorized');
      return;
    }
  }

  const inst = relay.get(instanceId);
  if (inst) {
    if (Number.isFinite(body?.lastServerCursor)) link.serverAckSeq = Math.max(link.serverAckSeq, body.lastServerCursor);
    if (body?.closing) {
      inst.removeLink(link, 'plugin closing');
      inst.online = false;
      inst.disconnectedAt = Date.now();
      inst.lastDisconnectReason = 'plugin closing';
      relay.bus.emit('instances');
    }
  }

  sendJson(res, 200, { accepted: inst ? inst.lastSeq : 0 });
}

/** GET {basePath}/inbox —— 插件下行（长轮询挂起） */
export async function handleInbox(req, res, ctx) {
  const { relay, cfg } = ctx;
  const query = ctx.query;
  const key = relay.extractKey({ headers: req.headers, query });
  const entry = relay.authorizeKey(key);
  if (!entry) {
    unauthorized(res, key ? 'unknown instance key' : 'missing instance key');
    return;
  }
  const instanceId = query.instanceId || req.headers['x-dsh-instance-id'] || entry.instanceId;
  if (!instanceId) {
    sendJson(res, 400, { error: { code: 'bad_request', message: '缺少 instanceId' } });
    return;
  }

  const inst = relay.get(instanceId);
  if (!inst) {
    // 还没握过手：存活但无数据，插件据此继续轮询等 hello.ack
    sendJson(res, 200, { frames: [], cursor: 0, waitMs: 5000 });
    return;
  }
  if (inst.keyId && inst.keyId !== entry.id) {
    sendJson(res, 403, { error: { code: 'forbidden', message: '该 key 不属于这个实例' } });
    return;
  }

  const link = pickHttpLink(relay, instanceId, ctx.baseUrl, ctx.insecure);
  link.noteInbound();
  inst.markSeen();
  if (Number.isFinite(Number(query.cursor))) link.serverAckSeq = Math.max(link.serverAckSeq, Number(query.cursor));

  const waitMs = Math.min(Math.max(Number(query.waitMs) || 25000, 0), 60000);
  let frames = [];

  const hasPending = link.queue.length > 0;
  if (!hasPending && waitMs > 0) {
    // 挂起期间连接断开也要及时收摊，否则 waiters 会泄漏
    frames = await new Promise((resolve) => {
      let settled = false;
      const onClose = () => {
        if (settled) return;
        settled = true;
        resolve([]);
      };
      req.on('close', onClose);
      link.wait(waitMs).then((f) => {
        if (settled) return;
        settled = true;
        req.off('close', onClose);
        resolve(f);
      });
    });
  } else {
    frames = link.queue.splice(0, link.queue.length);
  }

  if (res.writableEnded) return;
  sendJson(res, 200, { frames, cursor: inst.serverSeq, waitMs: 25000 });
}

/** 认证失败时给 WebSocket 发的致命错误帧（规范 §2.3：随后用 4401 关闭） */
export function fatalErrorFrame(code, message) {
  return { v: 1, type: 'error', code, message, fatal: true };
}
