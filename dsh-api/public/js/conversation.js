/* 对话区：会话头 + 转录 + 输入框。
 *
 * 对应上游 ui-conversation 的 skeleton（ConversationRoot / ConversationSession / InputBar）
 * 与 ui-chat 的 ChatView / MessageItem / ToolRow / TurnProcessNodeView。
 */
import { h, clsx, append, timeAgo, fullTime, baseName, duration, json, copyText, toast, bytes } from './util.js';
import { icon } from './icons.js';
import {
  state, settings, saveSettings, sessionData, openTurnsOf, notify, hasCapability, ADVANCED,
} from './store.js';
import { api } from './api.js';
import {
  buildTranscript, sessionTitle, turnStats, changedFiles, humanDuration, shortNum, tokenStats,
  parseTurnReason, turnReasonLabel, isAbnormalTurnEnd, isTurnFailure,
} from './model.js';
import { markdownFragment, StreamingMarkdown, terminalBlock, diffBlock } from './markdown.js';
import { TrajectoryView } from './trajectory.js';
import { buildTrajectorySnapshot } from './trajectory-model.js';
import { openMenu, openModal, confirmDialog, iconButton, selector } from './ui.js';

/** 工具 → 展示形态。对应上游的 TOOL_VARIANTS 与各 toolview 的标题键。 */
const TOOL_VIEWS = {
  bash: { variant: 'bash', icon: 'ApiOutline14', title: '终端' },
  pwsh: { variant: 'bash', icon: 'ApiOutline14', title: '终端' },
  read: { variant: 'read', icon: 'BrowseOutline16', title: '读取' },
  read_image: { variant: 'read', icon: 'BrowseOutline16', title: '读取图片' },
  write: { variant: 'write', icon: 'EditOutline16', title: '写入' },
  edit: { variant: 'edit', icon: 'EditOutline16', title: '编辑' },
  grep: { variant: 'search', icon: 'SearchOutline16', title: '搜索' },
  glob: { variant: 'search', icon: 'SearchOutline16', title: '查找文件' },
  web_search: { variant: 'search', icon: 'GlobeOutline14', title: '网页搜索' },
  web_fetch: { variant: 'read', icon: 'GlobeOutline14', title: '抓取网页' },
  todo_write: { variant: 'others', icon: 'ChecklistOutline14', title: '待办' },
  ask_user_question: { variant: 'others', icon: 'QuestionOutline14', title: '提问' },
  run_code: { variant: 'code', icon: 'CodeOutline16', title: '运行代码' },
  subagent: { variant: 'others', icon: 'AgentPresetOutline16', title: '子代理' },
  // 历史窗口从中间开始时的孤儿结果（调用在窗口外）
  'tool-result': { variant: 'others', icon: 'InspectOutline12', title: '工具结果' },
};

const FALLBACK_ICON = 'Sparkle16';

function toolView(node) {
  const name = String(node.name || 'tool');
  const base = TOOL_VIEWS[name] || (name.startsWith('subagent') ? TOOL_VIEWS.subagent : null)
    || { variant: 'others', icon: FALLBACK_ICON, title: name };
  const a = node.args || {};

  // 本地 UI 显示的是模型写的意图（"Show the relay's view of this test message"），
  // 不是命令行本身。插件若提供 description 就优先用它（PLUGIN-EXT.md §9.1）。
  if (node.description) return { ...base, summary: String(node.description).split('\n')[0] };

  const path = a.file_path || a.path || a.notebook_path || a.filePath;
  let summary = '';
  if (base.variant === 'bash') summary = a.command || a.cmd || '';
  else if (path) summary = String(path);
  else if (a.pattern) summary = String(a.pattern);
  else if (a.query) summary = String(a.query);
  else if (a.url) summary = String(a.url);
  else if (a.prompt) summary = String(a.prompt);
  else if (a.description) summary = String(a.description);
  return { ...base, summary: String(summary).split('\n')[0] };
}

/** 文件改动行的 +N -M 统计（对应上游 ToolRow 的 diffStat） */
function diffStat(node) {
  const meta = node.result?.meta;
  const added = meta?.added ?? meta?.insertions;
  const removed = meta?.removed ?? meta?.deletions;
  if (added == null && removed == null) return '';
  return `+${added ?? 0} -${removed ?? 0}`;
}

/** 一轮过程折叠按钮的文案，与上游一致：「N 个工具调用 · M 条消息」 */
function processLabel(node) {
  const parts = [];
  if (node.toolCalls) parts.push(`${node.toolCalls} 个工具调用`);
  if (node.messages) parts.push(`${node.messages} 条消息`);
  return parts.length ? parts.join(' · ') : '思考了一会儿';
}

// ---------------------------------------------------------------- 视图状态

const view = {
  host: null,
  handlers: null,
  sessionId: null,
  order: [],
  byKey: new Map(),
  streamMd: null,
  scrollEl: null,
  columnEl: null,
  atBottom: true,
  openTools: new Set(),
  openReasoning: new Set(),
};

/**
 * 渲染整个对话区。
 * @param {HTMLElement} host
 * @param {object} handlers
 */
export function renderConversation(host, handlers) {
  view.host = host;
  view.handlers = handlers;
  view.sessionId = state.currentSessionId;
  view.order = [];
  view.byKey = new Map();
  view.streamMd = null;
  view.openTools = new Set();
  view.openReasoning = new Set();
  view.trajectory = null;
  host.innerHTML = '';

  if (!state.currentInstanceId) {
    host.append(emptyState('先在设置里登记 dsh 实例 key，然后从左上角选择一台机器。'));
    return;
  }
  if (!state.currentSessionId) {
    host.append(heroState(handlers));
    return;
  }

  host.append(renderHeader(handlers));

  if (state.viewMode === 'trajectory') {
    const pane = h('div', { class: 'trajPane' });
    host.append(h('div', { class: 'convBody' }, pane));
    view.trajectory = new TrajectoryView(pane, {
      onLoadOlder: () => handlers.onLoadOlder(),
    });
    refreshTrajectory();
    host.append(renderComposer(handlers));
    return;
  }

  const scroll = h('div', { class: 'convScroll' });
  const column = h('div', { class: 'convColumn' });
  scroll.append(column);
  view.scrollEl = scroll;
  view.columnEl = column;

  scroll.addEventListener('scroll', () => {
    view.atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 24;
  }, { passive: true });

  host.append(h('div', { class: 'convBody' }, scroll));

  const data = sessionData(state.currentSessionId);
  if (data.hasMore) {
    column.append(h('div', { class: 'olderRow' },
      h('button', { class: 'olderButton', onclick: () => handlers.onLoadOlder() }, '加载更早的消息')));
  }

  host.append(renderComposer(handlers));
  refreshTranscript();
}

