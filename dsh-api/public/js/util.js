/* 通用工具：DOM 构建、样式拼接、时间与体积格式化、轻提示。 */
import { icon } from './icons.js';

/**
 * 构建 DOM 元素。
 * @param {string} tag 标签名
 * @param {object|null} props 属性；`class` 走 className，`on*` 走事件，`style` 接受对象或字符串
 * @param {...(Node|string|number|null|false|Array)} kids 子节点，数组会自动展开，null/false 跳过
 * @returns {HTMLElement}
 */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style') { if (typeof v === 'string') el.style.cssText = v; else Object.assign(el.style, v); }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, kids);
  return el;
}

/** 把（可能嵌套的）子节点挂到父节点上 */
export function append(parent, kids) {
  for (const kid of kids.flat(6)) {
    if (kid == null || kid === false || kid === '') continue;
    parent.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return parent;
}

/** 条件类名拼接（对应上游的 clsx 用法） */
export function clsx(...parts) {
  return parts.flat(4).filter((p) => typeof p === 'string' && p !== '').join(' ');
}

/** SVG 字符串转元素 */
export function svgFrom(markup) {
  const box = document.createElement('div');
  box.innerHTML = markup.trim();
  return box.firstElementChild;
}

const REL = [
  [60_000, 1000, (n) => `${n} 秒前`],
  [3_600_000, 60_000, (n) => `${n} 分钟前`],
  [86_400_000, 3_600_000, (n) => `${n} 小时前`],
  [604_800_000, 86_400_000, (n) => `${n} 天前`],
];

/**
 * 相对时间，风格与 dsh 会话行一致（刚发生的不显示秒数）。
 * @param {number} ms epoch 毫秒
 * @returns {string}
 */
export function timeAgo(ms) {
  if (!ms) return '';
  const d = Date.now() - ms;
  if (d < 0) return '刚刚';
  for (const [limit, div, fmt] of REL) {
    if (d < limit) return fmt(Math.max(1, Math.floor(d / div)));
  }
  return new Date(ms).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

/** 完整时刻，hover 提示用 */
export const fullTime = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '');

/** 运行时长，例如 "1分23秒" */
export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/** 字节数 */
export function bytes(n) {
  if (!Number.isFinite(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

/** 目录路径取末段，用作工作区标题 */
export function baseName(p) {
  if (!p) return '';
  const s = String(p).replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) || s : s;
}

/**
 * 把 home 前缀缩写成 ~（上游 abbreviateHomePath 的等价做法）。
 * @param {string} path 完整路径
 * @param {string} home 宿主 home 目录
 */
export function abbreviate(path, home) {
  if (!path || !home) return path || '';
  if (path === home) return '~';
  if (path.startsWith(home + '/') || path.startsWith(home + '\\')) return '~' + path.slice(home.length);
  return path;
}

/** 内容截断到 n 个字符 */
export function truncate(text, n) {
  const s = String(text ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 复制到剪贴板，失败时回退到 execCommand */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/** 安全 JSON 字符串化 */
export function json(value, indent = 2, max = 6000) {
  let s;
  try { s = JSON.stringify(value, null, indent); } catch { s = String(value); }
  return s && s.length > max ? `${s.slice(0, max)}\n…（已截断）` : s;
}

let toastHost = null;

/**
 * 顶部居中的轻提示，样式取自 dsh 的 Toast。
 * @param {'info'|'error'} kind
 * @param {string} text
 * @param {number} [holdMs]
 */
export function toast(kind, text, holdMs = 3200) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toastLayer' });
    document.body.append(toastHost);
  }
  const el = h('div', { class: clsx('toast', kind), role: 'status' },
    kind === 'error' ? icon('WarningOutline16', 16) : null,
    h('span', { text }));
  toastHost.append(el);
  setTimeout(() => el.remove(), holdMs);
  return el;
}
