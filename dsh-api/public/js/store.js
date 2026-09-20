/* 全局状态与本地设置。
 *
 * 业务数据都留在内存（对应上游「业务数据住在对象层」的约定），
 * 只有用户偏好进 localStorage。
 */

const SETTINGS_KEY = 'dshConsoleSettings';

const DEFAULT_SETTINGS = {
  /** 对话显示：紧凑（折叠已结束轮次的中间步骤）| 标准 */
  transcript: 'compact',
  /** 主题：light | dark | system */
  theme: 'system',
  /** 正文字号，12–17 */
  fontSize: 14,
  /** 自动刷新拉取的间隔（毫秒）；0 表示只靠实时事件流 */
  autoRefreshMs: 5000,
  /** 新会话默认权限，与本地 DSH 的通用设置一致。 */
  defaultPermission: 'workspace-write',
  /** 会话繁忙时 Enter 的默认行为。 */
  submitMode: 'queue',
  /** 侧边栏是否折叠 */
  sidebarCollapsed: false,
  /** 右侧栏出不出来，以及当前挂着哪个面板 */
  rightbarOpen: false,
  rightbarTab: 'trace',
  /** 提权开关：默认全关，要用再自己开（对应 PLUGIN-EXT.md §3.3 / §7.3） */
  allowRemotePrivileged: false,
  allowRemoteTerminal: false,
  /** 是否展示逐条原始事件（调试用） */
  showRawEvents: false,
  /** 轨迹时间线：true 按真实时长画，false 按等宽操作序画（对应上游 dsh.trajectory.duration） */
  trajectoryDuration: false,
};

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export const settings = loadSettings();

export function saveSettings(patch) {
  Object.assign(settings, patch);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  listeners.forEach((fn) => fn('settings'));
}

const listeners = new Set();

/** 订阅状态变化；返回取消订阅函数 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify(what) {
  listeners.forEach((fn) => fn(what));
}

export const state = {
  /** 机器列表（/instances 返回） */
  instances: [],
  currentInstanceId: localStorage.getItem('dshInstance') || '',
  /** 当前机器详情（含会话缓存、待决审批、工作目录、任务） */
  detail: null,

  /** 当前机器的会话列表（session.list 的 items） */
  sessions: [],
  currentSessionId: null,
  /** hero 态新建会话时使用的工作目录 */
  heroCwd: null,
  /** hero 态为下一会话暂存的 Agent 预设、模型与权限。 */
  heroAgentPreset: null,
  heroModel: null,
  heroPermission: null,
  /** 当前机器的 Agent 预设名单与模型目录。 */
  agentPresetRoster: null,
  modelCatalog: null,
  /** 会话视图：chat（对话）| trajectory（轨迹），对应上游 conversation.view */
  viewMode: 'chat',
  /** 右侧「文件」面板当前浏览到的目录 */
  currentSessionCwd: null,

  /** sessionId -> { events: [], live: {text, streaming, revision}, snapshot, loading, hasMore, oldestSeq } */
  sessions_data: new Map(),
  /** sessionId -> Set<turn> 手动展开过的轮次 */
  openTurns: new Map(),

  /** 折叠的分组：'' 表示未归属 */
  collapsedGroups: new Set(),

  connected: false,
  connDetail: '',
  /** 窄屏下用户是否手动展开了侧边栏（不写盘，跨断点自动清掉） */
  narrowExpanded: false,
  /** 事件流调试用的最近帧 */
  frames: [],
  /** 最后一次自动刷新的时间 */
  lastRefreshAt: 0,
  autoRefreshOn: true,
};

/** 取某个会话的本地缓存，没有就建一个 */
export function sessionData(sid) {
  if (!state.sessions_data.has(sid)) {
    state.sessions_data.set(sid, {
      /** 转录事件：优先来自 session.events（原始日志），降级用 session.history（消息对齐） */
      events: [],
      /** 原始日志窗口（session.events），只用来算时长/步数/轨迹，不参与转录 */
      trace: [],
      traceHasMore: false,
      live: null,
      snapshot: null,
      loading: false,
      loaded: false,
      hasMore: false,
      oldestSeq: null,
      pageMinSeq: null,
      /** 已点过的 👍/👎：seq -> rating */
      feedback: new Map(),
      /** 附件本体缓存：attachmentId -> dataURL */
      attachments: new Map(),
    });
  }
  return state.sessions_data.get(sid);
}

/** 取某个会话被手动展开的轮次集合 */
export function openTurnsOf(sid) {
  if (!state.openTurns.has(sid)) state.openTurns.set(sid, new Set());
  return state.openTurns.get(sid);
}

export function currentInstance() {
  return state.instances.find((i) => i.instanceId === state.currentInstanceId) || null;
}

/**
 * 当前机器是否具备某个扩展能力。
 *
 * 对应 PLUGIN-EXT.md §0.2 的能力位表。插件没报的能力位一律返回 false，
 * 界面据此隐藏对应入口——所以插件升级后云端不需要跟着改。
 * @param {string} name 能力位名，例如 'sessionEvents'
 * @returns {boolean}
 */
export function hasCapability(name) {
  return !!currentInstance()?.capabilities?.[name];
}

/** 本机记住的高级开关（提权类操作需要显式打开） */
export const ADVANCED = {
  get remoteTerminal() { return settings.allowRemoteTerminal === true; },
  get remotePrivileged() { return settings.allowRemotePrivileged === true; },
};

export function currentSession() {
  return state.sessions.find((s) => s.sessionId === state.currentSessionId) || null;
}

/** 窄屏断点，与上游 SIDEBAR_AUTO_COLLAPSE 一致 */
export const NARROW_BREAKPOINT = 1024;

export const isNarrow = () => window.innerWidth < NARROW_BREAKPOINT;

/** 侧边栏折叠态：窄屏默认折成 56px icon rail，手动展开只覆盖当前会话 */
export function isSidebarCollapsed() {
  return isNarrow() ? !state.narrowExpanded : settings.sidebarCollapsed;
}

export function toggleSidebar() {
  if (isNarrow()) state.narrowExpanded = !state.narrowExpanded;
  else saveSettings({ sidebarCollapsed: !settings.sidebarCollapsed });
  notify('layout');
}
