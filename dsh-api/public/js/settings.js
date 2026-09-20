/* 设置面板。结构与上游 ui-settings-general 的 SettingsRoot 一致：
 * 左侧 188px 导航 + 右侧内容区，顶部右侧是动作区与关闭按钮。
 * 管理密钥、机器管理这些云端特有的东西都收在这里（对应需求「放到设置里面去」）。
 */
import { h, clsx, json, toast, copyText, fullTime } from './util.js';
import { icon } from './icons.js';
import { state, settings, saveSettings, notify, hasCapability } from './store.js';
import { api, adminKey, BASE } from './api.js';
import { openMenu, settingRow, selector, confirmDialog, openModal } from './ui.js';

const SECTIONS = [
  { id: 'general', label: '通用设置', icon: 'SettingsOutline16' },
  { id: 'machines', label: '机器与密钥', icon: 'PersonalizationOutline16' },
  { id: 'plugins', label: '插件', icon: 'CordisPluginOutline14' },
  { id: 'agent-presets', label: 'Agent 预设', icon: 'AgentPresetOutline16' },
  { id: 'debug', label: '调试', icon: 'ApiOutline14' },
];

let modal = null;
let activeSection = 'general';
let contentHost = null;
let pluginPresetSelection = null;
let expandedPlugin = null;
const pluginGroupsOpen = { session: true, global: false };

/**
 * 打开设置面板。
 * @param {string} [section] 初始分区
 */
export function openSettings(section) {
  if (modal) { selectSection(section || activeSection); return; }
  activeSection = section || 'general';

  const navList = h('div', { class: 'settingsNavList' });
  const content = h('div', { class: 'settingsContent' });
  const options = h('div', { class: 'settingsOptions' });
  contentHost = options;

  const panel = h('div', { class: 'settingsPanel' },
    h('nav', { class: 'settingsNav' },
      h('div', { class: 'settingsNavTitle', text: '设置' }),
      navList),
    content);

  content.append(
    h('div', { class: 'settingsHeader' },
      h('div', { class: 'settingsActions' }),
      h('button', { class: 'settingsClose', 'aria-label': '关闭', onclick: () => close() }, icon('CloseOutline16', { size: 14 }))),
    options);

  const overlay = h('div', { class: 'overlay' },
    h('div', { class: 'mask', onclick: () => close() }),
    panel);
  document.body.append(overlay);
  modal = overlay;

  function renderNav() {
    navList.innerHTML = '';
    for (const s of SECTIONS) {
      navList.append(h('button', {
        type: 'button',
        class: clsx('navCell', s.id === activeSection && 'active'),
        'aria-current': s.id === activeSection ? 'true' : undefined,
        onclick: () => selectSection(s.id),
      }, icon(s.icon, { size: 16 }), h('span', { text: s.label })));
    }
  }

  function selectSection(id) {
    activeSection = id;
    renderNav();
    options.innerHTML = '';
    if (id === 'general') renderGeneral(options);
    else if (id === 'machines') renderMachines(options);
    else if (id === 'plugins') renderPlugins(options);
    else if (id === 'agent-presets') renderAgentPresets(options);
    else renderDebug(options);
  }

  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);

  function close() {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    modal = null;
    contentHost = null;
  }

  selectSection(activeSection);
}

