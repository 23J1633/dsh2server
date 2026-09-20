/* 控制台入口：装配外壳、接管事件流、串起自动刷新。 */
import { h, clsx, append, toast, json, copyText } from './util.js';
import { icon } from './icons.js';
import {
  state, settings, saveSettings, sessionData, openTurnsOf, notify, subscribe,
  isSidebarCollapsed, currentInstance, hasCapability,
} from './store.js';
import { api, adminKey, openStream, ApiError } from './api.js';
import { renderSidebar } from './sidebar.js';
import { renderConversation, refreshTranscript } from './conversation.js';
import { openSettings, applyTheme, refreshSettings } from './settings.js';
import { openModal, openMenu, confirmDialog, promptDialog, closeMenu } from './ui.js';
import { renderRightbar } from './rightbar.js';

// ---------------------------------------------------------------- 外壳

const root = document.getElementById('root');
const sidebarCol = h('div', { class: 'sidebarCol' });
const mainCol = h('div', { class: 'centerCol' });
const rightCol = h('div', { class: 'rightbarCol' });
const frame = h('div', { class: 'frame' }, sidebarCol, mainCol, rightCol);
root.append(frame);

/** 右侧栏宽度：对齐上游以视口比例为主，并给常用桌面宽度留出合理上下限。 */
function rightbarWidth() {
  return Math.max(340, Math.min(680, Math.round(window.innerWidth * 0.42)));
}

function layout() {
  // 上游 columns.ts：左侧展开 280（264–420），折叠成 56 的 icon rail；
  // 右侧栏默认不占轨道，打开时从右边缘展开一段固定宽度
  const w = isSidebarCollapsed() ? 56 : 280;
  const showRightbar = settings.rightbarOpen && !!state.currentSessionId;
  const fullscreenRightbar = showRightbar && window.innerWidth < 768;
  const r = showRightbar && !fullscreenRightbar ? rightbarWidth() : 0;
  frame.style.gridTemplateColumns = `${w}px minmax(0, 1fr) ${r}px`;
  frame.toggleAttribute('data-rightbar', showRightbar);
  frame.toggleAttribute('data-rightbar-fullscreen', fullscreenRightbar);
  frame.dataset.rightbarTab = showRightbar ? settings.rightbarTab : '';
  const folderButton = mainCol.querySelector('.headerFolderButton');
  if (folderButton) {
    const filesOpen = showRightbar && settings.rightbarTab === 'files';
    folderButton.title = filesOpen ? '关闭项目目录' : '查看整个项目目录';
    folderButton.setAttribute('aria-label', folderButton.title);
    folderButton.setAttribute('aria-pressed', filesOpen ? 'true' : 'false');
  }
  renderRightbar(rightCol, handlers);
}

/** 主区外壳只在「机器 + 会话」这个组合变化时才重建，其余时候只增量刷转录 */
let shellKey = null;

function ensureShell() {
  // hero 态的工作目录、以及「对话 / 轨迹」视图都要进 key：变了就得重画整个主区
  // 当前会话标题也要参与 key，否则重命名后只会重画侧边栏，
  // 面包屑会一直保留旧标题直到重新打开会话。
  const selected = state.currentSessionId
    ? state.sessions.find((session) => session.sessionId === state.currentSessionId)
    : null;
  const selectedTitle = selected?.title ?? selected?.projections?.values?.title ?? '';
  const key = `${state.currentInstanceId}|${state.currentSessionId}|${state.viewMode}|${selectedTitle}`
    + `|${state.currentSessionId ? '' : [
      state.heroCwd ?? '',
      state.heroAgentPreset ?? '',
      state.heroModel ? `${state.heroModel.provider}/${state.heroModel.model}/${state.heroModel.reasoningEffort || ''}` : '',
      state.heroPermission ?? '',
      state.agentPresetRoster?.presets?.map((preset) => `${preset.id}:${preset.isDefault ? 1 : 0}`).join(',') || '',
      state.modelCatalog?.default ? `${state.modelCatalog.default.provider}/${state.modelCatalog.default.model}` : '',
    ].join('|')}`;
  if (key === shellKey) return false;
  shellKey = key;
  renderConversation(mainCol, handlers);
  return true;
}

/** 统一的重新渲染：侧边栏整体重画，主区按需重画 */
function redraw(what) {
  if (what === 'layout' || what === undefined || what === 'instances' || what === 'sessions') {
    layout();
    renderSidebar(sidebarCol, handlers);
  }
  // 'layout' 也要走这一支：切换「对话 / 轨迹」视图、开关右侧栏都要重画主区
  if (what === 'layout' || what === 'sessions' || what === 'instances'
      || what === 'session' || what === 'transcript' || what === undefined) {
    if (!ensureShell() && state.currentSessionId) refreshTranscript();
    if (settings.rightbarOpen && what !== 'instances') renderRightbar(rightCol, handlers);
  }
}

subscribe((what) => {
  if (what === 'settings') { applyTheme(); }
  redraw(what);
});

window.addEventListener('resize', () => {
  state.narrowExpanded = false;
  layout();
  renderSidebar(sidebarCol, handlers);
});

// ---------------------------------------------------------------- 事件处理

const handlers = {
  onSelectMachine,
  onNewSession,
  onOpenSession,
  onOpenSettings: (section) => { closeMenu(); openSettings(section); },
  onRefresh: () => refreshSessions(true),
  onSearch: () => searchSessions(),
  onAddWorkspace: (anchor) => workspaceMenu(anchor, null),
  onForkSession: (s) => forkSession(s.sessionId),
  onBranchMessage: (node) => forkSession(state.currentSessionId, node.logSeq),
  onRenameSession: (s) => renameSession(s.sessionId, s.title),
  onArchiveSession: archiveSession,
  onArchiveHint: (msg) => toast('info', msg),
  onSend: (text, mode, attachments) => sendPrompt(text, mode, attachments),
  onPickCwd: (anchor) => pickHeroCwd(anchor),
  onPickAgentPreset: (anchor) => pickAgentPreset(anchor),
  onInterrupt: interrupt,
  onPickModel: pickModel,
  onSlash: openSlashMenu,
  onLoadOlder: loadOlder,
  onRefreshSession: refreshCurrentSession,
  onAction: (id) => actionMenu(id),
  // 扩展能力（插件没报能力位时，这些回调不会被触发）
  onFeedback: sendFeedback,
  onPermission: setPermission,
  onAttach: uploadAttachment,
  onWorkspaceMenu: workspaceMenu,
  onToggleRightbar: toggleRightbar,
  onTerminalOpen: terminalOpen,
  onTerminalWrite: terminalWrite,
  onTerminalResize: terminalResize,
  onTerminalClose: terminalClose,
};

// ---------------------------------------------------------------- 引导

async function boot() {
  applyTheme();
  layout();
  renderSidebar(sidebarCol, handlers);
  renderConversation(mainCol, handlers);

  if (!adminKey.get()) {
    openSettings('general');
    toast('info', '需要管理密钥：请读取服务端数据目录的 admin-key.txt。', 10000);
    return;
  }
  await reloadAll();
  connect();
  startAutoRefresh();
  // 立即拉一次会话列表，别等第一个自动刷新周期
  if (state.currentInstanceId) refreshSessions(false);
}

async function reloadAll() {
  try {
    await api.health();
  } catch (e) {
    if (e instanceof ApiError && e.code === 'unauthorized') {
      toast('error', '管理密钥无效');
      openSettings('general');
      return;
    }
  }
  await loadInstances();
  if (state.currentInstanceId) await loadDetail();
}

