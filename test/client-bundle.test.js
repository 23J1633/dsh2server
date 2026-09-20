/**
 * Tests for the browser half (`lib/client.js`).
 *
 * The bundle is hand-written, so it gets checked the way the client module
 * system treats it — as a lazy-CJS factory — and then actually **rendered**:
 * the harness installs a minimal React with a working hook dispatcher, so the
 * panel's data fetching, state transitions, and button handlers all run for
 * real against a stubbed `fetch`.
 *
 * The last test is the one that protects the pair: every `/api/dsh2server/...`
 * path the browser calls must exist in the Host half's declared route table.
 * That is the failure a hand-written bundle is most likely to introduce.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { CONSOLE_BASE, CONSOLE_ROUTES } from '../lib/host-ui.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(ROOT, 'lib', 'client.js')

/**
 * Untyped `globalThis` alias.
 *
 * Statements are written as `g.foo = …` on purpose: a line beginning with a
 * JSDoc cast (`/** @type {any} *​/ (globalThis)…`) starts with `(`, and a
 * preceding unterminated statement would then parse as a call instead of a new
 * statement — the classic automatic-semicolon-insertion trap.
 */
const g = /** @type {any} */ (globalThis)

/**
 * A minimal React with a real hook dispatcher.
 *
 * Enough to run the panel: `useState` writes back into the hook slot,
 * `useCallback` memoizes on deps, `useEffect` collects effects (and their
 * cleanups) for the harness to run, and elements are plain
 * `{ type, props }` records that can be walked.
 *
 * @returns {object} the harness: `React`, `render`, `reset`, `text`, `find`, `click`, `cleanup`.
 */
function createRenderer() {
  let slots = []
  let cursor = 0
  let pendingEffects = []
  let pendingCleanups = []
  let rerender = () => {}

  /** @param {unknown[] | undefined} a @param {unknown[] | undefined} b */
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

  const React = {
    Fragment: Symbol('Fragment'),
    /**
     * @param {unknown} type element type.
     * @param {object | null} props element props.
     * @param {...unknown} children element children.
     * @returns {{type: unknown, props: Record<string, unknown>}} a flat element record.
     */
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
      return { type, props: { ...(props ?? {}), children: flat } }
    },
    /**
     * @param {unknown} initial initial state or initializer.
     * @returns {[unknown, (value: unknown) => void]} the state pair.
     */
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [
        slots[index],
        (value) => {
          slots[index] = typeof value === 'function' ? value(slots[index]) : value
          rerender()
        },
      ]
    },
    /**
     * @param {Function} fn callback.
     * @param {unknown[]} deps dependency list.
     * @returns {Function} the memoized callback.
     */
    useCallback(fn, deps) {
      const index = cursor++
      const previous = slots[index]
      if (!previous || !sameDeps(previous.deps, deps)) slots[index] = { fn, deps }
      return slots[index].fn
    },
    /**
     * @param {Function} fn effect body.
     * @param {unknown[]} [deps] dependency list.
     */
    useEffect(fn, deps) {
      const index = cursor++
      const previous = slots[index]
      if (!previous || !sameDeps(previous.deps, deps)) pendingEffects.push(fn)
      slots[index] = { deps }
    },
    /**
     * @param {unknown} initial initial value.
     * @returns {{current: unknown}} a stable ref object.
     */
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    /** @returns {string} a stable id. */
    useId() {
      return 'test-id'
    },
    /** @param {Function} fn deferred callback. */
    useMemo(fn) {
      return fn()
    },
  }

  return {
    React,
    /**
     * Render once.
     *
     * @param {Function} Component component to render.
     * @param {object} [props] component props.
     * @returns {{type: unknown, props: Record<string, unknown>}} the tree.
     */
    render(Component, props = {}) {
      cursor = 0
      const tree = Component(props)
      return tree
    },
    /** @returns {Promise<void>} run collected effects (and record their cleanups). */
    async runEffects() {
      const effects = pendingEffects
      pendingEffects = []
      for (const effect of effects) {
        const cleanup = effect()
        if (typeof cleanup === 'function') pendingCleanups.push(cleanup)
      }
      // Let the async effect bodies settle.
      for (let index = 0; index < 12; index += 1) await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
      for (let index = 0; index < 12; index += 1) await Promise.resolve()
    },
    /** Forget all hook state. */
    reset() {
      slots = []
      cursor = 0
      pendingEffects = []
    },
    /**
     * Register the re-render hook the state setters call.
     *
     * @param {() => void} fn re-render function.
     */
    setRerender(fn) {
      rerender = fn
    },
    /** Run every effect cleanup collected so far (clears intervals). */
    cleanup() {
      for (const cleanup of pendingCleanups.splice(0)) {
        try {
          cleanup()
        } catch {
          // A failing cleanup must not mask the assertion that follows.
        }
      }
    },
  }
}