/** 主题与字号落到 document 上（对应上游的 ThemePresenter） */
export function applyTheme() {
  const dark = settings.theme === 'dark'
    || (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  document.body.toggleAttribute('data-ds-dark-theme', dark);
  document.body.style.setProperty('--dsh-content-font-size', `${settings.fontSize}px`);
}

// ---------------------------------------------------------------- 通用

function renderGeneral(host) {
  host.append(h('h2', { class: 'settingsSectionTitle', text: '通用设置' }));
  host.append(h('p', { class: 'settingsIntro', text: '这些偏好只影响本控制台，不会下发给机器上的 dsh。' }));

  // 外观
  const cubes = h('div', { class: 'themeCubes' },
    ...[['light', '浅色', 'LightOutline16'], ['dark', '深色', 'DarkOutline16'], ['system', '跟随系统', 'FollowsystemOutline16']]
      .map(([id, label, ic]) => h('button', {
        type: 'button', class: 'themeCube', dataset: { theme: id },
        'aria-pressed': settings.theme === id ? 'true' : 'false',
        onclick: () => { saveSettings({ theme: id }); applyTheme(); refreshContent(); },
      }, h('span', { class: 'swatch' }), icon(ic, { size: 14 }), h('span', { text: label }))));
  host.append(settingRow('外观', '浅色、深色，或跟随系统。', cubes));

  // 字号
  const sizeLabel = h('span', { style: 'min-width:34px;text-align:right;font-variant-numeric:tabular-nums' },
    `${settings.fontSize}px`);
  const stepper = h('div', { class: 'selector', style: 'padding:0 6px 0 14px' },
    sizeLabel,
    h('span', { style: 'display:flex;flex-direction:column' },
      h('button', {
        class: 'iconButton', style: 'width:22px;height:16px', 'aria-label': '增大字号',
        onclick: () => { saveSettings({ fontSize: Math.min(17, settings.fontSize + 1) }); applyTheme(); refreshContent(); },
      }, icon('ChevronUpOutline14', { size: 12 })),
      h('button', {
        class: 'iconButton', style: 'width:22px;height:16px', 'aria-label': '减小字号',
        onclick: () => { saveSettings({ fontSize: Math.max(12, settings.fontSize - 1) }); applyTheme(); refreshContent(); },
      }, icon('ChevronDownOutline14', { size: 12 }))));
  host.append(settingRow('字号大小', '仅影响会话内容的字号。', stepper));

  // 对话显示
  host.append(settingRow('对话显示', '控制已结束轮次里的过程内容怎么展示。',
    selector(settings.transcript === 'compact' ? '紧凑' : '标准', (e) => {
      openMenu(e.currentTarget, [
        { id: 'compact', label: '紧凑', meta: '折叠中间步骤', selected: settings.transcript === 'compact' },
        { id: 'normal', label: '标准', meta: '全部展开', selected: settings.transcript !== 'compact' },
      ], { align: 'end', onSelect: (id) => { saveSettings({ transcript: id }); refreshContent(); notify('transcript'); } });
    })));

  const permissionLabels = {
    'read-only': '只读',
    'workspace-write': '工作区内修改',
    'full-access': '完全权限',
  };
  host.append(settingRow('权限', '选择新会话的默认权限模式。',
    selector(permissionLabels[settings.defaultPermission] || settings.defaultPermission, (e) => {
      openMenu(e.currentTarget, Object.entries(permissionLabels).map(([id, label]) => ({
        id, label, selected: settings.defaultPermission === id,
      })), { align: 'end', onSelect: (id) => { saveSettings({ defaultPermission: id }); refreshContent(); } });
    })));

  host.append(settingRow('繁忙时的发送行为', '智能体运行时 Enter 键采用的默认行为。',
    selector(settings.submitMode === 'steer' ? '插话发送' : '排队发送', (e) => {
      openMenu(e.currentTarget, [
        { id: 'queue', label: '排队发送', meta: '作为下一轮执行', selected: settings.submitMode !== 'steer' },
        { id: 'steer', label: '插话发送', meta: '在下个步骤边界送入当前轮', selected: settings.submitMode === 'steer' },
      ], { align: 'end', onSelect: (id) => { saveSettings({ submitMode: id }); refreshContent(); } });
    })));

  // 自动刷新
  const REFRESH = [
    { id: 0, label: '关闭', meta: '只靠实时事件流' },
    { id: 3000, label: '3 秒' },
    { id: 5000, label: '5 秒' },
    { id: 10000, label: '10 秒' },
    { id: 30000, label: '30 秒' },
  ];
  const cur = REFRESH.find((r) => r.id === settings.autoRefreshMs) || REFRESH[2];
  host.append(settingRow('自动刷新', '定期重新拉取会话列表，保证云端与本地看到的状态一致。实时事件流始终生效。',
    selector(cur.label, (e) => {
      openMenu(e.currentTarget, REFRESH.map((r) => ({ ...r, selected: r.id === settings.autoRefreshMs })),
        { align: 'end', onSelect: (id) => { saveSettings({ autoRefreshMs: Number(id) }); refreshContent(); notify('autorefresh'); } });
    })));

  // 连接状态
  host.append(settingRow('实时连接', state.connected ? '已连接，事件流正常。' : `异常：${state.connDetail || '未连接'}`,
    h('span', { class: clsx('badge', state.connected ? 'ok' : 'err') }, state.connected ? '在线' : '离线')));

  // 管理密钥
  const keyInput = h('input', { class: 'input', type: 'password', value: adminKey.get(), autocomplete: 'off' });
  host.append(h('div', { class: 'setRow setRowStack' },
    h('div', { class: 'setRowText', style: 'padding-right:0' },
      h('div', { class: 't', text: '管理密钥' }),
      h('div', { class: 'd', text: '密钥只保存在当前浏览器；完整值位于服务端数据目录的 admin-key.txt。' })),
    h('div', { style: 'display:flex;gap:8px;margin-top:10px' },
      keyInput,
      h('button', {
        class: 'btn primary sm', style: 'flex:none',
        onclick: () => { adminKey.set(keyInput.value.trim()); toast('info', '已保存，正在重连…'); window.location.reload(); },
      }, '保存并重连'))));

  // 端点
  host.append(settingRow('服务端点', BASE, h('button', {
    class: 'btn outline sm', onclick: () => copyText(location.origin + BASE).then(() => toast('info', '已复制端点')),
  }, '复制')));

  // ---- 高级：能改机器状态的开关，默认全关
  host.append(h('h2', { class: 'settingsSectionTitle', style: 'margin-top:26px' }, '高级'));
  host.append(h('p', { class: 'settingsIntro' },
    '下面这些开关会让云端获得更强的机器控制权。默认全部关闭，按需打开。'));

  host.append(settingRow('允许远程终端',
    '打开后右侧栏出现「终端」标签页，可以把命令送进本机 shell。等价于交出本机命令行，确认这台机器可信再开。',
    switchBox(settings.allowRemoteTerminal, (on) => { saveSettings({ allowRemoteTerminal: on }); refreshContent(); notify('layout'); })));

  host.append(settingRow('允许提权操作',
    '打开后才允许远程切换会话的权限预设（只读 / 工作区写 / 完全权限）、启停插件、改插件配置。',
    switchBox(settings.allowRemotePrivileged, (on) => { saveSettings({ allowRemotePrivileged: on }); refreshContent(); })));

  host.append(settingRow('右侧面板',
    '展开右侧的轨迹 / 文件 / 终端面板。',
    switchBox(settings.rightbarOpen, (on) => { saveSettings({ rightbarOpen: on }); refreshContent(); notify('layout'); })));
}

/** 开关控件，对应上游 ui-primitives 的 Switch */
function switchBox(on, onChange) {
  const el = h('button', {
    type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false',
    class: clsx('switch', on && 'on'),
    onclick: () => onChange(!on),
  }, h('span', { class: 'knob' }));
  return el;
}

// ---------------------------------------------------------------- 机器与密钥

function renderMachines(host) {
  host.append(h('h2', { class: 'settingsSectionTitle', text: '机器与密钥' }));
  host.append(h('p', { class: 'settingsIntro', text: '每台 dsh 自己生成一把 key，登记到服务器后即可被这里接管；吊销即刻生效。' }));

  // 当前机器
  const inst = state.instances.find((i) => i.instanceId === state.currentInstanceId);
  if (inst) {
    const caps = Object.entries(inst.capabilities || {})
      .filter(([, v]) => v === true)
      .map(([k]) => k);
    host.append(h('div', { class: 'setRow setRowStack' },
      h('div', { class: 'setRowText', style: 'padding-right:0' },
        h('div', { class: 't', text: `${inst.label || inst.instanceId}（当前选中）` }),
        h('div', { class: 'd mono wrapAny', text: inst.instanceId }),
        h('div', { class: 'd', text: `${inst.hostname || '?'} · ${inst.platform || '?'} · 插件 ${inst.pluginVersion || '?'} · ${inst.transport || '未知载体'}${inst.insecure ? ' · ⚠ 明文链路' : ' · TLS'}` }),
        h('div', { class: 'd', text: `key 指纹 ${inst.keyFingerprint || '—'}　最后活跃 ${fullTime(inst.lastSeenAt)}` })),
      h('div', { style: 'display:flex;flex-wrap:wrap;gap:4px;margin-top:8px' },
        ...caps.slice(0, 18).map((c) => h('span', { class: 'badge', text: c }))),
      h('div', { style: 'display:flex;gap:8px;margin-top:12px' },
        h('button', {
          class: 'btn outline sm',
          onclick: async () => {
            const r = await api.call(inst.instanceId, 'instance.info').catch((e) => { toast('error', e.message); return null; });
            if (r) showJson('instance.info', r);
          },
        }, '查看实例信息'),
        h('button', {
          class: 'btn outline sm',
          onclick: () => editMachineOf(inst.instanceId),
        }, '编辑名称 / key'),
        h('button', {
          class: 'btn danger sm',
          onclick: () => rotateKey(inst),
        }, '轮换 key'))));
  } else {
    host.append(h('div', { class: 'empty', text: '还没有选中机器。等某台 dsh 连上来后，从左上角的下拉框选择它。' }));
  }

  // 新增入口保持为一个动作；输入只在需要时出现在小窗口里。
  host.append(h('div', { class: 'machineAddRow' },
    h('button', {
      class: 'btn outline sm',
      type: 'button',
      onclick: () => openRegisterKeyModal(),
    }, icon('PlusOutline16', { size: 14 }), '新增实例')));

  // 已登记列表
  const listHost = h('div');
  host.append(h('div', { class: 'setRow setRowStack' },
    h('div', { class: 'setRowText', style: 'padding-right:0' },
      h('div', { class: 't', text: '已登记的 key' }),
      h('div', { class: 'd', text: '只显示指纹，完整 key 不会回显。' })),
    listHost));

  api.keys().then((keys) => {
    listHost.innerHTML = '';
    if (!keys.length) { listHost.append(h('div', { class: 'd', style: 'margin-top:8px', text: '还没有登记任何 key。' })); return; }
    for (const k of keys) {
      listHost.append(h('div', { class: 'keyRow' },
        h('div', { class: 'kMain' },
          h('div', { class: 'kLabel', text: k.label || '未命名' }),
          h('div', { class: 'kFp', text: `${k.fingerprint}${k.instanceId ? `　${k.instanceId}` : ''}` })),
        h('div', { style: 'display:flex;gap:6px' },
          h('button', {
            class: 'btn outline sm',
            onclick: () => editKey(k),
          }, '编辑'),
          h('button', {
            class: 'btn danger sm',
            onclick: async () => {
              if (!await confirmDialog('吊销 key', `吊销「${k.label}」后，该机器下一次重连会被拒绝，最长 60 秒内生效。其它机器不受影响。`, '吊销', true)) return;
              await api.revokeKey(k.id);
              toast('info', '已吊销');
              notify('instances');
              refreshContent();
            },
          }, '吊销'))));
    }
  }).catch(() => { listHost.append(h('div', { class: 'd', text: '读取失败。' })); });
}

/** 从 instanceId 反查 key 条目，找不到就给个提示 */
async function editMachineOf(instanceId) {
  try {
    const keys = await api.keys();
    const hit = keys.find((k) => k.instanceId === instanceId);
    if (!hit) { toast('error', '这台机器还没有对应的 key 记录，先在下面登记一把'); return; }
    editKey(hit);
  } catch (e) { toast('error', e.message); }
}

/**
 * 编辑一台已登记机器：改备注名 / 换 key。
 *
 * 换 key 只改服务器侧记录，不会去动机器上的 dsh——填的必须是那台机器当前
 * 实际持有的 key，否则它下次重连会被拒。想两边一起换请用「轮换 key」。
 * @param {{id: string, label?: string, fingerprint?: string, instanceId?: string|null}} entry
 */
function editKey(entry) {
  const labelInput = h('input', {
    class: 'input', value: entry.label || '', placeholder: '备注名，例如：办公室台式机',
  });
  const keyInput = h('input', {
    class: 'input', type: 'password', placeholder: '留空表示不改', spellcheck: 'false',
    autocomplete: 'off',
  });
  const reveal = h('button', {
    type: 'button', class: 'btn outline sm', style: 'flex:none;white-space:nowrap',
    onclick: () => {
      const hidden = keyInput.type === 'password';
      keyInput.type = hidden ? 'text' : 'password';
      reveal.textContent = hidden ? '隐藏' : '显示';
    },
  }, '显示');

  const modal = openModal({
    title: `编辑「${entry.label || '未命名'}」`,
    width: '460px',
    body: h('div', { class: 'setRowStack', style: 'padding:0' },
      h('div', { class: 'setRowText', style: 'padding:0' },
        h('div', { class: 't', text: '备注名' }),
        h('div', { class: 'd', text: '只影响控制台里显示的名字，随时可改。' })),
      labelInput,
      h('div', { class: 'setRowText', style: 'padding:12px 0 0' },
        h('div', { class: 't', text: '替换实例 key' }),
        h('div', {
          class: 'd',
          text: '只改服务器侧记录。新值必须是这台机器当前实际持有的 key，'
            + '否则它下次重连会被拒；要两边同时换请用「轮换 key」。',
        }),
        h('div', { class: 'd mono', text: `当前指纹 ${entry.fingerprint || '—'}` })),
      h('div', { style: 'display:flex;gap:8px;align-items:center' }, keyInput, reveal)),
    footer: [
      h('button', { class: 'btn outline', onclick: () => modal.close() }, '取消'),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          const patch = {};
          const label = labelInput.value.trim();
          if (label && label !== (entry.label || '')) patch.label = label;
          const key = keyInput.value.trim();
          if (key) patch.key = key;
          if (!Object.keys(patch).length) { modal.close(); return; }
          try {
            await api.updateKey(entry.id, patch);
            toast('info', '已保存');
            modal.close();
            notify('instances');
            refreshContent();
          } catch (e) { toast('error', e.message); }
        },
      }, '保存'),
    ],
  });
}