async function loadInstances() {
  try {
    state.instances = await api.instances();
  } catch (e) {
    if (e instanceof ApiError && e.code !== 'unauthorized') toast('error', `读取机器列表失败：${e.message}`);
    return;
  }
  const stillThere = state.instances.some((i) => i.instanceId === state.currentInstanceId);
  if (!stillThere) {
    const first = state.instances.find((i) => i.online) || state.instances[0];
    state.currentInstanceId = first ? first.instanceId : '';
    localStorage.setItem('dshInstance', state.currentInstanceId);
    state.detail = null;
    state.sessions = [];
    state.currentSessionId = null;
  }
  notify('instances');
}

async function loadDetail() {
  if (!state.currentInstanceId) return;
  try {
    state.detail = await api.instance(state.currentInstanceId);
    state.sessions = state.detail.sessions || [];
    const [roster, catalog, workspaces] = await Promise.all([
      hasCapability('agentPresets')
        ? api.call(state.currentInstanceId, 'agentPreset.list').catch(() => null)
        : Promise.resolve(null),
      hasCapability('modelCatalog')
        ? api.call(state.currentInstanceId, 'session.modelCatalog').catch(() => null)
        : Promise.resolve(null),
      hasCapability('workspaceRegistry')
        ? api.call(state.currentInstanceId, 'workspace.list').catch(() => null)
        : Promise.resolve(null),
    ]);
    state.agentPresetRoster = roster;
    state.modelCatalog = catalog;
    if (workspaces) {
      state.detail.workspaces = workspaces;
      const hostArchived = new Set(workspaces.archivedSessionIds || []);
      if (hostArchived.size) state.sessions = state.sessions.filter((row) => !hostArchived.has(row.sessionId));
    }
    if (state.currentSessionId && !state.sessions.some((row) => row.sessionId === state.currentSessionId)) {
      state.currentSessionId = null;
      state.currentCwd = null;
    }
    notify('sessions');
  } catch (e) {
    if (e instanceof ApiError && e.code === 'not_found') {
      state.detail = null;
      state.sessions = [];
      notify('sessions');
    }
  }
}

// ---------------------------------------------------------------- 实时流

let stream = null;

function connect() {
  stream?.close();
  stream = openStream({
    onState: (ok, detail) => {
      state.connected = ok;
      state.connDetail = detail || '';
      notify('sessions');
      refreshSettings();
    },
    onInstances: (list) => {
      state.instances = list;
      notify('instances');
    },
    onLink: () => { scheduleDetailRefresh(); },
    onArchives: ({ instanceId }) => {
      if (instanceId === state.currentInstanceId) scheduleDetailRefresh(100);
    },
    onFrame: handleFrame,
  });
}

function handleFrame({ instanceId, frame, dir = 'in' }) {
  if (instanceId !== state.currentInstanceId) return;
  state.frames.push({ frame, dir, at: Date.now() });
  if (state.frames.length > 1500) state.frames.splice(0, state.frames.length - 1500);
  if (frame.type !== 'event') return;

  const d = frame.data || {};
  const sid = frame.sessionId || d.sessionId || null;

  switch (frame.kind) {
    case 'session/status':
      updateSessionRow(sid, { running: !!d.running, status: d.status });
      break;
    case 'session/activity':
      updateSessionRow(sid, { updatedAt: d.updatedAt ?? frame.ts });
      break;
    case 'session/created':
    case 'session/added':
    case 'session/removed':
    case 'session/disposed':
      scheduleDetailRefresh(500);
      break;
    case 'session/error':
      updateSessionRow(sid, { lastError: d.message });
      break;
    case 'session/paused':
    case 'session/resumed':
      if (sid) {
        const data = sessionData(sid);
        if (data.snapshot) data.snapshot.paused = frame.kind === 'session/paused' && d.paused !== false;
        if (sid === state.currentSessionId) mergeSnapshot({ paused: data.snapshot?.paused });
      }
      scheduleDetailRefresh(400);
      break;
    case 'session/approval-policy':
      if (sid === state.currentSessionId) mergeSnapshot({ approvalPolicy: d.policy });
      break;
    case 'session/snapshot':
      if (sid) { sessionData(sid).snapshot = d; mergeProjections(sid, d); }
      if (sid === state.currentSessionId) { mergeSnapshot(d); }
      break;
    case 'session/permission':
      if (sid) sessionData(sid).permission = d.preset ?? null;
      if (sid === state.currentSessionId) notify('transcript');
      break;
    case 'agent-preset/changed':
      if (d.action === 'selected' && sid) {
        const data = sessionData(sid);
        if (data.snapshot?.header) data.snapshot.header.agentPreset = d.agentPreset;
        const row = state.sessions.find((item) => item.sessionId === sid);
        if (row) row.agentPreset = d.agentPreset;
      } else {
        api.call(state.currentInstanceId, 'agentPreset.list').then((roster) => {
          state.agentPresetRoster = roster;
          notify('transcript');
          refreshSettings();
        }).catch(() => {});
      }
      if (sid === state.currentSessionId) notify('transcript');
      break;
    case 'message/feedback':
      if (sid) sessionData(sid).feedback.set(d.seq, d.rating);
      if (sid === state.currentSessionId) notify('transcript');
      break;
    case 'workspace/changed':
      scheduleDetailRefresh(400);
      break;
    case 'plugin/changed':
      refreshSettings();
      break;
    case 'terminal/output':
      onTerminalOutput(d);
      break;
    case 'terminal/exit':
      onTerminalExit(d);
      break;
    case 'session/event':
      if (!sid) break;
      ingestSessionEvent(sid, d);
      break;
    case 'session/assistant-stream':
      if (!sid) break;
      ingestStream(sid, d.frame);
      break;
    case 'todos/changed':
      if (sid) sessionData(sid).todos = d.todos || [];
      break;
    case 'jobs/changed':
      scheduleDetailRefresh(600);
      break;
    case 'approval/request':
      toast('info', `收到审批请求：${d.toolName || ''} ${d.reason || ''}`.trim(), 9000);
      scheduleDetailRefresh(300);
      if (sid === state.currentSessionId) appendDecisionNode(sid, d);
      break;
    case 'question/request':
      toast('info', `收到提问：${d.toolName || ''}`.trim(), 9000);
      scheduleDetailRefresh(300);
      if (sid === state.currentSessionId) appendDecisionNode(sid, d);
      break;
    case 'bridge/resync':
      toast('info', '插件要求重新拉全量，正在重新同步…');
      refreshSessions(true);
      break;
    default:
      break;
  }
}

let detailTimer = null;
function scheduleDetailRefresh(ms = 300) {
  if (detailTimer) return;
  detailTimer = setTimeout(() => { detailTimer = null; loadDetail(); }, ms);
}

function updateSessionRow(sid, patch) {
  if (!sid) return;
  const row = state.sessions.find((s) => s.sessionId === sid);
  if (row) Object.assign(row, patch);
  notify('sessions');
}

function mergeSnapshot(patch) {
  const data = sessionData(state.currentSessionId);
  data.snapshot = { ...(data.snapshot || {}), ...patch };
  notify('session');
}

/** 单次拉取的历史消息条数（协议上限 500） */
const HISTORY_PAGE = 200;
/** 单次拉取的原始事件条数（PLUGIN-EXT.md §1.2 的 limit，上限 2000） */
const TRACE_PAGE = 800;

/**
 * 把一页消息对齐历史并进本地事件表。
 *
 * 这一页是合成的消息视图：`seq` 是页内序号而不是日志序号，`time` 也可能是 0。
 * 统一压成负序号，既保住页内顺序，又保证它们排在实时事件（正序号）之前。
 * @param {object} data sessionData 缓存
 * @param {Array} records 本页事件，按时间升序
 * @param {boolean} [prepend] true 表示这是「更早的一页」，插到最前面
 * @returns {boolean} 是否真的加进了新内容
 */