/**
 * 刷新轨迹视图。
 *
 * 数据来自 `session.events`（PLUGIN-EXT.md §1）——轨迹要的是原始日志的
 * turn/step/tool 起止时间，消息对齐视图给不了。插件不支持时视图自己会
 * 显示空的时间线，不需要在这里兜底。
 */
export function refreshTrajectory() {
  const sid = state.currentSessionId;
  if (!sid || !view.trajectory) return;
  const data = sessionData(sid);
  const base = buildTrajectorySnapshot(data.events, { running: !!data.snapshot?.running });
  view.trajectory.setData({
    snapshot: base,
    live: data.live,
    hasMore: !!data.hasMore,
    historyLoading: !data.loaded,
    onLoadOlder: () => new Promise((resolve) => {
      const before = data.events.length;
      Promise.resolve(view.handlers?.onLoadOlder?.()).then(
        () => resolve(data.events.length > before),
        () => resolve(false),
      );
    }),
  });
}

/** 空状态（连机器都没选） */
function emptyState(text) {
  return h('div', { class: 'hero' }, h('div', { class: 'heroStack' }, h('div', { class: 'heroSub', text })));
}

/** Hero：DeepSeek 标识 + 标题 + 工作目录 chip + 居中输入框 */
function heroState(handlers) {
  const el = h('div', { class: 'hero' });
  const stack = h('div', { class: 'heroStack' },
    h('div', { class: 'heroHeadline' },
      h('span', { class: 'heroAgentMark' }, h('span', {
        class: 'agentBrandMark agentBrandMark--dsh',
        style: '--agent-mark-size:34px',
        dataset: { agentType: 'dsh' },
        title: 'DeepSeek Harness',
      })),
      h('span', { text: 'DeepSeek Harness' }),
      h('span', { class: 'heroPreview', text: '云端中转' })),
    h('div', { class: 'heroSub', text: '选一台机器、选一个工作目录，就能在这里驱动它上面的 dsh。' }));

  // 工作目录 chip：对应上游的 WorkspaceChip
  const heroChips = h('div', { class: 'heroChips' },
    h('button', {
      type: 'button',
      class: 'selector',
      title: '选择新会话的工作目录',
      onclick: (e) => handlers.onPickCwd(e.currentTarget),
    },
      icon(state.heroCwd ? 'FolderOpen16' : 'FolderClose16', { size: 16 }),
      h('span', { text: state.heroCwd ? baseName(state.heroCwd) : '选择工作目录' }),
      icon('ChevronDownOutline14', { size: 14, className: 'chev' })));

  const roster = state.agentPresetRoster;
  if (hasCapability('agentPresets') && roster?.modeSelectionEnabled && roster?.presets?.length) {
    const current = state.heroAgentPreset
      || roster.presets.find((preset) => preset.isDefault)?.id
      || roster.presets[0].id;
    const preset = roster.presets.find((item) => item.id === current);
    heroChips.append(h('button', {
      type: 'button',
      class: 'selector',
      title: '即将开始的这个会话所用的 Agent 预设',
      onclick: (e) => handlers.onPickAgentPreset(e.currentTarget),
    },
      icon('AgentPresetOutline16', { size: 16 }),
      h('span', { text: preset?.name || current }),
      icon('ChevronDownOutline14', { size: 14, className: 'chev' })));
  }
  stack.append(heroChips);

  stack.append(renderComposer(handlers, { hero: true }));
  el.append(stack);
  return el;
}

// ---------------------------------------------------------------- 会话头

function headerBadges(session, snapshot) {
  const badges = [];
  if (session?.running || snapshot?.running) badges.push(h('span', { class: 'badge ok' }, '运行中'));
  if (snapshot?.paused || session?.paused) badges.push(h('span', { class: 'badge warn' }, '已暂停'));
  if (snapshot?.queuedPrompts) badges.push(h('span', { class: 'badge warn' }, `排队 ${snapshot.queuedPrompts}`));
  return badges;
}

function renderHeader(handlers) {
  const s = state.sessions.find((x) => x.sessionId === state.currentSessionId);
  const inst = state.instances.find((i) => i.instanceId === state.currentInstanceId);
  const data = sessionData(state.currentSessionId);
  const snap = data.snapshot || {};
  const title = s ? sessionTitle(s) : state.currentSessionId;
  const presetId = snap.projections?.values?.agentPreset || s?.agentPreset || snap.header?.agentPreset;
  const preset = state.agentPresetRoster?.presets?.find((item) => item.id === presetId);
  const presetLabel = preset?.name || presetId;

  const badges = headerBadges(s, snap);

  // 「对话 / 轨迹」两个视图，对应上游 conversation.view 的注册式视图切换
  const views = [
    { id: 'chat', label: '对话' },
    { id: 'trajectory', label: '轨迹' },
  ];

  return h('header', { class: 'convHeader' },
    h('div', { class: 'convTitleRow' },
      h('div', { class: 'crumbs' },
        h('span', { class: 'crumbMachine' }, icon('PersonalizationOutline16', { size: 13 }),
          inst?.label || inst?.displayName || inst?.instanceId || '未知机器'),
        h('span', { class: 'crumbSep', text: '/' }),
        h('span', { class: 'crumbCurrent', title, text: title }),
        h('span', {
          class: clsx('headerPreset', !presetLabel && 'hidden'),
          title: presetLabel ? `Agent 预设：${presetLabel}` : '',
        }, icon('AgentPresetOutline16', { size: 13 }), h('span', { class: 'headerPresetLabel', text: presetLabel || '' }))),
      h('div', { class: 'headerActions' },
        h('span', { class: 'headerStatus' }, ...badges),
        hasCapability('fileBrowser') ? h('button', {
          type: 'button',
          class: 'btn icon headerFolderButton',
          title: settings.rightbarOpen && settings.rightbarTab === 'files' ? '关闭项目目录' : '查看整个项目目录',
          'aria-label': settings.rightbarOpen && settings.rightbarTab === 'files' ? '关闭项目目录' : '查看整个项目目录',
          'aria-pressed': settings.rightbarOpen && settings.rightbarTab === 'files' ? 'true' : 'false',
          onclick: () => handlers.onToggleRightbar('files'),
        }, icon('FolderOpen16', { size: 15 })) : null,
        iconButton('EllipsisOutline16', '会话操作', (e) => openActionsMenu(e.currentTarget, handlers), 15),
        h('button', {
          type: 'button', class: 'btn icon rightbarExpandButton',
          title: '打开右侧面板', 'aria-label': '打开右侧面板',
          onclick: () => handlers.onToggleRightbar(),
        }, icon('PanelLeftOutline16', { size: 15, className: 'rightbarExpandGlyph' })))),
    h('div', { class: 'convTabs', role: 'tablist' },
      ...views.map((v) => h('button', {
        type: 'button', role: 'tab',
        class: clsx('convTab', v.id === state.viewMode && 'active'),
        'aria-selected': v.id === state.viewMode ? 'true' : 'false',
        onclick: () => { state.viewMode = v.id; notify('layout'); },
      }, v.label))));
}