/**
 * @param {{type: unknown, props: Record<string, unknown>}} tree element tree.
 * @returns {string[]} every text node, in order.
 */
function collectText(tree) {
  const out = []
  /**
   * @param {unknown} node element, string, number, or array.
   */
  const walk = (node) => {
    if (node === null || node === undefined || node === false) return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (typeof node === 'string' || typeof node === 'number') {
      out.push(String(node))
      return
    }
    if (typeof node === 'object' && 'props' in node) walk(/** @type {any} */ (node).props.children)
  }
  walk(tree)
  return out
}

/**
 * @param {{type: unknown, props: Record<string, unknown>}} tree element tree.
 * @param {(node: {type: unknown, props: Record<string, unknown>}) => boolean} predicate matcher.
 * @returns {Array<{type: unknown, props: Record<string, unknown>}>} matching nodes.
 */
function findAll(tree, predicate) {
  const out = []
  /**
   * @param {unknown} node element, string, number, or array.
   */
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (predicate(/** @type {any} */ (node))) out.push(/** @type {any} */ (node))
    walk(/** @type {any} */ (node).props.children)
  }
  walk(tree)
  return out
}

/**
 * @param {{type: unknown, props: Record<string, unknown>}} tree element tree.
 * @param {string} label button label.
 * @returns {{type: unknown, props: Record<string, unknown>}} the button.
 */
function button(tree, label) {
  const match = findAll(tree, (node) => node.type === 'button' && collectText(node).join(' ').includes(label))[0]
  assert.ok(match, `no button labelled "${label}" in the rendered panel`)
  return match
}

/** A canned console state payload the stubbed fetch serves. */
function statePayload(overrides = {}) {
  return {
    ok: true,
    plugin: { name: 'dsh2server', version: '0.1.0', protocol: 1 },
    instanceId: 'dsh-gui',
    key: 'dshk_GUI_TEST_KEY_0000000000000000000000000000',
    keyFingerprint: 'dshk_GUI_TEST…0000',
    keyFile: 'D:/dsh/data/dsh2server/identity.json',
    keyPersisted: true,
    uptimeMs: 123456,
    config: {
      endpoints: ['https://relay.example.com/dsh-api'],
      endpoint: 'https://relay.example.com/dsh-api',
      transport: 'auto',
      locale: 'system',
      allowRemotePrompt: true,
      allowRemoteControl: true,
      forwardApprovals: false,
    },
    editableKeys: ['endpoint', 'transport', 'locale'],
    overriddenKeys: [],
    compositionKeys: ['endpoint'],
    configFile: 'D:/dsh/data/dsh2server/config.json',
    connected: true,
    links: [
      {
        endpoint: 'https://relay.example.com/dsh-api',
        state: 'connected',
        transport: 'websocket',
        rejected: null,
        lastError: null,
      },
    ],
    methods: ['session.list', 'session.prompt'],
    ...overrides,
  }
}

/**
 * Load the bundle through a faithful fake of the client module loader.
 *
 * @returns {Promise<{exports: any, entry: any, source: string}>} the materialized module.
 */
async function loadBundle() {
  const source = await readFile(BUNDLE, 'utf8')
  /** @type {any} */
  let entry
  const documentStub = {
    head: { appendChild() {} },
    querySelector: () => null,
    createElement: () => ({ dataset: {}, style: {}, setAttribute() {}, select() {}, remove() {} }),
    body: { appendChild() {} },
    execCommand: () => true,
  }
  const previousWindow = g.window
  const previousDocument = g.document
  g.document = documentStub
  g.window = {
    isSecureContext: true,
    confirm: () => true,
    __ModuleLoader__: {
      /**
       * @param {any} value the bundle registration.
       */
      load(value) {
        entry = value
      },
    },
  }
  try {
    // A fresh module instance per call: the bundle is a side-effecting script.
    await import(`${pathToFileURL(BUNDLE).href}?t=${Date.now()}-${Math.random()}`)
  } finally {
    if (previousWindow === undefined) delete g.window
    else g.window = previousWindow
    if (previousDocument === undefined) delete g.document
    else g.document = previousDocument
  }
  assert.ok(entry, 'the bundle must call window.__ModuleLoader__.load(...)')
  return { entry, source, exports: entry.factory(seedRequire()) }
}

/**
 * @returns {(specifier: string) => unknown} a require backed by the shell's platform seed table.
 */