function applyHistoryPage(data, records, prepend = false) {
  const base = prepend ? (data.events[0]?.seq ?? 0) - records.length : -records.length;
  const stamped = records.map((ev, i) => ({ ...ev, seq: base + i }));
  const live = data.events.filter((e) => (e.seq || 0) > 0);

  if (prepend) {
    // 「更早的一页」：按内容去重后插到最前面
    const before = new Set(data.events.filter((e) => (e.seq || 0) <= 0)
      .map((e) => `${e.type}:${JSON.stringify(e.data)}`));
    const fresh = stamped.filter((e) => !before.has(`${e.type}:${JSON.stringify(e.data)}`));
    if (!fresh.length) return false;
    data.events = [...fresh, ...data.events];
  } else {
    // 重新拉基线：整段替换历史部分，保留已经收到的实时事件
    data.events = [...stamped, ...live];
  }
  data.seen = new Set(data.events.map((e) => `${e.type}:${e.seq}:${e.time}`));
  // 供 beforeSeq 翻页用：本页里最大的「页内序号」
  data.pageMinSeq = Math.max(0, ...records.map((e) => (Number.isFinite(e.seq) ? e.seq : 0)));
  return true;
}

/** 持久事件：写进本地日志并刷新转录 */
function ingestSessionEvent(sid, event) {
  const data = sessionData(sid);
  // 去重键要带上类型：合成记录的 seq 可能重复，光看 seq 会误杀
  const key = `${event.type}:${event.seq}:${event.time}`;
  if (!data.seen) data.seen = new Set();
  if (data.seen.has(key)) return;
  data.seen.add(key);
  data.events.push(event);
  data.events.sort((a, b) => (a.seq || 0) - (b.seq || 0));

  // 实时事件同样是「原始日志」，要并进 trace：
  // 否则轨迹视图、每轮用时、步数、tok/s 在新建的会话上永远是空的
  if (!data.trace.some((e) => e.seq === event.seq)) {
    data.trace.push({ type: event.type, seq: event.seq, time: event.time, data: event.data });
    data.trace.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  }

  // 助手消息落库后，实时流式缓冲就作废了
  if (event.type === 'assistant/message' || event.type === 'turn/end') {
    if (data.live) { data.live = null; }
  }
  if (sid === state.currentSessionId) notify('transcript');
  else notify('sessions');
}

/** 逐 token 流式片段 */
function ingestStream(sid, f) {
  if (!f) return;
  const data = sessionData(sid);
  if (!data.live || data.live.revision !== f.revision) {
    data.live = { revision: f.revision, text: '', streaming: true, attemptId: f.attemptId };
  }
  if (f.type === 'start') data.live.text = '';
  else if (f.type === 'chunk') data.live.text += chunkText(f.chunk);
  else if (f.type === 'end') { data.live.streaming = false; data.live.outcome = f.outcome || null; }
  if (sid === state.currentSessionId) notify('transcript');
}

/** 与 model.js 的取法保持一致：chunk 结构由模型适配器决定 */
function chunkText(chunk) {
  if (!chunk || typeof chunk !== 'object') return '';
  const d = chunk.delta || chunk.choices?.[0]?.delta || chunk.message?.delta || chunk;
  const pick = (v) => {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join('');
    if (v && typeof v === 'object' && typeof v.text === 'string') return v.text;
    return '';
  };
  for (const k of ['content', 'text', 'reasoning_content', 'reasoning']) {
    const t = pick(d?.[k]);
    if (t) return t;
  }
  return '';
}

function appendDecisionNode(sid, d) {
  const data = sessionData(sid);
  data.decisions = data.decisions || [];
  if (!data.decisions.some((x) => x.requestId === d.requestId)) data.decisions.push(d);
  notify('transcript');
}

// ---------------------------------------------------------------- 自动刷新

let refreshTimer = null;

function startAutoRefresh() {
  stopAutoRefresh();
  if (!settings.autoRefreshMs) return;
  refreshTimer = setInterval(() => {
    if (document.visibilityState !== 'visible' || !state.connected) return;
    refreshSessions(false);
  }, settings.autoRefreshMs);
}

function stopAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshSessions(false);
});

/**
 * 重新拉取会话列表与机器详情。
 * @param {boolean} loud 手动触发时给反馈
 */
async function refreshSessions(loud) {
  if (!state.currentInstanceId) {
    if (loud) toast('info', '还没有选中机器');
    return;
  }
  try {
    const items = await api.call(state.currentInstanceId, 'session.list');
    if (items?.items) state.sessions = items.items;
    state.lastRefreshAt = Date.now();
    if (loud) toast('info', `已刷新，共 ${state.sessions.length} 个会话`);
  } catch (e) {
    if (loud) toast('error', `刷新失败：${e.message}`);
  } finally {
    await loadDetail();
  }
}

// ---------------------------------------------------------------- 机器与会话

async function onSelectMachine(instanceId) {
  if (instanceId === state.currentInstanceId) return;
  state.currentInstanceId = instanceId;
  localStorage.setItem('dshInstance', instanceId);
  state.detail = null;
  state.sessions = [];
  state.currentSessionId = null;
  state.heroAgentPreset = null;
  state.heroModel = null;
  state.heroPermission = null;
  state.agentPresetRoster = null;
  state.modelCatalog = null;
  state.sessions_data.clear();
  state.openTurns.clear();
  state.frames = [];
  notify('instances');
  await loadDetail();
  refreshSessions(false);
}

async function onOpenSession(sid) {
  if (state.currentSessionId === sid) return;
  state.currentSessionId = sid;
  notify('sessions');

  const data = sessionData(sid);
  data.loaded = false;
  data.events = [];
  data.live = null;

  // 1) 先用服务器侧缓存把界面填起来
  try {
    const cached = await api.sessionEvents(state.currentInstanceId, sid);
    if (Array.isArray(cached.items) && cached.items.length) data.events = cached.items;
    if (cached.stream?.text) data.live = { revision: cached.stream.revision, text: cached.stream.text, streaming: false };
    if (cached.snapshot) data.snapshot = cached.snapshot;
    notify('transcript');
  } catch { /* 缓存拿不到不影响 */ }

  // 2) 订阅这个会话的逐条事件 + 流式片段
  api.subscribe(state.currentInstanceId, { sessions: [sid], assistantStream: true, snapshot: true }).catch(() => {});

  // 3) 拿一次基线，然后按 throughSeq 拉完整历史
  await refreshCurrentSession();
}

async function refreshCurrentSession() {
  const sid = state.currentSessionId;
  if (!sid || !state.currentInstanceId) return;
  const data = sessionData(sid);
  try {
    const snap = await api.call(state.currentInstanceId, 'session.get', { sessionId: sid });
    if (snap) { data.snapshot = snap; mergeProjections(sid, snap); notify('session'); }
    const row = state.sessions.find((session) => session.sessionId === sid);
    const throughSeq = [
      snap?.seq,
      snap?.projections?.asOfSeq,
      row?.projections?.asOfSeq,
      data.snapshot?.seq,
      data.snapshot?.projections?.asOfSeq,
    ].find(Number.isFinite) ?? 1;

    // 有 session.events 就先拉原始日志窗口：它同时喂转录、时长统计和轨迹视图
    let loaded = false;
    if (hasCapability('sessionEvents')) {
      loaded = await loadTrace(sid, throughSeq);
    }
    if (!loaded) {
      const hist = await api.call(state.currentInstanceId, 'session.history', {
        sessionId: sid, throughSeq, maxMessages: HISTORY_PAGE,
      });
      const records = (hist?.records || []).map((r) => r.event).filter(Boolean);
      if (records.length) {
        // 消息对齐记录是合成视图：它的 seq 是「本页内的消息序号」，不是日志序号，
        // 直接当 seq 用会和实时事件的正序号打架。统一压成负序号，
        // 既保住数组顺序，又保证排在实时事件之前。
        applyHistoryPage(data, records);
      }
      data.hasMore = !!hist?.hasMore;
    }
    data.loaded = true;
    loadFeedback(sid);
    loadPermission(sid);
  } catch (e) {
    if (e.code === 'capability_unavailable') toast('info', '这台机器没有会话持久化能力，只能看到实时事件');
    else if (e.code !== 'session_not_found') toast('error', `读取会话失败：${e.message}`);
  }
  notify('transcript');
}

