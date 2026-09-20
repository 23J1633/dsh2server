/* 左侧边栏。
 * 结构与上游 ui-sidebar 的 SidebarRoot 一致：logoRow（品牌 + 折叠开关）
 * → 机器选择器（本控制台新增，就在标志正下方）→ 新会话 → 浏览区 → 底部。
 *
 * 刷新策略：外壳只建一次（按折叠态区分），之后每次通知都走原地更新。
 * 自动刷新每 5 秒来一次，整块 innerHTML 重建会让列表肉眼可见地闪一下，
 * 也会把滚动位置和悬停态抹掉——所以会话行按 sessionId 复用节点，
 * 只改变化的文本与类名。
 */
import { h, clsx, timeAgo, baseName, fullTime } from './util.js';
import { icon, wordmark } from './icons.js';
import { state, settings, sessionData, isSidebarCollapsed, toggleSidebar, notify } from './store.js';
import { openMenu, iconButton } from './ui.js';
import { groupByCwd, sessionTitle, sessionStatus } from './model.js';

const groupsCollapsed = new Set();

/** 当前外壳。`host` 或折叠态变了才重建。 */
let shell = null;
/** sessionId → 行元素，跨刷新复用 */
let sessionRowCache = new Map();
/** 工作区分组 key → { row, wrap } */
let groupCache = new Map();

/**
 * 渲染侧边栏到容器。
 * @param {HTMLElement} host
 * @param {{onSelectMachine: Function, onNewSession: Function, onOpenSession: Function,
 *          onOpenSettings: Function, onRefresh: Function, onForkSession: Function,
 *          onRenameSession: Function, onArchiveSession: Function, onArchiveHint: Function,
 *          onWorkspaceMenu: Function}} handlers
 */
export function renderSidebar(host, handlers) {
  const collapsed = isSidebarCollapsed();
  if (!shell || shell.host !== host || shell.collapsed !== collapsed) {
    host.innerHTML = '';
    sessionRowCache = new Map();
    groupCache = new Map();
    shell = buildShell(host, collapsed, handlers);
  }
  updateShell(shell, handlers);
}

// ---------------------------------------------------------------- 建外壳

function buildShell(host, collapsed, handlers) {
  const aside = h('aside', { class: clsx('sidebar', collapsed && 'collapsed') });

  // ---- 品牌行
  const logoRow = h('div', { class: 'logoRow' });
  if (!collapsed) {
    logoRow.append(h('button', {
      type: 'button', class: 'brand', 'aria-label': '新建会话',
      onclick: () => handlers.onNewSession(),
    }, h('span', { class: 'brandIdentity', 'aria-hidden': 'true' },
      h('span', { class: 'brandMark' }, agentMark(24)),
      h('span', { class: 'brandName' }, wordmark({ size: 19 })))));
  }
  logoRow.append(h('button', {
    type: 'button',
    class: 'iconButton toggle',
    'aria-label': collapsed ? '展开侧边栏' : '收起侧边栏',
    title: collapsed ? '展开侧边栏' : '收起侧边栏',
    onclick: () => { toggleSidebar(); notify('layout'); },
  },
    h('span', { class: 'railMark', 'aria-hidden': 'true' }, agentMark(22)),
    icon('PanelLeftOutline16', { size: collapsed ? 18 : 16, className: 'panelIcon' })));
  aside.append(logoRow);

  // ---- 机器选择器（品牌标志正下方）
  const machineRefs = buildMachineRow(collapsed, handlers);
  aside.append(h('div', { class: 'machineRow' }, machineRefs.button));

  // ---- 新建会话
  const newSessionBtn = h('button', {
    type: 'button', class: 'newSession', 'aria-label': '新建会话',
    title: '新建会话',
    onclick: () => handlers.onNewSession(),
  }, icon('NewChatOutline16', { size: collapsed ? 18 : 14 }),
    h('span', { class: 'newSessionLabel', text: '新会话' }));
  aside.append(newSessionBtn);

  // ---- 浏览区
  const listArea = h('div', { class: 'listArea' });
  aside.append(h('div', { class: 'regionArea' },
    h('div', { class: 'browser' },
      collapsed ? null : h('div', { class: 'sectionHeader' },
        h('span', { class: 'sectionLabel', text: '工作区' }),
        iconButton('SearchOutline16', '搜索会话', () => handlers.onSearch(), 14),
        iconButton('SettingsOutline14', '视图选项', (event) => openViewMenu(event.currentTarget, handlers), 14),
        iconButton('ProjectAddOutline16', '添加工作区', (event) => handlers.onAddWorkspace(event.currentTarget), 14)),
      collapsed ? null : listArea)));

  // ---- 底部
  const connText = h('span');
  const settingsBtn = h('button', {
    type: 'button', class: 'settingsTrigger', 'aria-label': '设置', title: '设置',
    onclick: () => handlers.onOpenSettings(),
  }, icon('SettingsOutline16', { size: 16 }), h('span', { text: '设置' }));
  aside.append(h('div', { class: 'footArea' },
    collapsed ? null : h('div', { class: 'connRow' },
      h('span', { class: 'stateDot' }), connText),
    settingsBtn));

  host.append(aside);
  return {
    host, collapsed, aside, listArea, machineRefs, newSessionBtn, connText,
    connDot: aside.querySelector('.connRow .stateDot'),
  };
}