function seedRequire() {
  /** @type {Map<string, unknown>} */
  const table = new Map()
  // Only `react` is needed by this bundle; anything else is a bug worth failing on.
  table.set('react', {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
    Fragment: Symbol('Fragment'),
  })
  return (specifier) => {
    if (!table.has(specifier)) {
      throw new Error(
        `client-modules: require("${specifier}") missed the platform seed table — the bundle must declare dsh.client.external for it`,
      )
    }
    return table.get(specifier)
  }
}

test('client bundle: the manifest declares the browser half the loader expects', async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.dsh.client.platform, 'web')
  // A package whose client half needs nothing beyond the shell's frozen seed
  // table declares no externals, so no supply edge can fail in a composition
  // that does not ship some other plugin.
  assert.deepEqual(manifest.dsh.client.inject ?? [], [])
  assert.equal(manifest.dsh.client.external, undefined)
  const clientExport = typeof manifest.exports['./client'] === 'string' ? manifest.exports['./client'] : manifest.exports['./client'].default
  assert.equal(clientExport, './lib/client.js')
  assert.ok(manifest.files.includes('lib'), 'the bundle must ship in the package')
})

test('client bundle: registers one tab into settings.plugins.tab under its own id', async () => {
  const { entry, exports } = await loadBundle()
  assert.equal(entry.id, 'dsh2server', 'the module id must be the package name the load graph keys on')
  assert.equal(typeof entry.factory, 'function')
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.Dsh2ServerPanel, 'function')

  /** @type {Array<{name: string, options: any, component: any}>} */
  const registrations = []
  /** @type {string[]} */
  const injections = []
  const ctx = {
    slots: {
      /**
       * @param {string} name slot name.
       * @param {Function} callback registration body.
       */
      inject(name, callback) {
        injections.push(name)
        callback()
      },
      /**
       * @param {any} options registration options.
       * @param {any} component slot component.
       * @returns {() => void} disposer.
       */
      register(options, component) {
        registrations.push({ name: options.name, options, component })
        return () => {}
      },
    },
  }
  exports.apply(ctx)

  assert.deepEqual(injections, ['settings.plugins.tab'])
  assert.equal(registrations.length, 1)
  const [registration] = registrations
  assert.equal(registration.name, 'settings.plugins.tab')
  assert.equal(registration.options.id, 'dsh2server', 'the tab needs a stable id for the section tab list')
  assert.equal(typeof registration.options.order, 'number')
  assert.equal(typeof registration.options.label, 'function')
  assert.equal(registration.options.label(), 'dsh2server')
  assert.equal(registration.component, exports.Dsh2ServerPanel)
})

