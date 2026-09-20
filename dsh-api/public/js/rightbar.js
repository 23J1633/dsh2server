/* 右侧栏：可切换的面板（轨迹 / 文件 / 终端 / 任务）。
 *
 * 对应上游 ui-sidebar-right 的停靠面板。每个标签页都按 PLUGIN-EXT.md 的能力位探测：
 * 插件没报能力的标签页直接不出现，报了就能用，中间不需要改服务器。
 */
import { h, clsx, toast } from './util.js';
import { icon } from './icons.js';
import { state, settings, saveSettings, sessionData, currentInstance, hasCapability } from './store.js';
import { api } from './api.js';
import {
  turnStats, humanDuration, shortNum, turnReasonLabel, isAbnormalTurnEnd, isTurnFailure,
} from './model.js';
import { iconButton } from './ui.js';

let activeTab = null;
const expandedFileDirs = new Map();

/**
 * 渲染右侧栏。
 * @param {HTMLElement} host
 * @param {object} handlers app.js 提供的回调
 */
export function renderRightbar(host, handlers) {
  // 上一个面板挂的全局监听要先摘掉，否则重渲染会越积越多
  if (host._cleanup) { try { host._cleanup(); } catch { /* 面板已销毁，忽略 */ } host._cleanup = null; }
  host.innerHTML = '';
  if (!settings.rightbarOpen || !state.currentSessionId) return;

  activeTab = settings.rightbarTab || activeTab || 'trace';
  const tabs = availableTabs();
  if (!tabs.some((t) => t.id === activeTab)) activeTab = tabs[0]?.id ?? 'trace';

  const panel = h('aside', { class: 'rightbar' },
    h('div', { class: 'rightbarTabs', role: 'tablist' },
      ...tabs.map((t) => h('button', {
        type: 'button', role: 'tab',
        class: clsx('rightbarTab', t.id === activeTab && 'active'),
        'aria-selected': t.id === activeTab ? 'true' : 'false',
        title: t.hint || t.label,
        onclick: () => { activeTab = t.id; saveSettings({ rightbarTab: t.id }); renderRightbar(host, handlers); },
      }, icon(t.icon, { size: 14 }), h('span', { text: t.label }))),
      h('span', { class: 'spacer' }),
      h('button', {
        type: 'button', class: 'btn icon rightbarCollapseButton',
        title: '收起右侧栏', 'aria-label': '收起右侧栏',
        onclick: () => handlers.onToggleRightbar(),
      }, icon('PanelLeftOutline16', { size: 15, className: 'rightbarCollapseGlyph' }))),
    h('div', { class: 'rightbarBody' }));

  const body = panel.querySelector('.rightbarBody');
  const rerender = () => renderRightbar(host, handlers);
  if (activeTab === 'trace') renderTrace(body, handlers);
  else if (activeTab === 'files') { body.classList.add('filesBody'); renderFiles(body, handlers); }
  else if (activeTab === 'terminal') renderTerminal(body, handlers, (fn) => { host._cleanup = fn; });
  else if (activeTab === 'jobs') renderJobs(body, rerender);

  host.append(panel);
}

/** 当前机器上有哪些标签页可用 */
function availableTabs() {
  const inst = currentInstance();
  const caps = inst?.capabilities || {};
  const tabs = [
    { id: 'files', label: '文件', icon: 'FolderOpen16', hint: '浏览工作区文件', available: !!caps.fileBrowser },
    { id: 'trace', label: '轨迹', icon: 'ClockOutline16', hint: '每轮/每步的耗时与工具调用', available: true },
    { id: 'terminal', label: '终端', icon: 'ApiOutline14', hint: '远程终端（需在设置里显式开启）', available: !!caps.terminal && settings.allowRemoteTerminal },
    { id: 'jobs', label: '任务', icon: 'DatabaseOutline16', hint: '后台任务与输出', available: !!caps.jobs },
  ];
  return tabs.filter((t) => t.available);
}

// ---------------------------------------------------------------- 轨迹

