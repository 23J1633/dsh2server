/* Markdown 渲染 + 代码高亮 + 工具输出块。
 *
 * 上游 dsh 用自研 mdast 管线（ui-primitives/src/markdown/）配 shiki 的
 * css-variables 主题。这里用 marked 做解析、自写一个小分词器产出同样的
 * span.shiki-token-* 结构，颜色仍然走主题包里的 --shiki-* 变量，
 * 所以视觉结果与上游一致，但不背 shiki/oniguruma 的体积。
 */
import { marked } from '../vendor/marked.esm.js';
import { h, clsx, copyText } from './util.js';
import { icon } from './icons.js';

marked.setOptions({ gfm: true, breaks: false });

// ---------------------------------------------------------------- 高亮

const KEYWORDS = {
  js: 'const let var function return if else for while do break continue new class extends super this null undefined true false import export from default async await try catch finally throw typeof instanceof in of delete void yield static get set',
  ts: 'const let var function return if else for while do break continue new class extends implements interface type enum namespace public private protected readonly abstract super this null undefined true false import export from default async await try catch finally throw typeof instanceof in of delete void yield static get set declare as satisfies keyof infer never unknown any string number boolean object',
  py: 'def class return if elif else for while break continue import from as pass raise try except finally with lambda None True False and or not in is global nonlocal yield assert del async await',
  sh: 'if then else elif fi for while do done case esac function return export local readonly source alias unset set trap in',
  json: 'true false null',
  yaml: 'true false null',
  other: '',
};

const LINE_COMMENT = { js: '//', ts: '//', py: '#', sh: '#', json: null, yaml: '#', other: null };

/** 语言别名归一（对应上游 LANG_ALIASES，用 Map 而非对象以免命中原型） */
const LANG_ALIASES = new Map([
  ['js', 'js'], ['jsx', 'js'], ['javascript', 'js'], ['mjs', 'js'], ['cjs', 'js'],
  ['ts', 'ts'], ['tsx', 'ts'], ['typescript', 'ts'],
  ['py', 'py'], ['python', 'py'],
  ['sh', 'sh'], ['bash', 'sh'], ['shell', 'sh'], ['zsh', 'sh'], ['console', 'sh'],
  ['json', 'json'], ['jsonc', 'json'],
  ['yaml', 'yaml'], ['yml', 'yaml'],
]);

/**
 * 归一语言标识。
 * @param {string|undefined} raw fence 的 info string（模型可控，必须走 Map 查找）
 * @returns {string}
 */
export function normalizeLang(raw) {
  const key = String(raw || '').trim().toLowerCase().split(/\s+/)[0];
  return LANG_ALIASES.get(key) || 'other';
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ESC[c]);

/**
 * 把一个代码片段切成 token。正则按优先级一次扫描，未命中的部分保持纯文本。
 * @param {string} code
 * @param {string} lang 归一后的语言
 * @returns {string} 带 span 的 HTML
 */
export function highlight(code, lang) {
  const kw = KEYWORDS[lang] ?? '';
  const lc = LINE_COMMENT[lang];
  const parts = [];

  const comment = lc === '#' ? String.raw`#[^\n]*` : lc === '//' ? String.raw`\/\/[^\n]*|\/\*[\s\S]*?\*\/` : null;
  const pattern = [
    comment ? `(?<comment>${comment})` : null,
    String.raw`(?<string>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\`(?:\\.|[^\`\\])*\`)`,
    String.raw`(?<number>\b(?:0[xX][\da-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b)`,
    kw ? `(?<keyword>\\b(?:${kw.split(' ').join('|')})\\b)` : null,
    String.raw`(?<fn>[A-Za-z_$][\w$]*(?=\s*\())`,
    String.raw`(?<punct>[{}()[\];,.:+\-*/%=<>!&|^~?]+)`,
  ].filter(Boolean).join('|');

  const re = new RegExp(pattern, 'g');
  let last = 0;
  let m;
  while ((m = re.exec(code)) !== null) {
    if (m.index > last) parts.push(escapeHtml(code.slice(last, m.index)));
    const g = m.groups;
    const cls = g.comment ? 'comment' : g.string ? 'string' : g.number ? 'constant' : g.keyword ? 'keyword' : g.fn ? 'function' : 'punctuation';
    parts.push(`<span class="shiki-token-${cls}">${escapeHtml(m[0])}</span>`);
    last = re.lastIndex;
    if (m[0] === '') re.lastIndex += 1; // 空匹配保护
  }
  if (last < code.length) parts.push(escapeHtml(code.slice(last)));
  return parts.join('');
}

// ---------------------------------------------------------------- 代码块

/**
 * 代码块：顶部 banner（语言 + 复制）+ 内容。对应上游的 CodeBlock。
 * @param {string} code
 * @param {string} [lang]
 * @param {{maxLines?: number}} [opts]
 * @returns {HTMLElement}
 */