/**
 * 拉一页原始事件窗口（PLUGIN-EXT.md §1）。成功时这份数据同时用于：
 * 转录装配、每轮时长/步数统计、轨迹视图。失败一律静默降级到 session.history。
 * @returns {Promise<boolean>} 是否拿到了数据
 */
async function loadTrace(sid, throughSeq) {
  const data = sessionData(sid);
  try {
    const out = await api.call(state.currentInstanceId, 'session.events', {
      sessionId: sid, throughSeq, limit: TRACE_PAGE,
    });
    const events = Array.isArray(out?.events) ? out.events : [];
    if (!events.length) return false;
    data.trace = events;
    data.traceHasMore = !!out.hasMore;
    data.oldestSeq = out.oldestSeq ?? events[0]?.seq ?? null;
    data.hasMore = !!out.hasMore;
    // 原始事件直接当转录输入：它有真实 seq/time，比消息对齐视图完整得多
    const live = data.events.filter((e) => (e.seq || 0) > 0 && !events.some((x) => x.seq === e.seq));
    data.events = [...events, ...live];
    data.seen = new Set(data.events.map((e) => `${e.type}:${e.seq}:${e.time}`));
    return true;
  } catch (e) {
    if (e.code !== 'capability_unavailable' && e.code !== 'unknown_method') {
      toast('error', `读取会话事件失败，已降级：${e.message}`);
    }
    return false;
  }
}

/** 把 session.get / session/snapshot 的投影并回会话行（标题、token 用量都在这儿） */
function mergeProjections(sid, snap) {
  const values = snap?.projections?.values;
  if (!values) return;
  const row = state.sessions.find((s) => s.sessionId === sid);
  const patch = {};
  if (values.title) patch.title = values.title;
  if (values.tokenUsage) patch.tokenUsage = values.tokenUsage;
  if (values.contextPressure) patch.contextPressure = values.contextPressure;
  if (values.contextBreakdown) patch.contextBreakdown = values.contextBreakdown;
  if (values.agentPreset) patch.agentPreset = values.agentPreset;
  if (Object.keys(patch).length) {
    if (row) Object.assign(row, patch);
    sessionData(sid).projection = { ...(sessionData(sid).projection || {}), ...patch };
  }
}

/** 读一次权限预设（PLUGIN-EXT.md §3） */
async function loadPermission(sid) {
  if (!hasCapability('permissionPresets')) return;
  const data = sessionData(sid);
  try {
    const out = await api.call(state.currentInstanceId, 'session.permission', { sessionId: sid });
    data.permission = out?.preset ?? null;
    data.permissionAvailable = out?.available ?? null;
    if (sid === state.currentSessionId) notify('transcript');
  } catch { /* 没实现就跳过 */ }
}

/** 拉一次已有评价（PLUGIN-EXT.md §2.2 B；A 方案会在事件里自带） */
async function loadFeedback(sid) {
  if (!hasCapability('messageFeedback')) return;
  const data = sessionData(sid);
  try {
    const out = await api.call(state.currentInstanceId, 'message.feedback.list', { sessionId: sid });
    for (const it of out?.items || []) if (it?.seq != null) data.feedback.set(it.seq, it.rating);
  } catch { /* 插件没实现就跳过，属于正常降级 */ }
}

async function loadOlder() {
  const sid = state.currentSessionId;
  const data = sessionData(sid);
  if (!sid) return;
  try {
    const snap = data.snapshot || {};
    const hist = await api.call(state.currentInstanceId, 'session.history', {
      sessionId: sid,
      throughSeq: Number.isFinite(snap.seq) ? snap.seq : 1,
      beforeSeq: data.pageMinSeq ?? undefined,
      maxMessages: HISTORY_PAGE,
    });
    const records = (hist?.records || []).map((r) => r.event).filter(Boolean);
    if (!records.length) { toast('info', '没有更早的消息了'); data.hasMore = false; notify('transcript'); return; }
    const added = applyHistoryPage(data, records, true);
    if (!added) {
      toast('info', '服务器没有返回更早的消息（消息对齐视图只能取到这一页）');
      data.hasMore = false;
    }
    notify('transcript');
  } catch (e) {
    toast('error', `加载更早的消息失败：${e.message}`);
  }
}

/**
 * 新建会话。
 *
 * 两件事必须做对，否则会出现「新会话跑到未分组下、而且第一轮直接报错」：
 *   1. 带上 cwd —— 不带的话会话不属于任何工作区，会落到「未分组」；
 *   2. 补一个模型 —— 插件建的会话默认没有模型路由，首轮组装提示词时
 *      `{{model}}` 取不到值会直接失败。
 * @param {string|null} cwd 工作目录；null 表示用工号里最近一个会话的 cwd
 * @returns {Promise<string|null>} 新会话 id
 */
async function createSession(cwd = null) {
  if (!state.currentInstanceId) { toast('info', '先在设置里登记一台机器'); return null; }
  const target = cwd || defaultCwd();
  try {
    const defaultPreset = state.agentPresetRoster?.presets?.find((preset) => preset.isDefault)?.id
      ?? state.agentPresetRoster?.presets?.[0]?.id;
    const agentPreset = state.heroAgentPreset || defaultPreset || null;
    const createParams = {
      ...(target ? { cwd: target } : {}),
      ...(agentPreset ? { agentPreset } : {}),
    };
    const created = await api.call(state.currentInstanceId, 'session.create', createParams);
    const sid = created?.sessionId;
    if (!sid) { toast('error', '新建会话失败：插件没有返回 sessionId'); return null; }
    // 复制一个可用模型路由过去
    try {
      const cat = state.modelCatalog || await api.call(state.currentInstanceId, 'session.modelCatalog', {});
      state.modelCatalog = cat;
      const def = state.heroModel || defaultModelOf(cat);
      if (def?.model) {
        await api.call(state.currentInstanceId, 'session.selectModel', {
          sessionId: sid, provider: def.provider, model: def.model, reasoningEffort: def.reasoningEffort,
        });
      }
    } catch { /* 插件不支持选模型就算了，交给 dsh 自己的默认值 */ }
    try {
      const preset = state.heroPermission || settings.defaultPermission;
      if (preset && hasCapability('permissionPresets')) {
        await api.call(state.currentInstanceId, 'session.permission', { sessionId: sid, preset });
      }
    } catch { /* 部署自己的默认权限仍然有效 */ }
    state.heroAgentPreset = null;
    state.heroModel = null;
    state.heroPermission = null;
    await refreshSessions(false);
    return sid;
  } catch (e) {
    toast('error', `新建会话失败：${e.message}`);
    return null;
  }
}

