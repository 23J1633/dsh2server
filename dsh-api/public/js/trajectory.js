/* 「轨迹」tab：工具条 + 顶部时间线 + 事件账本 + 右侧事件详情。
 *
 * 逐字移植自 deepseek-harness 的 `packages/client/ui-trajectory/src/client`：
 *   TrajectoryView.tsx      → 本文件的 TrajectoryView
 *   TrajectoryToolbar.tsx   → renderToolbar
 *   TrajectoryTimeline.tsx  → renderTimeline
 *   TrajectoryTable.tsx     → renderTable + 右侧详情面板
 * 数据侧（layout / timeline / 虚拟行 / 搜索 / 快照）在 trajectory-model.js。
 *
 * 三处实现差异，都写在注释里了：虚拟滚动不用 @tanstack/react-virtual，
 * JSON 树与系统提示词差异（structuredPatch）自己实现，悬浮提示用本文件的小浮层。
 */
import { h, append, clsx, toast } from './util.js';
import { icon } from './icons.js';
import { state, settings, saveSettings } from './store.js';
import { markdownFragment } from './markdown.js';
import {
  tj, KIND_LABEL_KEY, trajectoryRecordId, formatElapsedSeconds, formatDurationMs,
  trajectoryPreviewText, markdownPlainText, deriveTrajectoryLayout, lastCellIndex,
  deriveTrajectoryTimeline, trajectoryTimelineFocusIndexes, trajectoryVirtualRecordKey,
  groupTrajectoryVirtualRows, TrajectorySearchIndex, attachLivePartial,
} from './trajectory-model.js';

const BOTTOM_FOLLOW_THRESHOLD_PX = 2;
const OLDER_LOAD_THRESHOLD_PX = 48;
const HISTORY_LOAD_ROW_HEIGHT_PX = 30;
const VIRTUALIZATION_THRESHOLD = 100;
const VIRTUAL_OVERSCAN_ROWS = 12;

const DETAILS_MIN_WIDTH = 320;
const DETAILS_MAX_WIDTH = 720;
const TABLE_MIN_WIDTH = 280;
const DETAILS_RESIZE_STEP = 16;
const TOOL_REQUEST_SHARE = 0.58;
const TOOL_REQUEST_MIN_WIDTH = 180;
const TOOL_REQUEST_MAX_WIDTH = 480;
const DEFAULT_TOOL_REQUEST_SHARE = 0.36;
const DEFAULT_TOOL_REQUEST_OFFSET = 56;

const SEARCH_INDEX_THROTTLE_MS = 3000;
const MINIMUM_DRAG_PX = 3;
const MINIMUM_ZOOM_OPERATIONS = 4;
const EDGE_PAN_ZONE_FRACTION = 0.08;
const EDGE_PAN_STEP_FRACTION = 0.025;
const MAXIMUM_EDGE_PAN_PX = 32;
const TIMELINE_TOOLTIP_DELAY_MS = 500;
const TOOLTIP_DELAY_MS = 400;

const SYSTEM_PROMPT_TABS = [
  { id: 'system-prompt', labelKey: 'tab.systemPrompt' },
  { id: 'tools', labelKey: 'tab.tools' },
];
const SYSTEM_UPDATE_TABS = [{ id: 'diff', labelKey: 'tab.diff' }, ...SYSTEM_PROMPT_TABS];
const REQUEST_TABS = [
  { id: 'overview', labelKey: 'tab.summary' },
  { id: 'options', labelKey: 'tab.options' },
  { id: 'usage', labelKey: 'tab.usage' },
  { id: 'timing', labelKey: 'tab.timing' },
];

const KIND_ICON = {
  system: () => icon('SettingsOutline16', { size: 13 }),
  user: () => icon('UserOutline16', { size: 13 }),
  context: () => roleIcon('information', [
    '<circle cx="8" cy="8" r="6.7"/>',
    '<circle cx="8" cy="5.5" r=".85" fill="currentColor" stroke="none"/>',
    '<path d="M8 7.75v3.4" stroke-width="1.8"/>',
  ], 14, 1.4),
  compacted: () => roleIcon('compacted', [
    '<path d="m2.5 2.5 3.75 3.75M3 6.25h3.25V3"/>',
    '<path d="m13.5 2.5-3.75 3.75M13 6.25H9.75V3"/>',
    '<path d="m2.5 13.5 3.75-3.75M3 9.75h3.25V13"/>',
    '<path d="m13.5 13.5-3.75-3.75M13 9.75H9.75V13"/>',
  ], 13, 1.5),
  message: () => icon('Sparkle16', { size: 13 }),
  tool: () => roleIcon('wrench', [
    '<path d="M14 3.3a3.8 3.8 0 0 1-4.8 4.8l-5.1 5.1a1.6 1.6 0 1 1-2.3-2.3l5.1-5.1A3.8 3.8 0 0 1 11.7 1l-2.3 2.3 2.3 2.3L14 3.3Z"/>',
  ], 13, 1.5),
};
KIND_ICON.subtool = KIND_ICON.tool;

/** 账本里的 kind → 颜色类（上游那串三元表达式） */
const KIND_CLASS = {
  system: 'systemNeutral',
  user: 'user',
  context: 'contextGreen',
  compacted: 'compacted',
  message: 'assistantVioletBright',
  tool: 'toolAmber',
  subtool: 'subtoolAmber',
};

function roleIcon(role, markup, size, strokeWidth) {
  const box = document.createElement('div');
  box.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" `
    + `stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" `
    + `stroke-linejoin="round" data-role-icon="${role}" aria-hidden="true">${markup.join('')}</svg>`;
  return box.firstElementChild;
}

function wrenchGlyph(cls) {
  const box = document.createElement('div');
  box.innerHTML = `<svg class="${cls}" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">`
    + '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z" '
    + 'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return box.firstElementChild;
}

// ---------------------------------------------------------------- 悬浮提示

/**
 * 给元素挂一个延迟浮现的提示层（对应上游 ui-primitives 的 <Tooltip>）。
 * @param {HTMLElement} el
 * @param {string|Function} label 文案，或返回文案的函数
 * @param {{side?: 'top'|'bottom'|'left'|'right', delayMs?: number}} [opts]
 */
function attachTooltip(el, label, opts = {}) {
  const side = opts.side ?? 'top';
  const delay = opts.delayMs ?? TOOLTIP_DELAY_MS;
  let timer = null;
  let tip = null;

  const hide = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (tip) { tip.remove(); tip = null; }
  };

  const show = () => {
    const text = typeof label === 'function' ? label() : label;
    if (!text) return;
    tip = h('div', { class: 'tjTooltip', text });
    document.body.append(tip);
    const rect = el.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    let top = rect.top - box.height - 6;
    let left = rect.left + rect.width / 2 - box.width / 2;
    if (side === 'bottom') top = rect.bottom + 6;
    if (side === 'right') { top = rect.top + rect.height / 2 - box.height / 2; left = rect.right + 6; }
    if (side === 'left') { top = rect.top + rect.height / 2 - box.height / 2; left = rect.left - box.width - 6; }
    tip.style.top = `${Math.max(4, Math.min(top, window.innerHeight - box.height - 4))}px`;
    tip.style.left = `${Math.max(4, Math.min(left, window.innerWidth - box.width - 4))}px`;
    tip.dataset.show = 'true';
  };

  el.addEventListener('pointerenter', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(show, delay);
  });
  el.addEventListener('pointerleave', hide);
  el.addEventListener('pointerdown', hide);
  el.addEventListener('blur', hide);
}

// ---------------------------------------------------------------- JSON 树

function jsonScalar(value) {
  if (typeof value === 'string') return h('span', { class: 'jtString', text: JSON.stringify(value) });
  if (typeof value === 'number') return h('span', { class: 'jtNumber', text: String(value) });
  if (typeof value === 'boolean') return h('span', { class: 'jtKeyword', text: String(value) });
  return h('span', { class: 'jtKeyword', text: 'null' });
}

function isContainer(value) {
  return typeof value === 'object' && value !== null;
}

/**
 * 可折叠 JSON 树（对应上游 ui-primitives 的 <JsonTree>）。
 * @param {any} data
 * @param {{label?: string, className?: string, startOpen?: boolean}} [opts]
 * @returns {HTMLElement}
 */
function jsonTree(data, opts = {}) {
  const root = h('div', { class: clsx('jt', opts.className) });
  root.append(jsonNode(data, 0, opts.startOpen !== false));
  return root;
}

function jsonNode(data, depth, open) {
  if (!isContainer(data)) return h('div', { class: 'jtRow' }, jsonScalar(data));

  const entries = Array.isArray(data)
    ? data.map((value, index) => [String(index), value])
    : Object.entries(data);
  const node = h('div', { class: 'jtNode' });
  const row = h('div', { class: 'jtRow' });
  const children = h('div', { class: clsx('jtChildren', !open && 'jtHidden') });
  const summary = h('span', { class: 'jtSummary' });

  const toggle = h('button', {
    type: 'button',
    class: 'jtToggle',
    'aria-expanded': open ? 'true' : 'false',
    'aria-label': open ? '收起节点' : '展开节点',
    onclick: () => {
      const next = children.classList.toggle('jtHidden');
      toggle.setAttribute('aria-expanded', next ? 'false' : 'true');
      refreshSummary();
    },
  }, icon('ChevronRightOutline14', { size: 10 }));

  const refreshSummary = () => {
    const hidden = children.classList.contains('jtHidden');
    summary.textContent = hidden
      ? (Array.isArray(data) ? ` […] ${entries.length} 项` : ` {…} ${entries.length} 键`)
      : '';
  };

  row.append(
    entries.length > 0 ? toggle : h('span', { class: 'jtSpacer' }),
    h('span', { class: 'jtPunct', text: Array.isArray(data) ? '[' : '{' }),
    h('span', { class: 'jtPunct', text: Array.isArray(data) ? ']' : '}' }),
    summary,
    copyButton(() => JSON.stringify(data, null, 2), '复制值'),
  );

  for (const [key, value] of entries) {
    children.append(h('div', { class: 'jtRow' },
      h('span', { class: 'jtKey', text: `${key}: ` }),
      jsonNode(value, depth + 1, depth < 1)));
  }

  refreshSummary();
  node.append(row, children);
  return node;
}

function copyButton(text, title) {
  return h('button', {
    type: 'button', class: 'jtCopy', title,
    onclick: (e) => {
      e.stopPropagation();
      const value = typeof text === 'function' ? text() : text;
      navigator.clipboard?.writeText(value).then(
        () => toast('info', '已复制'),
        () => toast('error', '复制失败'),
      );
    },
  }, '复制');
}

// ---------------------------------------------------------------- 文本差异

/**
 * 极简行级差异（对应上游依赖的 `diff` 的 structuredPatch）。
 * LCS 动态规划，输出 `@@ -a,b +c,d @@` 块 + 逐行前缀。
 * @param {string} before
 * @param {string} after
 * @param {number} [context] 上下文行数
 * @returns {Array<{kind: 'meta'|'context'|'added'|'removed', text: string}>}
 */
