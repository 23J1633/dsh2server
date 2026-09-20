/* dsh-api 客户端：管理 REST + 控制台 SSE。
 *
 * 所有对机器的操作都走 POST {base}/instances/:id/request {method, params}，
 * 实时数据走 GET {base}/console/stream（用 fetch 流读取，以便带上 x-admin-key 头）。
 */

/** 基地址：页面挂在同一个服务上，所以直接取当前路径 */
export const BASE = location.pathname.replace(/\/+$/, '').replace(/\/index\.html$/, '') + '/dsh-api';

const KEY_STORE = 'dshAdminKey';

export const adminKey = {
  get: () => localStorage.getItem(KEY_STORE) || '',
  set(v) { if (v) localStorage.setItem(KEY_STORE, v); else localStorage.removeItem(KEY_STORE); },
};

export class ApiError extends Error {
  constructor(message, code = 'internal', retryable = false, details) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'x-admin-key': adminKey.get(),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (res.status === 401) throw new ApiError('管理密钥无效', 'unauthorized');
  if (!res.ok) {
    const e = data?.error || {};
    throw new ApiError(e.message || `HTTP ${res.status}`, e.code || 'internal', !!e.retryable, e.details);
  }
  return data;
}

export const api = {
  health: () => request('/health'),
  instances: () => request('/instances').then((r) => r.items || []),
  instance: (id) => request(`/instances/${encodeURIComponent(id)}`),
  keys: () => request('/keys').then((r) => r.items || []),
  registerKey: (key, label) => request('/keys', { method: 'POST', body: { key, label } }),
  /**
   * 编辑一条已登记的 key。
   * @param {string} id 条目 id
   * @param {{label?: string, key?: string, instanceId?: string|null}} patch 只传要改的字段
   */
  updateKey: (id, patch) => request(`/keys/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
  revokeKey: (id) => request(`/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  archiveSession: (id, sid, scope = 'server') =>
    request(`/instances/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sid)}/archive`, {
      method: 'POST', body: { scope },
    }),
  restoreSession: (id, sid) =>
    request(`/instances/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sid)}/archive`, { method: 'DELETE' }),
  rotateKey: (id) => request(`/instances/${encodeURIComponent(id)}/rotate-key`, { method: 'POST', body: { confirm: id } }),
  logs: () => request('/console/logs').then((r) => r.lines || []),

  events: (id, since = 0, limit = 500) =>
    request(`/instances/${encodeURIComponent(id)}/events?since=${since}&limit=${limit}`),

  sessionEvents: (id, sid, limit = 300) =>
    request(`/instances/${encodeURIComponent(id)}/session-events/${encodeURIComponent(sid)}?limit=${limit}`),

  subscribe: (id, payload) =>
    request(`/instances/${encodeURIComponent(id)}/subscribe`, { method: 'POST', body: payload }),

  unsubscribe: (id, payload) =>
    request(`/instances/${encodeURIComponent(id)}/unsubscribe`, { method: 'POST', body: payload }),

  /**
   * 向机器下发一次请求（对应协议里的 request/response）。
   * @param {string} id instanceId
   * @param {string} method 方法名，例如 session.prompt
   * @param {object} [params]
   * @param {{timeoutMs?: number}} [opts]
   * @returns {Promise<any>} 插件的 result
   * @throws {ApiError} 插件返回的 error（code 是稳定枚举）
   */
  async call(id, method, params = {}, opts = {}) {
    const out = await request(`/instances/${encodeURIComponent(id)}/request`, {
      method: 'POST',
      body: { method, params, timeoutMs: opts.timeoutMs },
    });
    if (out && out.ok === false) {
      const e = out.error || {};
      throw new ApiError(e.message || `${method} 失败`, e.code || 'internal', !!e.retryable, e.details);
    }
    return out ? out.result : null;
  },
};

/**
 * 打开控制台事件流（SSE）。
 * @param {{onReady?: Function, onInstances?: Function, onFrame?: Function, onLink?: Function,
 *          onState?: (connected: boolean, detail?: string) => void}} handlers
 * @returns {{close: () => void}}
 */
export function openStream(handlers = {}) {
  const ctl = new AbortController();
  let retry = 0;
  let stopped = false;

  const run = async () => {
    try {
      const res = await fetch(`${BASE}/console/stream`, {
        headers: { 'x-admin-key': adminKey.get() },
        signal: ctl.signal,
      });
      if (res.status === 401) { handlers.onState?.(false, '管理密钥无效'); return; }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      handlers.onState?.(true);
      retry = 0;

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          dispatchChunk(buf.slice(0, i), handlers);
          buf = buf.slice(i + 2);
        }
      }
      throw new Error('连接已断开');
    } catch (err) {
      if (stopped || ctl.signal.aborted) return;
      handlers.onState?.(false, err.message);
      retry = Math.min(retry + 1, 6);
      setTimeout(run, Math.min(1000 * 2 ** (retry - 1), 15000));
    }
  };

  run();
  return { close() { stopped = true; ctl.abort(); } };
}

function dispatchChunk(chunk, handlers) {
  let event = 'message';
  const data = [];
  for (const line of chunk.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  if (!data.length) return;
  let payload;
  try { payload = JSON.parse(data.join('\n')); } catch { return; }

  if (event === 'ready') handlers.onReady?.(payload);
  else if (event === 'instances') handlers.onInstances?.(payload || []);
  else if (event === 'frame') handlers.onFrame?.(payload);
  else if (event === 'link') handlers.onLink?.(payload);
  else if (event === 'archives') handlers.onArchives?.(payload);
}