function openRegisterKeyModal() {
  const keyInput = h('input', {
    class: 'input mono',
    placeholder: 'dshk_xxxxxxxx',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  const labelInput = h('input', {
    class: 'input',
    placeholder: '例如：办公室台式机',
    autocomplete: 'off',
  });
  const body = h('div', { class: 'registerKeyForm' },
    h('label', null, h('span', { text: '实例 key' }), keyInput),
    h('label', null, h('span', { text: '名称（可选）' }), labelInput));
  let busy = false;
  let dialog;
  const submit = async () => {
    if (busy) return;
    const key = keyInput.value.trim();
    if (!key) { toast('error', '请输入实例 key'); keyInput.focus(); return; }
    busy = true;
    save.disabled = true;
    save.textContent = '添加中…';
    try {
      const out = await api.registerKey(key, labelInput.value.trim());
      dialog.close();
      toast('info', `已添加 ${out.item.label}`);
      notify('instances');
      refreshContent();
    } catch (error) {
      busy = false;
      save.disabled = false;
      save.textContent = '添加';
      toast('error', error.message);
    }
  };
  const save = h('button', { class: 'btn primary', type: 'button', onclick: submit }, '添加');
  dialog = openModal({
    title: '新增实例',
    width: 'min(420px, 92vw)',
    body,
    footer: [
      h('button', { class: 'btn outline', type: 'button', onclick: () => dialog.close() }, '取消'),
      save,
    ],
  });
  body.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); void submit(); }
  });
  setTimeout(() => keyInput.focus(), 0);
}