export function codeBlock(code, lang, opts = {}) {
  const norm = normalizeLang(lang);
  const label = (lang || '').trim().split(/\s+/)[0] || '';
  const body = h('div', { class: 'codeContent' });
  body.innerHTML = `<pre class="shiki"><code>${highlight(code, norm)}</code></pre>`;

  const copyBtn = h('button', { type: 'button', class: 'codeCopy', text: '复制' });
  copyBtn.addEventListener('click', async () => {
    // 与上游一致：复制 pre 的 textContent，行号不进剪贴板
    const ok = await copyText(body.querySelector('pre')?.textContent ?? code);
    copyBtn.textContent = ok ? '已复制' : '复制失败';
    setTimeout(() => { copyBtn.textContent = '复制'; }, 1000);
  });

  const el = h('div', { class: clsx('codeBlock', opts.maxLines ? 'clamped' : null) },
    h('div', { class: 'codeBanner' },
      h('div', { class: 'codeLang', text: label }),
      h('div', { class: 'codeActions' }, copyBtn)),
    body);
  if (opts.maxLines) body.style.maxHeight = `${opts.maxLines * 19}px`;
  return el;
}

/**
 * 终端输出块（工具结果）。
 * @param {string} text
 * @param {{maxLines?: number}} [opts]
 */
export function terminalBlock(text, opts = {}) {
  const el = h('div', { class: 'terminalBlock' });
  const pre = h('pre', { class: 'terminalPre' });
  pre.textContent = text ?? '';
  el.append(pre);
  if (opts.maxLines) el.style.maxHeight = `${opts.maxLines * 22}px`;
  return el;
}

/**
 * 差异块：识别 +/- 行并按行着色。
 * @param {string} text
 * @param {{maxLines?: number}} [opts]
 */
export function diffBlock(text, opts = {}) {
  const el = h('div', { class: 'diffBlock' });
  for (const raw of String(text ?? '').split('\n')) {
    const kind = raw.startsWith('+++') || raw.startsWith('---') ? 'meta'
      : raw.startsWith('@@') ? 'hunk'
        : raw.startsWith('+') ? 'add'
          : raw.startsWith('-') ? 'del'
            : 'ctx';
    el.append(h('div', { class: `diffLine ${kind}`, text: raw || ' ' }));
  }
  if (opts.maxLines) el.style.maxHeight = `${opts.maxLines * 20}px`;
  return el;
}

// ---------------------------------------------------------------- Markdown

/**
 * 把 marked 的产物加工成 dsh 的样式：外链加图标、代码块换成组件。
 * @param {HTMLElement} root
 */
function postProcess(root) {
  for (const a of root.querySelectorAll('a[href]')) {
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    if (!a.querySelector('svg')) a.prepend(icon('LinkOutline16', { size: 12 }));
  }
  for (const pre of [...root.querySelectorAll('pre')]) {
    const codeEl = pre.querySelector('code');
    const raw = codeEl ? codeEl.textContent : pre.textContent;
    const cls = codeEl?.className || '';
    const m = /language-([\w+-]+)/.exec(cls);
    pre.replaceWith(codeBlock(raw.replace(/\n$/, ''), m ? m[1] : ''));
  }
  for (const img of root.querySelectorAll('img')) {
    img.loading = 'lazy';
    img.className = 'mdImage';
  }
  for (const table of root.querySelectorAll('table')) {
    const wrap = h('div', { class: 'mdTableWrap' });
    table.replaceWith(wrap);
    wrap.append(table);
  }
}

/**
 * 把 markdown 文本渲染成片段。
 * @param {string} text
 * @returns {DocumentFragment}
 */
export function markdownFragment(text) {
  const frag = document.createDocumentFragment();
  const holder = h('div');
  holder.innerHTML = marked.parse(String(text ?? ''));
  postProcess(holder);
  frag.append(...holder.childNodes);
  return frag;
}

/**
 * 流式 markdown 渲染器：冻结已定型的头部，每个 chunk 只重解析尾部，
 * 成本与尾部大小成正比而不是整篇（对应上游 StreamingRenderer）。
 */
export class StreamingMarkdown {
  /** @param {HTMLElement} host */
  constructor(host) {
    this.host = host;
    this.head = '';
    // 必须一开始就是空片段：head 与上次相同时不会重建，留着 null 会在首次更新时炸掉
    this.headNodes = document.createDocumentFragment();
    this.tail = null;
    this.text = '';
  }

  /** @param {string} text 到目前为止的完整文本 */
  update(text) {
    if (text === this.text) return;
    this.text = text;

    const head = freezePoint(text);
    if (head !== this.head) {
      this.head = head;
      this.headNodes = head ? markdownFragment(head) : document.createDocumentFragment();
    }

    this.host.textContent = '';
    this.host.append(this.headNodes.cloneNode(true));
    if (!this.tail) this.tail = h('div', { class: 'mdTail' });
    this.tail.textContent = '';
    this.tail.append(markdownFragment(text.slice(head.length)));
    this.host.append(this.tail);
  }

  /** 流式结束后做一次全量解析，修正被冻结边界切断的结构 */
  settle() {
    this.host.textContent = '';
    this.host.append(markdownFragment(this.text));
    this.head = this.text;
    this.headNodes = document.createDocumentFragment();
    this.tail = null;
  }
}

/**
 * 找一个可以安全冻结的切点：最后一个不在代码围栏里的空行，且离结尾足够远。
 * 与上游一样接受轻微的边界误差，settle 时的全量解析会自愈。
 */
function freezePoint(text) {
  const limit = text.length - 600;
  if (limit <= 0) return '';
  let fences = 0;
  let best = -1;
  const re = /```|\n\n/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > limit) break;
    if (m[0] === '```') fences += 1;
    else if (fences % 2 === 0) best = m.index + 2;
  }
  return best > 0 ? text.slice(0, best) : '';
}
