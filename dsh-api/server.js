// dsh2server 中转服务器 · 入口
//
//   插件 → 本服务器： {basePath}/ws（WebSocket，首选）
//                     {basePath}/events + {basePath}/inbox（HTTP 长轮询回退）
//   运维 → 本服务器： {basePath}/instances、/keys 等管理接口 + / 图形化测试台
//
// 会话正文仍只做中转；服务器仅持久化 key 白名单和控制台归档索引。
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { loadConfig, ROOT } from './lib/config.js';
import { initLog, log } from './lib/log.js';
import { KeyStore, fingerprint } from './lib/keystore.js';
import { ArchiveStore } from './lib/archive-store.js';
import { Relay } from './lib/relay.js';
import { WsLink } from './lib/link.js';
import { AdminApi } from './lib/admin.js';
import { handleEvents, handleInbox, fatalErrorFrame } from './lib/carriers.js';

const cfg = loadConfig();
fs.mkdirSync(cfg.dataDir, { recursive: true });
initLog({ level: process.env.DSH_RELAY_LOG_LEVEL || 'info', file: path.join(cfg.dataDir, 'relay.log') });

const keystore = new KeyStore(cfg.dataDir);
const archives = new ArchiveStore(cfg.dataDir);
const relay = new Relay(cfg, keystore);

// ---------------------------------------------------------------- TLS

function loadTls() {
  const { cert, key } = cfg.tls || {};
  if (!cert || !key) return null;
  try {
    return { cert: fs.readFileSync(cert), key: fs.readFileSync(key), mtime: statMtime(cert) + statMtime(key) };
  } catch (err) {
    log.warn(`[tls] 证书读取失败（${err.message}），将以明文 HTTP 启动`);
    return null;
  }
}

function statMtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

let tls = loadTls();

// ---------------------------------------------------------------- 静态资源（测试台）

const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.join(PUBLIC_DIR, rel);
  // 目录穿越防护
  if (!target.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403).end('forbidden'); return; }
  const ext = path.extname(target).toLowerCase();
  if (!MIME[ext]) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found'); return; }
  fs.readFile(target, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[ext], 'cache-control': 'no-cache' });
    res.end(buf);
  });
}

// ---------------------------------------------------------------- 请求处理

const admin = new AdminApi({ relay, keystore, archives, cfg, secure: !!tls, query: {} });
admin.start();

function parseQuery(url) {
  const out = {};
  for (const [k, v] of new URL(url, 'http://localhost').searchParams) out[k] = v;
  return out;
}

function requestContext(req, tlsEnabled) {
  const proto = tlsEnabled ? 'https' : 'http';
  const host = req.headers.host || `${cfg.host}:${cfg.port}`;
  return { proto, host, baseUrl: `${proto}://${host}${cfg.basePath}` };
}

function handleRequest(req, res) {
  const tlsEnabled = req.socket.encrypted === true;
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const query = parseQuery(req.url);
  const ctx = { relay, keystore, cfg, query, secure: tlsEnabled, insecure: !tlsEnabled, ...requestContext(req, tlsEnabled) };

  if (pathname === cfg.basePath + '/events' && req.method === 'POST') {
    handleEvents(req, res, ctx);
    return;
  }
  if (pathname === cfg.basePath + '/inbox' && (req.method === 'GET' || req.method === 'POST')) {
    handleInbox(req, res, ctx);
    return;
  }

  admin.ctx.query = query;
  admin.ctx.secure = tlsEnabled;
  const route = admin.match(req.method, pathname);
  if (route) {
    route.handler(req, res, route.params);
    return;
  }

  if (pathname.startsWith(cfg.basePath + '/')) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: `没有这个接口：${pathname}` } }));
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, url.pathname);
    return;
  }
  res.writeHead(405).end('method not allowed');
}

// ---------------------------------------------------------------- 服务启动

const server = tls ? https.createServer({ cert: tls.cert, key: tls.key }, handleRequest) : http.createServer(handleRequest);

// 证书热重载：1Panel 续期后不必重启进程
if (tls && cfg.tls.watchMs > 0) {
  const timer = setInterval(() => {
    const mark = statMtime(cfg.tls.cert) + statMtime(cfg.tls.key);
    if (!mark || mark === tls.mtime) return;
    const fresh = loadTls();
    if (!fresh) return;
    try {
      server.setSecureContext({ cert: fresh.cert, key: fresh.key });
      tls = fresh;
      log.info('[tls] 证书已热重载');
    } catch (err) {
      log.warn(`[tls] 热重载失败：${err.message}`);
    }
  }, cfg.tls.watchMs);
  timer.unref?.();
}