function renderTrace(host, handlers) {
  const data = sessionData(state.currentSessionId);
  const trace = data.trace || [];
  const stats = turnStats(trace);

  if (!trace.length) {
    host.append(h('div', { class: 'empty', html:
      '这台机器的插件还没有提供 <b>session.events</b>（原始事件窗口），<br>拿不到每轮的起止时间，轨迹无法还原。<br><br>'
      + '接口已经定义好，见仓库里的 <code>PLUGIN-EXT.md</code> §1；<br>插件加上之后这里会自动出现内容。' }));
    return;
  }

  const total = stats.length;
  const totalMs = stats.reduce((a, t) => a + (t.durationMs || 0), 0);
  const totalTools = stats.reduce((a, t) => a + t.toolCalls, 0);
  const totalSteps = stats.reduce((a, t) => a + t.steps, 0);
  const outTok = stats.reduce((a, t) => a + t.outputTokens, 0);

  host.append(h('div', { class: 'traceSummary' },
    statChip('轮次', String(total)),
    statChip('步数', String(totalSteps)),
    statChip('工具调用', String(totalTools)),
    statChip('总耗时', humanDuration(totalMs)),
    outTok ? statChip('输出 token', shortNum(outTok)) : null,
    totalMs > 0 && outTok > 0 ? statChip('平均速率', `${(outTok / (totalMs / 1000)).toFixed(0)} tok/s`) : null));

  const list = h('div', { class: 'traceList' });
  for (const t of stats.slice().reverse()) {
    list.append(h('div', { class: 'traceRow' },
      h('div', { class: 'traceHead' },
        h('span', { class: 'traceTurn', text: `第 ${t.turn} 轮` }),
        isAbnormalTurnEnd(t.reason) ? h('span', { class: clsx('badge', isTurnFailure(t.reason) ? 'err' : 'warn'), text: turnReasonLabel(t.reason) }) : null,
        h('span', { class: 'spacer' }),
        h('span', { class: 'traceDur', text: t.durationMs != null ? humanDuration(t.durationMs) : '—' })),
      h('div', { class: 'traceMeta' },
        `${t.steps} 步 · ${t.toolCalls} 次工具调用`
        + (t.outputTokens ? ` · ${shortNum(t.outputTokens)} 输出 token` : '')
        + (t.tokPerSec ? ` · ${t.tokPerSec.toFixed(0)} tok/s` : '')),
      h('div', { class: 'traceBar' },
        ...barSegments(t))));
  }
  host.append(list);
  void handlers;
}

/** 一条迷你时间条：思考 / 工具 / 输出三段 */
function barSegments(t) {
  if (!t.durationMs) return [h('span', { class: 'traceBarEmpty' })];
  const segs = [];
  const toolRatio = t.toolCalls > 0 ? Math.min(0.6, t.toolCalls * 0.08) : 0;
  const thinkRatio = t.steps > 0 ? Math.min(0.3, t.steps * 0.03) : 0;
  segs.push(h('span', { class: 'seg think', style: `width:${thinkRatio * 100}%` }));
  segs.push(h('span', { class: 'seg tool', style: `width:${toolRatio * 100}%` }));
  segs.push(h('span', { class: 'seg out', style: `width:${Math.max(4, (1 - toolRatio - thinkRatio) * 100)}%` }));
  return segs;
}

function statChip(label, value) {
  return h('div', { class: 'statChip' }, h('span', { class: 'sv', text: value }), h('span', { class: 'sl', text: label }));
}

// ---------------------------------------------------------------- 文件