function diffLines(before, after, context = 3) {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push(['context', a[i]]); i += 1; j += 1; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push(['removed', a[i]]); i += 1; }
    else { ops.push(['added', b[j]]); j += 1; }
  }
  while (i < n) { ops.push(['removed', a[i]]); i += 1; }
  while (j < m) { ops.push(['added', b[j]]); j += 1; }

  // 按变更行切 hunk，保留前后 context 行
  const out = [];
  let index = 0;
  let hunkIndex = 0;
  while (index < ops.length) {
    if (ops[index][0] === 'context') { index += 1; continue; }
    const start = Math.max(0, index - context);
    let end = index;
    let gap = 0;
    while (end < ops.length && gap <= context * 2) {
      if (ops[end][0] === 'context') gap += 1; else gap = 0;
      end += 1;
    }
    end = Math.min(ops.length, end);
    const slice = ops.slice(start, end);
    const oldLines = slice.filter(([k]) => k !== 'added').length;
    const newLines = slice.filter(([k]) => k !== 'removed').length;
    const oldStart = ops.slice(0, start).filter(([k]) => k !== 'added').length + 1;
    const newStart = ops.slice(0, start).filter(([k]) => k !== 'removed').length + 1;
    if (hunkIndex > 0) out.push({ kind: 'meta', text: '' });
    out.push({ kind: 'meta', text: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@` });
    for (const [kind, text] of slice) out.push({ kind, text });
    hunkIndex += 1;
    index = end;
  }
  return out;
}

// ---------------------------------------------------------------- 视图

/**
 * 轨迹视图。宿主（conversation.js）在数据变化时调用 `setData`。
 */
export class TrajectoryView {
  /**
   * @param {HTMLElement} host
   * @param {{onLoadOlder?: Function, onInspectApplied?: Function}} [handlers]
   */
  constructor(host, handlers = {}) {
    this.host = host;
    this.handlers = handlers;
    /** 折叠的轮次 */
    this.collapsedTurns = new Set();
    /** 折叠了工具调用的助手记录 id */
    this.collapsedAssistants = new Set();
    this.timelineSelection = null;
    this.actualDuration = settings.trajectoryDuration === true;
    this.actualTime = false;
    this.searchQuery = '';
    this.searchIndex = new TrajectorySearchIndex();
    this.searchIndexTimer = null;
    this.searchIndexInitialized = false;
    this.searchRevision = 0;
    this.selectedTimelineIndex = null;
    this.recordSelection = null;
    this.recordFocus = null;
    this.selectedRecordId = null;
    this.selectedRequestIdentity = null;
    this.activeTab = 'overview';
    this.thinkingExpanded = false;
    this.detailsWidth = null;
    this.toolRequestOffset = null;
    this.tabHistory = ['overview'];
    this.followsTableTail = false;
    this.tableScrollInitialized = false;
    this.pendingScrollRecordId = null;
    this.appliedRecordSelection = null;
    this.appliedRecordFocus = null;
    this.loadingOlder = false;
    this.olderLoadAnchor = null;
    this.virtualScrollTop = 0;
    this.data = null;
    this._build();
  }

  /** 拆掉本视图（宿主切换会话时调用） */
  destroy() {
    if (this.searchIndexTimer) clearTimeout(this.searchIndexTimer);
    this.searchIndexTimer = null;
    this.host.innerHTML = '';
  }

  /**
   * 换一批数据并重绘。
   * @param {object} payload 见 conversation.js 的调用点
   */
  setData(payload) {
    this.data = payload;
    const snapshot = attachLivePartial(payload.snapshot, payload.live);
    this.finalized = deriveTrajectoryLayout({
      ...snapshot,
      partial: null,
      requests: snapshot.requests,
    });
    this.lastIndex = lastCellIndex(this.finalized);
    this.snapshot = snapshot;
    this.requestNumbers = buildRequestNumbers(snapshot);
    this.render();
  }

  _build() {
    this.root = h('div', { class: 'tjRoot' });
    this.toolbarHost = h('div');
    this.timelineHost = h('div');
    this.ledgerHost = h('div', { class: 'ledger' });
    append(this.root, [this.toolbarHost, this.timelineHost, this.ledgerHost]);
    this.host.append(this.root);
  }

  // ---- 派生数据

  _timelineTurns() {
    return this.finalized ?? [];
  }

  _records() {
    return this.visibleRecords ?? [];
  }

  render() {
    if (!this.snapshot) return;
    this.renderToolbar();
    this.renderTimeline();
    this.renderLedger();
  }

  // ---------------------------------------------------------------- 工具条

  renderToolbar() {
    this.toolbarHost.innerHTML = '';
    const collapsibleTurnIds = this._collapsibleTurnIds();
    const collapsibleAssistantIds = this._collapsibleAssistantIds();
    const allTurnsCollapsed = collapsibleTurnIds.length > 0
      && collapsibleTurnIds.every((turn) => this.collapsedTurns.has(turn));
    const allAssistantsCollapsed = collapsibleAssistantIds.length > 0
      && collapsibleAssistantIds.every((id) => this.collapsedAssistants.has(id));

    const durationToggle = h('button', {
      type: 'button',
      class: 'tjToggle',
      'aria-label': tj('toolbar.useActualDuration'),
      'aria-pressed': this.actualDuration ? 'true' : 'false',
      title: this.actualDuration ? tj('toolbar.useEqualWidth') : tj('toolbar.useActualDuration'),
      onclick: () => {
        this.actualDuration = !this.actualDuration;
        saveSettings({ trajectoryDuration: this.actualDuration });
        this.timelineSelection = null;
        this.render();
      },
    });
    const clock = document.createElement('div');
    clock.innerHTML = '<svg class="toggleIcon" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
      + '<circle cx="8" cy="8" r="5.25"/><path d="M8 4.75V8l2.25 1.5"/></svg>';
    durationToggle.append(clock.firstElementChild, document.createTextNode(tj('toolbar.duration')));

    // 上游这个开关带 hidden 属性，永远不会显示；这里保留结构以便对齐
    const actualTimeControl = h('button', {
      type: 'button', class: 'control', role: 'switch',
      'aria-checked': this.actualTime ? 'true' : 'false', hidden: true,
    },
      h('span', { text: tj('toolbar.actualTime') }),
      h('span', {
        class: 'controlTrack',
        'aria-hidden': 'true',
        ...(this.actualTime ? { 'data-on': 'true' } : {}),
      }, h('span', { class: 'controlThumb' })));

    const turnsButton = h('button', {
      type: 'button', class: 'action',
      'aria-label': allTurnsCollapsed ? tj('toolbar.expandTurns') : tj('toolbar.collapseTurns'),
      'aria-pressed': allTurnsCollapsed ? 'true' : 'false',
      title: allTurnsCollapsed ? tj('toolbar.expandTurns') : tj('toolbar.collapseTurns'),
      onclick: () => {
        if (allTurnsCollapsed) for (const turn of collapsibleTurnIds) this.collapsedTurns.delete(turn);
        else for (const turn of collapsibleTurnIds) this.collapsedTurns.add(turn);
        this.render();
      },
    }, h('span', { class: 'actionIcon', 'aria-hidden': 'true', text: allTurnsCollapsed ? '⊞' : '⊟' }),
      document.createTextNode(tj('toolbar.turns')));

    const callsButton = h('button', {
      type: 'button', class: 'action',
      'aria-label': allAssistantsCollapsed ? tj('toolbar.expandCalls') : tj('toolbar.collapseCalls'),
      'aria-pressed': allAssistantsCollapsed ? 'true' : 'false',
      title: allAssistantsCollapsed ? tj('toolbar.expandCalls') : tj('toolbar.collapseCalls'),
      onclick: () => {
        if (allAssistantsCollapsed) for (const id of collapsibleAssistantIds) this.collapsedAssistants.delete(id);
        else for (const id of collapsibleAssistantIds) this.collapsedAssistants.add(id);
        this.render();
      },
    }, h('span', { class: 'actionIcon', 'aria-hidden': 'true', text: allAssistantsCollapsed ? '⊞' : '⊟' }),
      document.createTextNode(tj('toolbar.calls')));

    const searchInput = h('input', {
      type: 'search', class: 'searchInput',
      'aria-label': tj('toolbar.search'),
      placeholder: tj('toolbar.searchPlaceholder'),
      value: this.searchQuery,
    });
    searchInput.addEventListener('input', () => {
      this.searchQuery = searchInput.value;
      this.scheduleSearchIndex();
    });

    const searchBox = h('div', { class: 'search' },
      icon('SearchOutline16', { size: 11, className: 'searchIcon' }), searchInput);

    this.toolbarHost.append(h('div', { class: 'toolbarRoot', role: 'toolbar', 'aria-label': tj('toolbar.aria') },
      h('div', { class: 'inner' },
        h('div', { class: 'actions' }, durationToggle, actualTimeControl, turnsButton, callsButton),
        searchBox)));

    this.updateSearchIndex();
  }

  _collapsibleTurnIds() {
    return this._timelineTurns()
      .filter((turn) => turn.turn !== null
        && turn.groups.reduce((count, group) => count
          + group.cells.filter((cell) => cell.requestOnly !== true && cell.kind !== 'system').length, 0) > 1)
      .map((turn) => turn.turn);
  }

  _collapsibleAssistantIds() {
    const ids = [];
    for (const turn of this._timelineTurns()) {
      const cells = turn.groups.flatMap((group) => group.cells);
      for (let i = 0; i < cells.length; i += 1) {
        const cell = cells[i];
        if (cell?.kind !== 'message') continue;
        const next = cells[i + 1];
        if (next?.kind === 'tool' || next?.kind === 'subtool') ids.push(trajectoryRecordId(cell));
      }
    }
    return ids;
  }

  // ---------------------------------------------------------------- 搜索索引

  updateSearchIndex() {
    const turns = this._timelineTurns();
    const partialTurns = this.snapshot?.partial
      ? deriveTrajectoryLayout({ eventNodes: [], partial: this.snapshot.partial, runningCalls: [] })
      : [];
    this.searchLayouts = [turns, partialTurns];
    if (!this.searchIndexInitialized) {
      this.searchIndexInitialized = true;
      if (this.searchIndex.update(this.searchLayouts)) this.searchRevision += 1;
      return;
    }
    if (this.searchIndexTimer) return;
    this.searchIndexTimer = setTimeout(() => {
      this.searchIndexTimer = null;
      if (this.searchIndex.update(this.searchLayouts)) {
        this.searchRevision += 1;
        this.renderLedger();
      }
    }, SEARCH_INDEX_THROTTLE_MS);
  }

  scheduleSearchIndex() {
    // 输入立即按当前索引过滤；索引本身按上游的节流节奏重建
    this.renderLedger();
    this.updateSearchIndex();
  }

  searchMatchIndexes() {
    const ids = this.searchIndex.search(this.searchQuery);
    if (ids === null) return null;
    const indexes = new Set();
    for (const turns of this.searchLayouts ?? []) {
      for (const turn of turns) {
        for (const group of turn.groups) {
          for (const cell of group.cells) {
            if (ids.has(trajectoryRecordId(cell))) indexes.add(cell.index);
          }
        }
      }
    }
    return indexes;
  }

  // ---------------------------------------------------------------- 时间线

  renderTimeline() {
    this.timelineHost.innerHTML = '';
    if (this.timelineEl) { this.timelineEl.remove(); this.timelineEl = null; }
    const turns = this._timelineTurns();
    const mode = this.timelineMode();
    const model = deriveTrajectoryTimeline(turns, mode);
    const searchMatches = this.searchMatchIndexes();

    if (!this.viewport || (model && (this.viewport.end < model.start || this.viewport.start > model.end))) {
      this.viewport = null;
    }
    const fullDuration = Math.max(1, (model?.end ?? 0) - (model?.start ?? 0));
    const viewportDuration = Math.min(fullDuration,
      Math.max(1, (this.viewport?.end ?? 0) - (this.viewport?.start ?? 0)));
    const domainDuration = this.viewport === null ? fullDuration : viewportDuration;
    const domainStart = this.viewport === null
      ? (model?.start ?? 0)
      : Math.min(Math.max(this.viewport.start, model.start), model.end - viewportDuration);

    const track = h('div', { class: 'track', tabindex: '0', 'aria-label': tj('timeline.overviewAria') });

    if (model === null) {
      this.timelineHost.append(h('section', { class: 'timelineRoot', 'aria-label': tj('timeline.aria') },
        h('div', { class: 'plot' },
          h('div', { class: 'labels', 'aria-hidden': 'true' },
            h('span', { text: tj('column.input') }),
            h('span', { text: tj('column.model') }),
            h('span', { text: tj('column.tools') })),
          h('div', { class: 'track' }, h('span', { class: 'tjEmpty', text: tj('timeline.noTimingData') })))));
      return;
    }

    const detailByIndex = new Map(turns.flatMap((turn) => turn.groups.flatMap((group) =>
      group.cells.map((cell) => [cell.index, timelineRecordDetail(cell)]))));

    const projected = `--trajectory-domain-left:${-(domainStart - model.start) / domainDuration * 100}%;`
      + `--trajectory-domain-width:${fullDuration / domainDuration * 100}%`;

    // 轮次边界
    const boundaries = h('div', { class: 'turnBoundaries', 'aria-hidden': 'true', style: projected });
    for (const boundary of model.turnBoundaries) {
      if (boundary.time <= model.start) continue;
      if (boundary.time < domainStart || boundary.time > domainStart + domainDuration) continue;
      boundaries.append(h('span', {
        class: 'turnBoundary',
        'data-turn': String(boundary.turn),
        style: `--trajectory-turn-left:${(boundary.time - model.start) / fullDuration * 100}%`,
      }));
    }

    const lanes = h('div', { class: 'lanes', 'data-timeline-domain': '', style: projected });
    const activeRange = this.timelineDraft ?? this.timelineSelection;
    for (const span of model.spans) {
      if (span.index !== this.selectedTimelineIndex
        && !(span.end >= domainStart && span.start <= domainStart + domainDuration)) continue;
      const left = (span.start - model.start) / fullDuration;
      const width = (span.end - span.start) / fullDuration;
      const widthPercent = width * 100;
      const detail = detailByIndex.get(span.index);
      const ttft = detail?.ttftMs;
      const decoding = detail?.decodingMs;
      const ttftFraction = ttft === undefined || decoding === undefined || ttft + decoding <= 0
        ? null : ttft / (ttft + decoding);
      const el = h('span', {
        'aria-hidden': 'true',
        class: 'span',
        'data-timeline-span': span.kind,
        'data-timeline-record-index': String(span.index),
        ...(ttftFraction === null ? {} : { 'data-assistant-timing': 'true' }),
        ...(span.isError ? { 'data-error': 'true' } : {}),
        ...(mode === 'time' ? { 'data-equal-duration': 'true' } : {}),
        ...(span.index === this.selectedTimelineIndex ? { 'data-current': 'true' } : {}),
        ...(this.timelineHover === span.index ? { 'data-hovered': 'true' } : {}),
        ...(searchMatches === null ? {} : { 'data-search-match': searchMatches.has(span.index) ? 'true' : 'false' }),
        ...(activeRange === null ? {} : {
          'data-selected': span.start <= activeRange.end && span.end >= activeRange.start ? 'true' : 'false',
        }),
        style: `--trajectory-span-left:${left * 100}%;`
          + `--trajectory-span-width:${widthPercent}%;`
          + `--trajectory-span-gap:min(${widthPercent * 0.08}%,1px);`
          + `--trajectory-span-lane:${span.lane};`
          + (ttftFraction === null ? '' : `--trajectory-assistant-ttft:${ttftFraction * 100}%;`),
      });
      attachTooltip(el, () => timelineTooltipLabel(span.kind, detail), {
        side: 'bottom', delayMs: TIMELINE_TOOLTIP_DELAY_MS,
      });
      lanes.append(el);
    }

    const visibleRange = this.timelineDraft !== null && this.timelineDraft !== undefined
      ? this.rangeFraction(this.timelineDraft, domainStart, domainDuration, model)
      : (this.timelineSelection === null
        ? null
        : this.rangeFraction(this.timelineSelection, domainStart, domainDuration, model));

    if (visibleRange !== null) {
      const style = `--trajectory-selection-left:${visibleRange.start * 100}%;`
        + `--trajectory-selection-width:${(visibleRange.end - visibleRange.start) * 100}%`;
      track.append(
        h('div', {
          class: 'selection',
          'aria-hidden': 'true',
          ...(this.timelineDraft ? { 'data-dragging': 'true' } : {}),
          style,
        }),
        h('div', {
          class: 'selectionEdges',
          'aria-hidden': 'true',
          ...(this.timelineDraft ? { 'data-dragging': 'true' } : {}),
          style,
        }));
    }

    if (this.timelineHoverFraction !== undefined && this.timelineHoverRecord === null && !this.timelineDraft) {
      track.append(h('div', {
        class: 'hoverLine',
        'aria-hidden': 'true',
        style: `--trajectory-hover-left:${this.timelineHoverFraction * 100}%`,
      }));
    }

    if (this.data?.hasMore && domainStart === model.start) {
      const earlier = h('button', {
        type: 'button', class: 'earlierHistory',
        'aria-label': this.loadingOlder ? tj('history.loadingEarlierAria') : tj('history.loadEarlier'),
        onclick: () => this.loadEarlier(),
      }, '…');
      attachTooltip(earlier, () => (this.loadingOlder
        ? tj('history.loadingEarlier') : tj('history.clickToLoadEarlier')), { side: 'right', delayMs: TIMELINE_TOOLTIP_DELAY_MS });
      earlier.addEventListener('pointerenter', (e) => { e.stopPropagation(); this.timelineHoverFraction = undefined; });
      earlier.addEventListener('pointerdown', (e) => e.stopPropagation());
      track.append(earlier);
    }

    track.append(boundaries, lanes);
    this.wireTimelineTrack(track, model, { domainStart, domainDuration, fullDuration });

    this.timelineEl = h('section', { class: 'timelineRoot', 'aria-label': tj('timeline.aria') },
      h('div', { class: 'plot' },
        h('div', { class: 'labels', 'aria-hidden': 'true' },
          h('span', { text: tj('column.input') }),
          h('span', { text: tj('column.model') }),
          h('span', { text: tj('column.tools') })),
        track));
    this.timelineHost.append(this.timelineEl);

    // 选中项跑出视口时把视口挪过去
    if (model !== null && this.selectedTimelineIndex !== null && this.viewport !== null) {
      const span = model.spans.find((s) => s.index === this.selectedTimelineIndex);
      if (span && (span.end <= this.viewport.start || span.start >= this.viewport.end)) {
        const duration = Math.max(1, this.viewport.end - this.viewport.start);
        const desired = span.end <= this.viewport.start ? span.start : span.end - duration;
        const nextStart = Math.min(Math.max(desired, model.start), Math.max(model.start, model.end - duration));
        if (nextStart !== this.viewport.start) {
          this.viewport = { start: nextStart, end: nextStart + duration };
        }
      }
    }
  }

  rangeFraction(range, start, duration, model) {
    const bounded = [
      Math.min(model.end, Math.max(model.start, range.start)),
      Math.min(model.end, Math.max(model.start, range.end)),
    ].sort((a, b) => a - b);
    return { start: (bounded[0] - start) / duration, end: (bounded[1] - start) / duration };
  }

  timelineMode() {
    if (this.actualDuration) return this.actualTime ? 'actual' : 'duration';
    return this.actualTime ? 'time' : 'sequence';
  }

  loadEarlier() {
    if (this.loadingOlder || !this.data?.onLoadOlder) return;
    this.loadingOlder = true;
    Promise.resolve(this.data.onLoadOlder())
      .finally(() => { this.loadingOlder = false; this.render(); });
  }

  wireTimelineTrack(track, model, { domainStart, domainDuration, fullDuration }) {
    const fractionAt = (event) => {
      const rect = track.getBoundingClientRect();
      return Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
    };
    const recordIndexAt = (event) => {
      const target = event.target instanceof Element
        ? event.target.closest('[data-timeline-record-index]') : null;
      const value = target?.dataset.timelineRecordIndex;
      if (value === undefined) return null;
      const index = Number(value);
      return Number.isFinite(index) ? index : null;
    };

    let drag = null;
    let pan = null;

    const minimumSelectionDuration = Math.min(domainDuration, fullDuration / model.spans.length);
    const ordered = (a, b) => (a <= b ? { start: a, end: b } : { start: b, end: a });

    track.addEventListener('contextmenu', (e) => e.preventDefault());
    track.addEventListener('dblclick', (e) => { e.preventDefault(); this.timelineSelection = null; this.render(); });

    track.addEventListener('pointerdown', (event) => {
      if (event.button === 2) {
        pan = {
          anchorClientX: event.clientX,
          anchorStart: domainStart,
          moved: false,
          pannable: this.viewport !== null,
          pointerId: event.pointerId,
        };
        track.setPointerCapture(event.pointerId);
        track.dataset.panning = 'true';
        return;
      }
      if (event.button !== 0) return;
      const anchor = fractionAt(event);
      const recordIndex = recordIndexAt(event);
      drag = {
        pointerId: event.pointerId,
        anchorTime: domainStart + anchor * domainDuration,
        anchorClientX: event.clientX,
        recordIndex,
      };
      track.setPointerCapture(event.pointerId);
      this.timelineDraft = { start: drag.anchorTime, end: drag.anchorTime };
      track.dataset.panning = '';
      this.renderTimeline();
    });

    track.addEventListener('pointermove', (event) => {
      const rect = track.getBoundingClientRect();
      const fraction = fractionAt(event);
      const recordIndex = recordIndexAt(event);
      if (pan?.pointerId === event.pointerId) {
        if (Math.abs(event.clientX - pan.anchorClientX) >= MINIMUM_DRAG_PX) pan.moved = true;
        if (!pan.pannable) return;
        const delta = (event.clientX - pan.anchorClientX) / Math.max(1, rect.width);
        const nextStart = Math.min(
          Math.max(pan.anchorStart - delta * domainDuration, model.start),
          model.end - domainDuration,
        );
        this.viewport = { start: nextStart, end: nextStart + domainDuration };
        this.renderTimeline();
        return;
      }
      if (drag?.pointerId !== event.pointerId) return;
      let nextDomainStart = domainStart;
      if (this.viewport !== null) {
        const localX = event.clientX - rect.left;
        const edgeWidth = Math.min(MAXIMUM_EDGE_PAN_PX, Math.max(1, rect.width * EDGE_PAN_ZONE_FRACTION));
        const direction = localX < edgeWidth ? -1 : localX > rect.width - edgeWidth ? 1 : 0;
        if (direction !== 0) {
          const distance = direction < 0 ? edgeWidth - localX : localX - (rect.width - edgeWidth);
          const strength = Math.min(1, Math.max(0, distance / edgeWidth));
          const desired = domainStart
            + direction * domainDuration * EDGE_PAN_STEP_FRACTION * Math.max(0.2, strength);
          nextDomainStart = Math.min(Math.max(desired, model.start), model.end - domainDuration);
        }
      }
      const pointTime = nextDomainStart + fraction * domainDuration;
      this.timelineDraft = ordered(drag.anchorTime, pointTime);
      this.timelineHoverFraction = fraction;
      this.timelineHoverRecord = recordIndex;
      this.renderTimeline();
    });

    const end = (event) => {
      if (pan?.pointerId === event.pointerId) {
        const moved = pan.moved || Math.abs(event.clientX - pan.anchorClientX) >= MINIMUM_DRAG_PX;
        pan = null;
        track.dataset.panning = '';
        if (!moved) this.timelineSelection = null;
        this.render();
        return;
      }
      if (drag?.pointerId !== event.pointerId) return;
      const pointFraction = fractionAt(event);
      const pointTime = domainStart + pointFraction * domainDuration;
      const selected = ordered(drag.anchorTime, pointTime);
      const click = Math.abs(event.clientX - drag.anchorClientX) < MINIMUM_DRAG_PX;
      const clickedSpan = click && drag.recordIndex !== null
        ? model.spans.find((span) => span.index === drag.recordIndex)
        : undefined;
      drag = null;
      this.timelineDraft = null;
      this.timelineHoverFraction = pointFraction;
      if (clickedSpan !== undefined) {
        this.timelineSelection = null;
        this.selectRecord(clickedSpan.index, { scroll: false });
        return;
      }
      const committed = selected.end - selected.start < minimumSelectionDuration
        ? centeredRange(click ? selected.start : (selected.start + selected.end) / 2,
          minimumSelectionDuration, model.start, model.end)
        : selected;
      this.timelineSelection = committed;
      if (click) {
        const point = selected.start;
        const nearest = model.spans.reduce((candidate, span) => {
          const cd = point < candidate.start ? candidate.start - point
            : point > candidate.end ? point - candidate.end : 0;
          const sd = point < span.start ? span.start - point
            : point > span.end ? point - span.end : 0;
          return sd < cd ? span : candidate;
        });
        this.scrollToRecord(nearest.index);
      }
      this.render();
    };

    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', () => {
      drag = null;
      pan = null;
      this.timelineDraft = null;
      this.render();
    });
    track.addEventListener('pointerleave', () => {
      if (drag === null && pan === null) {
        this.timelineHoverFraction = undefined;
        this.timelineHoverRecord = null;
        this.renderTimeline();
      }
    });
    track.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || this.timelineSelection === null) return;
      event.preventDefault();
      this.timelineSelection = null;
      this.render();
    });
    track.addEventListener('wheel', (event) => {
      event.preventDefault();
      const rect = track.getBoundingClientRect();
      const anchorFraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
      const nextDuration = Math.min(fullDuration, Math.max(
        Math.min(this.timelineMode() === 'sequence' ? MINIMUM_ZOOM_OPERATIONS : 20, fullDuration),
        domainDuration * Math.exp(event.deltaY * 0.0015),
      ));
      if (nextDuration >= fullDuration * 0.999) {
        this.viewport = null;
        this.render();
        return;
      }
      const anchorTime = domainStart + anchorFraction * domainDuration;
      const nextStart = Math.min(
        Math.max(anchorTime - anchorFraction * nextDuration, model.start),
        model.end - nextDuration,
      );
      this.viewport = { start: nextStart, end: nextStart + nextDuration };
      this.render();
    }, { passive: false });
  }

  // ---------------------------------------------------------------- 账本

  renderLedger() {
    const turns = this._timelineTurns();
    const allRecords = flattenRecords(turns);
    this.allRecords = allRecords;
    this.streamingCellsByIndex = new Map();
    const searchMatches = this.searchMatchIndexes();

    // 请求组 / 请求编号 / 圆点落点 —— 对应上游的 requestGroups、indexRequestNumbers、
    // indexRequestBoundaries、indexRequestBoundaryRuns
    const requestGroups = new Set((this.requestNumbers ?? [])
      .map((request) => `${request.turn} ${request.group}`));
    const requestNumbers = new Map();
    for (const request of this.requestNumbers ?? []) {
      requestNumbers.set(`${request.turn} ${request.group}`, request.number);
    }
    const requestBoundaries = new Map();
    for (const record of allRecords) {
      const key = `${record.turn} ${record.group}`;
      if (!requestGroups.has(key) || requestBoundaries.has(key)) continue;
      if (record.cell.kind === 'user' || record.cell.kind === 'context') continue;
      requestBoundaries.set(key, record.cell.index);
    }

    const records = searchMatches !== null
      ? filterRecords(allRecords, searchMatches)
      : collapseAssistantRecords(
        collapseTurnRecords(allRecords, this.collapsedTurns, requestGroups),
        this.collapsedAssistants,
      );
    this.records = records;
    this.virtualRows = groupTrajectoryVirtualRows(records);
    const virtualizationEnabled = !!this.data?.hasMore || records.length > VIRTUALIZATION_THRESHOLD;
    this.virtualizationEnabled = virtualizationEnabled;
    const virtualScrollMargin = this.data?.hasMore ? HISTORY_LOAD_ROW_HEIGHT_PX : 0;
    this.virtualScrollMargin = virtualScrollMargin;

    const timelineFocus = this.timelineSelection === null
      ? null
      : trajectoryTimelineFocusIndexes(turns, this.timelineSelection, this.timelineMode());

    const selected = this.selectedRecordId === null ? undefined
      : allRecords.find((record) => trajectoryRecordId(record.cell) === this.selectedRecordId);

    // ---- 表格
    const pane = h('div', {
      class: 'tablePane',
      'data-trajectory-scroll': '',
      onscroll: (event) => this.onTableScroll(event.currentTarget),
      onclick: (event) => {
        if (event.target === event.currentTarget) {
          this.selectedRecordId = null;
          this.selectedRequestIdentity = null;
          this.timelineSelection = null;
          this.render();
        }
      },
    });

    if (this.data?.historyLoading || !this.tableScrollInitialized) {
      pane.append(h('div', { class: 'historyLoading', role: 'status', 'aria-live': 'polite' },
        h('span', { class: 'historyLoadingBar' },
          h('span', { class: 'historyLoadingSpinner', 'aria-hidden': 'true' }),
          tj('history.loadingTrajectory'))));
    }

    const table = h('table', {
      class: 'table',
      ...(this.tableScrollInitialized ? { 'data-scroll-ready': 'true' } : {}),
      'aria-rowcount': String(records.length + (this.data?.hasMore ? 1 : 0)),
    });
    table.append(h('colgroup', {},
      h('col', { class: 'eventColumn' }), h('col', { class: 'contentColumn' })));
    const tbody = h('tbody');

    if (this.data?.hasMore) {
      tbody.append(h('tr', { class: 'historyLoadRow', 'data-history-load': '', 'aria-rowindex': '1' },
        h('td', { colspan: '2' },
          h('button', {
            type: 'button', class: 'historyLoadButton',
            disabled: this.loadingOlder ? true : null,
            'aria-label': this.loadingOlder ? tj('history.loadingEarlierAria') : tj('history.loadEarlier'),
            onclick: () => this.loadEarlier(),
          },
            this.loadingOlder ? h('span', { class: 'historyLoadingSpinner', 'aria-hidden': 'true' }) : null,
            h('span', {
              'aria-hidden': 'true',
              text: this.loadingOlder ? tj('history.loadingEarlier') : tj('history.loadEarlier'),
            })))));
    }

    const { start, end } = this.virtualWindow();
    if (virtualizationEnabled && start > 0) {
      tbody.append(virtualSpacerRow('top', this.virtualOffset(start)));
    }

    for (let i = start; i < end; i += 1) {
      const row = this.virtualRows[i];
      if (!row) continue;
      for (const [entryIndex, entry] of row.entries.entries()) {
        const terminal = entry.record.cell.requestOnly === true
          && row.entries[row.entries.length - 1]?.record.cell.requestOnly === true
          && entryIndex === row.entries.length - 1;
        const tr = this.buildRow(entry.record, entry.logicalIndex, terminal, {
          allRecords, records, requestGroups, requestBoundaries, requestNumbers,
          timelineFocus, virtualizationEnabled,
        });
        if (tr) tbody.append(tr);
      }
    }

    if (virtualizationEnabled && end < this.virtualRows.length) {
      tbody.append(virtualSpacerRow('bottom', this.virtualOffset(this.virtualRows.length) - this.virtualOffset(end)));
    }

    table.append(tbody);
    pane.append(table);

    // ---- 右侧详情
    const details = this.renderDetails(allRecords);
    const split = h('div', {
      class: 'split',
      style: this.toolRequestOffset === null
        ? ''
        : `--trajectory-tool-request-width:calc(58cqw - ${this.toolRequestOffset}px)`,
    }, pane);
    if (details) split.append(details);

    this.ledgerHost.innerHTML = '';
    this.ledgerHost.append(split);
    this.tablePane = pane;
    this.tableEl = table;

    this.restoreTableScroll();

    // 时间线联动：把焦点区滚进视野
    if (timelineFocus !== null && timelineFocus.size > 0) this.scrollToFocus(timelineFocus);

    // 跨视图定位
    if (this.pendingScrollRecordId) {
      const id = this.pendingScrollRecordId;
      this.pendingScrollRecordId = null;
      this.scrollToRecordById(id);
    }
    void selected;
  }

  virtualWindow() {
    const rows = this.virtualRows ?? [];
    if (!this.virtualizationEnabled) return { start: 0, end: rows.length };
    const paneHeight = this.tablePane?.clientHeight || 600;
    const top = this.virtualScrollTop;
    let offset = 0;
    let start = 0;
    for (let i = 0; i < rows.length; i += 1) {
      if (offset + rows[i].height > top) { start = i; break; }
      offset += rows[i].height;
      start = i + 1;
    }
    start = Math.max(0, start - VIRTUAL_OVERSCAN_ROWS);
    let height = 0;
    let end = start;
    while (end < rows.length && height < paneHeight + VIRTUAL_OVERSCAN_ROWS * 30 * 2) {
      height += rows[end].height;
      end += 1;
    }
    end = Math.min(rows.length, end + VIRTUAL_OVERSCAN_ROWS);
    return { start, end };
  }

  virtualOffset(index) {
    if (!this.virtualizationEnabled) return 0;
    let total = 0;
    for (let i = 0; i < index && i < this.virtualRows.length; i += 1) total += this.virtualRows[i].height;
    return Math.max(0, total - this.virtualScrollMargin);
  }

  onTableScroll(pane) {
    this.virtualScrollTop = pane.scrollTop;
    this.followsTableTail = pane.scrollHeight - pane.clientHeight - pane.scrollTop
      <= BOTTOM_FOLLOW_THRESHOLD_PX;
    if (this.data?.hasMore && !this.loadingOlder && pane.scrollTop <= OLDER_LOAD_THRESHOLD_PX) {
      if (this.olderLoadAnchor === null) {
        this.olderLoadAnchor = {
          startSeq: this.data.historyStartSeq,
          scrollHeight: pane.scrollHeight,
          scrollTop: pane.scrollTop,
        };
      }
      this.loadEarlier();
      return;
    }
    if (this.virtualizationEnabled) {
      const { start, end } = this.virtualWindow();
      if (start !== this.renderedWindow?.start || end !== this.renderedWindow?.end) {
        this.renderedWindow = { start, end };
        this.renderLedger();
      }
    }
  }

  restoreTableScroll() {
    const pane = this.tablePane;
    if (!pane) return;
    const anchor = this.olderLoadAnchor;
    if (anchor !== null && anchor.startSeq !== this.data?.historyStartSeq) {
      this.olderLoadAnchor = null;
      this.followsTableTail = false;
      if (!this.virtualizationEnabled) {
        pane.scrollTop = anchor.scrollTop + pane.scrollHeight - anchor.scrollHeight;
      }
      return;
    }
    if (!this.tableScrollInitialized) {
      if (this.data?.historyLoading) return;
      this.tableScrollInitialized = true;
      this.followsTableTail = true;
      pane.scrollTop = this.virtualizationEnabled
        ? this.virtualOffset(this.virtualRows.length) : pane.scrollHeight;
      this.renderLedger();
      return;
    }
    if (this.followsTableTail && !this.virtualizationEnabled) pane.scrollTop = pane.scrollHeight;
  }

  /** 构造一行；返回 null 表示不该渲染（例如被折叠吞掉） */
  buildRow(record, position, terminalRequestBoundary, ctx) {
    const cell = record.cell;
    const isCollapsedSummary = record.collapsedSummary !== undefined;
    const isRequestOnly = cell.requestOnly === true;
    const isInitialSystem = cell.kind === 'system' && cell.index === ctx.allRecords[0]?.cell.index;
    const activeTurn = this.selectedRequestIdentity !== null
      ? this.selectedRequest()?.turn
      : (this.selectedRecordId === null ? undefined
        : ctx.allRecords.find((r) => trajectoryRecordId(r.cell) === this.selectedRecordId)?.turn);
    const sectionActive = record.turn === null
      ? false
      : activeTurn === record.turn;

    const presentation = recordPresentation(cell);
    const state = stateOf(record);
    const timelineFocus = ctx.timelineFocus;

    const tr = h('tr', {
      tabindex: isRequestOnly ? '-1' : '0',
      'aria-rowindex': String(position + 1 + (this.data?.hasMore ? 1 : 0)),
      'aria-label': isCollapsedSummary
        ? tj('request.collapsedSummary', {
          kind: tj(record.collapsedSummaryKind === 'turn' ? 'request.collapsedTurn' : 'request.collapsedAssistant'),
          summary: record.collapsedSummary,
        })
        : tj('request.rowAria', {
          request: '',
          kind: tj(KIND_LABEL_KEY[cell.kind]),
          content: presentation.listDisplayText || tj('request.noContent'),
        }),
      'aria-selected': !isCollapsedSummary && !isRequestOnly
        && this.selectedIndex() === cell.index ? 'true' : 'false',
      'data-kind': cell.kind,
      'data-trajectory-row-key': trajectoryVirtualRecordKey(record),
      ...(isCollapsedSummary || isRequestOnly ? {} : { 'data-record-index': String(cell.index) }),
      ...(isRequestOnly ? { 'data-request-only': 'true' } : {}),
      ...(terminalRequestBoundary ? { 'data-terminal-request-boundary': 'true' } : {}),
      ...(record.groupStart ? { 'data-group-start': 'true' } : {}),
      ...(record.turnStart ? { 'data-turn-start': 'true' } : {}),
      ...(cell.isError ? { 'data-error': 'true' } : {}),
      ...(state === 'running' ? { 'data-running': 'true' } : {}),
      ...(record.turnEnd ? { 'data-turn-end': 'true' } : {}),
      ...(record.collapsedSummaryKind ? { 'data-collapsed-summary': record.collapsedSummaryKind } : {}),
      ...(!isCollapsedSummary && this.selectedIndex() === cell.index ? { 'data-selected': 'true' } : {}),
      ...(isCollapsedSummary || timelineFocus === null ? {}
        : { 'data-timeline-focus': timelineFocus.has(cell.index) ? 'inside' : 'outside' }),
    });

    if (!isRequestOnly) {
      tr.addEventListener('click', () => {
        if (clickSelectsText(tr)) return;
        if (isCollapsedSummary) {
          if (record.collapsedSummaryKind === 'turn' && record.turn !== null) this.toggleTurn(record.turn);
          else this.toggleAssistant(trajectoryRecordId(cell));
        } else {
          this.selectRecord(cell.index);
        }
      });
      tr.addEventListener('dblclick', (event) => {
        if (isCollapsedSummary) return;
        if (record.turn !== null && this.collapsedTurns.has(record.turn)) {
          event.preventDefault();
          this.toggleTurn(record.turn);
          return;
        }
        if (cell.kind === 'message'
          && assistantToolCalls(ctx.allRecords, cell.index).length > 0) {
          event.preventDefault();
          this.toggleAssistant(trajectoryRecordId(cell));
          return;
        }
        if (!record.turnStart || record.turn === null) return;
        const count = ctx.allRecords.filter((c) => c.turn === record.turn
          && c.cell.requestOnly !== true && c.cell.kind !== 'system').length;
        if (count <= 1) return;
        event.preventDefault();
        this.toggleTurn(record.turn);
      });
      tr.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        if (isCollapsedSummary) {
          if (record.collapsedSummaryKind === 'turn' && record.turn !== null) this.toggleTurn(record.turn);
          else this.toggleAssistant(trajectoryRecordId(cell));
        } else {
          this.selectRecord(cell.index);
        }
      });
    }

    // ---- 左列
    const eventCell = h('td', { class: 'event' });
    const request = this.requestBoundaryFor(record, ctx);
    if (request !== undefined) {
      const info = this.requestInfo(request);
      const selectedRequest = info !== undefined
        && this.selectedRequestIdentity === requestIdentity(info);
      const dot = h('button', {
        type: 'button',
        class: clsx('requestBoundaryControl', selectedRequest && 'requestBoundaryControlActive'),
        'aria-label': requestLabel(info, request),
        'aria-pressed': selectedRequest ? 'true' : 'false',
        'data-label': requestLabel(info, request),
        'data-request-run-index': '0',
        ...(info?.status ? { 'data-request-status': info.status } : {}),
        style: '--request-boundary-offset:0px',
        onclick: (event) => {
          event.stopPropagation();
          if (info !== undefined) this.selectRequest(info);
        },
        ondblclick: (event) => event.stopPropagation(),
      });
      eventCell.append(dot);
    }
    if (record.turn !== null && sectionActive && !isInitialSystem) {
      eventCell.append(h('span', { class: 'turnRail', 'aria-hidden': 'true' }));
    }
    if (!isCollapsedSummary && this.selectedIndex() === cell.index) {
      eventCell.append(h('span', { class: 'selectionRail', 'aria-hidden': 'true' }));
    }
    if (!isCollapsedSummary && !isRequestOnly && record.turnStart) {
      const label = sectionLabel(record.turn);
      const turnLabel = h('span', {
        class: clsx('turnLabel', sectionActive && 'turnLabelActive'),
        'aria-label': label,
      });
      if (record.turn === null) turnLabel.append(document.createTextNode(label));
      else {
        turnLabel.append(
          h('span', { class: 'turnLabelFull', 'aria-hidden': 'true', text: label }),
          h('span', { class: 'turnLabelCompact', 'aria-hidden': 'true', text: `#${record.turn}` }));
      }
      eventCell.append(turnLabel);
    }
    if (!isCollapsedSummary && !isRequestOnly) {
      const tag = h('span', { class: clsx('kindTag', KIND_CLASS[cell.kind]), 'data-role-kind': cell.kind });
      const iconHost = h('span', { class: 'kindTagIcon', 'aria-hidden': 'true' });
      const glyph = KIND_ICON[cell.kind]?.();
      if (glyph) iconHost.append(glyph);
      attachTooltip(iconHost, () => tj(KIND_LABEL_KEY[cell.kind]), { side: 'right' });
      tag.append(iconHost, h('span', { class: 'kindTagLabel', text: tj(KIND_LABEL_KEY[cell.kind]) }));
      eventCell.append(h('div', { class: 'eventInner' }, h('span', { class: 'kindSlot' }, tag)));
    }
    tr.append(eventCell);

    // ---- 右列
    const contentCell = h('td', { class: 'content' });
    if (!isRequestOnly) {
      if (isCollapsedSummary) {
        contentCell.append(h('span', {
          class: 'collapsedTurnContent', title: record.collapsedSummary,
        },
          h('span', { class: 'collapsedTurnEllipsis', text: '…' }),
          h('span', { class: 'collapsedTurnText', text: record.collapsedSummary })));
      } else {
        const summary = h('span', {
          class: presentation.resultText === undefined ? 'contentText' : 'resultPreview',
          title: presentation.resultText === undefined
            ? presentation.listDisplayText
            : `${presentation.listDisplayText} → ${presentation.resultText}`,
          text: presentation.listDisplayText,
        });
        const inner = recordListText(presentation);
        if (presentation.resultText === undefined) {
          summary.textContent = '';
          summary.append(inner);
        } else {
          summary.textContent = '';
          summary.append(
            h('span', { class: 'resultRequest' }, inner),
            h('span', { class: clsx('inlineResult', cell.isError && 'error') },
              h('span', { class: 'arrow', text: '→' }),
              h('span', {
                class: clsx('inlineResultText', presentation.resultText === tj('record.noOutput') && 'noOutputText'),
                text: presentation.resultText,
              })));
        }
        contentCell.append(summary);
      }
    }
    tr.append(contentCell);
    return tr;
  }

  /**
   * 该行是否要挂请求圆点，是的话返回请求编号。
   * 规则与上游一致：请求组的第一条非 user/context 记录挂圆点，
   * 折叠摘要行和已折叠的轮次不挂。
   */
  requestBoundaryFor(record, ctx) {
    if (record.collapsedSummary !== undefined) return undefined;
    if (record.turn !== null && this.collapsedTurns.has(record.turn)) return undefined;
    const key = `${record.turn} ${record.group}`;
    if (!ctx.requestGroups.has(key)) return undefined;
    return ctx.requestBoundaries.get(key) === record.cell.index
      ? (ctx.requestNumbers.get(key) ?? undefined)
      : undefined;
  }

  /** 编号 → 请求信息 */
  requestInfo(number) {
    if (number === undefined || number === null) return undefined;
    return this.requestNumbers?.find((request) => request.number === number);
  }

  selectedIndex() {
    if (this.selectedRecordId === null) return null;
    const record = this.allRecords?.find((r) => trajectoryRecordId(r.cell) === this.selectedRecordId);
    return record?.cell.index ?? null;
  }

  selectedRequest() {
    if (this.selectedRequestIdentity === null) return undefined;
    return this.requestNumbers?.find((request) => requestIdentity(request) === this.selectedRequestIdentity);
  }

  toggleTurn(turn) {
    if (this.collapsedTurns.has(turn)) this.collapsedTurns.delete(turn);
    else this.collapsedTurns.add(turn);
    this.render();
  }

  toggleAssistant(id) {
    if (this.collapsedAssistants.has(id)) this.collapsedAssistants.delete(id);
    else this.collapsedAssistants.add(id);
    this.render();
  }

  selectRecord(index, { scroll = true } = {}) {
    const record = this.allRecords?.find((r) => r.cell.index === index);
    if (!record) return;
    this.selectedRequestIdentity = null;
    this.selectedRecordId = trajectoryRecordId(record.cell);
    const tabs = detailTabs(record).map((tab) => tab.id);
    const recent = [...this.tabHistory].reverse().find((tab) => tabs.includes(tab));
    this.activeTab = recent ?? tabs[0] ?? 'overview';
    if (scroll) this.pendingScrollRecordId = this.selectedRecordId;
    this.render();
  }

  activateTab(tab) {
    this.tabHistory = [...this.tabHistory.filter((t) => t !== tab), tab];
    this.activeTab = tab;
    this.render();
  }

  /** 选中一个请求（点圆点），右侧换成请求检查器 */
  selectRequest(info, tab = 'overview') {
    this.selectedRecordId = null;
    this.selectedRequestIdentity = requestIdentity(info);
    this.activeTab = tab;
    this.render();
  }

  scrollToRecord(index) {
    const record = this.allRecords?.find((r) => r.cell.index === index);
    if (record) this.scrollToRecordById(trajectoryRecordId(record.cell));
  }

  scrollToRecordById(id) {
    const position = this.records?.findIndex((record) => trajectoryRecordId(record.cell) === id
      && record.collapsedSummary === undefined);
    if (position === undefined || position === -1) return;
    this.followsTableTail = false;
    const recordIndex = this.records[position]?.cell.index;
    if (recordIndex === undefined || !this.tablePane) return;
    if (this.virtualizationEnabled) {
      let offset = 0;
      for (let i = 0; i < position; i += 1) offset += this.virtualRows[i].height;
      this.tablePane.scrollTo({ top: Math.max(0, offset - this.tablePane.clientHeight / 2), behavior: 'smooth' });
      return;
    }
    const row = this.tableEl?.querySelector(`tr[data-record-index="${recordIndex}"]`);
    row?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }

  scrollToFocus(focusIndexes) {
    if (!this.tablePane) return;
    const focused = [...(this.tableEl?.querySelectorAll('tr[data-timeline-focus="inside"]') ?? [])];
    if (focused.length === 0) return;
    const first = focused[0];
    const last = focused[focused.length - 1];
    const height = last.getBoundingClientRect().bottom - first.getBoundingClientRect().top;
    const target = height > this.tablePane.clientHeight
      ? first : focused[Math.floor((focused.length - 1) / 2)];
    if (this.virtualizationEnabled) {
      const firstIndex = this.records.findIndex((record) => focusIndexes.has(record.cell.index));
      if (firstIndex >= 0) {
        let offset = 0;
        for (let i = 0; i < firstIndex; i += 1) offset += this.virtualRows[i].height;
        this.tablePane.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
      }
      return;
    }
    this.followsTableTail = false;
    target?.scrollIntoView?.({ behavior: 'smooth', block: height > this.tablePane.clientHeight ? 'start' : 'center' });
  }

  // ---------------------------------------------------------------- 详情面板

  renderDetails(allRecords) {
    const selectedRecord = this.selectedRecordId === null ? undefined
      : allRecords.find((r) => trajectoryRecordId(r.cell) === this.selectedRecordId);
    const requestInfo = this.selectedRequest();
    if (!selectedRecord && !requestInfo) return null;

    const aside = h('aside', {
      class: 'details',
      'aria-label': tj('details.event'),
      ...(this.detailsWidth === null ? {} : { style: `width:${this.detailsWidth}px` }),
    });

    const handle = h('div', {
      class: 'detailsResizeHandle', role: 'separator',
      'aria-label': tj('details.resize'), 'aria-controls': 'trajectory-detail-panel',
      'aria-orientation': 'vertical', tabindex: '0', title: tj('details.resizeTitle'),
      ondblclick: () => { this.detailsWidth = null; this.toolRequestOffset = null; this.render(); },
    });
    wireDetailsResize(handle, this);
    aside.append(handle);

    // ---- 头部
    if (requestInfo) {
      aside.append(h('div', { class: 'detailsHeader' },
        h('div', { class: 'detailsTitle' },
          h('span', { class: 'requestDetailsDot', 'aria-hidden': 'true' }),
          h('span', { class: 'requestDetailsName', text: tj('request.label', { request: requestInfo.number }) }),
          h('span', {
            class: 'detailsLocation',
            text: requestInfo.purpose === 'compaction'
              ? tj('request.compaction', { section: sectionLabel(requestInfo.turn) })
              : sectionLabel(requestInfo.turn),
          })),
        this.closeButton()));
    } else {
      aside.append(h('div', { class: 'detailsHeader' },
        h('div', { class: 'detailsTitle' },
          h('span', {
            class: clsx('kindTag', KIND_CLASS[selectedRecord.cell.kind]),
            text: tj(KIND_LABEL_KEY[selectedRecord.cell.kind]),
          }),
          h('span', {
            class: 'detailsLocation',
            text: selectedRecord.cell.kind === 'compacted'
              ? sectionLabel(selectedRecord.turn)
              : `${sectionLabel(selectedRecord.turn)} · ${selectedRecord.group}`,
          })),
        this.closeButton()));
    }

    // ---- 页签
    const tabs = requestInfo
      ? REQUEST_TABS.filter((tab) => tab.id !== 'options' || requestInfo.requestConfig !== undefined)
      : detailTabs(selectedRecord);
    const tabList = h('div', { class: 'detailTabs', role: 'tablist', 'aria-label': tj('details.event') });
    for (const tab of tabs) {
      tabList.append(h('button', {
        type: 'button', role: 'tab', id: `trajectory-detail-${tab.id}`,
        'aria-controls': 'trajectory-detail-panel',
        'aria-selected': this.activeTab === tab.id ? 'true' : 'false',
        class: clsx('detailTab', this.activeTab === tab.id && 'detailTabActive'),
        onclick: () => this.activateTab(tab.id),
      }, tj(tab.labelKey)));
    }
    aside.append(tabList);

    // ---- 内容
    const body = h('div', {
      id: 'trajectory-detail-panel',
      class: clsx('detailBody', this.activeTab === 'overview' && 'detailBodySummary'),
      role: 'tabpanel', 'aria-labelledby': `trajectory-detail-${this.activeTab}`,
    });
    if (requestInfo) this.fillRequestBody(body, requestInfo, allRecords);
    else this.fillDetailBody(body, selectedRecord, stateOf(selectedRecord), allRecords);
    aside.append(body);
    return aside;
  }

  closeButton() {
    return h('button', {
      type: 'button', class: 'close', 'aria-label': tj('details.close'),
      onclick: () => {
        this.selectedRecordId = null;
        this.selectedRequestIdentity = null;
        this.render();
      },
    }, h('span', { 'aria-hidden': 'true', text: '×' }));
  }

  /** 请求检查器：概述 / 选项 / 用量 / 计时（上游 TrajectoryTable 的 selectedRequestInfo 分支） */
  fillRequestBody(body, info, allRecords) {
    const group = info.group;
    const records = allRecords.filter((record) => record.turn === info.turn && record.group === group);
    const assistant = records.find((record) => record.cell.kind === 'message');
    const anchor = assistant ?? records[0];
    const requestState = info.status
      ?? (assistant?.cell.assistantMetrics?.completedTime === null ? 'running'
        : assistant === undefined && records.some((r) => stateOf(r) === 'running') ? 'running'
          : 'complete');
    const toolCalls = records.filter((r) => r.cell.kind === 'tool').length;
    const subtoolCalls = records.filter((r) => r.cell.kind === 'subtool').length;
    const usage = info.usage ?? (assistant === undefined ? undefined : {
      ...(assistant.cell.input === undefined ? {} : { input: assistant.cell.input }),
      ...(assistant.cell.cacheRead === undefined ? {} : { cacheRead: assistant.cell.cacheRead }),
      ...(assistant.cell.cacheWrite === undefined ? {} : { cacheWrite: assistant.cell.cacheWrite }),
      ...(assistant.cell.output === undefined ? {} : { output: assistant.cell.output }),
      ...(assistant.cell.think === undefined ? {} : { reasoning: assistant.cell.think }),
    });

    if (this.activeTab === 'options') {
      body.append(requestOptions(info.requestConfig));
      return;
    }
    if (this.activeTab === 'usage') {
      body.append(h('div', { class: 'usagePanel' },
        h('section', { class: 'usageGroup' },
          h('h4', { class: 'usageHeading', text: tj('usage.thisRequest') }), usageRows(usage)),
        h('section', { class: 'usageGroup' },
          h('h4', { class: 'usageHeading', text: tj('usage.sessionCumulative') }),
          usageRows(info.cumulativeUsage ?? usage))));
      return;
    }
    if (this.activeTab === 'timing') {
      body.append(requestTiming(assistant, anchor, info));
      return;
    }

    // 概述
    const overview = h('dl', { class: 'overview summaryScrollRegion', 'data-summary-scroll-region': '' });
    overview.append(overviewRow(tj('details.status'), stateLabel(requestState), requestState === 'error'));
    if (info.purpose === 'compaction') {
      overview.append(overviewRow(tj('details.purpose'), tj('request.compactionPurpose')));
    }
    const provider = info.provider ?? info.requestConfig?.provider;
    const model = info.model ?? info.requestConfig?.model;
    if (provider !== undefined) overview.append(overviewRow(tj('details.provider'), provider));
    if (model !== undefined) overview.append(overviewRow(tj('details.model'), model));
    overview.append(overviewRow(tj('details.toolCalls'), String(toolCalls)));
    if (subtoolCalls > 0) overview.append(overviewRow(tj('details.subtoolCalls'), String(subtoolCalls)));
    if (info.error !== undefined) {
      overview.append(overviewRow(tj('details.error'),
        requestErrorMessage(info), true));
    }
    if (info.resultSeq !== undefined) {
      const result = allRecords.find((record) => record.cell.sourceSeq === info.resultSeq);
      if (result) {
        overview.append(overviewRow(tj('details.result'),
          hierarchyLink(
            info.purpose === 'compaction' ? tj('details.compacted') : tj('details.assistantMessage'),
            () => this.selectRecord(result.cell.index),
          )));
      }
    }
    body.append(overview);

    const sections = h('div', { class: 'overviewSections' });
    if (info.requestConfig !== undefined) {
      sections.append(overviewSection(tj('tab.options'), () => this.activateTab('options'),
        requestOptions(info.requestConfig, true)));
    }
    sections.append(overviewSection(tj('tab.usage'), () => this.activateTab('usage'), usageRows(usage)));
    sections.append(overviewSection(tj('tab.timing'), () => this.activateTab('timing'),
      requestTiming(assistant, anchor, info)));
    body.append(sections);
  }

  fillDetailBody(body, record, state, allRecords) {
    const cell = record.cell;
    const tab = this.activeTab;
    const promptSelected = cell.kind === 'system'
      && (cell.promptDetail !== undefined || cell.systemPromptDetail !== undefined);
    const systemPrompt = cell.promptDetail?.system ?? cell.systemPromptDetail;

    if (tab === 'diff' && cell.previousPromptDetail && cell.promptDetail) {
      body.append(systemPromptDiff(cell.previousPromptDetail, cell.promptDetail));
      return;
    }
    if (promptSelected && tab === 'system-prompt') {
      if (systemPrompt === '') body.append(h('p', { class: 'noPayload', text: tj('record.systemPromptMissing') }));
      else body.append(h('div', { class: 'markdownPayload systemPrompt' }, markdownBlock(systemPrompt)));
      return;
    }
    if (cell.promptDetail !== undefined && tab === 'tools') {
      body.append(toolCatalog(cell.promptDetail.tools));
      return;
    }

    if (tab === 'overview' || (cell.kind === 'compacted' && tab === 'overview')) {
      const overview = h('dl', { class: 'overview summaryScrollRegion', 'data-summary-scroll-region': '' });
      if (cell.kind === 'compacted') {
        overview.append(
          overviewRow(tj('details.status'), stateLabel(state), state === 'error'),
          overviewRow(tj('timing.duration'), formatElapsedSeconds(cell.timeSeconds)),
          overviewRow(tj('usage.tokens'), '—'));
        body.append(overview);
        if (cell.outputDetail !== undefined) {
          body.append(h('div', { class: 'compactedSummary summaryScrollRegion', 'data-summary-scroll-region': '' },
            this.renderMarkdownRecord(record, true, allRecords)));
        }
        return;
      }
      if (cell.messageSource !== undefined) {
        overview.append(overviewRow(tj('details.source'),
          hierarchyLink(messageSourceLabel(cell.messageSource), () => this.activateTab('source'))));
      }
      overview.append(overviewRow(tj('details.status'), stateLabel(state), state === 'error'));
      if (cell.kind === 'message') overview.append(tokenRows(cell));
      if (cell.kind === 'user' || cell.kind === 'context') {
        overview.append(overviewRow(tj('timing.duration'), formatElapsedSeconds(cell.timeSeconds)));
      }
      body.append(overview);

      const sections = h('div', { class: 'overviewSections' });
      if (isMarkdownRecord(record)) {
        sections.append(overviewSection(tj('tab.preview'), () => this.activateTab('rendered'),
          this.renderMarkdownRecord(record, true, allRecords, true)));
      } else {
        if (cell.inputDetail) {
          sections.append(overviewSection(tj('tab.payload'), () => this.activateTab('input'),
            recordPayload(record, 'input', true)));
        }
        if (cell.outputDetail) {
          sections.append(overviewSection(tj('tab.result'), () => this.activateTab('output'),
            recordPayload(record, 'output', true)));
        }
        sections.append(overviewSection(tj('tab.schema'), () => this.activateTab('schema'),
          recordSchema(record, true)));
      }
      if (cell.kind === 'tool' || cell.kind === 'subtool') {
        sections.append(overviewSection(tj('tab.timing'), () => this.activateTab('timing'), recordTiming(record)));
      }
      body.append(sections);
      return;
    }

    if (tab === 'rendered') { body.append(this.renderMarkdownRecord(record, true, allRecords)); return; }
    if (tab === 'raw') { body.append(this.renderMarkdownRecord(record, false, allRecords)); return; }
    if (tab === 'source') { body.append(messageSource(record)); return; }
    if (tab === 'input') { body.append(recordPayload(record, 'input', false)); return; }
    if (tab === 'output') { body.append(recordPayload(record, 'output', false)); return; }
    if (tab === 'schema') { body.append(recordSchema(record, false)); return; }
    if (tab === 'timing') { body.append(recordTiming(record)); }
  }

  /**
   * Markdown 记录的正文（上游 MarkdownRecordContent）。
   * @param {object} record
   * @param {boolean} rendered true 渲染 Markdown，false 走源块
   * @param {Array} allRecords
   * @param {boolean} [preview]
   */
  renderMarkdownRecord(record, rendered, allRecords, preview = false) {
    void allRecords;
    const cell = record.cell;
    if (!rendered && cell.sourceBlocks?.length > 0) return sourceBlocks(cell.sourceBlocks);
    if (cell.thinkingDetail) {
      if (!rendered) {
        const source = [cell.thinkingDetail, cell.outputDetail]
          .filter((v) => v !== undefined && v !== '').join('\n\n');
        return markdownFragmentEl(source, false, preview);
      }
      const wrap = h('div', { class: 'assistantContent assistantContentRendered' });
      const quote = h('div', {
        class: clsx('thinkingQuote', preview && !cell.outputDetail && 'thinkingQuoteOnlyPreview'),
      });
      const toggle = h('button', {
        type: 'button', class: 'thinkingToggle',
        'aria-expanded': this.thinkingExpanded ? 'true' : 'false',
        onclick: () => {
          this.thinkingExpanded = !this.thinkingExpanded;
          this.render();
        },
      }, document.createTextNode(tj('record.thinking')),
        icon('ChevronRightOutline14', { size: 12, className: 'thinkingChevron' }));
      quote.append(toggle);
      if (this.thinkingExpanded) quote.append(markdownFragmentEl(cell.thinkingDetail, true, preview));
      wrap.append(quote);
      if (cell.outputDetail) {
        wrap.append(h('div', { class: 'assistantOutput' },
          markdownFragmentEl(cell.outputDetail, true, preview)));
      }
      wrap.append(assistantToolCallsList(cell.sourceBlocks, preview));
      return wrap;
    }
    const source = markdownSource(record);
    const hasImages = cell.sourceBlocks?.some((b) => b.attachment !== undefined) === true;
    const hasToolCalls = cell.kind === 'message'
      && cell.sourceBlocks?.some((b) => b.type === 'tool-call') === true;
    if (!source && !hasImages && !hasToolCalls) {
      return h('p', {
        class: 'noPayload',
        text: cell.text || tj('record.noContent'),
      });
    }
    if (!rendered || (!hasImages && !hasToolCalls)) {
      return markdownFragmentEl(source ?? '', rendered, preview);
    }
    const wrap = h('div');
    if (source) wrap.append(markdownFragmentEl(source, true, preview));
    if (cell.kind === 'message') wrap.append(assistantToolCallsList(cell.sourceBlocks, preview));
    return wrap;
  }
}