async function rotateKey(inst) {
  const ok = await confirmDialog(
    '轮换实例 key',
    `服务器会调用插件的 instance.rotateKey，自动登记新 key 并删除旧 key。\n\n执行后该机器连接会立即断开，退避后自动用新 key 重连，不需要人工干预。`,
    '轮换', true);
  if (!ok) return;
  try {
    const out = await api.rotateKey(inst.instanceId);
    toast('info', '已轮换', 6000);
    showJson('新的实例 key（只显示这一次）', out);
    notify('instances');
  } catch (e) {
    toast('error', `轮换失败：${e.message}`);
  }
}

// ---------------------------------------------------------------- 插件

function renderPlugins(host) {
  host.append(h('h2', { class: 'settingsSectionTitle', text: '插件' }));
  host.append(h('p', { class: 'settingsIntro', text: '查看这台机器上的插件清单、配置与启用状态。' }));

  if (!hasCapability('pluginManagement')) {
    host.append(h('div', { class: 'empty', html:
      '这台机器的插件还没有提供插件管理接口 <b>plugin.list / plugin.setEnabled / plugin.config</b>。<br><br>'
      + '接口已经定义好，见仓库 <code>PLUGIN-EXT.md</code> §8；<br>插件加上之后这一页会自动出现内容，无需再改服务器。' }));
    host.append(h('div', { class: 'setRow setRowStack' },
      h('div', { class: 'setRowText', style: 'padding-right:0' },
        h('div', { class: 't', text: '本机 dsh 的能力清单' }),
        h('div', { class: 'd', text: '下面这些是插件当前上报的能力位，勾选的是已经支持的。' })),
      h('div', { style: 'display:flex;flex-wrap:wrap;gap:5px;margin-top:10px' },
        ...capabilityChips())));
    return;
  }

  const listBox = h('div', { class: 'pluginInventory' });
  host.append(listBox);
  listBox.append(h('div', { class: 'empty', text: '加载中…' }));

  api.call(state.currentInstanceId, 'plugin.list').then((out) => {
    listBox.innerHTML = '';
    const items = out?.items || [];
    if (!items.length) { listBox.append(h('div', { class: 'empty', text: '没有插件' })); return; }

    const sessionItems = items.filter((item) => item.scope === 'session');
    const presetIds = [...new Set(sessionItems.map((item) => item.preset).filter(Boolean))];
    const roster = state.agentPresetRoster?.presets || [];
    const defaultPreset = roster.find((preset) => preset.isDefault)?.id || presetIds[0] || null;
    if (!presetIds.includes(pluginPresetSelection)) pluginPresetSelection = defaultPreset;

    const search = h('input', {
      type: 'search',
      placeholder: '搜索插件',
      'aria-label': '搜索插件',
      autocomplete: 'off',
    });
    const catalog = h('div', { class: 'pluginCatalog' });
    listBox.append(h('label', { class: 'pluginSearch' },
      icon('SearchOutline16', { size: 16 }),
      search), catalog);

    const draw = () => {
      const query = search.value.trim().toLocaleLowerCase();
      const searching = query.length > 0;
      const matches = (item) => [item.name, item.id, item.description, item.version]
        .some((value) => String(value || '').toLocaleLowerCase().includes(query));
      const selectedSession = sessionItems
        .filter((item) => item.preset === pluginPresetSelection)
        .filter(matches);
      const globalItems = items
        .filter((item) => item.scope !== 'session')
        .filter(matches);
      catalog.innerHTML = '';

      if (searching && !selectedSession.length && !globalItems.length) {
        catalog.append(h('div', { class: 'empty pluginEmpty', text: '没有匹配的插件。' }));
        return;
      }

      if (presetIds.length) {
        const selected = roster.find((preset) => preset.id === pluginPresetSelection);
        const switcher = h('button', {
          class: 'pluginPresetSwitch',
          type: 'button',
          'aria-label': '选择 Agent 预设',
          onclick: (event) => {
            openMenu(event.currentTarget, presetIds.map((id) => {
              const preset = roster.find((item) => item.id === id);
              return {
                id,
                label: `${preset?.name || id}${preset?.isDefault ? '（默认）' : ''}`,
                selected: id === pluginPresetSelection,
              };
            }), {
              minWidth: 220,
              onSelect: (id) => { pluginPresetSelection = id; draw(); },
            });
          },
        },
          h('span', { text: `${selected?.name || pluginPresetSelection}${selected?.isDefault ? '（默认）' : ''}` }),
          icon('ChevronDownOutline14', { size: 14 }));
        catalog.append(pluginGroup({
          id: 'session',
          title: '会话插件',
          subtitle: '由 Agent 预设按会话组成',
          items: selectedSession,
          total: sessionItems.filter((item) => item.preset === pluginPresetSelection).length,
          searching,
          trailing: switcher,
          redraw: draw,
        }));
      }

      catalog.append(pluginGroup({
        id: 'global',
        title: '全局插件',
        subtitle: '系统与所有会话共用',
        items: globalItems,
        total: items.filter((item) => item.scope !== 'session').length,
        searching,
        redraw: draw,
      }));
    };
    search.addEventListener('input', draw);
    draw();
  }).catch((e) => {
    listBox.innerHTML = '';
    listBox.append(h('div', { class: 'empty', text: `读取失败：${e.message}` }));
  });
}