function openActionsMenu(anchor, handlers) {
  const sid = state.currentSessionId;
  const data = sessionData(sid);
  const snap = data.snapshot || {};
  const paused = !!snap.paused;
  openMenu(anchor, [
    { id: '__refresh', label: '刷新会话状态', icon: 'RefreshOutline16' },
    { separator: true },
    { id: 'interrupt', label: '中断当前轮次', icon: 'StopFill16' },
    { id: 'cancel', label: '取消并清空排队', icon: 'CloseOutline16', danger: true },
    { separator: true },
    paused
      ? { id: 'resume', label: '恢复运行', icon: 'PlayOutline16' }
      : { id: 'pause', label: '暂停运行', icon: 'PauseOutline16' },
    { separator: true },
    { id: 'rename', label: '重命名会话', icon: 'EditOutline16' },
    { id: 'fork', label: '分叉出新会话', icon: 'BranchOutline16' },
    { id: 'history', label: '查看历史消息', icon: 'ClockOutline16' },
    { id: 'search', label: '全文检索', icon: 'SearchOutline16' },
    { separator: true },
    { id: 'policy', label: `审批策略：${snap.approvalPolicy || '默认'}`, icon: 'ShieldOutline16' },
    { id: 'goal', label: '目标（goal）', icon: 'GoalOutline16' },
    { separator: true },
    { id: 'compact', label: '执行 /compact', icon: 'CompactOutline16' },
    { id: 'export', label: '执行 /export', icon: 'DownloadOutline16' },
  ], {
    align: 'end',
    minWidth: 220,
    onSelect: (id) => handlers.onAction(id),
  });
}

// ---------------------------------------------------------------- 转录

/** 增量刷新转录：按 key 做最小改动，流式节点原地更新 */
export function refreshTranscript() {
  const sid = state.currentSessionId;
  if (!sid) return;
  // 轨迹视图不走转录那套增量装配，数据同源但渲染完全独立
  if (state.viewMode === 'trajectory') { refreshTrajectory(); return; }
  if (!view.columnEl || view.sessionId !== sid) return;
  const data = sessionData(sid);
  const nodes = buildTranscript(data.events, data.live, {
    compact: settings.transcript === 'compact',
    openTurns: openTurnsOf(sid),
    // 消息对齐记录没有 turn/end，靠这个判断最后一轮是否已经结束
    running: !!data.snapshot?.running,
  });

  // 待决的审批/提问直接排进转录末尾，不用额外开一个面板
  for (const d of (state.detail?.pendingDecisions || [])) {
    if (d.sessionId && d.sessionId !== sid) continue;
    nodes.push({
      kind: 'decision',
      key: `decision:${d.requestId}`,
      seq: Number.MAX_SAFE_INTEGER,
      time: d.at || d.raisedAt,
      decision: d,
    });
  }

  const keys = nodes.map((n) => n.key);
  const appendOnly = keys.length >= view.order.length
    && view.order.every((k, i) => k === keys[i]);

  if (!appendOnly) {
    // 顺序变了（折叠状态变化、历史前插）：整体重建
    for (const el of view.byKey.values()) el.remove();
    view.byKey.clear();
    view.order = [];
  }

  const frag = document.createDocumentFragment();
  for (const node of nodes) {
    // 单个节点渲染失败不能拖垮整条转录
    try {
      const existing = view.byKey.get(node.key);
      if (existing) {
        updateNode(existing, node);
        continue;
      }
      const el = createNode(node);
      view.byKey.set(node.key, el);
      frag.append(el);
    } catch (err) {
      console.error('[transcript] 节点渲染失败', node.kind, err);
    }
  }
  if (frag.childNodes.length) view.columnEl.append(frag);
  view.order = keys;

  updateComposerChrome();

  if (view.atBottom) {
    view.scrollEl.scrollTop = view.scrollEl.scrollHeight;
  }
}

function createNode(node) {
  const el = wrap(node);
  updateNode(el, node, true);
  return el;
}

function wrap(node) {
  const el = h('div', { class: 'flowItem', dataset: { kind: node.kind, key: node.key } });
  el._node = node;
  return el;
}

function updateNode(el, node, fresh = false) {
  const prev = el._node;
  el._node = node;

  // 折叠态：过程成员用 hidden 收起，保留在 DOM 里让 Ctrl+F 能穿透
  if (node.kind === 'turn-process') {
    if (fresh) el.append(turnProcessEl(node));
    else updateTurnProcess(el.firstElementChild, node);
    return;
  }
  el.hidden = !!node.hidden;

  const render = RENDERERS[node.kind] || renderGeneric;
  if (fresh || prev.kind !== node.kind || !el._rendered) {
    el.innerHTML = '';
    el._rendered = node.kind;
    append(el, [render(node)]);
  } else {
    render(node, el.firstElementChild);
  }
}

const RENDERERS = {
  user: renderUser,
  'assistant-step': renderAssistant,
  tool: renderTool,
  reasoning: renderReasoning,
  'turn-error': renderTurnError,
  'turn-max-tokens': renderTurnMaxTokens,
  'turn-files': renderTurnFiles,
  decision: renderDecision,
};