// ---------------------------------------------------------------- 表格辅助

function clickSelectsText(target) {
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed && selection.rangeCount > 0
    && selection.getRangeAt(0).intersectsNode(target);
}

function virtualSpacerRow(where, height) {
  return h('tr', { class: 'virtualSpacer', 'data-virtual-spacer': where, 'aria-hidden': 'true' },
    h('td', { colspan: '2', style: `--trajectory-virtual-spacer-height:${height}px` }));
}

function flattenRecords(turns) {
  return turns.flatMap((turn, section) => {
    let firstInSection = true;
    const records = turn.groups.flatMap((group) => group.cells.map((cell, index) => {
      const turnStart = firstInSection
        && cell.requestOnly !== true
        && cell.kind !== 'system'
        && (cell.kind !== 'compacted' || turn.turn === null);
      if (turnStart) firstInSection = false;
      return {
        turn: turn.turn, section, group: group.title, groupStart: index === 0, turnStart, cell, turnEnd: false,
      };
    }));
    const last = records[records.length - 1];
    if (last) last.turnEnd = true;
    return records;
  });
}

function filterRecords(records, matches) {
  const filtered = records
    .filter((record) => record.cell.requestOnly !== true && matches.has(record.cell.index))
    .map((record) => ({ ...record, groupStart: false, turnStart: false, turnEnd: false }));
  const startedSections = new Set();
  for (const [index, record] of filtered.entries()) {
    const previous = filtered[index - 1];
    const next = filtered[index + 1];
    record.groupStart = previous === undefined
      || previous.section !== record.section || previous.group !== record.group;
    record.turnStart = !startedSections.has(record.section)
      && record.cell.kind !== 'system'
      && (record.cell.kind !== 'compacted' || record.turn === null);
    if (record.turnStart) startedSections.add(record.section);
    record.turnEnd = next === undefined || next.section !== record.section;
  }
  return filtered;
}