function agentMark(size) {
  return h('span', {
    class: 'agentBrandMark agentBrandMark--dsh',
    style: `--agent-mark-size:${size}px`,
    dataset: { agentType: 'dsh' },
    title: 'DeepSeek Harness',
  });
}

function openViewMenu(anchor, handlers) {
  openMenu(anchor, [
    { id: 'refresh', label: '立即刷新', icon: 'RefreshOutline14' },
    { separator: true },
    { id: 'expand', label: '展开全部工作区', icon: 'FolderOpen16' },
    { id: 'collapse', label: '折叠全部工作区', icon: 'FolderClose16' },
  ], {
    align: 'end',
    onSelect: (id) => {
      if (id === 'refresh') handlers.onRefresh();
      else if (id === 'expand') { groupsCollapsed.clear(); notify('sessions'); }
      else if (id === 'collapse') {
        for (const group of groupByCwd(state.sessions, state.detail?.workspaces?.items || [])) groupsCollapsed.add(group.key);
        notify('sessions');
      }
    },
  });
}

// ---------------------------------------------------------------- 更新外壳

function updateShell(shellRef, handlers) {
  const collapsed = shellRef.collapsed;

  // 机器选择器
  const cur = state.instances.find((i) => i.instanceId === state.currentInstanceId);
  const label = cur ? (cur.label || cur.displayName || cur.instanceId) : '未选择机器';
  shellRef.machineRefs.name.textContent = label;
  shellRef.machineRefs.button.title = `选择机器${cur ? `：${label}` : ''}`;
  if (shellRef.machineRefs.dot) {
    const machineState = machineConnectionState(cur);
    shellRef.machineRefs.dot.className = clsx('stateDot', 'machineStateDot', machineState);
    shellRef.machineRefs.dot.title = machineStateLabel(machineState);
  }

  // 新会话按钮的可点状态
  shellRef.newSessionBtn.disabled = !state.currentInstanceId;

  // 底部连接状态
  shellRef.connText.textContent = state.connected
    ? (settings.autoRefreshMs > 0 ? '实时 · 自动刷新' : '实时连接')
    : (state.connDetail || '未连接');
  if (shellRef.connDot) {
    shellRef.connDot.className = clsx('stateDot', 'connectionStateDot', state.connected ? 'connected' : 'disconnected');
  }

  if (!collapsed) updateSessionList(shellRef.listArea, handlers);
}

// ---------------------------------------------------------------- 机器选择器

function buildMachineRow(collapsed, handlers) {
  const dot = collapsed ? null : h('span', { class: 'stateDot machineStateDot disconnected' });
  const name = collapsed ? null : h('span', { class: 'mName' });
  const button = h('button', {
    type: 'button',
    class: 'machineButton',
    'aria-haspopup': 'menu',
    onclick: () => openMachineMenu(button, handlers),
  },
    collapsed ? icon('PersonalizationOutline16', { size: 18 }) : dot,
    name,
    collapsed ? null : icon('ChevronDownOutline14', { size: 14, className: 'chev' }));
  return { button, dot, name };
}