function pluginGroup({ id, title, subtitle, items, total, searching, trailing, redraw }) {
  const open = searching || pluginGroupsOpen[id];
  const section = h('section', { class: 'pluginGroup', 'data-plugin-scope': id });
  const toggle = h('button', {
    class: 'pluginGroupToggle',
    type: 'button',
    'aria-expanded': open ? 'true' : 'false',
    onclick: () => { pluginGroupsOpen[id] = !open; redraw(); },
  },
    icon('ChevronDownOutline14', { size: 12, className: 'pluginChevron' }),
    h('span', { text: title }));
  section.append(
    h('div', { class: 'pluginGroupHead' }, toggle, trailing || null),
    h('p', { class: 'pluginGroupSub', text: `${subtitle} · ${searching ? items.length : total} 个` }));
  if (open && items.length) {
    section.append(h('div', { class: 'pluginCards' }, ...items.map((item) => pluginCard(item, redraw))));
  }
  return section;
}

function pluginCard(p, redraw) {
  const stateLabel = { active: '运行中', pending: '等待依赖', failed: '启动失败', unloading: '卸载中', disabled: '已停用' }[p.state] || p.state;
  const tone = p.state === 'active' ? 'ok' : p.state === 'failed' ? 'err' : '';
  const key = `${p.scope}:${p.preset || ''}:${p.id}`;
  const open = expandedPlugin === key;
  const details = h('div', { class: 'pluginCardDetails' },
    p.description ? h('p', { class: 'pluginDescription', text: p.description }) : null,
    h('dl', { class: 'pluginFacts' },
      h('div', null, h('dt', { text: '完整名称' }), h('dd', { text: p.name || '—' })),
      h('div', null, h('dt', { text: '版本' }), h('dd', { text: p.version || '—' })),
      h('div', null, h('dt', { text: '运行状态' }), h('dd', { text: stateLabel }))),
    p.scope !== 'session' && p.id ? h('div', { class: 'pluginCardActions' },
      p.configurable ? h('button', {
        class: 'btn outline sm',
        type: 'button',
        onclick: async () => {
          if (!settings.allowRemotePrivileged) { toast('error', '先在「通用设置 → 高级」里打开「允许提权操作」'); return; }
          try {
            const cfg = await api.call(state.currentInstanceId, 'plugin.config', { id: p.id });
            editPluginConfig(p, cfg);
          } catch (error) { toast('error', error.message); }
        },
      }, '配置') : null,
      h('button', {
        class: clsx('btn sm', p.enabled ? 'outline' : 'primary'),
        type: 'button',
        onclick: async () => {
          if (!settings.allowRemotePrivileged) { toast('error', '先在「通用设置 → 高级」里打开「允许提权操作」'); return; }
          const ok = await confirmDialog(p.enabled ? '停用插件' : '启用插件',
            `${p.enabled ? '停用' : '启用'}「${p.name || p.id}」会影响这台机器上所有会话，确认吗？`, p.enabled ? '停用' : '启用', p.enabled);
          if (!ok) return;
          try {
            await api.call(state.currentInstanceId, 'plugin.setEnabled', { id: p.id, enabled: !p.enabled });
            p.enabled = !p.enabled;
            p.state = p.enabled ? 'active' : 'disabled';
            toast('info', p.enabled ? '插件已启用' : '插件已停用');
            redraw();
          } catch (error) { toast('error', error.message); }
        },
      }, p.enabled ? '停用' : '启用')) : null);
  return h('article', { class: clsx('pluginCard', open && 'open'), 'data-plugin-id': p.id },
    h('button', {
      class: 'pluginCardButton',
      type: 'button',
      'aria-expanded': open ? 'true' : 'false',
      onclick: () => { expandedPlugin = open ? null : key; redraw(); },
    },
      h('span', { class: 'pluginCardMain' },
        h('strong', { class: 'pluginCardTitle', text: pluginShortName(p.name || p.id) }),
        h('span', { class: 'pluginCardTrailing' },
          p.state === 'active' ? h('span', { class: 'pluginStateDot', title: stateLabel }) : null,
          h('span', { class: `badge ${tone}`, text: p.enabled ? '已启用' : stateLabel }),
          icon('ChevronDownOutline14', { size: 12, className: 'pluginCardChevron' }))),
      h('code', { class: 'pluginCardIdentity', text: String(p.id || '').replace(/^include:/, '') || 'include' })),
    open ? details : null);
}

