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
      .dsh2server-panel { display: grid; gap: 18px; max-width: 720px; padding: 4px 0 8px; }
      .dsh2server-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .dsh2server-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); margin: 0; }
      .dsh2server-badge { font-size: 11px; padding: 1px 8px; border-radius: 99px; border: .5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-tertiary); }
      .dsh2server-badge[data-on="true"] { color: var(--dsw-alias-label-success, #3fb950); border-color: currentColor; }
      .dsh2server-badge[data-off="true"] { color: var(--dsw-alias-label-error, #f85149); border-color: currentColor; }
      .dsh2server-field { display: grid; gap: 5px; }
      .dsh2server-label { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
      .dsh2server-hint { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); margin: 0; }
      .dsh2server-input, .dsh2server-select, .dsh2server-code {
        font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-layer-4, transparent);
        border: .5px solid var(--dsw-alias-border-l4); border-radius: 8px; padding: 7px 9px; width: 100%;
      }
      .dsh2server-input { font-family: ui-monospace, Consolas, monospace; min-height: 64px; resize: vertical; white-space: pre; }
      .dsh2server-code { font-family: ui-monospace, Consolas, monospace; overflow-wrap: anywhere; }
      .dsh2server-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .dsh2server-button {
        font: inherit; font-size: 13px; padding: 5px 12px; border-radius: 8px; cursor: pointer;
        color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-4, transparent);
        border: .5px solid var(--dsw-alias-border-l4);
      }
      .dsh2server-button:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary, #4c9aff); }
      .dsh2server-button:disabled { opacity: .5; cursor: not-allowed; }
      .dsh2server-button[data-kind="primary"] { background: var(--dsw-alias-brand-primary, #1d4ed8); border-color: transparent; color: #fff; }
      .dsh2server-button[data-kind="danger"] { color: var(--dsw-alias-label-error, #f85149); }
      .dsh2server-section { display: grid; gap: 9px; border-top: .5px solid var(--dsw-alias-border-l3); padding-top: 14px; }
      .dsh2server-note { font-size: 12px; line-height: 1.5; margin: 0; }
      .dsh2server-note[data-tone="error"] { color: var(--dsw-alias-label-error, #f85149); }
      .dsh2server-note[data-tone="ok"] { color: var(--dsw-alias-label-success, #3fb950); }
      .dsh2server-note[data-tone="info"] { color: var(--dsw-alias-label-tertiary); }
      .dsh2server-kv { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 3px 12px; font-size: 12px; }
      .dsh2server-kv > span:nth-child(odd) { color: var(--dsw-alias-label-tertiary); }
      .dsh2server-kv > span:nth-child(even) { color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
      .dsh2server-links { display: grid; gap: 6px; font-size: 12px; }
      .dsh2server-link { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
      .dsh2server-link code { color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
      .dsh2server-toggle { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
      .dsh2server-toggle input { margin-top: 2px; }
    `

    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh2server'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    const h = React.createElement

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
     * @param {string} text endpoint textarea contents.
     * @returns {string[]} the endpoint list.
     */
    function parseEndpoints(text) {
      return String(text || '')
        .split(/[\n,]/)
        .map((line) => line.trim())
        .filter(Boolean)
    }

    /**
     * @param {object} item one link description from the console.
     * @returns {string} a one-line status.
     */
    function linkStatus(item) {
      if (item.rejected) return `被拒绝：${item.rejected.message}`
      if (item.state === 'connected') return `已连接（${item.transport}）`
      if (item.lastError) return `未连接：${item.lastError.message}`
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
      const [endpointDraft, setEndpointDraft] = React.useState('')
      const [transportDraft, setTransportDraft] = React.useState('auto')
      const [dirty, setDirty] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [revealKey, setRevealKey] = React.useState(false)

      const adopt = React.useCallback((payload, force) => {
        setState(payload)
        if (force) {
          setEndpointDraft((payload.config.endpoints || []).join('\n'))
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
          h('p', { className: 'dsh2server-hint' }, error ? `无法读取插件状态：${error}` : '正在读取插件状态…'),
        )
      }

      const config = state.config || {}
      const endpoints = config.endpoints || []
      const links = state.links || []
      const connected = state.connected === true
      const badge = connected
        ? { text: `${links.filter((item) => item.state === 'connected').length}/${links.length} 条链路已连接`, on: true }
        : endpoints.length === 0
          ? { text: '未配置服务器', off: true }
          : { text: '未连接', off: true }

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
          h('label', { className: 'dsh2server-label' }, label, overridden.has(key) ? ' ·由网页设置' : ''),
          control,
          hint ? h('p', { className: 'dsh2server-hint' }, hint) : null,
        )

      return h(
        'div',
        { className: 'dsh2server-panel' },
        h(
          'div',
          { className: 'dsh2server-head' },
          h('h3', { className: 'dsh2server-title' }, 'dsh2server'),
          h(
            'span',
            {
              className: 'dsh2server-badge',
              'data-on': badge.on ? 'true' : undefined,
              'data-off': badge.off ? 'true' : undefined,
            },
            badge.text,
          ),
          h('span', { className: 'dsh2server-badge' }, `v${state.plugin.version} · 协议 v${state.plugin.protocol}`),
        ),
        h(
          'p',
          { className: 'dsh2server-hint' },
          '把本机 dsh 连接到中转服务器。保存后立即生效，无需重启 dsh。',
        ),

        // ── 服务器端点 ───────────────────────────────────────────────────────
        h(
          'div',
          { className: 'dsh2server-section' },
          field(
            'endpoint',
            '服务器 API 端点',
            h('textarea', {
              className: 'dsh2server-input',
              value: endpointDraft,
              spellCheck: false,
              placeholder: 'https://example.com/dsh-api\nhttp://10.0.0.5:8787/dsh-api',
              onChange: (event) => {
                setEndpointDraft(event.target.value)
                setDirty(true)
                setNotice('')
              },
            }),
            '每行一个（也可用逗号分隔）。http 与 https 可以混用，插件会同时连接全部端点；留空则完全空闲。',
          ),
          field(
            'transport',
            '传输方式',
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
              h('option', { value: 'auto' }, 'auto —— 先 WebSocket，失败自动回退 HTTP 长轮询'),
              h('option', { value: 'ws' }, 'ws —— 只用 WebSocket'),
              h('option', { value: 'http' }, 'http —— 只用 HTTP 长轮询（PHP 后端请选这个）'),
            ),
          ),
          h(
            'div',
            { className: 'dsh2server-row' },
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
                    '已保存并应用',
                  ),
              },
              busy ? '保存中…' : '保存并应用',
            ),
            h(
              'button',
              {
                className: 'dsh2server-button',
                disabled: busy || overridden.size === 0,
                onClick: () =>
                  perform(
                    () => request('/config', { method: 'POST', body: { reset: ['endpoint', 'transport'] } }),
                    '已恢复为配置文件里的值',
                  ),
              },
              '恢复配置文件的值',
            ),
            h(
              'button',
              {
                className: 'dsh2server-button',
                disabled: busy || endpoints.length === 0,
                onClick: () => perform(() => request('/reconnect', { method: 'POST', body: {} }), '已请求重连'),
              },
              '立即重连',
            ),
          ),
          error ? h('p', { className: 'dsh2server-note', 'data-tone': 'error' }, error) : null,
          notice ? h('p', { className: 'dsh2server-note', 'data-tone': 'ok' }, notice) : null,
          h(
            'p',
            { className: 'dsh2server-hint' },
            `网页设置写入 ${state.configFile}；未在网页上改过的项仍来自 dsh 配置文件。`,
          ),
        ),

        // ── 本机 Key ────────────────────────────────────────────────────────
        h(
          'div',
          { className: 'dsh2server-section' },
          h('label', { className: 'dsh2server-label' }, '本机实例 Key'),
          h(
            'div',
            { className: 'dsh2server-code' },
            revealKey ? state.key : `${state.keyFingerprint}（点击“显示”查看完整 key）`,
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
                  if (ok) setNotice('已复制完整 key 到剪贴板')
                  else setError('浏览器拒绝了剪贴板访问，请点“显示”后手动复制')
                },
              },
              '复制 Key',
            ),
            h(
              'button',
              { className: 'dsh2server-button', onClick: () => setRevealKey(!revealKey) },
              revealKey ? '隐藏' : '显示',
            ),
            pairingCommand
              ? h(
                  'button',
                  {
                    className: 'dsh2server-button',
                    onClick: async () => {
                      const ok = await copyText(pairingCommand)
                      if (ok) setNotice('已复制登记命令（curl），可直接在服务器上执行')
                      else setError('浏览器拒绝了剪贴板访问')
                    },
                  },
                  '复制登记命令',
                )
              : null,
            h(
              'button',
              {
                className: 'dsh2server-button',
                'data-kind': 'danger',
                disabled: busy,
                onClick: () => {
                  if (!window.confirm('轮换后会立刻断开连接，直到你在服务器上登记新的 key。确定继续吗？')) return
                  void perform(
                    () => request('/key/rotate', { method: 'POST', body: { confirm: state.instanceId } }),
                    '已生成新 key —— 请立刻复制并登记到服务器',
                  )
                },
              },
              '轮换 Key',
            ),
          ),
          h(
            'p',
            { className: 'dsh2server-hint' },
            `把上面的 key 填进服务器的 key 白名单即可。一台机器一个 key，服务器据此区分并单独吊销每台机器。`,
          ),
          h(
            'div',
            { className: 'dsh2server-kv' },
            h('span', null, 'instance id'),
            h('span', null, state.instanceId),
            h('span', null, 'key 存放位置'),
            h('span', null, state.keyFile || '（默认位置）'),
          ),
          state.keyPersisted === false
            ? h(
                'p',
                { className: 'dsh2server-note', 'data-tone': 'error' },
                `key 无法写入磁盘：${state.keyWarning || '未知原因'} —— 重启后会变化，请在 dsh 配置里固定 key。`,
              )
            : null,
        ),

        // ── 连接详情 ────────────────────────────────────────────────────────
        h(
          'div',
          { className: 'dsh2server-section' },
          h('label', { className: 'dsh2server-label' }, '连接状态'),
          links.length === 0
            ? h('p', { className: 'dsh2server-hint' }, '没有配置端点，插件处于空闲状态（不会产生任何网络请求）。')
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
                    h('span', { className: 'dsh2server-hint' }, linkStatus(item)),
                  ),
                ),
              ),
          h(
            'div',
            { className: 'dsh2server-kv' },
            h('span', null, '可用远程方法'),
            h('span', null, `${(state.methods || []).length} 个`),
            h('span', null, '运行时长'),
            h('span', null, `${Math.round(state.uptimeMs / 1000)} 秒`),
          ),
        ),

        // ── 安全开关 ────────────────────────────────────────────────────────
        h(
          'div',
          { className: 'dsh2server-section' },
          h('label', { className: 'dsh2server-label' }, '远程权限'),
          ...[
            ['allowRemotePrompt', '允许服务器下发新命令（session.prompt）'],
            ['allowRemoteControl', '允许服务器中断 / 暂停 / 恢复 / 轮换 key'],
            ['forwardApprovals', '把工具调用审批转发到服务器等待远程批准（谨慎开启）'],
          ].map(([key, label]) =>
            h(
              'label',
              { className: 'dsh2server-toggle', key },
              h('input', {
                type: 'checkbox',
                checked: config[key] === true,
                disabled: busy,
                onChange: (event) =>
                  void perform(
                    () => request('/config', { method: 'POST', body: { values: { [key]: event.target.checked } } }),
                    '已更新',
                  ),
              }),
              h('span', null, label),
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