/** 新会话默认落在哪个工作目录：优先 hero 里选的，其次最近一个会话的 cwd */
function defaultCwd() {
  if (state.heroCwd) return state.heroCwd;
  const latest = [...state.sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  return latest?.cwd || null;
}

async function onNewSession() {
  if (!state.currentInstanceId) { toast('info', '先在设置里登记一台机器'); return false; }
  const cwds = await knownCwds();
  const fallback = defaultCwd();
  const anchor = sidebarCol.querySelector('.newSession') || sidebarCol;
  openMenu(anchor, [
    { title: '在哪个工作目录新建会话' },
    ...cwds.map((c) => ({
      id: `cwd:${c}`, label: c.split(/[\\/]/).filter(Boolean).pop() || c, meta: c,
      icon: 'FolderOpen16', selected: c === fallback,
    })),
    ...(cwds.length ? [{ separator: true }] : []),
    { id: 'manual', label: '手动输入目录…', icon: 'EditOutline16' },
  ], {
    minWidth: 340,
    onSelect: async (id) => {
      let cwd = fallback;
      if (id === 'manual') {
        const v = prompt('工作目录（留空则用 dsh 的默认目录）：', fallback || cwds[0] || '');
        if (v === null) return;
        cwd = v.trim() || null;
      } else if (id.startsWith('cwd:')) {
        cwd = id.slice(4);
      }
      const sid = await createSession(cwd);
      if (sid) { toast('info', `已新建会话`); await onOpenSession(sid); }
    },
  });
}

/** hero 态的工作目录选择（对应上游的 WorkspaceChip 菜单） */
async function pickHeroCwd(anchor) {
  const cwds = await knownCwds();
  openMenu(anchor, [
    { title: '新会话的工作目录' },
    ...cwds.map((c) => ({ id: `cwd:${c}`, label: c.split(/[\\/]/).filter(Boolean).pop() || c, meta: c, icon: 'FolderOpen16', selected: c === state.heroCwd })),
    ...(cwds.length ? [{ separator: true }] : []),
    { id: 'manual', label: '手动输入目录…', icon: 'EditOutline16' },
  ], {
    minWidth: 340,
    onSelect: (id) => {
      if (id === 'manual') {
        const v = prompt('工作目录（留空则用 dsh 的默认目录）：', state.heroCwd || cwds[0] || '');
        if (v === null) return;
        state.heroCwd = v.trim() || null;
      } else if (id.startsWith('cwd:')) {
        state.heroCwd = id.slice(4);
      }
      notify('transcript');
    },
  });
}

async function knownCwds() {
  const fromSessions = state.sessions.map((s) => s.cwd).filter(Boolean);
  const ws = state.detail?.workspaces?.items?.map((w) => w.path).filter(Boolean) || [];
  return [...new Set([...ws, ...fromSessions])];
}

// ---------------------------------------------------------------- 会话操作

async function sendPrompt(text, mode, attachments = []) {
  const value = String(text || '').trim();
  const files = Array.isArray(attachments) ? attachments.filter((item) => item?.attachmentId) : [];
  if (!value && !files.length) return false;
  if (!state.currentInstanceId) { toast('info', '先在设置里登记一台机器'); return false; }

  // hero 态直接输入：先建会话再发，和本地 dsh 的手感一致
  let sid = state.currentSessionId;
  if (!sid) {
    sid = await createSession(null);
    if (!sid) return false;
    await onOpenSession(sid);
  }

  const content = [
    ...(value ? [{ type: 'text', text: value }] : []),
    ...files.map((item) => ({
      type: item.kind === 'image' ? 'image' : 'file',
      attachmentId: item.attachmentId,
      ...(item.name ? { name: item.name } : {}),
    })),
  ];
  const params = {
    sessionId: sid,
    content,
    mode: mode || 'queue',
    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  try {
    const out = await api.call(state.currentInstanceId, 'session.prompt', params);
    if (out?.deferred) toast('info', `会话已暂停，消息排在第 ${out.position} 位`);
    // 乐观回显：插件也会推 user/message，这里靠 seq 去重不会重复
    return true;
  } catch (e) {
    if (e.code === 'session_paused') {
      toast('error', '会话处于暂停，先恢复或勾选强行投递');
    } else {
      toast('error', `下发失败：${e.message}`);
    }
    return false;
  }
}

async function interrupt() {
  const sid = state.currentSessionId;
  if (!sid) return;
  try {
    await api.call(state.currentInstanceId, 'session.interrupt', { sessionId: sid });
    toast('info', '已请求中断');
  } catch (e) { toast('error', e.message); }
}

async function renameSession(sid, current) {
  const title = prompt('新的会话标题：', current || '');
  if (!title) return;
  try {
    await api.call(state.currentInstanceId, 'session.rename', { sessionId: sid, title });
    toast('info', '已重命名');
    await refreshSessions(false);
  } catch (e) { toast('error', e.message); }
}

async function forkSession(sid, atSeq) {
  const anchored = Number.isSafeInteger(atSeq);
  if (!await confirmDialog('分叉会话', anchored ? '从这条回复处分叉出一个新会话？' : '从该会话分叉出一个新会话？', '分叉')) return;
  try {
    const out = await api.call(state.currentInstanceId, 'session.fork', {
      sessionId: sid,
      ...(anchored ? { atSeq } : {}),
    });
    toast('info', `已分叉：${out.sessionId}`);
    await refreshSessions(false);
    await onOpenSession(out.sessionId);
  } catch (e) { toast('error', e.message); }
}

/**
 * Archive a session in this relay, optionally mirroring the archive to DSH.
 * Host mirroring uses DSH's official workspace archive API: it hides the
 * session locally but deliberately leaves the durable log intact.
 */
function archiveSession(session) {
  const hostAvailable = hasCapability('sessionArchive');
  let scope = 'server';
  let busy = false;
  const options = [];
  const submit = h('button', { type: 'button', class: 'btn primary' }, '归档');

  const update = () => {
    for (const option of options) {
      const selected = option.dataset.scope === scope;
      option.classList.toggle('selected', selected);
      option.setAttribute('aria-checked', selected ? 'true' : 'false');
    }
  };
  const choice = (value, title, description, disabled = false) => {
    const option = h('button', {
      type: 'button',
      class: 'archiveChoice',
      role: 'radio',
      'aria-checked': value === scope ? 'true' : 'false',
      disabled,
      dataset: { scope: value },
      onclick: () => { if (!disabled && !busy) { scope = value; update(); } },
    },
      h('span', { class: 'archiveChoiceMark', 'aria-hidden': 'true' }),
      h('span', { class: 'archiveChoiceText' },
        h('strong', { text: title }),
        h('span', { text: description })));
    options.push(option);
    return option;
  };

  const modal = openModal({
    title: '归档会话',
    width: '480px',
    body: h('div', { class: 'archiveDialog' },
      h('div', { class: 'archiveSessionName', text: session.title || session.sessionId }),
      h('div', { class: 'archiveChoices', role: 'radiogroup', 'aria-label': '归档范围' },
        choice('server', '仅从此服务器归档', '只在当前服务器隐藏；主机本地仍然保留并可继续使用。'),
        choice('host', '同时从主机归档', hostAvailable
          ? '当前服务器和主机本地列表都会隐藏；遵循 DSH 官方语义，主机日志仍会保留。'
          : '当前插件不支持主机归档，请更新并重启 dsh 后再使用。', !hostAvailable)),
      h('div', { class: 'archiveNotice', text: '归档不会删除工作目录中的项目文件。' })),
    footer: [
      h('button', { type: 'button', class: 'btn outline', onclick: () => { if (!busy) modal.close(); } }, '取消'),
      submit,
    ],
  });
  update();

  submit.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    submit.disabled = true;
    submit.textContent = '正在归档…';
    for (const option of options) option.disabled = true;
    try {
      await api.archiveSession(state.currentInstanceId, session.sessionId, scope);
      if (state.currentSessionId === session.sessionId) {
        state.currentSessionId = null;
        state.currentSessionCwd = null;
      }
      modal.close();
      await loadDetail();
      notify('layout');
      toast('info', scope === 'host' ? '已在服务器和主机归档' : '已从此服务器归档');
    } catch (error) {
      busy = false;
      submit.disabled = false;
      submit.textContent = '归档';
      for (const option of options) option.disabled = option.dataset.scope === 'host' && !hostAvailable;
      toast('error', `归档失败：${error.message}`);
    }
  });
}

