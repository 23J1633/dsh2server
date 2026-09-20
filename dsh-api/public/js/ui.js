/* 共享小组件：菜单、模态框、按钮。几何与交互对齐上游的 ui-primitives。 */
import { h, clsx, append } from './util.js';
import { icon } from './icons.js';

let openMenuEl = null;

/** 关掉当前打开的菜单 */
export function closeMenu() {
  if (openMenuEl) {
    openMenuEl.remove();
    openMenuEl = null;
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
    window.removeEventListener('resize', closeMenu);
    document.removeEventListener('scroll', closeMenu, true);
  }
}

function onDocPointerDown(e) {
  if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu();
}
function onDocKeyDown(e) {
  if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); }
  if (!openMenuEl || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const items = [...openMenuEl.querySelectorAll('button:not(:disabled)')];
  if (!items.length) return;
  e.preventDefault();
  const current = items.indexOf(document.activeElement);
  let next;
  if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  else if (e.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length;
  else next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
  items[next]?.focus();
}

/**
 * 在锚点旁弹出一个菜单。
 * @param {HTMLElement} anchor 锚点元素
 * @param {Array<{id: string, label: string, icon?: Node|string, meta?: string, trailingIcon?: string,
 *                className?: string, danger?: boolean, selected?: boolean, disabled?: boolean}
 *                |{separator: true}|{title: string}>} items
 * @param {{align?: 'start'|'end', onSelect?: (id: string) => void, minWidth?: number}} [opts]
 * @returns {{close: () => void}}
 */
export function openMenu(anchor, items, opts = {}) {
  closeMenu();
  const card = h('div', { class: 'menuCard', role: 'menu' });
  if (opts.minWidth) card.style.minWidth = `${opts.minWidth}px`;

  for (const item of items) {
    if (item.separator) { card.append(h('div', { class: 'menuSep' })); continue; }
    if (item.title) { card.append(h('div', { class: 'menuTitle', text: item.title })); continue; }
    const btn = h('button', {
      type: 'button',
      role: item.selected === undefined ? 'menuitem' : 'menuitemradio',
      'aria-checked': item.selected === undefined ? undefined : (item.selected ? 'true' : 'false'),
      class: clsx('menuItem', item.className, item.selected && 'selected', item.danger && 'danger'),
      disabled: item.disabled,
      onclick: () => { closeMenu(); opts.onSelect?.(item.id); },
    },
      typeof item.icon === 'string' ? icon(item.icon, { size: 16 }) : (item.icon || null),
      h('span', { class: 'miLabel', text: item.label }),
      item.meta ? h('span', { class: 'miMeta', text: item.meta }) : null,
      item.trailingIcon ? icon(item.trailingIcon, { size: 14, className: 'miTrailing' }) : null);
    card.append(btn);
  }

  document.body.append(card);
  openMenuEl = card;

  const r = anchor.getBoundingClientRect();
  const cr = card.getBoundingClientRect();
  const alignEnd = opts.align === 'end';
  let left = alignEnd ? r.right - cr.width : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - cr.width - 8));
  let top = r.bottom + 6;
  if (top + cr.height > window.innerHeight - 8) top = Math.max(8, r.top - cr.height - 6);
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;

  queueMicrotask(() => {
    if (openMenuEl !== card) return;
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onDocKeyDown, true);
    window.addEventListener('resize', closeMenu);
    document.addEventListener('scroll', closeMenu, true);
  });

  return { close: closeMenu };
}

/**
 * 模态框。
 * @param {{title: string, body: Node|Node[], footer?: Node[], width?: string, onClose?: Function}} opts
 * @returns {{close: () => void, root: HTMLElement}}
 */
export function openModal({ title, body, footer, width, onClose }) {
  const overlay = h('div', { class: 'overlay', style: 'z-index:1050' });
  const mask = h('div', { class: 'mask', onclick: () => close() });
  const card = h('div', { class: 'modalCard', role: 'dialog', 'aria-modal': 'true' });
  if (width) card.style.width = width;

  card.append(h('header', null,
    h('span', { text: title }),
    h('span', { class: 'spacer' }),
    h('button', { class: 'settingsClose', 'aria-label': '关闭', onclick: () => close() }, icon('CloseOutline16', { size: 14 }))));

  const bodyEl = h('div', { class: 'body' });
  append(bodyEl, [body]);
  card.append(bodyEl);
  if (footer?.length) card.append(h('footer', null, ...footer));

  overlay.append(mask, card);
  document.body.append(overlay);

  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    onClose?.();
  }
  return { close, root: card };
}

/** 页面内文本输入框，避免浏览器原生 prompt 被 Edge 的弹窗策略隐藏。 */
export function promptDialog({
  title,
  label,
  value = '',
  placeholder = '',
  confirmLabel = '确定',
  required = true,
}) {
  return new Promise((resolve) => {
    let settled = false;
    const input = h('input', {
      class: 'input',
      type: 'text',
      value,
      placeholder,
      autocomplete: 'off',
      spellcheck: 'false',
    });
    const error = h('div', { class: 'fieldError', role: 'alert' });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
      modal.close();
    };
    const submit = () => {
      const result = input.value.trim();
      if (required && !result) {
        error.textContent = '此项不能为空';
        input.focus();
        return;
      }
      finish(result);
    };
    const modal = openModal({
      title,
      body: h('label', { class: 'dialogField' },
        h('span', { class: 'dialogFieldLabel', text: label }),
        input,
        error),
      footer: [
        h('button', { type: 'button', class: 'btn outline', onclick: () => finish(null) }, '取消'),
        h('button', { type: 'button', class: 'btn primary', onclick: submit }, confirmLabel),
      ],
      onClose: () => {
        if (settled) return;
        settled = true;
        resolve(null);
      },
    });
    input.addEventListener('input', () => { error.textContent = ''; });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      submit();
    });
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
  });
}

/** 简单的确认框 */
export function confirmDialog(title, message, confirmLabel = '确定', danger = false) {
  return new Promise((resolve) => {
    const modal = openModal({
      title,
      body: h('div', { class: 'small muted', style: 'line-height:20px', text: message }),
      footer: [
        h('button', { class: 'btn outline', onclick: () => { modal.close(); resolve(false); } }, '取消'),
        h('button', {
          class: clsx('btn', danger ? 'danger' : 'primary'),
          onclick: () => { modal.close(); resolve(true); },
        }, confirmLabel),
      ],
    });
  });
}

/** 带描述的设置行（对应上游的 settings.general.item 行） */
export function settingRow(title, desc, control) {
  return h('div', { class: 'setRow' },
    h('div', { class: 'setRowText' },
      h('div', { class: 't', text: title }),
      desc ? h('div', { class: 'd', text: desc }) : null),
    control);
}

/** 下拉选择器药丸（对应上游的 .selector） */
export function selector(label, onClick) {
  return h('button', { type: 'button', class: 'selector', onclick: onClick },
    h('span', { text: label }),
    icon('ChevronDownOutline14', { size: 14, className: 'chev' }));
}

/** 图标按钮 */
export function iconButton(name, title, onClick, size = 16) {
  return h('button', { type: 'button', class: 'btn icon', title, 'aria-label': title, onclick: onClick },
    icon(name, { size }));
}