/**
 * 「本轮文件改动」行，对应本地 UI 轮次末尾那一行
 * 「本轮文件改动 start-relay.cmd README.md」。
 * 远端打不开文件，所以 chip 点击是复制路径而不是打开。
 */
function renderTurnFiles(node, el) {
  if (el) return;
  return h('div', { class: 'changedFiles' },
    h('span', { class: 'cfLabel', text: '本轮文件改动' }),
    ...node.files.map((f) => h('button', {
      type: 'button', class: 'fileChip', title: f.path,
      onclick: () => copyText(f.path).then(() => toast('info', `已复制路径：${f.name}`)),
    },
      icon('CodeOutline16', { size: 11 }),
      h('span', { text: f.name }),
      (f.added != null || f.removed != null)
        ? h('span', { class: 'cfStat', text: `+${f.added ?? 0} -${f.removed ?? 0}` })
        : null)));
}

/**
 * 思考行，对应上游的 ReasoningRow：
 * 折叠时只显示一行摘要（流式中跟最后一行，结束后用第一行），展开才看全文。
 */
function renderReasoning(node, el) {
  if (el) {
    const body = el.querySelector('.reasoningBody');
    if (body) body.textContent = node.text;
    return;
  }
  const open = view.openReasoning.has(node.key);
  const firstLine = () => String(node.text || '').split('\n').find((l) => l.trim()) || '';
  const summary = firstLine().replaceAll('**', '').slice(0, 120);

  const body = h('div', { class: clsx('reasoningBody', !open && 'hidden'), text: node.text });
  const head = h('button', {
    type: 'button', class: 'reasoningSummary', 'aria-expanded': open ? 'true' : 'false',
    onclick: (e) => {
      if (view.openReasoning.has(node.key)) view.openReasoning.delete(node.key); else view.openReasoning.add(node.key);
      body.classList.toggle('hidden');
      e.currentTarget.setAttribute('aria-expanded', body.classList.contains('hidden') ? 'false' : 'true');
    },
  },
    icon('ThinkOutline14', { size: 14 }),
    h('span', { class: 'rLabel', text: '思考' }),
    h('span', { class: 'tSep' }),
    h('span', { class: 'rText', text: summary }),
    h('span', { class: 'tChev', style: 'opacity:1' }, icon('ChevronDownOutline14', { size: 14 })));

  return h('div', { class: 'reasoning' }, head, body);
}

/** 待决审批 / 提问的应答卡片（协议 §9.7） */
function renderDecision(node, el) {
  if (el) return;
  const d = node.decision || {};
  const isQuestion = d.kind === 'question';

  const respond = async (outcome) => {
    try {
      const r = await api.call(state.currentInstanceId, isQuestion ? 'question.answer' : 'approval.respond',
        isQuestion ? { requestId: d.requestId, answers: [] } : { requestId: d.requestId, outcome });
      if (!isQuestion) {
        toast('info', r?.matched === false
          ? '没有匹配到请求（可能已超时或已被本机回答）——属于正常情况'
          : `已应答：${outcome}`);
      }
      notify('instances');
      view.handlers.onAction('__refresh');
    } catch (e) {
      toast('error', `应答失败：${e.message}`);
    }
  };

  return h('div', { class: 'toolBody', style: 'padding:0' },
    h('div', { class: 'composerCard', style: 'gap:10px' },
      h('div', { style: 'display:flex;align-items:center;gap:8px' },
        icon(isQuestion ? 'QuestionOutline14' : 'ShieldOutline16', { size: 16 }),
        h('strong', { style: 'font-size:13px', text: isQuestion ? '需要回答' : '需要审批' }),
        h('span', { class: 'badge warn', text: d.toolName || d.kind || '' }),
        h('span', { class: 'spacer' }),
        h('span', { class: 'tiny muted', text: `requestId ${d.requestId}` })),
      d.reason ? h('div', { class: 'small', style: 'color:var(--dsw-alias-label-secondary)', text: d.reason }) : null,
      h('div', { style: 'display:flex;gap:8px' },
        isQuestion ? null : h('button', {
          class: 'btn primary sm', onclick: () => respond('allowed-once'),
        }, '允许一次'),
        h('button', { class: 'btn outline sm', onclick: () => respond('rejected') }, '拒绝'),
        h('button', { class: 'btn sm', onclick: () => respond('cancelled') }, '取消'))));
}

function renderGeneric(node, el) {
  if (el) return;
  return h('div', { class: 'toolRow' },
    h('div', { class: 'toolHead' },
      h('span', { class: 'tLeading' }, icon(FALLBACK_ICON, { size: 14 })),
      h('span', { class: 'tTitle', text: node.kind })));
}

// ---- 用户消息

function renderUser(node, el) {
  if (el) return;
  return h('div', { class: 'msgUser' },
    h('div', { class: 'userStack' },
      h('div', { class: 'bubble', text: node.text }),
      h('div', { class: 'msgActions right' },
        node.time ? h('span', { class: 'maTime maTimeStart', text: fullTime(node.time) }) : null,
        iconButton('CopyOutline16', '复制', () => copyText(node.text).then(() => toast('info', '已复制')), 14))));
}

// ---- 助手消息

function renderAssistant(node, el) {
  if (el) {
    const mdHost = el.querySelector('.mdHost');
    if (node.streaming && mdHost) {
      if (!el._md) el._md = new StreamingMarkdown(mdHost);
      el._md.update(node.text);
    } else if (el._md) {
      el._md.settle();
      el._md = null;
    }
    el.querySelector('.stoppedTag')?.classList.toggle('hidden', !node.interrupted);
    // 操作行（用时/时间戳/点赞）依赖后到的原始事件，数据变了要重画
    const acts = el.querySelector('.msgActions');
    const next = messageActions(node, state.currentSessionId);
    if (acts && acts.outerHTML !== next.outerHTML) acts.replaceWith(next);
    return;
  }

  const mdHost = h('div', { class: 'md mdHost' });
  const stack = h('div', { class: 'assistant' }, mdHost,
    node.interrupted ? h('span', { class: 'stoppedTag', text: '已中断' }) : null);

  stack.append(messageActions(node, state.currentSessionId));

  if (node.streaming) {
    const r = new StreamingMarkdown(mdHost);
    r.update(node.text);
    stack._md = r;
  } else {
    mdHost.append(markdownFragment(node.text));
  }
  return stack;
}