function openMachineMenu(anchor, handlers) {
  const items = [];
  if (!state.instances.length) {
    items.push({ title: '还没有 dsh 连上来' });
    items.push({ id: '__settings', label: '去设置里登记实例 key', icon: 'SettingsOutline16' });
  } else {
    items.push({ title: `共 ${state.instances.length} 台机器` });
    for (const inst of state.instances) {
      const name = inst.label || inst.displayName || inst.instanceId;
      const machineState = machineConnectionState(inst, false);
      items.push({
        id: inst.instanceId,
        label: name,
        icon: h('span', {
          class: clsx('stateDot', 'machineStateDot', machineState),
          title: machineStateLabel(machineState),
        }),
        meta: machineState === 'connected'
          ? (inst.transport === 'websocket' ? '实时' : '轮询')
          : machineStateLabel(machineState),
        selected: inst.instanceId === state.currentInstanceId,
      });
    }
    items.push({ separator: true });
    items.push({ id: '__settings', label: '管理机器与实例 key…', icon: 'SettingsOutline16' });
  }

  openMenu(anchor, items, {
    minWidth: 260,
    onSelect: (id) => {
      if (id === '__settings') handlers.onOpenSettings('machines');
      else handlers.onSelectMachine(id);
    },
  });
}

function machineConnectionState(instance, includeConsole = true) {
  if (instance?.online) return 'connected';
  if (instance?.connecting || instance?.state === 'connecting' || (includeConsole && instance && !state.connected)) return 'connecting';
  return 'disconnected';
}

function machineStateLabel(value) {
  return value === 'connected' ? '已连接' : value === 'connecting' ? '连接中' : '未连接';
}

// ---------------------------------------------------------------- 会话列表

function updateSessionList(host, handlers) {
  if (!state.currentInstanceId) {
    host.innerHTML = '';
    host.append(h('div', { class: 'emptyHint', text: '先在设置里登记 dsh 实例 key，机器连上来后这里会显示会话。' }));
    return;
  }
  if (!state.sessions.length) {
    host.innerHTML = '';
    host.append(h('div', { class: 'emptyHint', text: '这台机器还没有会话。点「新会话」开始。' }));
    return;
  }

  const groups = groupByCwd(state.sessions, state.detail?.workspaces?.items || []);
  const wantedRows = new Set();
  const wantedGroups = new Set();

  for (const g of groups) {
    wantedGroups.add(g.key);
    let entry = groupCache.get(g.key);
    if (!entry) {
      entry = buildGroup(g, handlers);
      groupCache.set(g.key, entry);
    }
    const collapsedGroup = groupsCollapsed.has(g.key);
    updateGroup(entry, g, collapsedGroup, handlers);

    const desired = [];
    for (const s of g.sessions) {
      wantedRows.add(s.sessionId);
      let row = sessionRowCache.get(s.sessionId);
      if (!row) {
        row = buildSessionRow(s, handlers);
        sessionRowCache.set(s.sessionId, row);
      }
      updateSessionRow(row, s);
      desired.push(row);
    }
    reconcile(entry.wrap, desired);
  }

  // 分组与行按顺序重排；appendChild 只移动节点，不会重建
  const desiredGroups = [];
  for (const g of groups) {
    const entry = groupCache.get(g.key);
    if (!entry) continue;
    desiredGroups.push(entry.row);
    if (!groupsCollapsed.has(g.key)) desiredGroups.push(entry.wrap);
  }
  reconcile(host, desiredGroups);

  for (const [sid, row] of sessionRowCache) {
    if (!wantedRows.has(sid)) { row.remove(); sessionRowCache.delete(sid); }
  }
  for (const [key, entry] of groupCache) {
    if (!wantedGroups.has(key)) {
      entry.row.remove();
      entry.wrap.remove();
      groupCache.delete(key);
    }
  }
}

/**
 * 按目标顺序重排子节点：已在位的不动，缺的补，多的删。
 * 全程只做 appendChild / remove，不重建已有节点。
 */
function reconcile(parent, desired) {
  let cursor = parent.firstElementChild;
  for (const node of desired) {
    if (cursor === node) {
      cursor = cursor.nextElementSibling;
      continue;
    }
    parent.insertBefore(node, cursor);
  }
  while (cursor) {
    const next = cursor.nextElementSibling;
    cursor.remove();
    cursor = next;
  }
}

function buildGroup(g, handlers) {
  const title = g.label || (g.cwd ? baseName(g.cwd) : '未分组');
  const label = h('span', { class: 'gLabel', text: title });
  const count = h('span', { class: 'gCount', text: String(g.sessions.length) });
  const folder = h('span', { class: 'gIcon' });
  const row = h('div', {
    class: 'groupRow',
    title: g.cwd || '',
    onclick: (e) => {
      if (e.target.closest('.rowActions')) return;
      if (groupsCollapsed.has(g.key)) groupsCollapsed.delete(g.key); else groupsCollapsed.add(g.key);
      notify('sessions');
    },
  },
    folder, label, count,
    // 工作区增删改：插件报了 workspaceMutation 才会真的下发（PLUGIN-EXT.md §5）
    h('span', { class: 'rowActions' },
      h('button', {
        type: 'button', class: 'iconButton', 'aria-label': '工作区操作',
        title: '工作区操作',
        onclick: (e) => { e.stopPropagation(); handlers.onWorkspaceMenu(e.currentTarget, row._group ?? g); },
      }, icon('EllipsisOutline16', { size: 15 }))));

  return { row, wrap: h('div', { class: 'groupSessions' }), label, count, folder, path: g.cwd };
}