/**
 * 展开模型目录里的所有可选模型。
 *
 * 协议只约定 `{ default, routableProviders, groups, failures }`，`groups` 的内部形状
 * 各适配器写法不一，所以这里把见过的几种都认一遍：
 *   groups[].models[]、groups[].items[]、groups[] 本身就是模型、以及顶层 models[]。
 * @returns {Array<{provider:string, model:string, label:string, effort:string|null}>}
 */
function flattenModels(cat) {
  const out = [];
  const push = (provider, m) => {
    const id = m?.id ?? m?.model ?? m?.name;
    if (!id) return;
    out.push({
      provider: provider || m.provider || '',
      model: String(id),
      label: m.label ?? m.displayName ?? m.name ?? String(id),
      efforts: Array.isArray(m.reasoning?.efforts) ? m.reasoning.efforts : [],
      defaultEffort: m.reasoning?.defaultEffort ?? m.reasoningEffort ?? null,
    });
  };
  const groups = Array.isArray(cat?.groups) ? cat.groups : [];
  for (const g of groups) {
    const provider = g?.provider ?? g?.id ?? '';
    const models = g?.models ?? g?.items;
    if (Array.isArray(models)) for (const m of models) push(provider, m);
    else if (g?.model || g?.id) push(provider, g);
  }
  if (Array.isArray(cat?.models)) for (const m of cat.models) push(m.provider, m);
  return out;
}

/** 目录默认模型，补上模型条目声明的默认推理等级。 */
function defaultModelOf(cat) {
  const def = cat?.default;
  if (!def?.model) return null;
  const found = flattenModels(cat).find((item) => item.provider === def.provider && item.model === def.model);
  return {
    provider: def.provider ?? found?.provider ?? '',
    model: def.model,
    reasoningEffort: def.reasoningEffort ?? found?.defaultEffort ?? undefined,
  };
}

/** 现在用哪个模型（会话的 model 或目录的 default） */
function currentModelOf(cat, snap) {
  const m = snap?.model ?? cat?.default ?? null;
  if (!m?.model) return null;
  return { provider: m.provider ?? '', model: m.model, reasoningEffort: m.reasoningEffort ?? undefined };
}

function modelEntryOf(models, selection) {
  if (!selection?.model) return null;
  return models.find((item) => item.provider === selection.provider && item.model === selection.model) || null;
}

function effectiveEffortOf(model, selection) {
  return selection?.reasoningEffort ?? model?.defaultEffort ?? undefined;
}

function effortLabelOf(model, selection) {
  const id = effectiveEffortOf(model, selection);
  if (id == null) return '提供方默认';
  const declared = model?.efforts?.find((item) => item.id === id);
  return declared?.name ?? `${id}`.replace(/^./, (c) => c.toUpperCase());
}

async function applyModelSelection(sid, selected, modelLabel) {
  if (!sid) {
    state.heroModel = selected;
    notify('transcript');
    return;
  }
  try {
    const out = await api.call(state.currentInstanceId, 'session.selectModel', { sessionId: sid, ...selected });
    mergeSnapshot({ model: out?.selected ?? selected });
    toast('info', `已切换到 ${modelLabel || selected.model}`);
    notify('transcript');
  } catch (e) {
    toast('error', `切换失败：${e.message}`);
  }
}

/** 官方两级模型菜单：根层只显示“模型 / 推理等级”，两类选项分别进入自己的列表。 */
function openModelRoot(anchor, cat, models, cur, sid) {
  const currentModel = modelEntryOf(models, cur);
  const rows = [{
    id: 'model',
    label: '模型',
    meta: currentModel?.label || cur?.model || '未指定',
    trailingIcon: 'ChevronRightOutline14',
    className: 'modelMenuCell',
  }];
  if (currentModel?.efforts?.length) {
    rows.push({
      id: 'effort',
      label: '推理等级',
      meta: effortLabelOf(currentModel, cur),
      trailingIcon: 'ChevronRightOutline14',
      className: 'modelMenuCell',
    });
  }
  openMenu(anchor, rows, {
    align: 'end', minWidth: 248,
    onSelect: (id) => {
      if (id === 'model') openModelList(anchor, cat, models, cur, sid);
      else if (id === 'effort') openEffortList(anchor, currentModel, cur, sid);
    },
  });
}

function openModelList(anchor, cat, models, cur, sid) {
  const items = [];
  const providers = [...new Set(models.map((item) => item.provider))];
  for (const provider of providers) {
    items.push({ title: provider || '默认提供方' });
    for (const [index, model] of models.entries()) {
      if (model.provider !== provider) continue;
      const selected = model.provider === cur?.provider && model.model === cur?.model;
      items.push({
        id: `model:${index}`,
        label: model.label,
        selected,
        trailingIcon: selected ? 'CheckOutline16' : undefined,
        className: 'modelMenuOption',
      });
    }
  }
  if (cat?.failures?.length) {
    items.push({ separator: true }, { title: `${cat.failures.length} 个提供方暂不可用` });
  }
  openMenu(anchor, items, {
    align: 'end', minWidth: 280,
    onSelect: (id) => {
      const index = Number(id.slice('model:'.length));
      const model = models[index];
      if (!model) return;
      if (model.provider === cur?.provider && model.model === cur?.model) return;
      void applyModelSelection(sid, { provider: model.provider, model: model.model }, model.label);
    },
  });
}

function openEffortList(anchor, model, cur, sid) {
  if (!model) return;
  const effective = effectiveEffortOf(model, cur);
  const choices = model.defaultEffort == null
    ? [{ id: '', name: '提供方默认' }, ...model.efforts]
    : model.efforts;
  const items = choices.map((effort, index) => {
    const selected = (effort.id || undefined) === effective;
    return {
      id: `effort:${index}`,
      label: effort.name || effort.id || '提供方默认',
      selected,
      trailingIcon: selected ? 'CheckOutline16' : undefined,
      className: 'modelMenuOption',
    };
  });
  openMenu(anchor, items, {
    align: 'end', minWidth: 220,
    onSelect: (id) => {
      const index = Number(id.slice('effort:'.length));
      const effort = choices[index];
      if (!effort || (effort.id || undefined) === effective) return;
      const selected = {
        provider: cur.provider,
        model: cur.model,
        ...(effort.id ? { reasoningEffort: effort.id } : {}),
      };
      void applyModelSelection(sid, selected, model.label);
    },
  });
}

async function pickModel(anchor) {
  const sid = state.currentSessionId;
  try {
    const cat = state.modelCatalog || await api.call(state.currentInstanceId, 'session.modelCatalog', {});
    state.modelCatalog = cat;
    const models = flattenModels(cat);
    const cur = sid ? currentModelOf(cat, sessionData(sid).snapshot) : (state.heroModel || defaultModelOf(cat));
    if (!models.length) {
      toast('info', '这台机器没有可路由的模型（modelCatalog 为空）');
      return;
    }
    openModelRoot(anchor, cat, models, cur, sid);
  } catch (e) {
    if (e.code === 'capability_unavailable' || e.code === 'unknown_method') {
      toast('error', '这台机器的插件不支持模型选择（session.modelCatalog / session.selectModel）');
    } else {
      toast('error', `读取模型目录失败：${e.message}`);
    }
  }
}

