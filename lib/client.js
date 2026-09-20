/**
 * dsh2server — browser half.
 *
 * This file is the package's `./client` export: the artifact the dsh **client
 * module system** serves to the page for any deployment whose Loader mounts
 * this bundle (`dsh.client` in `package.json`). It renders one tab —
 * **Settings → Plugins → dsh2server** — that configures the server endpoint and
 * copies this machine's instance key.
 *
 * It is written by hand as the loader's lazy-CJS factory artifact, because the
 * in-repo build preset is not published:
 *
 *   window.__ModuleLoader__.load({ id: '<package name>', factory: (require) => exports })
 *
 * Two consequences shape everything below:
 *
 *   · `require` resolves only against the shell's frozen platform seed table
 *     (`react`, `react/jsx-runtime`, `react-dom`, `@deepseek-ai/cordis`,
 *     `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`,
 *     `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-dockkit`)
 *     plus whatever `dsh.client.external` names. This bundle needs **react
 *     only**, so it declares no externals and therefore no supply edge that
 *     could fail to resolve in someone else's composition.
 *   · Nothing may be imported from another plugin (the bundle-purity gate): the
 *     card owns its own chrome, styling, and data fetching.
 *
 * Everything it displays comes from the package's own Host half over
 * `/api/dsh2server/*`, so the two halves travel together and no dsh installation
 * is ever modified.
 *
 * @module dsh2server/client
 */