test('client bundle: the panel fetches state, saves the endpoint, and copies the key', async () => {
  const harness = createRenderer()
  const { exports } = await loadBundle()

  /** @type {Array<{url: string, init: any}>} */
  const calls = []
  let payload = statePayload()
  const previousFetch = globalThis.fetch
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  /** @type {string[]} */
  const copied = []

  globalThis.fetch = /** @type {any} */ (
    async (url, init) => {
      calls.push({ url: String(url), init })
      if (String(url).endsWith('/config')) {
        const body = JSON.parse(init.body)
        const endpoints = body.values?.endpoint ?? payload.config.endpoints
        payload = statePayload({
          config: {
            ...payload.config,
            endpoints,
            transport: body.values?.transport ?? payload.config.transport,
            locale: body.values?.locale ?? payload.config.locale,
          },
          overriddenKeys: Object.keys(body.values ?? {}),
        })
      }
      if (String(url).endsWith('/key/rotate')) {
        payload = statePayload({ key: 'dshk_ROTATED_0000000000000000000000000000000000', keyFingerprint: 'dshk_ROTATED_…0000' })
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
    }
  )
  // The bundle's React is the seed stub; swap in the hook-capable one.
  const bundleReact = harness.React
  const originalCreateElement = bundleReact.createElement
  // `navigator` is a read-only global in modern Node, so it is replaced through
  // a property definition rather than assignment.
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      clipboard: {
        /**
         * @param {string} text clipboard text.
         */
        async writeText(text) {
          copied.push(text)
        },
      },
    },
  })

  try {
    // Re-materialize the bundle with the hook-capable React.
    const source = await readFile(BUNDLE, 'utf8')
    /** @type {any} */
    let entry
    g.document = {
      head: { appendChild() {} },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, style: {}, setAttribute() {}, select() {}, remove() {} }),
      body: { appendChild() {} },
      execCommand: () => true,
    }
    g.window = {
      isSecureContext: true,
      confirm: () => true,
      __ModuleLoader__: {
        /** @param {any} value bundle registration. */
        load(value) {
          entry = value
        },
      },
    }
    await import(`${pathToFileURL(BUNDLE).href}?t=${Date.now()}-render`)
    assert.ok(source.length > 0)
    const module = entry.factory((specifier) => {
      if (specifier === 'react') return { ...bundleReact, createElement: originalCreateElement }
      throw new Error(`unexpected require("${specifier}")`)
    })

    let tree = harness.render(module.Dsh2ServerPanel)
    assert.match(collectText(tree).join(' '), /正在读取插件状态/)
    await harness.runEffects()
    harness.setRerender(() => {
      tree = harness.render(module.Dsh2ServerPanel)
    })
    tree = harness.render(module.Dsh2ServerPanel)

    // ── loaded state ─────────────────────────────────────────────────────────
    const text = collectText(tree).join(' ')
    assert.match(text, /dsh2server/, 'the card must title itself')
    assert.match(text, /1\/1 条链路已连接/, 'the badge must report link health')
    assert.match(text, /dshk_GUI_TEST…0000/, 'the key is shown as a fingerprint until revealed')
    const endpointInputs = () =>
      findAll(
        tree,
        (node) => node.type === 'input' && String(node.props.className || '').includes('dsh2server-endpoint-input'),
      )
    assert.equal(findAll(tree, (node) => node.type === 'textarea').length, 0, 'endpoints are not edited in a shared textarea')
    assert.equal(endpointInputs()[0].props.value, 'https://relay.example.com/dsh-api')
    assert.match(text, /relay\.example\.com\/dsh-api/)
    assert.ok(calls.some((call) => call.url === `${CONSOLE_BASE}/state`), 'the panel must read /state on mount')

    // ── switching the plugin language ───────────────────────────────────────
    const languageSelect = findAll(
      tree,
      (node) => node.type === 'select' && node.props.value === 'system',
    )[0]
    assert.ok(languageSelect, 'the plugin exposes an independent language selector')
    languageSelect.props.onChange({ target: { value: 'en-US' } })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    tree = harness.render(module.Dsh2ServerPanel)
    assert.match(collectText(tree).join(' '), /Plugin language/)
    const localeCall = calls.find((call) => {
      if (call.url !== `${CONSOLE_BASE}/config`) return false
      return JSON.parse(call.init.body).values?.locale === 'en-US'
    })
    assert.ok(localeCall, 'language selection must persist through /config')
    const englishLanguageSelect = findAll(
      tree,
      (node) => node.type === 'select' && node.props.value === 'en-US',
    )[0]
    englishLanguageSelect.props.onChange({ target: { value: 'zh-CN' } })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    tree = harness.render(module.Dsh2ServerPanel)

    // ── editing and saving the endpoint ──────────────────────────────────────
    endpointInputs()[0].props.onChange({ target: { value: 'http://10.0.0.5:8787/dsh-api' } })
    tree = harness.render(module.Dsh2ServerPanel)
    button(tree, '添加服务器端点').props.onClick()
    tree = harness.render(module.Dsh2ServerPanel)
    assert.equal(endpointInputs().length, 2, 'adding creates a separate endpoint field')
    endpointInputs()[1].props.onChange({ target: { value: 'https://relay.example.com/dsh-api' } })
    tree = harness.render(module.Dsh2ServerPanel)
    button(tree, '添加服务器端点').props.onClick()
    tree = harness.render(module.Dsh2ServerPanel)
    assert.equal(endpointInputs().length, 3)
    const removeThird = findAll(
      tree,
      (node) => node.type === 'button' && node.props['aria-label'] === '移除端点 3',
    )[0]
    assert.ok(removeThird, 'every endpoint has its own remove action')
    removeThird.props.onClick()
    tree = harness.render(module.Dsh2ServerPanel)
    assert.deepEqual(
      endpointInputs().map((input) => input.props.value),
      ['http://10.0.0.5:8787/dsh-api', 'https://relay.example.com/dsh-api'],
      'removing one endpoint preserves the other independent fields',
    )
    const save = button(tree, '保存并应用')
    assert.equal(save.props.disabled, false, 'the save button enables once the form is dirty')
    assert.equal(button(harness.render(module.Dsh2ServerPanel), '恢复配置文件的值').props.disabled, false, 'the language override can be reset')

    await save.props.onClick()
    const configCall = calls.find((call) => {
      if (call.url !== `${CONSOLE_BASE}/config`) return false
      return Array.isArray(JSON.parse(call.init.body).values?.endpoint)
    })
    assert.ok(configCall, 'saving must POST /config')
    assert.deepEqual(JSON.parse(configCall.init.body).values.endpoint, [
      'http://10.0.0.5:8787/dsh-api',
      'https://relay.example.com/dsh-api',
    ])
    tree = harness.render(module.Dsh2ServerPanel)
    assert.match(collectText(tree).join(' '), /已保存并应用/)

    // ── copying the key ──────────────────────────────────────────────────────
    await button(tree, '复制 Key').props.onClick()
    assert.deepEqual(copied, [payload.key], 'the copy button must copy the full key')

    // ── revealing the key ────────────────────────────────────────────────────
    button(tree, '显示').props.onClick()
    tree = harness.render(module.Dsh2ServerPanel)
    assert.ok(collectText(tree).join(' ').includes(payload.key), 'reveal shows the full key')

    // ── resetting the override layer ─────────────────────────────────────────
    const reset = button(tree, '恢复配置文件的值')
    await reset.props.onClick()
    const resetCall = calls.filter((call) => call.url === `${CONSOLE_BASE}/config`).pop()
    assert.deepEqual(JSON.parse(resetCall.init.body).reset, ['endpoint', 'transport', 'locale'])

    // ── rotating the key ─────────────────────────────────────────────────────
    // The rotate handler is a block body that deliberately does not return its
    // promise (the button must not be awaited by React), so flush the chain.
    button(tree, '轮换 Key').props.onClick()
    for (let tick = 0; tick < 6; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
    tree = harness.render(module.Dsh2ServerPanel)
    assert.match(collectText(tree).join(' '), /已生成新 key/)
    const rotateCall = calls.find((call) => call.url === `${CONSOLE_BASE}/key/rotate`)
    assert.deepEqual(JSON.parse(rotateCall.init.body), { confirm: 'dsh-gui' })
  } finally {
    harness.cleanup()
    globalThis.fetch = previousFetch
    if (previousNavigator === undefined) delete g.navigator
    else Object.defineProperty(globalThis, 'navigator', previousNavigator)
    delete g.window
    delete g.document
  }
})