/** 本地 DSH Hero 上的 Agent 预设选择器。已有对话由 DSH 拒绝切换。 */
async function pickAgentPreset(anchor) {
  if (!hasCapability('agentPresets')) return;
  try {
    const roster = state.agentPresetRoster || await api.call(state.currentInstanceId, 'agentPreset.list');
    state.agentPresetRoster = roster;
    const presets = roster?.presets || [];
    if (!roster?.modeSelectionEnabled || !presets.length) {
      toast('info', '这台机器没有可选的 Agent 预设');
      return;
    }
    const sid = state.currentSessionId;
    const snap = sid ? sessionData(sid).snapshot : null;
    const row = sid ? state.sessions.find((item) => item.sessionId === sid) : null;
    const current = sid
      ? (snap?.projections?.values?.agentPreset || row?.agentPreset || snap?.header?.agentPreset)
      : (state.heroAgentPreset || presets.find((preset) => preset.isDefault)?.id || presets[0]?.id);
    openMenu(anchor, [
      { title: 'Agent 预设' },
      ...presets.map((preset) => ({
        id: preset.id,
        label: preset.name || preset.id,
        meta: preset.broken || preset.description || (preset.trust === 'system' ? '内置' : preset.id),
        icon: 'AgentPresetOutline16',
        selected: preset.id === current,
        disabled: !!preset.broken,
      })),
    ], {
      minWidth: 360,
      onSelect: async (agentPreset) => {
        if (!sid) {
          state.heroAgentPreset = agentPreset;
          notify('transcript');
          return;
        }
        try {
          const out = await api.call(state.currentInstanceId, 'agentPreset.select', { sessionId: sid, agentPreset });
          if (snap?.header) snap.header.agentPreset = out?.agentPreset || agentPreset;
          if (row) row.agentPreset = out?.agentPreset || agentPreset;
          toast('info', `Agent 预设：${out?.agentPreset || agentPreset}`);
          notify('transcript');
        } catch (e) {
          toast('error', `切换预设失败：${e.message}`);
        }
      },
    });
  } catch (e) {
    toast('error', `读取 Agent 预设失败：${e.message}`);
  }
}

async function openSlashMenu(anchor) {
  const sid = state.currentSessionId;
  if (!sid) return;
  try {
    const out = await api.call(state.currentInstanceId, 'command.list', { sessionId: sid });
    const items = (out?.items || []).map((c) => ({ id: c.name, label: `/${c.name}`, meta: c.description || '', icon: 'CodeOutline16' }));
    if (!items.length) { toast('info', '这台机器没有可用命令'); return; }
    openMenu(anchor, [{ title: '斜杠命令' }, ...items], {
      minWidth: 320,
      onSelect: async (name) => {
        try {
          const r = await api.call(state.currentInstanceId, 'command.run', { sessionId: sid, line: `/${name}` });
          openModal({ title: `/${name} 执行结果`, body: h('pre', { class: 'jsonBox', text: json(r?.result ?? r) }) });
        } catch (e) { toast('error', e.message); }
      },
    });
  } catch (e) { toast('error', e.message); }
}

async function actionMenu(id) {
  if (id === '__refresh') { await loadDetail(); notify('transcript'); return; }
  const sid = state.currentSessionId;
  if (!sid) return;
  const call = (m, p) => api.call(state.currentInstanceId, m, p);
  try {
    if (id === 'interrupt') { await call('session.interrupt', { sessionId: sid }); toast('info', '已请求中断'); }
    else if (id === 'cancel') { await call('session.cancel', { sessionId: sid }); toast('info', '已取消并清空排队'); }
    else if (id === 'pause') { const r = await call('session.pause', { sessionId: sid }); toast('info', `已暂停，排队 ${r.queued ?? 0} 条`); }
    else if (id === 'resume') { const r = await call('session.resume', { sessionId: sid }); toast('info', `已恢复，放行 ${r.delivered ?? 0} 条`); }
    else if (id === 'rename') await renameSession(sid, state.sessions.find((s) => s.sessionId === sid)?.title);
    else if (id === 'fork') await forkSession(sid);
    else if (id === 'history') await showHistory(sid);
    else if (id === 'search') await searchSessions();
    else if (id === 'policy') await togglePolicy(sid);
    else if (id === 'goal') await showGoal(sid);
    else if (id === 'compact') await runCommand(sid, '/compact');
    else if (id === 'export') await runCommand(sid, '/export');
  } catch (e) {
    toast('error', e.message);
  }
  refreshCurrentSession();
}

async function showHistory(sid) {
  const data = sessionData(sid);
  const throughSeq = Number.isFinite(data.snapshot?.seq) ? data.snapshot.seq : 1;
  const out = await api.call(state.currentInstanceId, 'session.history', { sessionId: sid, throughSeq, maxMessages: 80 });
  const records = out?.records || [];
  openModal({
    title: `历史消息（${records.length} 条${out?.hasMore ? '，还有更早的' : ''}）`,
    body: h('div', { style: 'display:flex;flex-direction:column;gap:8px' },
      ...records.map((r) => h('div', null,
        h('div', { class: 'tiny muted mono', text: `${r.event?.type} · seq=${r.event?.seq} · ${r.event?.time ? new Date(r.event.time).toLocaleString('zh-CN', { hour12: false }) : ''}` }),
        h('pre', { class: 'jsonBox', style: 'max-height:180px', text: json(r.event?.data, 2, 1200) })))),
  });
}

async function searchSessions() {
  const query = prompt('全文检索关键词：');
  if (!query) return;
  try {
    const out = await api.call(state.currentInstanceId, 'session.search', { query });
    const items = out?.items || [];
    openModal({
      title: `搜索结果：${query}（${items.length} 条）`,
      body: h('div', { style: 'display:flex;flex-direction:column;gap:8px' },
        ...(items.length ? items.map((it) => h('div', { class: 'keyRow' },
          h('div', { class: 'kMain' },
            h('div', { class: 'mono small', text: it.sessionId }),
            h('div', { class: 'd', text: it.snippet || '' })),
          h('button', { class: 'btn sm outline', onclick: () => { onOpenSession(it.sessionId); } }, '打开')))
          : [h('div', { class: 'muted small', text: '没有匹配结果' })])),
    });
  } catch (error) {
    toast('error', `搜索失败：${error.message}`);
  }
}

async function togglePolicy(sid) {
  const data = sessionData(sid);
  const cur = data.snapshot?.approvalPolicy;
  const next = cur === 'never' ? 'ask' : 'never';
  const ok = await confirmDialog('切换审批策略',
    `把审批策略切成 "${next}"？\n\nnever = 所有审批直接判定为拒绝，不打扰任何人（无人值守场景）。\nask = 交给应答者链，开启 forwardApprovals 时包括本服务器。`, '切换');
  if (!ok) return;
  const out = await api.call(state.currentInstanceId, 'session.approvalPolicy', { sessionId: sid, policy: next });
  mergeSnapshot({ approvalPolicy: out?.policy });
  toast('info', `审批策略：${out?.policy}`);
}

async function showGoal(sid) {
  const out = await api.call(state.currentInstanceId, 'goal.get', { sessionId: sid });
  const goal = out?.goal;
  if (!goal) { toast('info', '该会话没有长期目标'); return; }
  const body = h('div', null,
    h('div', { class: 'badge info', text: goal.phase }),
    h('p', { style: 'margin:10px 0', text: goal.objective || '' }),
    h('div', { class: 'tiny muted', text: `revision ${goal.revision} · 轮次 ${goal.roundsStarted ?? 0}/${goal.maxGoalRounds ?? '∞'}` }),
    h('div', { style: 'display:flex;gap:6px;margin-top:14px;flex-wrap:wrap' },
      ...['pause', 'resume', 'complete', 'clear', 'disarm'].map((m) => h('button', {
        class: clsx('btn sm', (m === 'clear' || m === 'disarm') && 'danger'),
        onclick: async () => {
          try {
            const r = await api.call(state.currentInstanceId, `goal.${m}`, { sessionId: sid, goalId: goal.id, revision: goal.revision });
            toast('info', `goal.${m} 完成：${r?.goal?.phase ?? '已清除'}`);
          } catch (e) { toast('error', e.message); }
        },
      }, m))));
  openModal({ title: '长期目标', body });
}