window.__ModuleLoader__.load({
  id: 'dsh2server',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** Absolute path of this package's Host console API. */
    const API = '/api/dsh2server'
    /** Style element identity, injected once per page like every client bundle. */
    const STYLE_ID = 'dsh2server/Panel.css'

    const CSS = `
      .dsh2server-panel {
        display: grid;
        gap: 14px;
        width: 100%;
        max-width: 760px;
        padding: 4px 0 24px;
        color: var(--dsw-alias-label-primary);
        container-type: inline-size;
      }
      .dsh2server-hero {
        display: grid;
        gap: 9px;
        overflow: hidden;
        padding: 17px 18px;
        border: .5px solid var(--dsw-alias-border-l4);
        border-radius: 16px;
        background: var(--dsw-alias-bg-layer-3);
      }
      .dsh2server-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
      }
      .dsh2server-heading { display: grid; gap: 3px; min-width: 0; }
      .dsh2server-eyebrow {
        margin: 0;
        font-size: 11px;
        font-weight: 600;
        line-height: 1.4;
        letter-spacing: .06em;
        text-transform: uppercase;
        color: var(--dsw-alias-label-tertiary);
      }
      .dsh2server-title {
        margin: 0;
        font-size: 19px;
        font-weight: 650;
        line-height: 1.35;
        color: var(--dsw-alias-label-primary);
      }
      .dsh2server-badges { display: flex; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
      .dsh2server-badge {
        display: inline-flex;
        align-items: center;
        min-height: 22px;
        padding: 1px 8px;
        border: .5px solid var(--dsw-alias-border-l3);
        border-radius: 999px;
        font-size: 11px;
        line-height: 1.5;
        white-space: nowrap;
        color: var(--dsw-alias-label-tertiary);
        background: var(--dsw-alias-bg-layer-2, transparent);
      }
      .dsh2server-badge[data-on="true"] {
        color: var(--dsw-alias-label-success, #2f9e44);
        border-color: color-mix(in srgb, currentColor 48%, transparent);
        background: color-mix(in srgb, currentColor 8%, transparent);
      }
      .dsh2server-badge[data-off="true"] {
        color: var(--dsw-alias-label-error, #e5484d);
        border-color: color-mix(in srgb, currentColor 42%, transparent);
        background: color-mix(in srgb, currentColor 7%, transparent);
      }
      .dsh2server-hint {
        margin: 0;
        font-size: 12px;
        line-height: 1.6;
        color: var(--dsw-alias-label-tertiary);
      }
      .dsh2server-feedback {
        display: grid;
        gap: 6px;
      }
      .dsh2server-note {
        margin: 0;
        padding: 9px 11px;
        border: .5px solid var(--dsw-alias-border-l3);
        border-radius: 10px;
        background: var(--dsw-alias-bg-layer-3);
        font-size: 12px;
        line-height: 1.5;
      }
      .dsh2server-note[data-tone="error"] { color: var(--dsw-alias-label-error, #e5484d); }
      .dsh2server-note[data-tone="ok"] { color: var(--dsw-alias-label-success, #2f9e44); }
      .dsh2server-note[data-tone="info"] { color: var(--dsw-alias-label-tertiary); }
      .dsh2server-section {
        display: grid;
        gap: 14px;
        min-width: 0;
        padding: 16px;
        border: .5px solid var(--dsw-alias-border-l4);
        border-radius: 16px;
        background: var(--dsw-alias-bg-layer-3);
      }
      .dsh2server-section-head { display: grid; gap: 3px; }
      .dsh2server-section-title {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
        line-height: 1.5;
        color: var(--dsw-alias-label-primary);
      }
      .dsh2server-card-grid {
        display: grid;
        grid-template-columns: minmax(0, 1.08fr) minmax(0, .92fr);
        gap: 12px;
        align-items: stretch;
      }
      .dsh2server-field { display: grid; gap: 7px; min-width: 0; }
      .dsh2server-field-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .dsh2server-label {
        min-width: 0;
        font-size: 12px;
        font-weight: 500;
        line-height: 1.5;
        color: var(--dsw-alias-label-secondary);
      }
      .dsh2server-override {
        padding: 1px 6px;
        border-radius: 999px;
        background: var(--dsw-alias-bg-layer-2, transparent);
        font-size: 10px;
        line-height: 1.5;
        color: var(--dsw-alias-label-tertiary);
      }
      .dsh2server-endpoint-input, .dsh2server-select, .dsh2server-code {
        box-sizing: border-box;
        width: 100%;
        min-width: 0;
        max-width: 100%;
        border: .5px solid var(--dsw-alias-border-l4);
        border-radius: 9px;
        background: var(--dsw-alias-bg-layer-2, transparent);
        color: var(--dsw-alias-label-primary);
        font: inherit;
        font-size: 13px;
      }
      .dsh2server-endpoint-input, .dsh2server-select { padding: 9px 11px; }
      .dsh2server-endpoint-input {
        min-height: 38px;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        line-height: 1.5;
      }
      .dsh2server-select { min-height: 38px; }
      .dsh2server-endpoint-input:focus-visible, .dsh2server-select:focus-visible {
        outline: none;
        border-color: var(--dsw-alias-brand-primary, #4c9aff);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary, #4c9aff) 14%, transparent);
      }
      .dsh2server-endpoints { display: grid; gap: 8px; min-width: 0; }
      .dsh2server-endpoint-row {
        display: grid;
        grid-template-columns: 28px minmax(0, 1fr) auto;
        gap: 8px;
        align-items: center;
        min-width: 0;
      }
      .dsh2server-endpoint-index {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        border: .5px solid var(--dsw-alias-border-l3);
        border-radius: 999px;
        background: var(--dsw-alias-bg-layer-2, transparent);
        color: var(--dsw-alias-label-tertiary);
        font-size: 11px;
        font-variant-numeric: tabular-nums;
      }
      .dsh2server-endpoint-remove, .dsh2server-endpoint-add {
        min-height: 34px;
        border: .5px solid var(--dsw-alias-border-l3);
        border-radius: 8px;
        background: transparent;
        color: var(--dsw-alias-label-secondary);
        font: inherit;
        font-size: 12px;
        line-height: 1.5;
        cursor: pointer;
        transition: border-color .15s, background .15s, color .15s;
      }
      .dsh2server-endpoint-remove { padding: 5px 10px; }
      .dsh2server-endpoint-add {
        justify-self: start;
        padding: 5px 12px;
        border-style: dashed;
        color: var(--dsw-alias-label-tertiary);
      }
      .dsh2server-endpoint-remove:hover:not(:disabled), .dsh2server-endpoint-add:hover:not(:disabled) {
        border-color: var(--dsw-alias-label-dimmed, var(--dsw-alias-border-l4));
        background: var(--dsw-alias-bg-layer-2, transparent);
        color: var(--dsw-alias-label-primary);
      }
      .dsh2server-endpoint-remove:focus-visible, .dsh2server-endpoint-add:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary, #4c9aff);
        outline-offset: 2px;
      }
      .dsh2server-endpoint-remove:disabled, .dsh2server-endpoint-add:disabled { opacity: .42; cursor: default; }
      .dsh2server-endpoint-empty {
        padding: 11px 12px;
        border: .5px dashed var(--dsw-alias-border-l3);
        border-radius: 9px;
        color: var(--dsw-alias-label-tertiary);
        font-size: 12px;
        line-height: 1.5;
      }
      .dsh2server-code {
        min-height: 38px;
        padding: 9px 11px;
        overflow-wrap: anywhere;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        line-height: 1.5;
      }
      .dsh2server-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .dsh2server-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        padding-top: 12px;
        border-top: .5px solid var(--dsw-alias-border-l2);
      }
      .dsh2server-actions .dsh2server-button[data-kind="quiet"] { margin-left: auto; }
      .dsh2server-button {
        min-height: 34px;
        padding: 5px 12px;
        border: .5px solid var(--dsw-alias-border-l3);
        border-radius: 8px;
        background: transparent;
        color: var(--dsw-alias-label-secondary);
        font: inherit;
        font-size: 12px;
        line-height: 1.5;
        cursor: pointer;
        transition: border-color .15s, background .15s, color .15s;
      }
      .dsh2server-button:hover:not(:disabled) {
        border-color: var(--dsw-alias-label-dimmed, var(--dsw-alias-border-l4));
        background: var(--dsw-alias-bg-layer-2, transparent);
        color: var(--dsw-alias-label-primary);
      }
      .dsh2server-button:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary, #4c9aff);
        outline-offset: 2px;
      }
      .dsh2server-button:disabled { opacity: .42; cursor: default; }
      .dsh2server-button[data-kind="primary"] {
        border-color: transparent;
        background: var(--dsw-alias-label-primary);
        color: var(--dsw-alias-bg-layer-3, #fff);
      }
      .dsh2server-button[data-kind="quiet"] { border-color: transparent; background: transparent; }
      .dsh2server-button[data-kind="danger"] {
        border-color: color-mix(in srgb, var(--dsw-alias-label-error, #e5484d) 35%, transparent);
        color: var(--dsw-alias-label-error, #e5484d);
      }
      .dsh2server-meta {
        display: grid;
        gap: 8px;
        padding: 10px 11px;
        border-radius: 10px;
        background: var(--dsw-alias-bg-layer-2, transparent);
      }
      .dsh2server-kv {
        display: grid;
        grid-template-columns: max-content minmax(0, 1fr);
        gap: 5px 12px;
        font-size: 11px;
        line-height: 1.5;
      }
      .dsh2server-kv > span:nth-child(odd) { color: var(--dsw-alias-label-tertiary); }
      .dsh2server-kv > span:nth-child(even) {
        min-width: 0;
        overflow-wrap: anywhere;
        color: var(--dsw-alias-label-secondary);
      }
      .dsh2server-links { display: grid; gap: 8px; }
      .dsh2server-link {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 3px 8px;
        align-items: start;
        min-width: 0;
        padding: 9px 10px;
        border: .5px solid var(--dsw-alias-border-l2);
        border-radius: 10px;
        background: var(--dsw-alias-bg-layer-2, transparent);
      }
      .dsh2server-link code {
        min-width: 0;
        overflow-wrap: anywhere;
        color: var(--dsw-alias-label-secondary);
        font-size: 11px;
        line-height: 1.55;
      }
      .dsh2server-link .dsh2server-hint { grid-column: 2; font-size: 11px; }
      .dsh2server-toggle-list {
        display: grid;
        overflow: hidden;
        border: .5px solid var(--dsw-alias-border-l2);
        border-radius: 12px;
        background: var(--dsw-alias-bg-layer-2, transparent);
      }
      .dsh2server-toggle {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 18px;
        min-height: 48px;
        padding: 10px 12px;
        color: var(--dsw-alias-label-secondary);
        font-size: 12px;
        line-height: 1.5;
        cursor: pointer;
      }
      .dsh2server-toggle span { min-width: 0; overflow-wrap: anywhere; }
      .dsh2server-toggle + .dsh2server-toggle { border-top: .5px solid var(--dsw-alias-border-l2); }
      .dsh2server-toggle span { min-width: 0; }
      .dsh2server-toggle input {
        flex: none;
        appearance: none;
        width: 34px;
        height: 20px;
        margin: 0;
        border: .5px solid var(--dsw-alias-border-l4);
        border-radius: 999px;
        background: var(--dsw-alias-bg-layer-4, transparent);
        cursor: pointer;
        transition: background .16s, border-color .16s;
      }
      .dsh2server-toggle input::after {
        display: block;
        width: 16px;
        height: 16px;
        margin: 1px;
        border-radius: 50%;
        background: var(--dsw-alias-label-tertiary);
        content: '';
        transition: transform .16s, background .16s;
      }
      .dsh2server-toggle input:checked {
        border-color: var(--dsw-alias-brand-primary, #4c9aff);
        background: var(--dsw-alias-brand-primary, #4c9aff);
      }
      .dsh2server-toggle input:checked::after {
        transform: translateX(14px);
        background: #fff;
      }
      .dsh2server-toggle input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4c9aff); outline-offset: 2px; }
      .dsh2server-toggle input:disabled { opacity: .45; cursor: default; }
      @media (max-width: 700px) {
        .dsh2server-card-grid { grid-template-columns: minmax(0, 1fr); }
      }
      @container (max-width: 620px) {
        .dsh2server-card-grid { grid-template-columns: minmax(0, 1fr); }
      }
      @container (max-width: 320px) {
        .dsh2server-hero, .dsh2server-section {
          box-sizing: border-box;
          width: 100%;
          min-width: 0;
          padding: 9px;
        }
        .dsh2server-head, .dsh2server-field-head { align-items: stretch; flex-direction: column; gap: 5px; }
        .dsh2server-badges { display: grid; justify-content: stretch; }
        .dsh2server-badge { box-sizing: border-box; width: 100%; max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
        .dsh2server-endpoint-input {
          padding: 7px;
          overflow-wrap: anywhere;
        }
        .dsh2server-endpoint-row { grid-template-columns: minmax(0, 1fr); }
        .dsh2server-endpoint-index { display: none; }
        .dsh2server-endpoint-remove, .dsh2server-endpoint-add {
          box-sizing: border-box;
          width: 100%;
          min-width: 0;
          max-width: 100%;
        }
        .dsh2server-select, .dsh2server-code { padding: 7px; font-size: 11px; }
        .dsh2server-row, .dsh2server-actions {
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          width: 100%;
          min-width: 0;
        }
        .dsh2server-button {
          box-sizing: border-box;
          width: 100%;
          min-width: 0;
          max-width: 100%;
          padding-right: 5px;
          padding-left: 5px;
          white-space: normal;
          overflow-wrap: anywhere;
        }
        .dsh2server-section-head, .dsh2server-field, .dsh2server-meta,
        .dsh2server-links, .dsh2server-link, .dsh2server-toggle-list { min-width: 0; }
        .dsh2server-meta > * { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
        .dsh2server-link { grid-template-columns: minmax(0, 1fr); }
        .dsh2server-link .dsh2server-hint { grid-column: 1; min-width: 0; overflow-wrap: anywhere; }
        .dsh2server-kv { grid-template-columns: minmax(0, 1fr); }
        .dsh2server-toggle {
          box-sizing: border-box;
          width: 100%;
          min-width: 0;
          max-width: 100%;
          align-items: flex-start;
          gap: 6px;
          padding: 8px;
        }
      }
      @media (max-width: 520px) {
        .dsh2server-panel { gap: 10px; }
        .dsh2server-hero, .dsh2server-section { padding: 14px; border-radius: 13px; }
        .dsh2server-head { align-items: stretch; flex-direction: column; }
        .dsh2server-badges { justify-content: flex-start; }
        .dsh2server-actions { align-items: stretch; }
        .dsh2server-actions .dsh2server-button { flex: 1 1 auto; }
        .dsh2server-actions .dsh2server-button[data-kind="quiet"] { margin-left: 0; }
        .dsh2server-toggle { align-items: flex-start; }
      }
    `

    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh2server'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    const h = React.createElement

    const TEXT = Object.freeze({
      loadingFailed: ['无法读取插件状态：{error}', 'Unable to load plugin status: {error}'],
      loading: ['正在读取插件状态…', 'Loading plugin status…'],
      rejected: ['被拒绝：{error}', 'Rejected: {error}'],
      connectedVia: ['已连接（{transport}）', 'Connected ({transport})'],
      disconnectedError: ['未连接：{error}', 'Disconnected: {error}'],
      linksConnected: ['{connected}/{total} 条链路已连接', '{connected}/{total} links connected'],
      serverUnconfigured: ['未配置服务器', 'Server not configured'],
      disconnected: ['未连接', 'Disconnected'],
      webOverride: ['网页值', 'Web override'],
      relay: ['远程中转', 'Remote relay'],
      serverConnection: ['服务器连接', 'Server connection'],
      pluginLanguage: ['插件语言', 'Plugin language'],
      languageHint: ['自动模式会跟随电脑语言；手动选择会保存在插件配置中。', 'Automatic mode follows the computer language; a manual choice is stored in plugin settings.'],
      languageSystem: ['自动（跟随系统）', 'Automatic (system)'],
      languageZh: ['简体中文', 'Simplified Chinese'],
      languageEn: ['English', 'English'],
      languageUpdated: ['语言已更新', 'Language updated'],
      endpoints: ['服务器 API 端点', 'Server API endpoints'],
      endpointAria: ['服务器 API 端点 {index}', 'Server API endpoint {index}'],
      removeEndpoint: ['移除端点 {index}', 'Remove endpoint {index}'],
      remove: ['移除', 'Remove'],
      noEndpoints: ['还没有服务器端点。', 'No server endpoints yet.'],
      addEndpoint: ['＋ 添加服务器端点', '+ Add server endpoint'],
      transport: ['传输方式', 'Transport'],
      auto: ['自动', 'Automatic'],
      longPolling: ['HTTP 长轮询', 'HTTP long polling'],
      savedApplied: ['已保存并应用', 'Saved and applied'],
      saving: ['保存中…', 'Saving…'],
      saveApply: ['保存并应用', 'Save and apply'],
      resetDone: ['已恢复为配置文件里的值', 'Restored values from the configuration file'],
      reset: ['恢复配置文件的值', 'Restore configuration-file values'],
      reconnectDone: ['已请求重连', 'Reconnect requested'],
      reconnect: ['立即重连', 'Reconnect now'],
      credentials: ['实例凭据', 'Instance credentials'],
      hiddenKey: ['{fingerprint}（点击“显示”查看完整 key）', '{fingerprint} (click “Show” to view the full key)'],
      keyCopied: ['已复制完整 key 到剪贴板', 'Full key copied to the clipboard'],
      clipboardShow: ['浏览器拒绝了剪贴板访问，请点“显示”后手动复制', 'Clipboard access was denied; click “Show” and copy manually'],
      copyKey: ['复制 Key', 'Copy key'],
      hide: ['隐藏', 'Hide'],
      show: ['显示', 'Show'],
      registrationCopied: ['已复制登记命令（curl），可直接在服务器上执行', 'Registration command copied; run it on the server'],
      clipboardDenied: ['浏览器拒绝了剪贴板访问', 'Clipboard access was denied'],
      copyRegistration: ['复制登记命令', 'Copy registration command'],
      rotateConfirm: ['轮换后会立刻断开连接，直到你在服务器上登记新的 key。确定继续吗？', 'Rotating disconnects this machine until the new key is registered on the server. Continue?'],
      rotateDone: ['已生成新 key —— 请立刻复制并登记到服务器', 'New key generated — copy and register it on the server now'],
      rotateKey: ['轮换 Key', 'Rotate key'],
      keyLocation: ['key 存放位置', 'Key location'],
      defaultLocation: ['（默认位置）', '(default location)'],
      keyWarning: ['key 无法写入磁盘：{error} —— 重启后会变化，请在 dsh 配置里固定 key。', 'The key cannot be saved to disk: {error}. It will change after restart; pin it in the dsh configuration.'],
      unknown: ['未知原因', 'Unknown reason'],
      links: ['链路状态', 'Link status'],
      idleNoEndpoint: ['没有配置端点，插件处于空闲状态（不会产生任何网络请求）。', 'No endpoint is configured. The plugin is idle and makes no network requests.'],
      methods: ['可用远程方法', 'Available remote methods'],
      count: ['{count} 个', '{count}'],
      uptime: ['运行时长', 'Uptime'],
      seconds: ['{count} 秒', '{count} s'],
      permissions: ['远程权限', 'Remote permissions'],
      permissionsHint: ['仅开启实际需要的能力。审批转发会把工具决策权交给远程服务器。', 'Enable only what you need. Forwarding approvals gives the remote server tool-decision authority.'],
      allowPrompt: ['允许服务器下发新命令（session.prompt）', 'Allow the server to send new prompts (session.prompt)'],
      allowControl: ['允许服务器中断 / 暂停 / 恢复 / 轮换 key', 'Allow the server to interrupt, pause, resume, and rotate keys'],
      allowTerminal: ['允许服务器打开本机远程终端（高风险）', 'Allow the server to open a local remote terminal (high risk)'],
      forwardApprovals: ['把工具调用审批转发到服务器等待远程批准（谨慎开启）', 'Forward tool approvals to the server (enable with care)'],
      updated: ['已更新', 'Updated'],
    })

    function resolvedLocale(setting) {
      if (setting === 'zh-CN' || setting === 'en-US') return setting
      if (typeof navigator === 'undefined') return 'zh-CN'
      const values = (navigator.languages || [navigator.language]).filter(Boolean)
      if (!values.length) return 'zh-CN'
      return values.some((value) => String(value || '').toLowerCase().startsWith('zh')) ? 'zh-CN' : 'en-US'
    }

    function tx(setting, key, values) {
      const pair = TEXT[key] || [key, key]
      const template = pair[resolvedLocale(setting) === 'zh-CN' ? 0 : 1]
      return template.replace(/\{(\w+)\}/g, (whole, name) =>
        (values && Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole))
    }

    /**
     * Issue one console request.
     *
     * @param {string} path API path below `/api/dsh2server`.
     * @param {object} [init] fetch init.
     * @returns {Promise<object>} the parsed JSON body.
     */
    async function request(path, init) {
      const response = await fetch(API + path, {
        method: (init && init.method) || 'GET',
        headers: init && init.body ? { 'content-type': 'application/json' } : undefined,
        body: init && init.body ? JSON.stringify(init.body) : undefined,
        credentials: 'same-origin',
      })
      const text = await response.text()
      let body
      try {
        body = text ? JSON.parse(text) : {}
      } catch {
        body = { ok: false, error: { message: `HTTP ${response.status}` } }
      }
      if (!response.ok) {
        const detail = body && body.error ? body.error : {}
        const issues = Array.isArray(detail.issues)
          ? ` (${detail.issues.map((issue) => `${(issue.path || []).join('.')}: ${issue.message}`).join('; ')})`
          : ''
        const error = new Error(`${detail.message || `HTTP ${response.status}`}${issues}`)
        error.status = response.status
        error.body = body
        throw error
      }
      return body
    }

    /**
     * Copy text to the clipboard, falling back to a temporary selection when the
     * async Clipboard API is unavailable (it needs a secure context — loopback
     * counts, but a proxied LAN origin may not).
     *
     * @param {string} text text to copy.
     * @returns {Promise<boolean>} whether the copy succeeded.
     */
    async function copyText(text) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        // Fall through to the legacy path.
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        area.remove()
        return ok
      } catch {
        return false
      }
    }

    /**
     * @param {unknown[]} values endpoint field values.
     * @returns {string[]} the endpoint list.
     */
    function parseEndpoints(values) {
      return (Array.isArray(values) ? values : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    }

    /**
     * @param {object} item one link description from the console.
     * @returns {string} a one-line status.
     */
    function linkStatus(item, locale) {
      if (item.rejected) return tx(locale, 'rejected', { error: item.rejected.message })
      if (item.state === 'connected') return tx(locale, 'connectedVia', { transport: item.transport })
      if (item.lastError) return tx(locale, 'disconnectedError', { error: item.lastError.message })
      return item.state
    }

    /**
     * The dsh2server card: configure the relay endpoint and copy the machine key.
     *
     * @param {object} props slot props (unused; the card owns its own chrome).
     * @returns {object} the rendered element tree.
     */
    function Dsh2ServerPanel() {
      const [state, setState] = React.useState(null)
      const [endpointDraft, setEndpointDraft] = React.useState([])
      const [transportDraft, setTransportDraft] = React.useState('auto')
      const [dirty, setDirty] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [revealKey, setRevealKey] = React.useState(false)
      const locale = state && state.config ? state.config.locale : 'system'
      const t = (key, values) => tx(locale, key, values)

      const adopt = React.useCallback((payload, force) => {
        setState(payload)
        if (force) {
          setEndpointDraft([...(payload.config.endpoints || [])])
          setTransportDraft(payload.config.transport)
          setDirty(false)
        }
      }, [])

      const refresh = React.useCallback(
        async (force) => {
          try {
            adopt(await request('/state'), force)
            setError('')
          } catch (cause) {
            setError(String(cause.message || cause))
          }
        },
        [adopt],
      )

      React.useEffect(() => {
        void refresh(true)
      }, [refresh])

      /**
       * @param {() => Promise<object>} action console call.
       * @param {string} done message shown on success.
       */
      const perform = React.useCallback(
        async (action, done) => {
          setBusy(true)
          setError('')
          setNotice('')
          try {
            adopt(await action(), true)
            setNotice(done)
          } catch (cause) {
            setError(String(cause.message || cause))
          } finally {
            setBusy(false)
          }
        },
        [adopt],
      )

      /** Re-read the state without overwriting an in-progress edit. */
      const softRefresh = React.useCallback(() => {
        if (!dirty) void refresh(false)
      }, [dirty, refresh])

      React.useEffect(() => {
        const timer = setInterval(softRefresh, 3000)
        return () => clearInterval(timer)
      }, [softRefresh])

      if (!state) {
        return h(
          'div',
          { className: 'dsh2server-panel' },
          h('p', { className: 'dsh2server-hint' }, error ? t('loadingFailed', { error }) : t('loading')),
        )
      }

      const config = state.config || {}
      const endpoints = config.endpoints || []
      const links = state.links || []
      const connected = state.connected === true
      const badge = connected
        ? { text: t('linksConnected', { connected: links.filter((item) => item.state === 'connected').length, total: links.length }), on: true }
        : endpoints.length === 0
          ? { text: t('serverUnconfigured'), off: true }
          : { text: t('disconnected'), off: true }

      const overridden = new Set(state.overriddenKeys || [])
      const pairingCommand =
        endpoints.length > 0
          ? `curl -X POST ${endpoints[0]}/keys -H "content-type: application/json" -d '{"key":"${state.key}","label":"${state.instanceId}"}'`
          : ''

      /**
       * @param {string} key editable key.
       * @param {string} label field label.
       * @param {object} control the input element.
       * @param {string} hint optional hint.
       * @returns {object} a labelled field.
       */
      const field = (key, label, control, hint) =>
        h(
          'div',
          { className: 'dsh2server-field' },
          h(
            'div',
            { className: 'dsh2server-field-head' },
            h('label', { className: 'dsh2server-label' }, label),
            overridden.has(key) ? h('span', { className: 'dsh2server-override' }, t('webOverride')) : null,
          ),
          control,
          hint ? h('p', { className: 'dsh2server-hint' }, hint) : null,
        )

      return h(
        'div',
        { className: 'dsh2server-panel' },
        h(
          'div',
          { className: 'dsh2server-hero' },
          h(
            'div',
            { className: 'dsh2server-head' },
            h(
              'div',
              { className: 'dsh2server-heading' },
              h('p', { className: 'dsh2server-eyebrow' }, t('relay')),
              h('h3', { className: 'dsh2server-title' }, 'dsh2server'),
            ),
            h(
              'div',
              { className: 'dsh2server-badges' },
              h(
                'span',
                {
                  className: 'dsh2server-badge',
                  'data-on': badge.on ? 'true' : undefined,
                  'data-off': badge.off ? 'true' : undefined,
                },
                badge.text,
              ),
            ),
          ),
        ),
        error || notice
          ? h(
              'div',
              { className: 'dsh2server-feedback', role: 'status', 'aria-live': 'polite' },
              error ? h('p', { className: 'dsh2server-note', 'data-tone': 'error' }, error) : null,
              notice ? h('p', { className: 'dsh2server-note', 'data-tone': 'ok' }, notice) : null,
            )
          : null,

        // ── 服务器端点 ───────────────────────────────────────────────────────
        h(
          'section',
          { className: 'dsh2server-section' },
          h(
            'div',
            { className: 'dsh2server-section-head' },
            h('h4', { className: 'dsh2server-section-title' }, t('serverConnection')),
          ),
          field(
            'locale',
            t('pluginLanguage'),
            h(
              'select',
              {
                className: 'dsh2server-select',
                value: locale,
                disabled: busy,
                onChange: (event) => {
                  const next = event.target.value
                  void perform(
                    () => request('/config', { method: 'POST', body: { values: { locale: next } } }),
                    tx(next, 'languageUpdated'),
                  )
                },
              },
              h('option', { value: 'system' }, t('languageSystem')),
              h('option', { value: 'zh-CN' }, t('languageZh')),
              h('option', { value: 'en-US' }, t('languageEn')),
            ),
            t('languageHint'),
          ),
          field(
            'endpoint',
            t('endpoints'),
            h(
              'div',
              { className: 'dsh2server-endpoints' },
              endpointDraft.length > 0
                ? endpointDraft.map((value, index) =>
                    h(
                      'div',
                      { className: 'dsh2server-endpoint-row', key: index },
                      h('span', { className: 'dsh2server-endpoint-index', 'aria-hidden': 'true' }, String(index + 1)),
                      h('input', {
                        className: 'dsh2server-endpoint-input',
                        type: 'url',
                        value,
                        spellCheck: false,
                        placeholder: 'https://example.com/dsh-api',
                        'aria-label': t('endpointAria', { index: index + 1 }),
                        onChange: (event) => {
                          const nextValue = event.target.value
                          setEndpointDraft((current) =>
                            current.map((endpoint, endpointIndex) => (endpointIndex === index ? nextValue : endpoint)),
                          )
                          setDirty(true)
                          setNotice('')
                        },
                      }),
                      h(
                        'button',
                        {
                          className: 'dsh2server-endpoint-remove',
                          type: 'button',
                          disabled: busy,
                          title: t('removeEndpoint', { index: index + 1 }),
                          'aria-label': t('removeEndpoint', { index: index + 1 }),
                          onClick: () => {
                            setEndpointDraft((current) => current.filter((_, endpointIndex) => endpointIndex !== index))
                            setDirty(true)
                            setNotice('')
                          },
                        },
                        t('remove'),
                      ),
                    ),
                  )
                : h('div', { className: 'dsh2server-endpoint-empty' }, t('noEndpoints')),
              h(
                'button',
                {
                  className: 'dsh2server-endpoint-add',
                  type: 'button',
                  disabled: busy,
                  onClick: () => {
                    setEndpointDraft((current) => [...current, ''])
                    setDirty(true)
                    setNotice('')
                  },
                },
                t('addEndpoint'),
              ),
            ),
          ),
          field(
            'transport',
            t('transport'),
            h(
              'select',
              {
                className: 'dsh2server-select',
                value: transportDraft,
                onChange: (event) => {
                  setTransportDraft(event.target.value)
                  setDirty(true)
                  setNotice('')
                },
              },
              h('option', { value: 'auto' }, t('auto')),
              h('option', { value: 'ws' }, 'WebSocket'),
              h('option', { value: 'http' }, t('longPolling')),
            ),
          ),
          h(
            'div',
            { className: 'dsh2server-actions' },
            h(
              'button',
              {
                className: 'dsh2server-button',
                'data-kind': 'primary',
                disabled: busy || !dirty,
                onClick: () =>
                  perform(
                    () =>
                      request('/config', {
                        method: 'POST',
                        body: { values: { endpoint: parseEndpoints(endpointDraft), transport: transportDraft } },
                      }),
                    t('savedApplied'),
                  ),
              },
              busy ? t('saving') : t('saveApply'),
            ),
            h(
              'button',
              {
                className: 'dsh2server-button',
                disabled: busy || overridden.size === 0,
                onClick: () =>
                  perform(
                    () => request('/config', { method: 'POST', body: { reset: ['endpoint', 'transport', 'locale'] } }),
                    t('resetDone'),
                  ),
              },
              t('reset'),
            ),
            h(
              'button',
              {
                className: 'dsh2server-button',
                disabled: busy || endpoints.length === 0,
                onClick: () => perform(() => request('/reconnect', { method: 'POST', body: {} }), t('reconnectDone')),
              },
              t('reconnect'),
            ),
          ),
        ),

        // ── 本机 Key ────────────────────────────────────────────────────────
        h(
          'div',
          { className: 'dsh2server-card-grid' },
          h(
            'section',
            { className: 'dsh2server-section' },
            h(
              'div',
              { className: 'dsh2server-section-head' },
              h('h4', { className: 'dsh2server-section-title' }, t('credentials')),
            ),
          h(
            'div',
            { className: 'dsh2server-code' },
            revealKey ? state.key : t('hiddenKey', { fingerprint: state.keyFingerprint }),
          ),
          h(
            'div',
            { className: 'dsh2server-row' },
            h(
              'button',
              {
                className: 'dsh2server-button',
                'data-kind': 'primary',
                onClick: async () => {
                  const ok = await copyText(state.key)
                  if (ok) setNotice(t('keyCopied'))
                  else setError(t('clipboardShow'))
                },
              },
              t('copyKey'),
            ),
            h(
              'button',
              { className: 'dsh2server-button', onClick: () => setRevealKey(!revealKey) },
              revealKey ? t('hide') : t('show'),
            ),
            pairingCommand
              ? h(
                  'button',
                  {
                    className: 'dsh2server-button',
                    onClick: async () => {
                      const ok = await copyText(pairingCommand)
                      if (ok) setNotice(t('registrationCopied'))
                      else setError(t('clipboardDenied'))
                    },
                  },
                  t('copyRegistration'),
                )
              : null,
            h(
              'button',
              {
                className: 'dsh2server-button',
                'data-kind': 'danger',
                disabled: busy,
                onClick: () => {
                  if (!window.confirm(t('rotateConfirm'))) return
                  void perform(
                    () => request('/key/rotate', { method: 'POST', body: { confirm: state.instanceId } }),
                    t('rotateDone'),
                  )
                },
              },
              t('rotateKey'),
            ),
          ),
          h(
            'div',
            { className: 'dsh2server-meta' },
            h(
              'div',
              { className: 'dsh2server-kv' },
              h('span', null, 'instance id'),
              h('span', null, state.instanceId),
              h('span', null, t('keyLocation')),
              h('span', null, state.keyFile || t('defaultLocation')),
            ),
          ),
          state.keyPersisted === false
            ? h(
                'p',
                { className: 'dsh2server-note', 'data-tone': 'error' },
                t('keyWarning', { error: state.keyWarning || t('unknown') }),
              )
            : null,
        ),

        // ── 连接详情 ────────────────────────────────────────────────────────
          h(
            'section',
            { className: 'dsh2server-section' },
            h(
              'div',
              { className: 'dsh2server-section-head' },
              h('h4', { className: 'dsh2server-section-title' }, t('links')),
            ),
          links.length === 0
            ? h('p', { className: 'dsh2server-hint' }, t('idleNoEndpoint'))
            : h(
                'div',
                { className: 'dsh2server-links' },
                links.map((item, index) =>
                  h(
                    'div',
                    { className: 'dsh2server-link', key: `${item.endpoint}-${index}` },
                    h(
                      'span',
                      {
                        className: 'dsh2server-badge',
                        'data-on': item.state === 'connected' ? 'true' : undefined,
                        'data-off': item.state === 'connected' ? undefined : 'true',
                      },
                      item.state,
                    ),
                    h('code', null, item.endpoint),
                    h('span', { className: 'dsh2server-hint' }, linkStatus(item, locale)),
                  ),
                ),
              ),
          h(
            'div',
            { className: 'dsh2server-meta' },
            h(
              'div',
              { className: 'dsh2server-kv' },
              h('span', null, t('methods')),
              h('span', null, t('count', { count: (state.methods || []).length })),
              h('span', null, t('uptime')),
              h('span', null, t('seconds', { count: Math.round(state.uptimeMs / 1000) })),
            ),
          ),
        ),
        ),

        // ── 安全开关 ────────────────────────────────────────────────────────
        h(
          'section',
          { className: 'dsh2server-section' },
          h(
            'div',
            { className: 'dsh2server-section-head' },
            h('h4', { className: 'dsh2server-section-title' }, t('permissions')),
            h('p', { className: 'dsh2server-hint' }, t('permissionsHint')),
          ),
          h(
          'div',
          { className: 'dsh2server-toggle-list' },
          ...[
            ['allowRemotePrompt', t('allowPrompt')],
            ['allowRemoteControl', t('allowControl')],
            ['allowRemoteTerminal', t('allowTerminal')],
            ['forwardApprovals', t('forwardApprovals')],
          ].map(([key, label]) =>
            h(
              'label',
              { className: 'dsh2server-toggle', key },
              h('span', null, label),
              h('input', {
                type: 'checkbox',
                checked: config[key] === true,
                disabled: busy,
                onChange: (event) =>
                  void perform(
                    () => request('/config', { method: 'POST', body: { values: { [key]: event.target.checked } } }),
                    t('updated'),
                  ),
              }),
            ),
          ),
          ),
        ),
      )
    }

    /** Required client services. */
    const inject = ['slots']

    /**
     * Register the dsh2server tab in the Plugins settings section.
     *
     * The section owns the page and its tab list; this plugin only contributes a
     * row into the public `settings.plugins.tab` list slot, which is the same
     * extension point the built-in tabs use. The tab appears for every
     * deployment that mounts this bundle — no dsh change, no per-machine setup.
     *
     * @param {object} ctx client plugin context.
     */
    function apply(ctx) {
      ctx.slots.inject('settings.plugins.tab', () =>
        ctx.slots.register(
          {
            name: 'settings.plugins.tab',
            id: 'dsh2server',
            order: 40,
            label: () => 'dsh2server',
          },
          Dsh2ServerPanel,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.Dsh2ServerPanel = Dsh2ServerPanel
    return module.exports
  },
})