function summarizeTurn(records, requestGroups) {
  const steps = new Set(records.map((r) => `${r.turn} ${r.group}`)
    .filter((key) => requestGroups.has(key))).size;
  const toolCalls = records.filter((r) => r.cell.kind === 'tool' || r.cell.kind === 'subtool').length;
  return [
    tj(steps === 1 ? 'summary.steps.one' : 'summary.steps.other', { count: steps }),
    tj(toolCalls === 1 ? 'summary.toolCalls.one' : 'summary.toolCalls.other', { count: toolCalls }),
  ].join(' · ');
}

function collapseTurnRecords(records, collapsedTurns, requestGroups) {
  const byTurn = new Map();
  for (const record of records) {
    if (record.turn === null) continue;
    const list = byTurn.get(record.turn) ?? [];
    list.push(record);
    byTurn.set(record.turn, list);
  }
  return records.flatMap((record) => {
    if (record.turn === null || !collapsedTurns.has(record.turn)) return [record];
    if (record.cell.requestOnly === true || record.cell.kind === 'system') return [record];
    const turnRecords = byTurn.get(record.turn) ?? [record];
    const content = turnRecords.filter((c) => c.cell.requestOnly !== true && c.cell.kind !== 'system');
    if (content.length <= 1) return [record];
    if (record.cell.index !== content[0]?.cell.index) return [];
    return [
      { ...record, turnEnd: false },
      {
        ...record,
        groupStart: false,
        turnStart: false,
        turnEnd: true,
        collapsedSummary: summarizeTurn(content.slice(1), requestGroups),
        collapsedSummaryKind: 'turn',
      },
    ];
  });
}