function updateGroup(entry, g, collapsedGroup, handlers) {
  entry.label.textContent = g.label || (g.cwd ? baseName(g.cwd) : '未分组');
  entry.count.textContent = String(g.sessions.length);
  entry.row.title = g.cwd || '';
  const containsCurrent = g.sessions.some((session) => session.sessionId === state.currentSessionId);
  const active = !collapsedGroup && containsCurrent;
  entry.row.className = clsx('groupRow', containsCurrent && 'containsCurrent');
  entry.folder.className = clsx('gIcon', active && 'active');
  const desiredIcon = icon(collapsedGroup ? 'FolderClose16' : 'FolderOpen16', { size: 16 });
  if (desiredIcon) {
    // 图标随折叠态换；不重建整行，只换那一个 glyph
    if (entry.folder.firstElementChild) entry.folder.firstElementChild.remove();
    entry.folder.append(desiredIcon);
  }
  // 分组回调闭包捕获的是第一次的 g；这里把最新引用挂到行上，避免用到过期的会话数组
  entry.row._group = g;
  void handlers;
}

function buildSessionRow(s, handlers) {
  const dot = h('span', { class: 'stateDot' });
  const title = h('span', { class: 'title' });
  const time = h('span', { class: 'time' });
  const row = h('div', {
    class: 'sessionRow',
    role: 'treeitem',
    onclick: () => handlers.onOpenSession(s.sessionId),
  },
    h('span', { class: 'slot' }, dot),
    title,
    time,
    h('span', { class: 'rowActions' },
      h('button', {
        type: 'button', class: 'iconButton', 'aria-label': '会话操作',
        onclick: (e) => { e.stopPropagation(); openSessionMenu(e.currentTarget, row._session ?? s, handlers); },
      }, icon('EllipsisOutline16', { size: 16 }))));
  return row;
}

function updateSessionRow(row, s) {
  row._session = s;
  const selected = s.sessionId === state.currentSessionId;
  row.className = clsx('sessionRow', selected && 'selected');
  row.setAttribute('aria-selected', selected ? 'true' : 'false');
  row.title = `${sessionTitle(s)}\n${fullTime(s.updatedAt)}${s.cwd ? `\n${s.cwd}` : ''}`;

  const st = sessionStatus(s, state.detail);
  const live = sessionData(s.sessionId).live?.streaming || s.running;
  const dot = row.querySelector('.slot .stateDot');
  if (dot) dot.className = clsx('stateDot', live ? 'ongoing' : st.state);

  const text = sessionTitle(s);
  const titleEl = row.querySelector('.title');
  if (titleEl && titleEl.textContent !== text) titleEl.textContent = text;

  const timeEl = row.querySelector('.time');
  const timeText = s.blank ? '' : timeAgo(s.updatedAt);
  if (timeEl && timeEl.textContent !== timeText) timeEl.textContent = timeText;
}

function openSessionMenu(anchor, s, handlers) {
  openMenu(anchor, [
    { id: 'rename', label: '重命名', icon: 'EditOutline16' },
    { id: 'fork', label: '分叉出新会话', icon: 'BranchOutline16' },
    { id: 'archive', label: '归档会话', icon: 'ArchiveOutline20' },
    { separator: true },
    { id: 'copyId', label: '复制会话 ID', icon: 'CopyOutline16' },
    { id: 'copyCwd', label: '复制工作目录', icon: 'CopyOutline16', disabled: !s.cwd },
  ], {
    align: 'start',
    onSelect: (id) => {
      if (id === 'rename') handlers.onRenameSession(s);
      else if (id === 'fork') handlers.onForkSession(s);
      else if (id === 'archive') handlers.onArchiveSession({ ...s, title: sessionTitle(s) });
      else if (id === 'copyId') navigator.clipboard?.writeText(s.sessionId).then(() => handlers.onArchiveHint('会话 ID 已复制'));
      else if (id === 'copyCwd') navigator.clipboard?.writeText(s.cwd).then(() => handlers.onArchiveHint('工作目录已复制'));
    },
  });
}
