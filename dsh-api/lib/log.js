// 极简日志：带时间戳与级别，可同时落文件。
// 约定：任何地方都不打印完整 key，只打印指纹（见 keystore.fingerprint）。
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel = LEVELS[process.env.DSH_RELAY_LOG_LEVEL] ?? LEVELS.info;
let stream = null;
const ring = [];
const RING_MAX = 500;

export function initLog({ level, file }) {
  if (level && LEVELS[level] != null) minLevel = LEVELS[level];
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    stream = fs.createWriteStream(file, { flags: 'a' });
  }
}

function write(level, args) {
  if (LEVELS[level] < minLevel) return;
  const ts = new Date().toISOString();
  const line = `${ts} ${level.toUpperCase().padEnd(5)} ${args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack || a.message : safeJson(a)))
    .join(' ')}`;
  ring.push(line);
  if (ring.length > RING_MAX) ring.shift();
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
  if (stream) stream.write(line + '\n');
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

export const log = {
  debug: (...a) => write('debug', a),
  info: (...a) => write('info', a),
  warn: (...a) => write('warn', a),
  error: (...a) => write('error', a),
  tail: (n = 200) => ring.slice(-n),
};