/**
 * 助手消息下方的操作行，对应本地 UI 的
 * 「复制 · 👍 · 👎 · 用时 43 秒 · 9月14日 18:15」。
 * 反馈按钮只在插件报了 messageFeedback 时出现；用时依赖原始事件。
 * @param {object} node 助手节点
 * @param {string} sid
 */
function messageActions(node, sid) {
  const data = sid ? sessionData(sid) : null;
  const row = h('div', { class: 'msgActions' });

  row.append(iconButton('CopyOutline16', '复制', () => copyText(node.text).then(() => toast('info', '已复制')), 14));

  if (hasCapability('sessionFork') && node.logSeq != null && !node.streaming) {
    row.append(iconButton('BranchOutline16', '从这里分支', () => view.handlers.onBranchMessage(node), 14));
  }

  if (data && hasCapability('messageFeedback')) {
    // 必须用日志真实序号：node.seq 是本地递增的节点 key 计数，插件不认
    const seq = node.logSeq;
    const cur = seq != null ? data.feedback.get(seq) : null;
    row.append(
      h('button', {
        type: 'button', class: clsx('btn icon', cur === 'like' && 'voted'), title: '有帮助',
        'aria-pressed': cur === 'like' ? 'true' : 'false',
        onclick: () => view.handlers.onFeedback(seq, 'like'),
      }, icon('LikeOutline16', { size: 14 })),
      h('button', {
        type: 'button', class: clsx('btn icon', cur === 'dislike' && 'voted'), title: '没帮助',
        'aria-pressed': cur === 'dislike' ? 'true' : 'false',
        onclick: () => view.handlers.onFeedback(seq, 'dislike'),
      }, icon('DislikeOutline16', { size: 14 })));
  }

  // 分支、用量、用时与时间都与本地消息尾部一致，且彼此独立显示。
  if (node.usage) {
    const usage = usageText(node.usage);
    if (usage) row.append(h('span', { class: 'maUsage', title: usage.detail }, icon('ApiOutline14', { size: 12 }), h('span', { text: usage.label })));
  }
  const dur = node.durationMs ?? (node.turn != null ? turnDuration(node.turn) : null);
  if (dur != null) {
    row.append(h('span', { class: 'maCost' }, icon('ClockOutline16', { size: 12 }), h('span', { text: `用时 ${humanDuration(dur)}` })));
  }
  if (node.time) {
    row.append(h('span', { class: 'maTime', text: fullTime(node.time) }));
  }
  return row;
}

let statsCache = { sid: null, at: 0, byTurn: new Map() };

/** 某一轮的耗时（毫秒）；没有原始事件时返回 null */
function turnDuration(turn) {
  const sid = state.currentSessionId;
  if (!sid) return null;
  if (statsCache.sid !== sid || Date.now() - statsCache.at > 2000) {
    const byTurn = new Map();
    for (const t of turnStats(sessionData(sid).trace)) byTurn.set(t.turn, t.durationMs);
    statsCache = { sid, at: Date.now(), byTurn };
  }
  return statsCache.byTurn.get(turn) ?? null;
}