function pluginShortName(name) {
  const value = String(name || '');
  const unscoped = value.startsWith('@') ? value.slice(value.indexOf('/') + 1) : value;
  return unscoped
    .replace(/^cordis:/, '')
    .replace(/^cordis-plugin-/, '')
    .replace(/^dsh-(?:host-|client-)?/, '');
}

/** 用真实的 plugin.setConfig 保存 JSON；Schema 留在同一窗口供核对。 */
function editPluginConfig(plugin, config) {
  const editor = h('textarea', {
    class: 'input mono',
    rows: '14',
    spellcheck: 'false',
    value: json(config?.values || {}, 2, 200000),
    style: 'width:100%;resize:vertical;min-height:260px',
  });
  const schema = h('details', { style: 'margin-top:12px' },
    h('summary', { class: 'small', text: '查看配置 Schema' }),
    h('pre', { class: 'jsonBox', style: 'max-height:260px', text: json(config?.schema || {}, 2, 200000) }));
  const modalRef = openModal({
    title: `${plugin.name || plugin.id} 配置`,
    width: 'min(760px, 92vw)',
    body: h('div', null,
      h('p', { class: 'settingsIntro', text: '保存时按字段浅合并到当前配置；JSON 必须是对象。' }),
      editor,
      schema),
    footer: [
      h('button', { class: 'btn outline', onclick: () => modalRef.close() }, '取消'),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          let patch;
          try { patch = JSON.parse(editor.value); } catch { toast('error', '配置不是合法 JSON'); return; }
          if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            toast('error', '配置必须是 JSON 对象');
            return;
          }
          try {
            await api.call(state.currentInstanceId, 'plugin.setConfig', { id: plugin.id, patch });
            toast('info', '插件配置已保存');
            modalRef.close();
            refreshContent();
          } catch (error) { toast('error', `保存失败：${error.message}`); }
        },
      }, '保存'),
    ],
  });
}