function assistantToolCalls(records, assistantIndex) {
  const at = records.findIndex((record) => record.cell.index === assistantIndex);
  if (at === -1 || records[at]?.cell.kind !== 'message') return [];
  const calls = [];
  for (let i = at + 1; i < records.length; i += 1) {
    const record = records[i];
    if (!record) break;
    if (record.cell.kind !== 'tool' && record.cell.kind !== 'subtool') break;
    calls.push(record);
  }
  return calls;
}

function summarizeAssistantTools(records) {
  const names = [...new Set(records.map((record) => {
    const separator = record.cell.text.indexOf(' · ');
    return separator === -1 ? record.cell.text : record.cell.text.slice(0, separator);
  }).filter((name) => name !== ''))];
  const summary = tj(records.length === 1 ? 'summary.toolCalls.one' : 'summary.toolCalls.other',
    { count: records.length });
  return names.length > 0 ? `${summary} · ${names.join(', ')}` : summary;
}

function collapseAssistantRecords(records, collapsedAssistants) {
  const out = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record) continue;
    out.push(record);
    if (record.cell.kind !== 'message'
      || !collapsedAssistants.has(trajectoryRecordId(record.cell))) continue;
    const calls = [];
    for (let j = i + 1; j < records.length; j += 1) {
      const candidate = records[j];
      if (!candidate || candidate.collapsedSummary !== undefined
        || (candidate.cell.kind !== 'tool' && candidate.cell.kind !== 'subtool')) break;
      calls.push(candidate);
    }
    if (calls.length === 0) continue;
    const last = calls[calls.length - 1];
    out[out.length - 1] = { ...record, turnEnd: false };
    out.push({
      ...record,
      groupStart: false,
      turnStart: false,
      turnEnd: last?.turnEnd ?? false,
      collapsedSummary: summarizeAssistantTools(calls),
      collapsedSummaryKind: 'assistant',
    });
    i += calls.length;
  }
  return out;
}