function renderFiles(host, handlers) {
  if (!hasCapability('fileBrowser')) {
    host.append(h('div', { class: 'empty', html:
      '这台机器的插件还没有提供文件浏览接口 <b>workspace.fs.list / workspace.fs.read</b>。<br><br>'
      + '接口已经定义好，见 <code>PLUGIN-EXT.md</code> §6；<br>插件加上之后这个面板会自动可用。' }));
    return;
  }

  const session = state.sessions.find((item) => item.sessionId === state.currentSessionId);
  const rootPath = session?.cwd || null;
  const treeKey = `${state.currentInstanceId}|${state.currentSessionId}|${rootPath || ''}`;
  if (!expandedFileDirs.has(treeKey)) expandedFileDirs.set(treeKey, new Set());
  const expanded = expandedFileDirs.get(treeKey);

  const pane = h('div', { class: 'filesPane' });
  const pathText = h('span', { class: 'filesPathText mono', text: rootPath || '未设置工作目录' });
  const rootList = h('ul', { class: 'fileTreeLevel fileTreeRoot' });
  const body = h('div', { class: 'fileTreeBody' }, rootList);
  let generation = 0;
  const reload = () => {
    generation += 1;
    rootList.innerHTML = '';
    if (!rootPath) {
      rootList.append(h('li', { class: 'fileTreeNote', text: '这个会话没有工作目录' }));
      return;
    }
    void loadLevel(rootPath, rootList, generation);
  };
  pane.append(
    h('div', { class: 'filesHeader' },
      h('div', { class: 'filesPath', title: rootPath || '' }, pathText),
      iconButton('RefreshOutline16', '刷新目录', reload, 15)),
    body,
  );
  host.append(pane);
  reload();

  async function loadLevel(path, list, renderGeneration) {
    list.innerHTML = '';
    list.append(h('li', { class: 'fileTreeNote', text: '加载中…' }));
    try {
      const out = await api.call(state.currentInstanceId, 'workspace.fs.list', { path });
      if (!list.isConnected || renderGeneration !== generation) return;
      list.innerHTML = '';
      const entries = (out?.entries || []).slice().sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : b.type === 'dir' ? 1 : 0;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      });
      if (!entries.length) {
        list.append(h('li', { class: 'fileTreeNote', text: '空目录' }));
        return;
      }
      for (const entry of entries) list.append(renderEntry(entry, renderGeneration));
      if (out?.truncated) list.append(h('li', { class: 'fileTreeNote', text: '目录内容过多，仅显示部分项目' }));
    } catch (err) {
      if (!list.isConnected || renderGeneration !== generation) return;
      list.innerHTML = '';
      list.append(h('li', { class: 'fileTreeNote error', text: `读取失败：${err.message}` }));
    }
  }

  function renderEntry(entry, renderGeneration) {
    const item = h('li', { class: clsx('fileTreeItem', entry.type) });
    if (entry.type !== 'dir') {
      item.append(h('button', {
        type: 'button', class: 'fileTreeRow', title: entry.path,
        onclick: () => { if (entry.type === 'file') void openFile(entry); },
      },
        icon('CodeOutline16', { size: 16, className: 'fileTypeIcon' }),
        h('span', { class: 'fileTreeName', text: entry.name })));
      return item;
    }

    const children = h('ul', { class: clsx('fileTreeLevel', !expanded.has(entry.path) && 'hidden') });
    const glyph = h('span', { class: 'fileTreeFolder' },
      icon(expanded.has(entry.path) ? 'FolderOpen16' : 'FolderClose16', { size: 16 }));
    let loaded = false;
    let loading = false;
    const row = h('button', {
      type: 'button', class: 'fileTreeRow', title: entry.path,
      'aria-expanded': expanded.has(entry.path) ? 'true' : 'false',
      onclick: async () => {
        const opening = !expanded.has(entry.path);
        if (opening) expanded.add(entry.path); else expanded.delete(entry.path);
        row.setAttribute('aria-expanded', opening ? 'true' : 'false');
        children.classList.toggle('hidden', !opening);
        glyph.replaceChildren(icon(opening ? 'FolderOpen16' : 'FolderClose16', { size: 16 }));
        if (opening && !loaded && !loading) {
          loading = true;
          await loadLevel(entry.path, children, renderGeneration);
          loaded = true;
          loading = false;
        }
      },
    }, glyph, h('span', { class: 'fileTreeName', text: entry.name }));
    item.append(row, children);
    if (expanded.has(entry.path)) {
      loading = true;
      void loadLevel(entry.path, children, renderGeneration).then(() => { loaded = true; loading = false; });
    }
    return item;
  }

  async function openFile(entry) {
    try {
      const out = await api.call(state.currentInstanceId, 'workspace.fs.read', { path: entry.path, maxBytes: 262144 });
      const body = out?.binary
        ? h('div', { class: 'empty', text: `二进制文件（${fmtSize(out.size)}），云端不预览` })
        : h('pre', { class: 'jsonBox', text: out?.text ?? '' });
      (await import('./ui.js')).openModal({ title: entry.name, width: 'min(880px, 92vw)', body });
    } catch (err) { toast('error', err.message); }
  }
  void handlers;
}