/** 把插件上报的能力位画成一组小标签，方便对照 PLUGIN-EXT.md 看还缺什么 */
function capabilityChips() {
  const caps = state.instances.find((i) => i.instanceId === state.currentInstanceId)?.capabilities || {};
  const EXT = [
    ['sessionEvents', '原始事件窗口'],
    ['messageFeedback', '消息反馈'],
    ['permissionPresets', '权限预设'],
    ['agentPresets', 'Agent 预设'],
    ['attachments', '附件'],
    ['workspaceMutation', '工作区增删'],
    ['fileBrowser', '文件浏览'],
    ['terminal', '终端'],
    ['pluginManagement', '插件管理'],
  ];
  const base = Object.keys(caps).filter((k) => !EXT.some(([e]) => e === k));
  return [
    ...EXT.map(([k, label]) => h('span', {
      class: clsx('badge', caps[k] ? 'ok' : ''),
      title: caps[k] ? `已支持：${k}` : `插件未提供 ${k}，见 PLUGIN-EXT.md`,
    }, `${caps[k] ? '✓' : '○'} ${label}`)),
    h('span', { class: 'badge info', text: `基础能力 ${base.length} 项` }),
  ];
}

// ---------------------------------------------------------------- Agent 预设

function renderAgentPresets(host) {
  host.append(h('h2', { class: 'settingsSectionTitle', text: 'Agent 预设' }));
  host.append(h('p', { class: 'settingsIntro', text:
    '预设决定一个会话的工具、提示词与能力。这里直接读取本机 DSH 的同一份名单。' }));

  if (!hasCapability('agentPresets')) {
    host.append(h('div', { class: 'empty', text: '这台机器没有组合 agent-presets 服务。' }));
    return;
  }

  const list = h('div');
  list.append(h('div', { class: 'empty', text: '加载中…' }));
  host.append(list);
  api.call(state.currentInstanceId, 'agentPreset.list').then((roster) => {
    state.agentPresetRoster = roster;
    list.innerHTML = '';
    const presets = roster?.presets || [];
    if (!presets.length) { list.append(h('div', { class: 'empty', text: '没有 Agent 预设' })); return; }
    for (const preset of presets) list.append(agentPresetRow(preset, roster));
  }).catch((error) => {
    list.innerHTML = '';
    list.append(h('div', { class: 'empty', text: `读取失败：${error.message}` }));
  });
}

function agentPresetRow(preset, roster) {
  const builtin = preset.trust === 'system';
  return h('div', { class: 'setRow' },
    h('div', { class: 'setRowText' },
      h('div', { class: 't' }, preset.name || preset.id,
        preset.isDefault ? h('span', { class: 'badge ok', style: 'margin-left:8px', text: '默认' }) : null,
        builtin ? h('span', { class: 'badge', style: 'margin-left:5px', text: '内置' }) : null),
      h('div', { class: 'd', text: preset.broken || preset.description || preset.id }),
      h('div', { class: 'd mono', text: preset.id })),
    h('button', {
      class: 'btn outline sm',
      disabled: !!preset.broken || roster?.modeSelectionEnabled === false,
      onclick: () => {
        state.heroAgentPreset = preset.id;
        toast('info', `下一个新会话将使用「${preset.name || preset.id}」`);
        notify('transcript');
      },
    }, '下次使用'),
    h('button', {
      class: 'btn outline sm',
      onclick: async () => {
        try {
          const document = await api.call(state.currentInstanceId, 'agentPreset.read', { agentPreset: preset.id });
          openModal({
            title: preset.name || preset.id,
            width: 'min(860px, 92vw)',
            body: h('pre', { class: 'jsonBox', style: 'max-height:70vh', text: document?.content || '' }),
          });
        } catch (error) { toast('error', error.message); }
      },
    }, '查看'),
    roster?.authorable ? h('button', {
      class: 'btn outline sm',
      onclick: () => copyAgentPreset(preset),
    }, '复制') : null,
    !builtin ? h('button', {
      class: 'btn danger sm',
      onclick: async () => {
        if (!settings.allowRemotePrivileged) { toast('error', '先在「通用设置 → 高级」里打开「允许提权操作」'); return; }
        if (!await confirmDialog('删除 Agent 预设', `删除「${preset.name || preset.id}」？正在使用它的既有会话不受影响。`, '删除', true)) return;
        try {
          await api.call(state.currentInstanceId, 'agentPreset.delete', { agentPreset: preset.id });
          toast('info', 'Agent 预设已删除');
          refreshContent();
        } catch (error) { toast('error', error.message); }
      },
    }, '删除') : null);
}