function usageText(usage) {
  const input = Number(usage.inputTokens ?? usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const output = Number(usage.outputTokens ?? usage.completion_tokens ?? usage.output_tokens ?? 0);
  const cacheRead = Number(usage.cacheReadTokens ?? usage.cache_read_tokens ?? 0);
  const cacheWrite = Number(usage.cacheWriteTokens ?? usage.cache_write_tokens ?? 0);
  const total = Number(usage.totalTokens ?? usage.total_tokens ?? (input + output + cacheRead + cacheWrite));
  if (!total && !input && !output) return null;
  return {
    label: `用量 ${total.toLocaleString()} token`,
    detail: `输入 ${input.toLocaleString()} · 输出 ${output.toLocaleString()}${cacheRead ? ` · 缓存读取 ${cacheRead.toLocaleString()}` : ''}${cacheWrite ? ` · 缓存写入 ${cacheWrite.toLocaleString()}` : ''}`,
  };
}

// ---- 工具行

function renderTool(node, el) {
  if (el) {
    el.className = clsx('toolRow', node.state, view.openTools.has(node.key) && 'open');
    return;
  }
  const info = toolView(node);
  const open = view.openTools.has(node.key);
  let body = null;

  const head = h('button', {
    type: 'button', class: 'toolHead', 'aria-expanded': open ? 'true' : 'false',
    onclick: (e) => {
      if (view.openTools.has(node.key)) view.openTools.delete(node.key); else view.openTools.add(node.key);
      const rowEl = e.currentTarget.parentElement;
      rowEl.classList.toggle('open');
      body.classList.toggle('hidden');
    },
  },
    h('span', { class: 'tLeading' }, node.state === 'running'
      ? icon('LoadingOutline16', { size: 14 })
      : icon(info.icon, { size: 14 })),
    h('span', { class: 'tTitle', text: info.title }),
    info.summary ? h('span', { class: 'tSep' }) : null,
    info.summary ? h('span', { class: 'tSummary', text: info.summary }) : null,
    diffStat(node) ? h('span', { class: 'tStat', text: diffStat(node) }) : null,
    h('span', { class: 'tChev' }, icon('ChevronDownOutline14', { size: 14 })));

  body = h('div', { class: clsx('toolBody', !open && 'hidden') });
  body.append(...toolBodyParts(node));

  return h('div', { class: clsx('toolRow', node.state, open && 'open') }, head, body);
}

function toolBodyParts(node) {
  const parts = [];
  const args = node.args || {};
  const resultText = node.result?.text ?? '';

  if (node.name === 'edit' || node.name === 'write') {
    const patch = args.patch || args.diff || args.new_string || resultText;
    if (patch) parts.push(diffBlock(String(patch), { maxLines: 24 }));
    if (args.old_string && args.new_string && !args.patch) {
      parts.length = 0;
      parts.push(diffBlock(String(args.old_string).split('\n').map((l) => `-${l}`)
        .concat(String(args.new_string).split('\n').map((l) => `+${l}`)).join('\n'), { maxLines: 24 }));
    }
  } else if (resultText) {
    parts.push(terminalBlock(resultText, { maxLines: 20 }));
  }

  const input = primaryArg(node, args);
  if (input) {
    parts.push(h('div', { class: 'ioCard' },
      h('span', { class: 'ioLabel', text: '输入' }), h('span', { class: 'ioText', text: input })));
  }
  if (node.result?.error) {
    parts.push(h('div', { class: 'ioCard' },
      h('span', { class: 'ioLabel', text: '错误' }),
      h('span', { class: 'ioText', dataset: { error: '1' }, text: json(node.result.error, 2, 1200) })));
  }
  if (!parts.length) parts.push(h('div', { class: 'tiny muted', text: '（无输出）' }));
  return parts;
}

function primaryArg(node, args) {
  const v = args.command || args.query || args.pattern || args.url || args.prompt;
  return typeof v === 'string' && v.length > 1 ? v : '';
}

// ---- 轮次折叠

function turnProcessEl(node) {
  return h('button', {
    type: 'button',
    class: 'turnProcess',
    dataset: node.open ? { open: '1' } : {},
    'aria-expanded': node.open ? 'true' : 'false',
    onclick: () => {
      const set = openTurnsOf(state.currentSessionId);
      if (set.has(node.turn)) set.delete(node.turn); else set.add(node.turn);
      refreshTranscript();
    },
  },
    h('span', { text: processLabel(node) }),
    icon('ChevronDownOutline14', { size: 14, className: 'tpChev' }));
}

function updateTurnProcess(el, node) {
  if (!el) return;
  if (node.open) el.setAttribute('data-open', '1'); else el.removeAttribute('data-open');
  el.firstElementChild.textContent = processLabel(node);
}

// ---- 轮次错误

/**
 * 本轮失败 / 达到输出上限。
 *
 * 对应上游 ui-chat 的 `turn-error` 与 `turn-max-tokens` 两个节点
 * （conversation-nodes/turn-error.ts、turn-max-tokens.ts 与 MessageItem.tsx）：
 * 只在 `reason.kind === 'error'` 时报错，`max-tokens` 走另一套提示，
 * `aborted` / `interrupted` / `blocked` 都是正常终止，不该弹错误。
 */
function renderTurnError(node, el) {
  if (el) return;
  const r = parseTurnReason(node.reason);
  return h('div', { class: 'turnErrorRow', role: 'status' },
    h('span', { class: 'stateDot turnErrorDot error' }),
    h('div', { class: 'turnErrorCopy' },
      h('span', { class: 'turnErrorTitle', text: '本轮运行失败' }),
      r.message ? h('span', { class: 'turnErrorMessage', text: r.message }) : null),
    r.code ? h('code', { class: 'turnErrorCode', text: r.code }) : null);
}

function renderTurnMaxTokens(node, el) {
  if (el) return;
  return h('div', { class: 'turnErrorRow', role: 'status' },
    h('span', { class: 'stateDot turnErrorDot warn' }),
    h('div', { class: 'turnErrorCopy' },
      h('span', { class: 'turnErrorTitle maxTokens', text: '已达到输出 token 上限' }),
      h('span', { class: 'turnErrorMessage', text: '回答被截断，已有输出保留在对话中。发送“继续”可让模型接着输出。' })));
}

// ---------------------------------------------------------------- 输入框

function modelPresentation(selection) {
  if (!selection?.model) return { modelName: '模型', effortName: '', label: '模型', title: '选择模型' };
  const groups = state.modelCatalog?.groups || [];
  let entry;
  for (const group of groups) {
    const provider = group?.provider ?? group?.id ?? '';
    if (selection.provider && provider !== selection.provider) continue;
    entry = (group?.models || group?.items || []).find((model) => (model.id ?? model.model) === selection.model);
    if (entry) break;
  }
  const effortId = selection.reasoningEffort ?? entry?.reasoning?.defaultEffort;
  const effort = entry?.reasoning?.efforts?.find((item) => item.id === effortId);
  const modelName = entry?.label ?? entry?.displayName ?? entry?.name ?? selection.model;
  const effortName = effort?.name ?? (effortId ? effortId[0].toUpperCase() + effortId.slice(1) : '');
  return {
    modelName,
    effortName,
    label: `${modelName}${effortName ? ` · ${effortName}` : ''}`,
    title: `${selection.provider || ''}/${selection.model}${effortName ? ` · ${effortName}` : ''}`,
  };
}

function defaultModelSelection() {
  const cat = state.modelCatalog;
  const def = cat?.default;
  if (!def?.model) return null;
  let declared;
  for (const group of cat?.groups || []) {
    const provider = group?.provider ?? group?.id ?? '';
    if (def.provider && provider !== def.provider) continue;
    declared = (group?.models || group?.items || []).find((model) => (model.id ?? model.model) === def.model);
    if (declared) break;
  }
  return {
    provider: def.provider || '',
    model: def.model,
    reasoningEffort: def.reasoningEffort ?? declared?.reasoning?.defaultEffort,
  };
}

function renderComposer(handlers, { hero = false } = {}) {
  const sid = state.currentSessionId;
  // hero 态没有会话，这里给一个空壳，避免下面到处判空
  const data = (sid && sessionData(sid)) || {
    snapshot: {}, feedback: new Map(), permission: state.heroPermission || settings.defaultPermission,
  };
  const snap = data.snapshot || {};
  const isRunning = () => !!(sid && sessionData(sid).snapshot?.running);
  const running = isRunning();
  // hero 态也允许直接输入：发出去时先建会话，和本地 dsh 的手感保持一致
  const usable = !!state.currentInstanceId;
  const pending = [];
  let send = null;

  const updateSubmitState = () => {
    if (!send) return;
    const active = isRunning();
    const canSubmit = usable && (active || input.value.trim() !== '' || pending.length > 0);
    send.disabled = !canSubmit;
    send.classList.toggle('stop', active);
    send.setAttribute('aria-label', active ? '中断' : '发送');
    send.title = active ? '中断当前轮次' : '发送';
    send.innerHTML = '';
    send.append(active
      ? h('svg', { viewBox: '0 0 16 16', width: '14', height: '14', 'aria-hidden': 'true' },
        h('rect', { x: '3', y: '3', width: '10', height: '10', rx: '3', fill: 'currentColor' }))
      : icon('SendOutline16', { size: 15 }));
  };

  const submit = async (buttonClick = false) => {
    if (buttonClick && isRunning()) { handlers.onInterrupt(); return; }
    if (!input.value.trim() && !pending.length) return;
    const accepted = await handlers.onSend(input.value, mode(), [...pending]);
    if (accepted === false) return;
    input.value = '';
    input.style.height = 'auto';
    pending.splice(0);
    renderAttachChips();
    updateSubmitState();
  };

  const input = h('textarea', {
    class: 'composerInput',
    rows: '1',
    placeholder: !usable ? '先在设置里登记一台机器'
      : hero ? '给 DeepSeek Harness 下发一条指令，会新建一个会话…（Enter 发送，Shift+Enter 换行）'
        : '给 DeepSeek Harness 下发一条指令…（Enter 发送，Shift+Enter 换行）',
    disabled: !usable,
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 336)}px`;
    updateSubmitState();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.shiftKey) return;                       // Shift+Enter 无条件换行
    if (e.isComposing || e.keyCode === 229) return; // 输入法组合中
    e.preventDefault();
    if (e.repeat) return;
    void submit(false);
  });

  const modeSel = h('button', { type: 'button', class: 'pillButton', title: '运行中按下发时的行为' },
    icon('QueueOutline14', { size: 14 }), h('span', { text: '队列' }));

  let submitMode = settings.submitMode === 'steer' ? 'steer' : 'queue';
  modeSel.lastElementChild.textContent = submitMode === 'queue' ? '队列' : '插话';
  modeSel.addEventListener('click', () => {
    openMenu(modeSel, [
      { id: 'queue', label: '排队发送', meta: '作为新一轮执行', selected: submitMode === 'queue' },
      { id: 'steer', label: '插话发送', meta: '喂给正在跑的那一轮', selected: submitMode === 'steer' },
    ], { onSelect: (id) => { submitMode = id; modeSel.lastElementChild.textContent = id === 'queue' ? '队列' : '插话'; } });
  });
  const mode = () => submitMode;

  // 显示成「模型名 High」这样，对应本地 UI 的 "DeepSeek-V41-Flash High"
  const modelSelection = hero ? (state.heroModel || defaultModelSelection()) : (snap.model || defaultModelSelection());
  const modelView = modelPresentation(modelSelection);
  const modelBtn = h('button', {
    type: 'button', class: 'pillButton modelTrigger', title: modelView.title,
    'aria-haspopup': 'menu',
  },
    icon('DataOutline16', { size: 14, className: 'modelTriggerIcon' }),
    h('span', { class: 'modelLabel', text: modelView.modelName }),
    h('span', { class: clsx('modelEffort', !modelView.effortName && 'hidden'), text: modelView.effortName }),
    icon('ChevronDownOutline14', { size: 12, className: 'modelChevron' }));
  modelBtn.addEventListener('click', () => handlers.onPickModel(modelBtn));

  // 附件：只在插件报了 attachments 能力时出现（PLUGIN-EXT.md §4）
  const fileInput = h('input', { type: 'file', multiple: true, style: 'display:none' });
  fileInput.addEventListener('change', async () => {
    for (const f of fileInput.files || []) {
      const out = await handlers.onAttach(f);
      if (out) pending.push(out);
    }
    fileInput.value = '';
    renderAttachChips();
    updateSubmitState();
  });
  const chips = h('div', { class: 'attachChips' });
  const renderAttachChips = () => {
    chips.innerHTML = '';
    for (const [i, a] of pending.entries()) {
      chips.append(h('span', { class: 'attachChip' },
        icon(a.kind === 'image' ? 'BrowseOutline16' : 'CodeOutline16', { size: 12 }),
        h('span', { text: a.name }),
        h('button', {
          type: 'button', class: 'acRemove', 'aria-label': '移除', onclick: () => {
            pending.splice(i, 1); renderAttachChips(); updateSubmitState();
          },
        }, icon('CloseOutline16', { size: 11 }))));
    }
  };
  const attachBtn = hasCapability('attachments')
    ? h('button', {
      type: 'button', class: 'pillButton', title: '添加附件（图片或文件）',
      onclick: () => fileInput.click(),
    }, icon('PaperclipOutline16', { size: 14 }))
    : null;

  // 权限预设：插件报了才出现（PLUGIN-EXT.md §3）
  const permLabels = { 'read-only': '只读', 'workspace-write': '工作区内修改', 'full-access': '完全权限' };
  const permBtn = hasCapability('permissionPresets')
    ? h('button', {
      type: 'button',
      class: clsx('pillButton', data.permission === 'full-access' && 'warn'),
      title: '会话权限预设',
      onclick: (e) => {
        const opts = (data.permissionAvailable || ['read-only', 'workspace-write', 'full-access'])
          .map((p) => ({ id: p, label: permLabels[p] || p, selected: data.permission === p }));
        openMenu(e.currentTarget, [{ title: '本机执行权限' }, ...opts], {
          onSelect: (p) => handlers.onPermission(p),
        });
      },
    }, icon('ShieldOutline16', { size: 14 }), h('span', { text: permLabels[data.permission] || '权限' }))
    : null;

  const currentRow = sid ? state.sessions.find((item) => item.sessionId === sid) : null;
  const currentPreset = snap.projections?.values?.agentPreset || currentRow?.agentPreset || snap.header?.agentPreset;
  const roster = state.agentPresetRoster;
  const presetRow = roster?.presets?.find((preset) => preset.id === currentPreset);
  const agentPresetBtn = sid && currentRow?.blank && hasCapability('agentPresets')
    && roster?.modeSelectionEnabled && roster?.presets?.length
    ? h('button', {
      type: 'button', class: 'pillButton', title: '这个空白会话使用的 Agent 预设',
      onclick: (e) => handlers.onPickAgentPreset(e.currentTarget),
    }, icon('AgentPresetOutline16', { size: 14 }), h('span', { text: presetRow?.name || currentPreset || 'Agent 预设' }))
    : null;

  send = h('button', {
    type: 'button', class: clsx('sendButton', running && 'stop'),
    'aria-label': running ? '中断' : '发送',
    title: running ? '中断当前轮次' : '发送',
    disabled: !usable || !running,
    onclick: () => { void submit(true); },
  }, running
    ? h('svg', { viewBox: '0 0 16 16', width: '14', height: '14', 'aria-hidden': 'true' },
      h('rect', { x: '3', y: '3', width: '10', height: '10', rx: '3', fill: 'currentColor' }))
    : icon('SendOutline16', { size: 15 }));

  const card = h('div', { class: 'composerCard' },
    fileInput,
    chips,
    input,
    h('div', { class: 'composerRow' },
      h('div', { class: 'composerTools' },
        h('button', {
          type: 'button', class: 'pillButton', title: '输入斜杠命令',
          onclick: () => handlers.onSlash(input),
        }, icon('PlusOutline16', { size: 14 }), h('span', { text: '命令' })),
        attachBtn,
        sid ? modeSel : null,
        agentPresetBtn,
        permBtn),
      h('div', { class: 'composerTrailing' },
        hasCapability('modelCatalog') ? modelBtn : null,
        send)));

  // 统计条与权限标签都依赖后到的数据，先留槽位，之后由 updateComposerChrome 增量刷
  view.permBtn = permBtn;
  view.modelBtn = modelBtn;
  view.sendBtn = send;
  view.composerInput = input;
  view.pendingAttachments = pending;
  view.updateSubmitState = updateSubmitState;
  view.statsHost = hero ? null : h('div', { class: 'composerStatsHost' });
  queueMicrotask(() => { updateComposerChrome(); updateSubmitState(); });

  return h('div', { class: clsx('composerWrap', hero && 'heroComposer') }, card, view.statsHost);
}

/**
 * 刷新输入框上依赖异步数据的部分：底部统计条、权限预设标签。
 * 输入框本身只在建/切会话时重建，这两处不能只算一次。
 */
export function updateComposerChrome() {
  const headerStatus = document.querySelector('.headerStatus');
  if (headerStatus && state.currentSessionId) {
    const data = sessionData(state.currentSessionId);
    const row = state.sessions.find((item) => item.sessionId === state.currentSessionId);
    headerStatus.replaceChildren(...headerBadges(row, data.snapshot || {}));
  }

  const headerPreset = document.querySelector('.headerPreset');
  if (headerPreset && state.currentSessionId) {
    const data = sessionData(state.currentSessionId);
    const row = state.sessions.find((item) => item.sessionId === state.currentSessionId);
    const presetId = data.snapshot?.projections?.values?.agentPreset
      || row?.agentPreset || data.snapshot?.header?.agentPreset;
    const preset = state.agentPresetRoster?.presets?.find((item) => item.id === presetId);
    const label = preset?.name || presetId || '';
    const labelEl = headerPreset.querySelector('.headerPresetLabel');
    if (labelEl && labelEl.textContent !== label) labelEl.textContent = label;
    headerPreset.classList.toggle('hidden', !label);
    headerPreset.title = label ? `Agent 预设：${label}` : '';
  }

  const permLabels = { 'read-only': '只读', 'workspace-write': '工作区内修改', 'full-access': '完全权限' };
  const btn = view.permBtn;
  if (btn && document.body.contains(btn)) {
    const cur = state.currentSessionId
      ? sessionData(state.currentSessionId).permission
      : (state.heroPermission || settings.defaultPermission);
    const label = btn.querySelector('span');
    const want = permLabels[cur] || '权限';
    if (label && label.textContent !== want) label.textContent = want;
    btn.classList.toggle('warn', cur === 'full-access');
  }

  const modelBtn = view.modelBtn;
  if (modelBtn && document.body.contains(modelBtn)) {
    const selection = state.currentSessionId
      ? (sessionData(state.currentSessionId).snapshot?.model || defaultModelSelection())
      : (state.heroModel || defaultModelSelection());
    const presentation = modelPresentation(selection);
    const label = modelBtn.querySelector('.modelLabel');
    if (label && label.textContent !== presentation.modelName) label.textContent = presentation.modelName;
    const effort = modelBtn.querySelector('.modelEffort');
    if (effort) {
      if (effort.textContent !== presentation.effortName) effort.textContent = presentation.effortName;
      effort.classList.toggle('hidden', !presentation.effortName);
    }
    modelBtn.title = presentation.title;
  }

  view.updateSubmitState?.();

  const host = view.statsHost;
  if (!host || !document.body.contains(host)) return;
  const el = statsBar(state.currentSessionId);
  host.innerHTML = '';
  if (el) host.append(el);
}

/**
 * 卡片下方的统计条，对应本地 UI 的
 * 「7 轮 · 470 步 · 281 tok/s」＋「191M tok · 缓存命中 99.9%」。
 * 步数与速率依赖 `session.events`，拿不到就只显示能算出来的部分。
 */
function statsBar(sid) {
  if (!sid) return null;
  const data = sessionData(sid);
  const nodes = buildTranscript(data.events, data.live, {
    compact: settings.transcript === 'compact', openTurns: new Set(), running: !!data.snapshot?.running,
  });
  const turns = nodes.filter((n) => n.kind === 'user').length;
  const stats = turnStats(data.trace);
  const steps = stats.reduce((a, t) => a + t.steps, 0);
  const last = stats.filter((t) => t.tokPerSec).slice(-1)[0];
  const values = data.snapshot?.projections?.values;
  const tok = tokenStats(values) || tokFromProjection(data.projection);

  const left = [];
  if (turns) left.push(`${turns} 轮`);
  if (steps) left.push(`${steps} 步`);
  if (last?.tokPerSec) left.push(`${last.tokPerSec.toFixed(0)} tok/s`);

  const right = [];
  if (tok?.total) right.push(`${shortNum(tok.total)} tok`);
  if (tok?.cacheHit != null) right.push(`缓存命中 ${(tok.cacheHit * 100).toFixed(1)}%`);

  if (!left.length && !right.length) return null;
  return h('div', { class: 'composerStats' },
    h('span', { text: left.join(' · ') }),
    h('span', { class: 'spacer' }),
    h('span', { text: right.join(' · ') }));
}

/** tokenUsage 也可能来自先前并回会话行的投影 */
function tokFromProjection(proj) {
  return proj?.tokenUsage ? tokenStats({ tokenUsage: proj.tokenUsage }) : null;
}