// ---------------------------------------------------------------- WebSocket 载体

const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname !== cfg.basePath + '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  // authMode=header / query 时可以在升级前就把不合法的 key 挡掉（规范 §2.3）
  const auth = req.headers.authorization;
  const queryKey = new URL(req.url, 'http://localhost').searchParams.get('key');
  const preKey = (typeof auth === 'string' && /^Bearer\s+/i.test(auth))
    ? auth.replace(/^Bearer\s+/i, '').trim()
    : queryKey;
  let preEntry = null;
  if (preKey) {
    preEntry = relay.authorizeKey(preKey);
    if (!preEntry) {
      log.warn(`[ws] 升级被拒（key 无效），来自 ${req.socket.remoteAddress}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const ctx = requestContext(req, req.socket.encrypted === true);
    const link = new WsLink({
      instanceId: url.searchParams.get('instanceId') || null,
      endpoint: ctx.baseUrl,
      insecure: !(req.socket.encrypted === true),
      socket: ws,
    });
    link.pendingKey = preKey;
    link.attempts = 1;
    log.info(`[ws] 升级成功，等待 hello（来自 ${req.socket.remoteAddress}，v=${url.searchParams.get('v')}）`);

    // 握手后迟迟不发 hello 的（半开连接）直接断开
    const helloTimer = setTimeout(() => {
      if (!relay.get(link.instanceId)) {
        link.send(fatalErrorFrame('timeout', 'hello 超时'));
        link.close(4408, 'hello timeout');
      }
    }, cfg.helloTimeoutMs);
    helloTimer.unref?.();

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return; // 规范 §4.2：不使用二进制帧
      let frame;
      try {
        frame = JSON.parse(raw.toString('utf8'));
      } catch {
        link.send({ v: 1, type: 'error', code: 'bad_frame', message: '不是合法 JSON', fatal: false });
        return;
      }
      const verdict = relay.handleInbound(link, frame);
      if (verdict?.fatal) {
        clearTimeout(helloTimer);
        link.send(fatalErrorFrame(verdict.code || 'unauthorized', verdict.message || 'unauthorized'));
        link.close(4401, verdict.code || 'unauthorized');
      }
      if (frame.type === 'hello' && verdict?.ok) clearTimeout(helloTimer);
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      const inst = relay.get(link.instanceId);
      if (inst) {
        inst.removeLink(link, 'socket closed');
        relay.bus.emit('instances');
      }
    });

    ws.on('error', (err) => log.warn(`[ws] 连接错误 ${link.instanceId || '未握手'}: ${err.message}`));

    // 服务器侧主动 ping，配合插件的 90s 无帧判定，双保险
    const ping = setInterval(() => {
      if (ws.readyState === ws.OPEN) { try { ws.ping(); } catch { /* 忽略 */ } }
    }, Math.max(15000, cfg.heartbeatMs));
    ping.unref?.();
    ws.on('close', () => clearInterval(ping));
  });
});

// ---------------------------------------------------------------- 启动

server.listen(cfg.port, cfg.host, () => {
  const scheme = tls ? 'wss' : 'ws';
  const adminKey = keystore.adminKey();
  log.info('─'.repeat(64));
  log.info(`dsh-api 已启动  ${tls ? 'https' : 'http'}://${cfg.host}:${cfg.port}${cfg.basePath}`);
  log.info(`  插件端点   ${tls ? 'https' : 'http'}://<域名>:${cfg.port}${cfg.basePath}`);
  log.info(`  WebSocket  ${scheme}://<域名>:${cfg.port}${cfg.basePath}/ws`);
  log.info(`  测试台     ${tls ? 'https' : 'http'}://<域名>:${cfg.port}/`);
  log.info(`  数据目录   ${cfg.dataDir}`);
  log.info(`  已登记 key ${keystore.entries.length} 把`);
  log.info(`  管理密钥   ${adminKey.slice(0, 14)}…${adminKey.slice(-4)}（完整值见 ${keystore.adminFile}）`);
  log.info('─'.repeat(64));
  if (!tls) log.warn('未启用 TLS：key 与全部会话内容都是明文传输（规范 §13.1）');
});

function shutdown(signal) {
  log.info(`收到 ${signal}，正在关闭…`);
  relay.close();
  for (const res of admin.sseClients) { try { res.end(); } catch { /* 忽略 */ } }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { relay, keystore, cfg, fingerprint };