function fmtSize(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

// ---------------------------------------------------------------- 终端

function renderTerminal(host, handlers, registerCleanup) {
  if (!hasCapability('terminal')) {
    host.append(h('div', { class: 'empty', html:
      '这台机器的插件还没有提供终端接口 <b>terminal.open / write / resize / close</b>。<br><br>'
      + '接口已经定义好，见 <code>PLUGIN-EXT.md</code> §7。<br>'
      + '如果只想看 bash 任务的输出，用「任务」标签页就够了，不必实现终端。' }));
    return;
  }
  if (!settings.allowRemoteTerminal) {
    host.append(h('div', { class: 'empty', html:
      '远程终端等价于把本机 shell 交出去，默认关闭。<br><br>'
      + '确认这台机器可信后，在 <b>设置 → 通用设置 → 高级</b> 里打开「允许远程终端」。' }));
    return;
  }

  const out = h('pre', { class: 'termOut' });
  const input = h('input', { class: 'input termInput', placeholder: '输入命令后回车（原始数据会发给本机 shell）' });
  host.append(out, h('div', { class: 'termRow' }, input));

  let opened = false;
  const ensure = async () => {
    if (opened) return;
    const cols = Math.max(40, Math.floor(host.clientWidth / 8));
    opened = !!(await handlers.onTerminalOpen(cols, 30));
    if (opened) out.textContent += '（终端已连接）\n';
  };

  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    await ensure();
    const line = input.value;
    input.value = '';
    out.textContent += `$ ${line}\n`;
    handlers.onTerminalWrite(`${line}\r`);
  });

  const onData = (e) => { out.textContent += e.detail.data; out.scrollTop = out.scrollHeight; };
  const onExit = (e) => { out.textContent += `\n（终端已退出，code=${e.detail.code}）\n`; opened = false; };
  window.addEventListener('dsh:terminal-output', onData);
  window.addEventListener('dsh:terminal-exit', onExit);
  registerCleanup(() => {
    window.removeEventListener('dsh:terminal-output', onData);
    window.removeEventListener('dsh:terminal-exit', onExit);
    handlers.onTerminalClose();
  });
  ensure();
}

// ---------------------------------------------------------------- 任务

function renderJobs(host, rerender) {
  const jobs = state.detail?.jobs?.items || [];
  const head = h('div', { class: 'traceSummary' },
    h('div', { class: 'statChip' }, h('span', { class: 'sv', text: String(jobs.length) }), h('span', { class: 'sl', text: '任务' })),
    h('div', { class: 'spacer' }),
    h('button', {
      class: 'btn sm outline',
      onclick: async () => {
        try {
          const out = await api.call(state.currentInstanceId, 'job.list', {});
          state.detail = { ...(state.detail || {}), jobs: out };
          rerender();
        } catch (e) { toast('error', e.message); }
      },
    }, '刷新'));
  host.append(head);

  if (!jobs.length) {
    host.append(h('div', { class: 'empty', html: '没有后台任务。<br>点上面的「刷新」调用 <code>job.list</code>。' }));
    return;
  }
  for (const j of jobs) {
    host.append(h('div', { class: 'traceRow' },
      h('div', { class: 'traceHead' },
        h('span', { class: clsx('badge', j.status === 'running' ? 'ok' : j.status === 'completed' ? 'info' : 'err'), text: j.status }),
        h('span', { class: 'traceTurn', text: j.label || j.id })),
      h('div', { class: 'traceMeta' }, j.detail || ''),
      h('div', { class: 'row', style: 'gap:6px;margin-top:6px' },
        h('button', {
          class: 'btn sm outline',
          onclick: async () => {
            try {
              const r = await api.call(state.currentInstanceId, 'job.read', { jobId: j.id, sessionId: j.sessionId });
              (await import('./ui.js')).openModal({ title: `任务 ${j.id} 输出`, body: h('pre', { class: 'jsonBox', text: r?.text || '（空）' }) });
            } catch (e) { toast('error', e.message); }
          },
        }, '读输出'),
        j.status === 'running' ? h('button', {
          class: 'btn sm danger',
          onclick: async () => {
            try { await api.call(state.currentInstanceId, 'job.kill', { jobId: j.id, sessionId: j.sessionId, reason: '云端手动终止' }); toast('info', '已请求终止'); }
            catch (e) { toast('error', e.message); }
          },
        }, '终止') : null)));
  }
}