function copyAgentPreset(source) {
  if (!settings.allowRemotePrivileged) { toast('error', '先在「通用设置 → 高级」里打开「允许提权操作」'); return; }
  const idInput = h('input', { class: 'input', placeholder: 'preset-id，例如 my-agent', spellcheck: 'false' });
  const nameInput = h('input', { class: 'input', placeholder: '显示名称（可选）' });
  const modalRef = openModal({
    title: `复制「${source.name || source.id}」`,
    body: h('div', { style: 'display:flex;flex-direction:column;gap:10px' }, idInput, nameInput),
    footer: [
      h('button', { class: 'btn outline', onclick: () => modalRef.close() }, '取消'),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          const agentPreset = idInput.value.trim();
          if (!agentPreset) { toast('error', '请填写预设 id'); return; }
          try {
            await api.call(state.currentInstanceId, 'agentPreset.copy', {
              from: source.id,
              agentPreset,
              ...(nameInput.value.trim() ? { name: nameInput.value.trim() } : {}),
            });
            toast('info', 'Agent 预设已复制');
            modalRef.close();
            refreshContent();
          } catch (error) { toast('error', error.message); }
        },
      }, '复制'),
    ],
  });
}

// ---------------------------------------------------------------- 调试

function renderDebug(host) {
  host.append(h('h2', { class: 'settingsSectionTitle', text: '调试' }));
  host.append(h('p', { class: 'settingsIntro', text: '查看链路原始帧、服务端日志，或直接调用任意方法。' }));

  const out = h('pre', { class: 'jsonBox', text: '点上面的按钮查看结果。' });

  host.append(h('div', { class: 'setRow' },
    h('div', { class: 'setRowText' },
      h('div', { class: 't', text: '实例自检' }),
      h('div', { class: 'd', text: '向当前机器下发只读的方法调用。' })),
    h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' },
      ...['instance.ping', 'instance.info', 'instance.health'].map((m) => h('button', {
        class: 'btn outline sm',
        onclick: async () => {
          const r = await api.call(state.currentInstanceId, m).catch((e) => ({ __error: e.message }));
          out.textContent = json(r);
        },
      }, m)))));

  const methodInput = h('input', { class: 'input', value: 'session.list' });
  const paramsInput = h('textarea', { class: 'input', rows: '3', placeholder: '{ "sessionId": "session-xxx" }' });
  host.append(h('div', { class: 'setRow setRowStack' },
    h('div', { class: 'setRowText', style: 'padding-right:0' },
      h('div', { class: 't', text: '任意方法调用' }),
      h('div', { class: 'd', text: '协议 §9 里的所有方法都可以在这里直接试。' })),
    h('div', { style: 'display:flex;flex-direction:column;gap:8px;margin-top:10px' },
      methodInput, paramsInput,
      h('button', {
        class: 'btn primary sm', style: 'align-self:flex-start',
        onclick: async () => {
          let params = {};
          if (paramsInput.value.trim()) {
            try { params = JSON.parse(paramsInput.value); } catch { toast('error', 'params 不是合法 JSON'); return; }
          }
          const r = await api.call(state.currentInstanceId, methodInput.value.trim(), params)
            .catch((e) => ({ __error: `${e.code || ''} ${e.message}` }));
          out.textContent = json(r);
        },
      }, '调用'))));

  host.append(h('div', { class: 'setRow setRowStack' },
    h('div', { class: 'setRowText', style: 'padding-right:0' },
      h('div', { class: 't', text: '结果' })),
    out));

  // 原始帧
  const frameHost = h('div', { class: 'frameList' });
  const drawFrames = () => {
    frameHost.innerHTML = '';
    const items = state.frames.slice(-120);
    if (!items.length) { frameHost.append(h('div', { class: 'empty', text: '还没有帧。' })); return; }
    for (const { frame, dir, at } of items) {
      frameHost.append(h('div', { class: 'frameItem' },
        h('div', { class: 'fMeta' },
          h('span', { class: clsx('badge', dir === 'in' ? 'info' : ''), text: dir === 'in' ? '↓ 上行' : '↑ 下行' }),
          h('span', { text: frame.type + (frame.kind ? ` / ${frame.kind}` : '') + (frame.method ? ` / ${frame.method}` : '') }),
          frame.seq != null ? h('span', { text: `seq=${frame.seq}` }) : null,
          h('span', { text: fullTime(at) })),
        h('pre', { text: json(frame, 2, 900) })));
    }
    frameHost.scrollTop = frameHost.scrollHeight;
  };
  drawFrames();
  const timer = setInterval(() => { if (!document.body.contains(frameHost)) { clearInterval(timer); return; } drawFrames(); }, 1200);

  host.append(h('div', { class: 'setRow setRowStack' },
    h('div', { class: 'setRowText', style: 'padding-right:0' },
      h('div', { class: 't', text: '链路原始帧' }),
      h('div', { class: 'd', text: '与当前机器之间的上下行帧，最多保留 1500 条（这里显示最近 120 条）。' })),
    frameHost));
}

// ---------------------------------------------------------------- 工具

function refreshContent() {
  if (!contentHost) return;
  contentHost.innerHTML = '';
  if (activeSection === 'general') renderGeneral(contentHost);
  else if (activeSection === 'machines') renderMachines(contentHost);
  else if (activeSection === 'plugins') renderPlugins(contentHost);
  else if (activeSection === 'agent-presets') renderAgentPresets(contentHost);
  else renderDebug(contentHost);
}

/** 打开设置面板时把外部变化也刷进去 */
export function refreshSettings() {
  if (modal) refreshContent();
}

function showJson(title, value) {
  openModal({ title, body: h('pre', { class: 'jsonBox', text: json(value) }) });
}
