// 配置加载：默认值 → 数据目录 config.json → 环境变量覆盖。
// 数据目录刻意放在**网站根目录之外**（默认 ~/.dsh-relay），
// 因为 index/ 整个目录都会被 nginx 公网静态服务，放里面等于把 key 白名单公开出去。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  host: '0.0.0.0',
  port: 50443,
  basePath: '/dsh-api',

  // TLS：留空则用明文 HTTP 启动（协议支持，但面向公网时 key 与全部会话内容都是明文）
  tls: {
    cert: '/opt/1panel/www/sites/Main/ssl/fullchain.pem',
    key: '/opt/1panel/www/sites/Main/ssl/privkey.pem',
    // 证书文件变化后自动热重载的轮询间隔（0 = 关闭）
    watchMs: 600000,
  },

  dataDir: path.join(os.homedir(), '.dsh-relay'),

  // 每实例保留的事件条数，用于断线补发
  eventBufferSize: 2000,
  // 单帧负载上限，超出则按 §6.1 打 truncated 标记
  maxPayloadBytes: 1048576,
  // 下发给插件的期望心跳间隔（插件会钳制在 5s~600s）
  heartbeatMs: 30000,
  // 超过这个时间没有任何入站帧就认为实例离线
  offlineAfterMs: 90000,
  // 收到 hello 后多久没等到认证就断开（防止半开连接堆积）
  helloTimeoutMs: 20000,

  requestTimeoutMs: 120000,
  // 个别方法天生慢，单独放宽
  methodTimeoutMs: {
    'session.prompt': 300000,
    'command.run': 300000,
    'session.create': 180000,
    'session.fork': 180000,
    'session.history': 180000,
  },

  // hello.ack 之后服务器主动订阅的 topic（协议建议至少 instance + sessions）
  // sessions 的语义与插件侧 autoSubscribeSessions 一致：none | running | all，或会话 id 数组。
  // 默认 running —— 正在干活的会话会把逐条事件与流式输出自动推上来，控制台开箱即见实时状态。
  autoSubscribe: {
    topics: ['instance', 'sessions', 'jobs', 'approvals', 'goals'],
    sessions: 'running',
    assistantStream: true,
  },

  // 控制台单次拉取的事件上限
  consoleBacklogLimit: 500,
};

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function configPath() {
  if (process.env.DSH_RELAY_CONFIG) return process.env.DSH_RELAY_CONFIG;
  // 注意：这里必须先看 DSH_RELAY_DATA_DIR，否则测试/多实例场景会读到用户主目录里的配置
  const dir = process.env.DSH_RELAY_DATA_DIR || DEFAULTS.dataDir;
  return path.join(dir, 'config.json');
}

export function loadConfig() {
  let cfg = { ...DEFAULTS };
  const file = configPath();
  if (fs.existsSync(file)) {
    try {
      cfg = deepMerge(cfg, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (err) {
      console.error(`[config] ${file} 解析失败，改用默认配置：${err.message}`);
    }
  } else {
    // 首次运行落一份可编辑的配置，方便运维直接改
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2) + '\n', { mode: 0o644 });
    } catch { /* 写不了就算了，不影响启动 */ }
  }

  // 环境变量只覆盖最常用的几个
  if (process.env.DSH_RELAY_PORT) cfg.port = Number(process.env.DSH_RELAY_PORT);
  if (process.env.DSH_RELAY_HOST) cfg.host = process.env.DSH_RELAY_HOST;
  if (process.env.DSH_RELAY_DATA_DIR) cfg.dataDir = process.env.DSH_RELAY_DATA_DIR;
  if (process.env.DSH_RELAY_NO_TLS === '1') cfg.tls = { ...cfg.tls, cert: '', key: '' };

  cfg.basePath = '/' + String(cfg.basePath || '').replace(/^\/+|\/+$/g, '');
  if (cfg.basePath === '/') cfg.basePath = '';
  return cfg;
}