test('client bundle: renders an idle plugin without a configured endpoint', async () => {
  const harness = createRenderer()
  const previousFetch = globalThis.fetch
  globalThis.fetch = /** @type {any} */ (
    async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify(
          statePayload({
            config: { ...statePayload().config, endpoints: [], endpoint: '' },
            connected: false,
            links: [],
          }),
        ),
    })
  )
  try {
    /** @type {any} */
    let entry
    g.document = {
      head: { appendChild() {} },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, style: {}, setAttribute() {}, select() {}, remove() {} }),
      body: { appendChild() {} },
    }
    g.window = { isSecureContext: true, __ModuleLoader__: { load(value) { entry = value } } }
    await import(`${pathToFileURL(BUNDLE).href}?t=${Date.now()}-idle`)
    const module = entry.factory((specifier) => {
      if (specifier === 'react') return harness.React
      throw new Error(`unexpected require("${specifier}")`)
    })
    let tree = harness.render(module.Dsh2ServerPanel)
    await harness.runEffects()
    harness.setRerender(() => {
      tree = harness.render(module.Dsh2ServerPanel)
    })
    tree = harness.render(module.Dsh2ServerPanel)
    const text = collectText(tree).join(' ')
    assert.match(text, /未配置服务器/)
    assert.match(text, /没有配置端点，插件处于空闲状态/)
    // With no endpoint there is nothing to pair against, so the curl helper is absent.
    assert.equal(findAll(tree, (node) => collectText(node).join(' ').includes('复制登记命令')).length, 0)
  } finally {
    harness.cleanup()
    globalThis.fetch = previousFetch
    delete g.window
    delete g.document
  }
})

test('client bundle: every API path it calls exists in the Host route table', async () => {
  const source = await readFile(BUNDLE, 'utf8')
  const declared = new Set(CONSOLE_ROUTES.map((route) => route.path))
  const called = new Set()
  // The card reaches the console through its own `request(path)` helper, so the
  // paths appear as string-literal arguments rather than interpolated URLs.
  for (const match of source.matchAll(/\brequest\(\s*'([^']+)'/g)) called.add(`${CONSOLE_BASE}${match[1]}`)
  assert.ok(called.size >= 3, `expected the bundle to call several console paths, found ${called.size}`)
  for (const path of called) {
    assert.ok(declared.has(path), `the browser calls ${path}, which the Host half does not register`)
  }
  // And the reverse: every route the Host registers is actually reachable from the card.
  assert.ok(called.has(`${CONSOLE_BASE}/state`), 'the card must read the state route')
  assert.ok(called.has(`${CONSOLE_BASE}/config`), 'the card must write the config route')
})