function stateOf(record) {
  if (record.cell.isError) return 'error';
  if (record.cell.kind === 'compacted' && record.cell.timeSeconds === null) return 'running';
  if ((record.cell.kind === 'tool' || record.cell.kind === 'subtool')
    && record.cell.outputDetail === undefined) return 'running';
  return 'complete';
}

function stateLabel(state) {
  if (state === 'error') return tj('status.failed');
  if (state === 'running') return tj('status.pending');
  return tj('status.completed');
}

function sectionLabel(turn) {
  return turn === null ? tj('section.betweenTurns') : tj('turn.label', { turn });
}

function requestIdentity(request) {
  return request.turn === null
    ? `compaction ${request.seq}`
    : `assistant ${request.turn} ${request.step}`;
}

function requestLabel(info, fallback) {
  const number = info?.number ?? fallback?.number;
  if (number === undefined) return '';
  return tj('request.label', { request: number });
}

// ---------------------------------------------------------------- 记录展示

function isToolCallOnly(cell) {
  return cell.kind === 'message' && !cell.outputDetail && !cell.thinkingDetail
    && cell.text === tj('layout.toolCallOnly');
}

function recordDisplayText(cell) {
  if (isToolCallOnly(cell)) return '';
  if (cell.previewMarkdown !== undefined) {
    const preview = trajectoryPreviewText(cell.previewMarkdown);
    if (cell.text === '') return preview;
    return preview === '' ? cell.text : `${cell.text} · ${preview}`;
  }
  if (cell.text !== '') return cell.text;
  const markdown = cell.kind === 'user' || cell.kind === 'context'
    ? cell.inputDetail
    : cell.kind === 'message' ? (cell.outputDetail ?? cell.thinkingDetail) : undefined;
  return markdown === undefined ? '' : trajectoryPreviewText(markdown);
}

function recordResultText(cell) {
  return cell.resultPreviewMarkdown === undefined
    ? cell.result
    : trajectoryPreviewText(cell.resultPreviewMarkdown);
}

function toolCallTextParts(kind, text) {
  if (kind !== 'tool' && kind !== 'subtool') return undefined;
  const separator = text.indexOf(' · ');
  if (separator === -1) return { name: text };
  return { name: text.slice(0, separator), args: text.slice(separator + 3) };
}

function recordPresentation(cell) {
  const displayText = recordDisplayText(cell);
  const resultText = recordResultText(cell);
  const toolCallOnly = isToolCallOnly(cell);
  const toolCallText = toolCallTextParts(cell.kind, displayText);
  return {
    displayText,
    resultText,
    toolCallOnly,
    toolCallText,
    listDisplayText: toolCallOnly
      ? tj('record.toolCallOnly')
      : toolCallText === undefined
        ? displayText
        : [toolCallText.name, toolCallText.args].filter(Boolean).join(' '),
  };
}

function recordListText(presentation) {
  if (presentation.toolCallOnly) {
    return h('span', { class: 'toolCallOnly', text: tj('record.toolCallOnly') });
  }
  if (presentation.toolCallText === undefined) return document.createTextNode(presentation.displayText || '—');
  const frag = document.createDocumentFragment();
  frag.append(h('span', { class: 'toolCallNameTypeface', text: presentation.toolCallText.name || '—' }));
  if (presentation.toolCallText.args !== undefined) {
    frag.append(h('span', { class: 'toolCallPayload', text: presentation.toolCallText.args }));
  }
  return frag;
}

// ---------------------------------------------------------------- 详情面板片段

function overviewRow(label, value, isError = false) {
  return h('div', {}, h('dt', { text: label }), h('dd', { class: isError ? 'error' : null }, value));
}

// ---------------------------------------------------------------- 请求

/**
 * 给请求编号并算出会话累计用量（上游 TrajectoryView 里的 requestNumbers 计算）。
 * @param {object} snapshot buildTrajectorySnapshot 的结果
 * @returns {Array<object>} 每一项带 number / turn / step / group 等展示字段
 */
function buildRequestNumbers(snapshot) {
  const assistantsByStep = new Map();
  for (const node of snapshot.eventNodes) {
    if (node.kind !== 'assistant' || node.step <= 0) continue;
    assistantsByStep.set(`${node.turn} ${node.step}`, node);
  }
  const requestsByStep = new Map(snapshot.requests
    .filter((request) => request.purpose === 'assistant')
    .map((request) => [`${request.turn} ${request.step}`, request]));
  const ordered = [
    ...snapshot.requests.map((request) => ({
      seq: request.startSeq,
      request,
      node: request.purpose === 'assistant'
        ? assistantsByStep.get(`${request.turn} ${request.step}`) : undefined,
    })),
    ...[...assistantsByStep.entries()].flatMap(([key, node]) => (requestsByStep.has(key)
      ? [] : [{ seq: node.seq, request: undefined, node }])),
  ].sort((left, right) => left.seq - right.seq);

  const numbered = [];
  let cumulative;
  for (const [index, entry] of ordered.entries()) {
    const usage = requestUsage(entry.request?.usage ?? entry.node?.usage);
    cumulative = addUsage(cumulative, usage);
    if (entry.request?.purpose === 'compaction') {
      const request = entry.request;
      numbered.push({
        seq: request.startSeq, turn: request.turn, step: 0,
        group: tj('group.compaction', { seq: request.startSeq }),
        number: index + 1, purpose: 'compaction', status: request.status,
        startedAt: request.startedAt, completedAt: request.completedAt,
        ...(request.error === undefined ? {} : { error: request.error }),
        resultSeq: request.startSeq,
        ...(request.provenance?.provider === undefined ? {} : { provider: request.provenance.provider }),
        ...(request.provenance?.model === undefined ? {} : { model: request.provenance.model }),
        ...(request.requestConfig === undefined ? {} : { requestConfig: request.requestConfig }),
        ...(usage === undefined ? {} : { usage }),
        ...(cumulative === undefined ? {} : { cumulativeUsage: cumulative }),
      });
      continue;
    }
    const request = entry.request;
    const node = entry.node;
    const turn = request?.turn ?? node?.turn;
    const step = request?.step ?? node?.step;
    if (turn === undefined || step === undefined) continue;
    const provider = request?.provenance?.provider ?? node?.provenance?.provider;
    const model = request?.provenance?.model ?? node?.provenance?.model;
    const requestConfig = request?.requestConfig ?? node?.requestConfig;
    numbered.push({
      seq: entry.seq, turn, step,
      group: tj('group.step', { step }),
      number: index + 1,
      ...(request?.status === undefined ? {} : { status: request.status }),
      ...(request?.startedAt === undefined ? {} : { startedAt: request.startedAt }),
      ...(request?.completedAt === undefined ? {} : { completedAt: request.completedAt }),
      ...(request?.error === undefined ? {} : { error: request.error }),
      ...(request?.resultSeq === undefined ? {} : { resultSeq: request.resultSeq }),
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      ...(requestConfig === undefined ? {} : { requestConfig }),
      ...(usage === undefined ? {} : { usage }),
      ...(cumulative === undefined ? {} : { cumulativeUsage: cumulative }),
    });
  }
  return numbered;
}