async function runCommand(sid, line) {
  try {
    const r = await api.call(state.currentInstanceId, 'command.run', { sessionId: sid, line });
    openModal({ title: `${line} 执行结果`, body: h('pre', { class: 'jsonBox', text: json(r?.result ?? r) }) });
  } catch (e) { toast('error', e.message); }
}

// ---------------------------------------------------------------- 扩展能力
// 下面这些全部按 PLUGIN-EXT.md 的约定走：插件没报对应能力位就整块不出现，
// 报了就直接可用，中间不需要再改服务器。

/** 给一条助手消息点 👍/👎（PLUGIN-EXT.md §2） */
async function sendFeedback(seq, rating) {
  const sid = state.currentSessionId;
  if (!sid || !hasCapability('messageFeedback')) return;
  const data = sessionData(sid);
  const next = data.feedback.get(seq) === rating ? 'none' : rating;
  try {
    const out = await api.call(state.currentInstanceId, 'message.feedback', { sessionId: sid, seq, rating: next });
    data.feedback.set(seq, out?.rating ?? next);
    notify('transcript');
  } catch (e) {
    toast('error', `提交失败：${e.message}`);
  }
}

/** 读 / 写会话权限预设（PLUGIN-EXT.md §3） */
async function setPermission(preset) {
  const sid = state.currentSessionId;
  if (!hasCapability('permissionPresets')) return;
  if (!sid) {
    state.heroPermission = preset;
    notify('transcript');
    return;
  }
  const data = sessionData(sid);
  const cur = data.permission ?? 'unknown';
  if (preset === cur) return;
  if (preset === 'full-access') {
    const ok = await confirmDialog('切换到完全权限',
      '完全权限允许智能体在本机执行任意命令、读写任意文件，不再受工作区限制。\n\n确认这台机器上的 dsh 允许被远程切换吗？', '切换为完全权限', true);
    if (!ok) return;
  }
  try {
    const out = await api.call(state.currentInstanceId, 'session.permission', { sessionId: sid, preset });
    data.permission = out?.preset ?? preset;
    toast('info', `权限预设：${data.permission}`);
    notify('transcript');
  } catch (e) {
    toast('error', `切换权限失败：${e.message}`);
  }
}

/** 上传附件（PLUGIN-EXT.md §4） */
async function uploadAttachment(file) {
  const sid = state.currentSessionId;
  if (!file || !hasCapability('attachments')) return null;
  const data = sessionData(sid);
  const MAX = 8 * 1024 * 1024;
  if (file.size > MAX) { toast('error', `文件超过 ${Math.round(MAX / 1048576)} MiB，协议不支持分片`); return null; }
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (const b of buf) bin += String.fromCharCode(b);
    const out = await api.call(state.currentInstanceId, 'attachment.put', {
      name: file.name,
      mime: file.type || 'application/octet-stream',
      dataBase64: btoa(bin),
    });
    if (out?.attachmentId && out.kind === 'image' && file.type.startsWith('image/')) {
      data.attachments.set(out.attachmentId, URL.createObjectURL(file));
    }
    return out;
  } catch (e) {
    toast('error', `上传失败：${e.message}`);
    return null;
  }
}

/** 工作区增删改（PLUGIN-EXT.md §5） */
function workspaceMenu(anchor, group) {
  if (!hasCapability('workspaceMutation')) { toast('info', '这台机器的插件还不支持远程增删工作区'); return; }
  const path = group?.cwd;
  openMenu(anchor, [
    { title: path || '工作区' },
    { id: 'create', label: '新建工作区…', icon: 'ProjectAddOutline16' },
    { id: 'rename', label: '重命名…', icon: 'EditOutline16', disabled: !path },
    { id: 'remove', label: '从列表移除', icon: 'TrashOutline16', danger: true, disabled: !path },
    { separator: true },
    { id: 'copy', label: '复制路径', icon: 'CopyOutline16', disabled: !path },
  ], {
    onSelect: async (id) => {
      try {
        if (id === 'create') {
          const p = await promptDialog({
            title: '新建工作区',
            label: '目录路径',
            placeholder: '例如 D:\\Project\\my-project',
            confirmLabel: '新增',
          });
          if (!p) return;
          await api.call(state.currentInstanceId, 'workspace.create', { path: p, title: p.split(/[\\/]/).filter(Boolean).pop() });
          toast('info', '已新建工作区');
        } else if (id === 'rename') {
          const t = await promptDialog({
            title: '重命名工作区',
            label: '工作区名称',
            value: group.label || '',
            confirmLabel: '保存',
          });
          if (!t) return;
          await api.call(state.currentInstanceId, 'workspace.rename', { path, title: t });
          toast('info', '已重命名');
        } else if (id === 'remove') {
          const ok = await confirmDialog('移除工作区', `把「${path}」从工作区列表里移除？\n\n只删登记关系，磁盘目录不动。`, '移除', true);
          if (!ok) return;
          await api.call(state.currentInstanceId, 'workspace.remove', { path });
          toast('info', '已移除');
        } else if (id === 'copy') {
          const copied = await copyText(path);
          if (!copied) throw new Error('浏览器拒绝访问剪贴板');
          toast('info', '已复制路径');
        }
        await refreshSessions(false);
      } catch (e) {
        toast('error', e.message);
      }
    },
  });
}

/** 右侧栏 */
function toggleRightbar(tab) {
  if (!tab) saveSettings({ rightbarOpen: !settings.rightbarOpen });
  else if (settings.rightbarOpen && settings.rightbarTab === tab) saveSettings({ rightbarOpen: false });
  else saveSettings({ rightbarOpen: true, rightbarTab: tab });
  notify('layout');
}

/** 终端（PLUGIN-EXT.md §7）——默认关闭，设置里显式打开才用 */
let terminalId = null;
async function terminalOpen(cols, rows) {
  if (!hasCapability('terminal') || !settings.allowRemoteTerminal) return null;
  try {
    const out = await api.call(state.currentInstanceId, 'terminal.open', {
      sessionId: state.currentSessionId || undefined, cols, rows,
    });
    terminalId = out?.terminalId ?? null;
    return terminalId;
  } catch (e) { toast('error', `打开终端失败：${e.message}`); return null; }
}
async function terminalWrite(data) {
  if (!terminalId) return;
  await api.call(state.currentInstanceId, 'terminal.write', { terminalId, data }).catch(() => {});
}
async function terminalResize(cols, rows) {
  if (!terminalId) return;
  await api.call(state.currentInstanceId, 'terminal.resize', { terminalId, cols, rows }).catch(() => {});
}
async function terminalClose() {
  if (!terminalId) return;
  const id = terminalId;
  terminalId = null;
  await api.call(state.currentInstanceId, 'terminal.close', { terminalId: id }).catch(() => {});
}
function onTerminalOutput(d) {
  if (d?.terminalId !== terminalId) return;
  window.dispatchEvent(new CustomEvent('dsh:terminal-output', { detail: d }));
}
function onTerminalExit(d) {
  if (d?.terminalId !== terminalId) return;
  window.dispatchEvent(new CustomEvent('dsh:terminal-exit', { detail: d }));
}

// ---------------------------------------------------------------- 快捷键

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); openSettings(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r' && e.shiftKey) { e.preventDefault(); refreshSessions(true); }
});

boot();

// 供侧边栏/对话区回调使用
export { handlers };