function requestUsage(value) {
  if (value === undefined) return undefined;
  const pick = (a, b) => (value[a] ?? value[b]);
  const usage = {
    input: pick('inputTokens', 'input'),
    cacheRead: pick('cacheReadTokens', 'cacheRead'),
    cacheWrite: pick('cacheWriteTokens', 'cacheWrite'),
    output: pick('outputTokens', 'output'),
    reasoning: pick('reasoningTokens', 'reasoning'),
  };
  return Object.values(usage).some((v) => v !== undefined) ? usage : undefined;
}

function addUsage(total, usage) {
  if (usage === undefined) return total;
  const out = {};
  for (const key of ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning']) {
    if (total?.[key] === undefined && usage[key] === undefined) continue;
    out[key] = (total?.[key] ?? 0) + (usage[key] ?? 0);
  }
  return out;
}

function inputTotal(usage) {
  if (usage.input === undefined && usage.cacheRead === undefined && usage.cacheWrite === undefined) {
    return undefined;
  }
  return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

function usageRows(usage) {
  if (usage === undefined) return h('p', { class: 'noPayload', text: tj('usage.notReported') });
  const d = h('dl', { class: 'overview' });
  const row = (label, value, detail = false) => h('div', { class: detail ? 'requestTokenDetail' : null },
    h('dt', { text: label }), h('dd', { text: value }));
  const totalInput = inputTotal(usage);
  const otherOutput = usage.output !== undefined && usage.reasoning !== undefined
    ? usage.output - usage.reasoning : undefined;
  if (totalInput !== undefined) d.append(row(tj('usage.input'), tj('unit.tokens', { value: totalInput })));
  if (usage.cacheRead !== undefined) d.append(row(tj('usage.cached'), tj('unit.tokens', { value: usage.cacheRead }), true));
  if (usage.cacheWrite !== undefined) d.append(row(tj('usage.cacheCreated'), tj('unit.tokens', { value: usage.cacheWrite }), true));
  if (usage.input !== undefined) d.append(row(tj('usage.other'), tj('unit.tokens', { value: usage.input }), true));
  if (usage.output !== undefined) d.append(row(tj('usage.output'), tj('unit.tokens', { value: usage.output })));
  if (usage.reasoning !== undefined) d.append(row(tj('usage.reasoning'), tj('unit.tokens', { value: usage.reasoning }), true));
  if (otherOutput !== undefined) d.append(row(tj('usage.content'), tj('unit.tokens', { value: otherOutput }), true));
  return d;
}

function requestOptions(options, preview = false) {
  if (options === undefined) return h('p', { class: 'noPayload', text: tj('options.notRecorded') });
  return jsonTree(options, {
    label: tj('options.json'),
    className: preview ? 'jsonPreview' : 'jsonPayload',
  });
}

function requestTiming(assistant, anchor, info) {
  if (assistant !== undefined) return recordTiming(assistant);
  if (info?.startedAt !== undefined) {
    const duration = info.completedAt === null || info.completedAt === undefined
      ? null : Math.max(0, (info.completedAt - info.startedAt) / 1000);
    return h('dl', { class: 'overview' },
      h('div', {}, h('dt', { text: tj('timing.started') }), startedAtValue(info.startedAt)),
      h('div', {}, h('dt', { text: tj('timing.duration') }), h('dd', { text: formatElapsedSeconds(duration) })),
      h('div', {}, h('dt', { text: tj('timing.source') }),
        h('dd', { text: duration === null ? tj('timing.sessionTimestampsRunning') : tj('timing.sessionTimestamps') })));
  }
  return h('dl', { class: 'overview' },
    h('div', {}, h('dt', { text: tj('timing.started') }), startedAtValue(anchor?.cell.startedAt ?? null)),
    h('div', {}, h('dt', { text: tj('timing.duration') }), h('dd', { text: formatElapsedSeconds(null) })));
}

function requestErrorMessage(info) {
  if (info.errorCode === 'AUTH') return tj('details.failure.auth');
  return info.error;
}

function hierarchyLink(label, onClick) {
  return h('span', { class: 'overviewParentLinks' },
    h('button', { type: 'button', class: 'overviewHierarchyNavLink', onclick: onClick },
      h('span', { text: label }),
      icon('ChevronRightOutline14', { size: 11, className: 'overviewHierarchyJumpIconTight' })));
}

function overviewSection(label, onOpen, children) {
  return h('section', { class: 'overviewSection' },
    h('h3', { class: 'overviewHeading' },
      h('button', { type: 'button', class: 'overviewTitle', onclick: onOpen },
        h('span', { text: label }),
        icon('ChevronRightOutline14', { size: 12, className: 'overviewTitleIcon' }))),
    h('div', { class: 'overviewPreview summaryScrollRegion', 'data-summary-scroll-region': '' }, children));
}

function markdownFragmentEl(text, rendered, preview = false) {
  if (!rendered) {
    return h('pre', { class: clsx('payload', preview && 'payloadPreview'), text });
  }
  const wrap = h('div', { class: preview ? 'markdownPreview' : 'markdownPayload' });
  wrap.append(markdownFragment(text));
  return wrap;
}

function markdownBlock(text) {
  const wrap = h('div');
  wrap.append(markdownFragment(text));
  return wrap;
}

function markdownSource(record) {
  if (record.cell.kind === 'user' || record.cell.kind === 'context') return record.cell.inputDetail;
  if (record.cell.kind === 'message' || record.cell.kind === 'compacted') return record.cell.outputDetail;
  return undefined;
}

function isMarkdownRecord(record) {
  return record.cell.kind === 'user' || record.cell.kind === 'context' || record.cell.kind === 'message';
}

function detailTabs(record) {
  const cell = record.cell;
  if (cell.kind === 'system') {
    if (cell.promptDetail === undefined && cell.systemPromptDetail !== undefined) {
      return SYSTEM_PROMPT_TABS.filter((tab) => tab.id === 'system-prompt');
    }
    return cell.previousPromptDetail === undefined ? SYSTEM_PROMPT_TABS : SYSTEM_UPDATE_TABS;
  }
  if (cell.kind === 'compacted') {
    return [{ id: 'overview', labelKey: 'tab.summary' }, { id: 'raw', labelKey: 'tab.rawOutput' }];
  }
  if (isMarkdownRecord(record)) {
    return [
      { id: 'overview', labelKey: 'tab.summary' },
      { id: 'rendered', labelKey: 'tab.preview' },
      { id: 'raw', labelKey: 'tab.raw' },
      ...(cell.messageSource === undefined ? [] : [{ id: 'source', labelKey: 'tab.source' }]),
    ];
  }
  return [
    { id: 'overview', labelKey: 'tab.summary' },
    ...(cell.inputDetail ? [{ id: 'input', labelKey: 'tab.payload' }] : []),
    ...(cell.outputDetail ? [{ id: 'output', labelKey: 'tab.result' }] : []),
    { id: 'schema', labelKey: 'tab.schema' },
    { id: 'timing', labelKey: 'tab.timing' },
  ];
}

function tokenRows(cell) {
  const content = cell.output !== undefined && cell.think !== undefined
    ? Math.max(0, cell.output - cell.think) : undefined;
  const frag = document.createDocumentFragment();
  frag.append(overviewRow(tj('usage.tokens'),
    cell.output === undefined ? '—' : tj('unit.tokens', { value: cell.output })));
  if (cell.think !== undefined) {
    frag.append(h('div', { class: 'requestTokenDetail' },
      h('dt', { text: tj('usage.reasoning') }),
      h('dd', { text: tj('unit.tokens', { value: cell.think }) })));
  }
  if (content !== undefined) {
    frag.append(h('div', { class: 'requestTokenDetail' },
      h('dt', { text: tj('usage.content') }),
      h('dd', { text: tj('unit.tokens', { value: content }) })));
  }
  return frag;
}

function formatStartedAt(timestamp) {
  if (timestamp === null || !Number.isFinite(timestamp)) return tj('timing.notAvailable');
  const date = new Date(timestamp);
  const two = (v) => String(v).padStart(2, '0');
  const three = (v) => String(v).padStart(3, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} `
    + `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${three(date.getMilliseconds())}`;
}

function startedAtValue(timestamp) {
  if (timestamp === null || !Number.isFinite(timestamp)) {
    return h('dd', { text: tj('timing.notAvailable') });
  }
  let showUnix = false;
  const button = h('button', {
    type: 'button', class: 'timestampToggle',
    title: tj('timing.showUnixTimestamp'),
    text: formatStartedAt(timestamp),
    onclick: () => {
      showUnix = !showUnix;
      button.textContent = showUnix ? (timestamp / 1000).toFixed(3) : formatStartedAt(timestamp);
      button.title = showUnix ? tj('timing.showLocalTime') : tj('timing.showUnixTimestamp');
    },
  });
  return h('dd', {}, button);
}

function assistantTimingPanel(metrics) {
  const d = h('dl', { class: 'overview' });
  const row = (label, value) => h('div', {}, h('dt', { text: label }), value);
  d.append(
    row(tj('timing.started'), startedAtValue(metrics.stepStartTime)),
    row(tj('timing.totalDuration'), h('dd', { text: totalTime(metrics) })),
    row(tj('timing.ttft'), h('dd', { text: ttft(metrics) })),
    row(tj('timing.generation'), h('dd', { text: generationTime(metrics) })),
    row(tj('timing.throughput'), h('dd', { text: throughput(metrics) })));
  return d;
}

function totalTime(metrics) {
  if (!metrics.timingRecorded) return tj('timing.notRecorded');
  if (metrics.stepStartTime === null) return tj('timing.stepStartUnavailable');
  if (metrics.completedTime === null) return tj('status.pending');
  return formatDurationMs(Math.max(0, metrics.completedTime - metrics.stepStartTime));
}

function ttft(metrics) {
  if (!metrics.timingRecorded) return tj('timing.notRecorded');
  if (metrics.stepStartTime === null) return tj('timing.stepStartUnavailable');
  if (metrics.firstTokenTime === null) return tj('timing.firstTokenUnavailable');
  return formatDurationMs(Math.max(0, metrics.firstTokenTime - metrics.stepStartTime));
}

function generationTime(metrics) {
  if (!metrics.timingRecorded || metrics.firstTokenTime === null) return tj('timing.firstTokenUnavailable');
  if (metrics.completedTime === null) return tj('status.pending');
  return formatDurationMs(Math.max(0, metrics.completedTime - metrics.firstTokenTime));
}

function throughput(metrics) {
  if (!metrics.usageProvided) return tj('timing.usageUnavailable');
  if (metrics.outputTokens === null) return tj('timing.outputTokensUnavailable');
  if (!metrics.timingRecorded || metrics.firstTokenTime === null) return tj('timing.firstTokenUnavailable');
  if (metrics.completedTime === null) return tj('status.pending');
  const seconds = (metrics.completedTime - metrics.firstTokenTime) / 1000;
  if (seconds <= 0) return tj('timing.durationTooShort');
  return tj('unit.tokensPerSecond', { value: (metrics.outputTokens / seconds).toFixed(1) });
}

function recordTiming(record) {
  if (record.cell.kind === 'message' && record.cell.assistantMetrics !== undefined) {
    return assistantTimingPanel(record.cell.assistantMetrics);
  }
  return h('dl', { class: 'overview' },
    h('div', {}, h('dt', { text: tj('timing.started') }), startedAtValue(record.cell.startedAt ?? null)),
    h('div', {}, h('dt', { text: tj('timing.duration') }),
      h('dd', { text: formatElapsedSeconds(record.cell.timeSeconds) })),
    h('div', {}, h('dt', { text: tj('timing.source') }),
      h('dd', {
        text: record.cell.timeSeconds === null ? tj('timing.notAvailable') : tj('timing.sessionTimestamps'),
      })));
}

function recordPayload(record, direction, preview = false) {
  const cell = record.cell;
  const value = direction === 'input' ? cell.inputDetail : cell.outputDetail;
  if (!value) {
    return h('p', { class: 'noPayload', text: direction === 'input' ? tj('record.noPayload') : tj('record.noResult') });
  }
  const error = direction === 'output' && cell.isError === true;
  const payloadClass = clsx(preview ? 'jsonPreview' : 'jsonPayload', error && 'errorPayload');
  const json = parseJsonContainer(value);
  const singleTextResult = direction === 'output' && cell.outputBlocks?.length === 1
    && cell.outputBlocks[0]?.type === 'text';
  if (singleTextResult && json !== undefined) {
    return jsonTree(json, { label: tj('record.resultJson'), className: payloadClass });
  }
  if (direction === 'output'
    && cell.outputBlocks?.some((b) => b.attachment !== undefined || b.content !== '') === true) {
    return toolOutputBlocks(cell.outputBlocks, error, error ? value : undefined, preview);
  }
  const markdown = (direction === 'input' && (cell.kind === 'user' || cell.kind === 'context'))
    || (direction === 'output' && cell.kind === 'message');
  if (markdown) {
    const wrap = h('div', {
      class: clsx(preview ? 'markdownPreview' : 'markdownPayload', error && 'errorPayload'),
    });
    wrap.append(markdownFragment(value));
    return wrap;
  }
  if (json !== undefined) {
    return jsonTree(json, {
      label: tj(direction === 'input' ? 'record.payloadJson' : 'record.outputJson'),
      className: payloadClass,
    });
  }
  return h('pre', {
    class: clsx('payload', preview && 'payloadPreview', error && 'errorPayload',
      value === tj('record.noOutput') && 'noOutputText'),
    text: value,
  });
}

function toolOutputBlocks(blocks, error, errorDetail, preview) {
  const wrap = h('div', { class: clsx('resultBlocks', preview && 'resultBlocksPreview', error && 'errorPayload') });
  if (error && errorDetail) wrap.append(h('pre', { class: 'resultBlockText', text: errorDetail }));
  for (const block of blocks) {
    if (block.attachment !== undefined) wrap.append(renderImages([{ attachment: block.attachment }]));
    else if (block.content !== '') wrap.append(h('pre', { class: 'resultBlockText', text: block.content }));
  }
  return wrap;
}

function recordSchema(record, preview = false) {
  if (!record.cell.schemaDetail) {
    return h('p', { class: 'noPayload', text: tj('record.schemaUnavailable') });
  }
  const schema = parseToolSchema(record.cell.schemaDetail);
  if (schema === undefined) {
    return h('pre', { class: clsx('payload', preview && 'payloadPreview'), text: record.cell.schemaDetail });
  }
  return h('div', { class: clsx('schema', preview && 'schemaPreview') },
    h('header', { class: 'schemaIntro' },
      h('h3', { class: 'schemaName', text: schema.name }),
      h('p', { class: 'schemaDescription', text: schema.description })),
    h('section', { class: 'schemaParameters' },
      h('h4', { class: 'schemaParametersTitle', text: tj('record.parameters') }),
      jsonTree(schema.parameters, {
        label: tj('record.namedParametersJson', { name: schema.name }),
        className: 'schemaTree',
      })));
}

function parseToolSchema(value) {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    if (typeof parsed.name !== 'string' || typeof parsed.description !== 'string'
      || typeof parsed.parameters !== 'object' || parsed.parameters === null
      || Array.isArray(parsed.parameters)) return undefined;
    return { name: parsed.name, description: parsed.description, parameters: parsed.parameters };
  } catch { return undefined; }
}

function parseJsonContainer(value) {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch { return undefined; }
}

function messageSourceLabel(source) {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return tj('source.unknown');
  const kind = source.kind;
  if (kind === 'user') return tj('source.user');
  if (kind === 'plugin') {
    return typeof source.plugin === 'string' && source.plugin !== ''
      ? tj('source.pluginNamed', { plugin: source.plugin }) : tj('source.plugin');
  }
  if (kind === 'goal') {
    return typeof source.round === 'number' && source.round > 0
      ? tj('source.goalRound', { round: source.round }) : tj('source.goal');
  }
  if (typeof kind !== 'string' || kind === '') return tj('source.unknown');
  return `${kind[0].toUpperCase()}${kind.slice(1)}`;
}

function messageSource(record) {
  const source = record.cell.messageSource;
  if (source === undefined) return h('p', { class: 'noPayload', text: tj('source.notRecorded') });
  const data = typeof source === 'object' && source !== null ? source : { value: source };
  return jsonTree(data, { label: tj('source.messageJson'), className: 'jsonPayload' });
}

function sourceBlocks(blocks) {
  const wrap = h('div', { class: 'sourceBlocks' });
  for (const [index, block] of blocks.entries()) {
    const section = h('section', { class: 'sourceBlock' });
    const label = tj('block.label', { index: index + 1, type: block.type });
    if (block.callId !== undefined) {
      section.append(h('button', {
        type: 'button', class: 'sourceBlockJumpTarget',
        'aria-label': tj('block.openSummary', { index: index + 1 }),
        title: tj('block.openSummaryTitle'),
      }, h('span', { class: 'sourceBlockLabel', text: label }),
        icon('ChevronRightOutline14', { size: 12, className: 'sourceBlockJumpIcon' })));
    } else {
      section.append(h('div', { class: 'sourceBlockHeader' },
        h('span', { class: 'sourceBlockLabel', text: label })));
    }
    if (block.attachment !== undefined) section.append(renderImages([{ attachment: block.attachment }]));
    else section.append(h('pre', { class: 'sourceBlockContent', text: block.content }));
    wrap.append(section);
  }
  return wrap;
}

function assistantToolCallsList(blocks, preview = false) {
  const calls = blocks?.filter((block) => block.type === 'tool-call') ?? [];
  if (calls.length === 0) return h('span');
  const list = h('ul', { class: clsx('assistantToolCalls', preview && 'assistantToolCallsPreview') });
  for (const [index, call] of calls.entries()) {
    const button = h('button', {
      type: 'button', class: 'assistantToolCallButton', title: tj('block.openSummaryTitle'),
    }, wrenchGlyph('assistantToolCallIcon'),
      h('span', { class: 'assistantToolCallText' },
        h('span', { class: 'assistantToolCallName', text: call.toolName ?? tj('details.toolCall') }),
        call.content !== '' ? h('span', { class: 'assistantToolCallArgs', text: call.content }) : null));
    list.append(h('li', { ...(call.callId ? { 'data-call-id': call.callId } : {}) }, button));
    void index;
  }
  return list;
}

function toolCatalog(tools) {
  if (tools.length === 0) return h('p', { class: 'noPayload', text: tj('record.toolsMissing') });
  const wrap = h('div', { class: 'toolCatalog' });
  for (const [index, tool] of tools.entries()) {
    const details = h('details', { class: 'toolCatalogItem' });
    details.append(
      h('summary', { class: 'toolCatalogSummary' },
        icon('ChevronRightOutline14', { size: 12, className: 'toolCatalogChevron' }),
        wrenchGlyph('toolCatalogIcon'),
        h('span', { class: 'toolCatalogName', text: tool.name }),
        h('span', { class: 'toolCatalogDescription', text: tool.description })),
      h('div', { class: 'toolCatalogDefinition' },
        tool.description !== '' ? h('p', { class: 'toolCatalogFullDescription', text: tool.description }) : null,
        jsonTree(tool.parameters, {
          label: tj('record.namedParametersJson', { name: tool.name }),
          className: 'toolCatalogTree',
        })));
    wrap.append(details);
    void index;
  }
  return wrap;
}

function systemPromptDiff(before, after) {
  const wrap = h('div', { class: 'promptDiffSections' });
  if (before.system !== after.system) {
    wrap.append(promptDiffSection(tj('record.systemPrompt'), before.system, after.system));
  }
  const toolsBefore = JSON.stringify(before.tools, null, 2);
  const toolsAfter = JSON.stringify(after.tools, null, 2);
  if (toolsBefore !== toolsAfter) {
    wrap.append(promptDiffSection(tj('record.tools'), toolsBefore, toolsAfter));
  }
  return wrap;
}

function promptDiffSection(title, before, after) {
  const lines = diffLines(before, after);
  if (lines.length === 0) return h('span');
  const pre = h('pre', { class: 'promptDiff' });
  for (const line of lines) {
    pre.append(h('span', { class: `promptDiffLine${line.kind}`, text: line.text || ' ' }), '\n');
  }
  return h('section', { class: 'promptDiffSection' },
    h('h3', { class: 'promptDiffTitle', text: title }), pre);
}

/** 附件图片：中转服务器不转发二进制，缓存里有就显示，没有就给个说明块 */
function renderImages(items) {
  const wrap = h('div', { class: 'messageImages' });
  const cache = state.currentSessionId
    ? state.sessions_data.get(state.currentSessionId)?.attachments : null;
  for (const item of items) {
    const attachment = item.attachment ?? {};
    const url = attachment.attachmentId ? cache?.get(attachment.attachmentId) : null;
    if (url) {
      wrap.append(h('img', {
        src: url, alt: attachment.name ?? '图片',
        style: 'max-width:100%;border:0.5px solid var(--dsw-alias-border-l2);border-radius:4px',
      }));
    } else {
      wrap.append(h('span', {
        class: 'noPayload',
        text: attachment.name ? `图片 ${attachment.name}` : '图片（本机未缓存）',
      }));
    }
  }
  return wrap;
}

// ---------------------------------------------------------------- 时间线细节

function timelineRecordDetail(cell) {
  const durationMs = cell.timeSeconds === null || !Number.isFinite(cell.timeSeconds)
    ? undefined : Math.max(0, cell.timeSeconds * 1000);
  const startedAt = cell.startedAt === null || !Number.isFinite(cell.startedAt)
    ? undefined : cell.startedAt;
  return { ...(durationMs === undefined ? {} : { durationMs }), ...(startedAt === undefined ? {} : { startedAt }), ...assistantTimingDetail(cell.assistantMetrics) };
}

function assistantTimingDetail(metrics) {
  const start = metrics?.stepStartTime;
  const first = metrics?.firstTokenTime;
  const completed = metrics?.completedTime;
  if (metrics?.timingRecorded !== true
    || typeof start !== 'number' || typeof first !== 'number' || typeof completed !== 'number'
    || !Number.isFinite(start) || !Number.isFinite(first) || !Number.isFinite(completed)
    || first < start || completed < first) return {};
  return { ttftMs: first - start, decodingMs: completed - first };
}

function timelineKindLabel(kind) {
  return tj(KIND_LABEL_KEY[kind]);
}

function formatRecordedTime(timestamp) {
  const date = new Date(timestamp);
  const two = (v) => String(v).padStart(2, '0');
  const three = (v) => String(v).padStart(3, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${three(date.getMilliseconds())}`;
}

function timelineTooltipLabel(kind, detail) {
  const heading = timelineKindLabel(kind);
  if (detail === undefined) return heading;
  const duration = detail.durationMs === undefined
    ? null : tj('timeline.total', { duration: formatDurationMillisText(detail.durationMs) });
  const range = detail.startedAt === undefined
    ? null
    : detail.durationMs === undefined
      ? tj('timeline.started', { time: formatRecordedTime(detail.startedAt) })
      : `${formatRecordedTime(detail.startedAt)} → ${formatRecordedTime(detail.startedAt + detail.durationMs)}`;
  const segments = detail.ttftMs === undefined || detail.decodingMs === undefined
    ? null
    : tj('timeline.ttftDecoding', {
      ttft: formatDurationMillisText(detail.ttftMs),
      decoding: formatDurationMillisText(detail.decodingMs),
    });
  const timing = [duration, segments].filter((v) => v !== null).join(' · ');
  return [heading, range, timing].filter((v) => v !== null && v !== '').join('\n');
}

function formatDurationMillisText(ms) {
  return tj('unit.milliseconds', {
    value: String(Math.round(ms)).replace(/\B(?=(\d{3})+(?!\d))/g, ','),
  });
}

function centeredRange(center, width, minimum, maximum) {
  const clampedWidth = Math.min(maximum - minimum, Math.max(0, width));
  const start = Math.min(Math.max(center - clampedWidth / 2, minimum), maximum - clampedWidth);
  return { start, end: start + clampedWidth };
}

function wireDetailsResize(handle, view) {
  let drag = null;
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const details = handle.parentElement;
    const split = details?.parentElement;
    if (!split) return;
    const splitWidth = split.getBoundingClientRect().width;
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: details.getBoundingClientRect().width,
      splitWidth,
      startToolRequestOffset: view.toolRequestOffset
        ?? (splitWidth * TOOL_REQUEST_SHARE - defaultToolRequestWidth(splitWidth)),
    };
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  handle.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = clampDetailsWidth(drag.startWidth + drag.startX - event.clientX, drag.splitWidth);
    view.detailsWidth = next;
    view.toolRequestOffset = drag.startToolRequestOffset
      + (next - drag.startWidth) * TOOL_REQUEST_SHARE;
    applyDetailsWidth(handle, view, next);
  });
  handle.addEventListener('pointerup', (event) => {
    if (drag?.pointerId !== event.pointerId) return;
    drag = null;
    handle.releasePointerCapture(event.pointerId);
    view.render();
  });
  handle.addEventListener('pointercancel', () => { drag = null; });
  handle.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const details = handle.parentElement;
    const split = details?.parentElement;
    if (!split) return;
    const direction = event.key === 'ArrowLeft' ? 1 : -1;
    const currentWidth = details.getBoundingClientRect().width;
    const splitWidth = split.getBoundingClientRect().width;
    const next = clampDetailsWidth(currentWidth + direction * DETAILS_RESIZE_STEP, splitWidth);
    const currentOffset = view.toolRequestOffset
      ?? (splitWidth * TOOL_REQUEST_SHARE - defaultToolRequestWidth(splitWidth));
    view.detailsWidth = next;
    view.toolRequestOffset = currentOffset + (next - currentWidth) * TOOL_REQUEST_SHARE;
    applyDetailsWidth(handle, view, next);
    event.preventDefault();
  });
}

function applyDetailsWidth(handle, view, width) {
  const details = handle.parentElement;
  if (details) details.style.width = `${width}px`;
  const split = details?.parentElement;
  if (split && view.toolRequestOffset !== null) {
    split.style.setProperty('--trajectory-tool-request-width',
      `calc(58cqw - ${view.toolRequestOffset}px)`);
  }
}

function clampDetailsWidth(width, splitWidth) {
  const maxWidth = Math.max(DETAILS_MIN_WIDTH,
    Math.min(DETAILS_MAX_WIDTH, splitWidth - TABLE_MIN_WIDTH));
  return Math.round(Math.min(Math.max(width, DETAILS_MIN_WIDTH), maxWidth));
}

function defaultToolRequestWidth(splitWidth) {
  return Math.min(Math.max(
    splitWidth * DEFAULT_TOOL_REQUEST_SHARE - DEFAULT_TOOL_REQUEST_OFFSET,
    TOOL_REQUEST_MIN_WIDTH,
  ), TOOL_REQUEST_MAX_WIDTH);
}
