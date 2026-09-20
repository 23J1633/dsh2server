/**
 * Integration test for the web-console Host half.
 *
 * Loads the **real** Connection service from an installed dsh, loads this
 * plugin into the same Cordis context, and drives the console API through
 * Connection's own shared fetch handler — the same code path the browser hits
 * at `/api/...`, including its route table. That covers what a unit test with a
 * fake context cannot: the exact paths, the method matrix, the JSON envelope,
 * and that a configuration write really reconnects the bridge.
 *
 * Skips itself when no dsh installation is found, so `npm test` stays green on a
 * machine without one.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { createRelayServer } from '../examples/server.js'
import { CONSOLE_BASE, CONSOLE_ROUTES } from '../lib/host-ui.js'
import { Logger } from '../lib/log.js'
import { waitFor } from './helpers/fake-host.js'

/** Candidate dsh installations, newest-style path first. */
const DSH_ROOTS = [
  process.env.DSH_INSTALL,
  'D:/dsh/app/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
  '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
].filter(Boolean)

/**
 * @returns {{root: string, cordis: string, credentials: string, connection: string} | undefined}
 *   resolved module URLs, or undefined when no installation is usable.
 */
function findInstall() {
  for (const root of DSH_ROOTS) {
    const cordis = `${root}/cordis/lib/index.js`
    const credentials = `${root}/dsh-credentials-local/lib/index.js`
    const connection = `${root}/dsh-client-connection/lib/index.js`
    try {
      if (existsSync(cordis) && existsSync(credentials) && existsSync(connection)) {
        return { root, cordis, credentials, connection }
      }
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

const install = findInstall()
const skip = install ? false : 'no dsh installation found (set DSH_INSTALL to enable this test)'

/** @returns {string} a deterministic test key. */
function testKey(seed) {
  return `dshk_${createHash('sha256').update(seed).digest('base64url').slice(0, 40)}`
}

/**
 * Whether one relay currently holds a *connected* row for an instance.
 *
 * The HTTP carrier has no socket-close event, so a relay keeps the row and marks
 * it disconnected through the plugin's `bye` frame. "Is it connected?" is
 * therefore `row exists && not marked disconnected` — not `row exists`.
 *
 * @param {any} relay running relay.
 * @param {string} instanceId instance identity.
 * @returns {boolean} whether the relay sees a live instance.
 */
function liveOn(relay, instanceId) {
  const row = relay.instances.get(instanceId)
  return row !== undefined && !row.disconnectedAt
}

/**
 * Load a package's default export into a context.
 *
 * @param {any} ctx target context.
 * @param {string} entry absolute path to the package's lib/index.js.
 * @returns {Promise<void>} resolves after the plugin is mounted.
 */
async function mount(ctx, entry) {
  const mod = await import(pathToFileURL(entry).href)
  await ctx.plugin(mod.default ?? mod)
}

/**
 * Start the real Connection stack in a bare Cordis context.
 *
 * @returns {Promise<{ctx: any, handler: {fetch: (request: Request) => Promise<Response>}, dispose: () => Promise<void>}>} the stack.
 */
async function startConnection() {
  const cordis = await import(pathToFileURL(install.cordis).href)
  const ctx = new cordis.Context()
  await mount(ctx, install.credentials)
  await mount(ctx, install.connection)
  assert.ok(ctx.get('connection'), 'the Connection service must be available')
  return {
    ctx,
    handler: ctx.get('connection').createSharedFetchHandler('/api'),
    // The root fiber owns every service the stack started, including the
    // Connection's browser-auth timers; disposing it is what lets the test
    // process exit instead of idling on their handles.
    dispose: async () => {
      await ctx.fiber.dispose()
    },
  }
}

test('console: the Host half serves state and reconfigures through the real Connection', { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh2server-console-'))
  const originalHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir

  const key = testKey('console')
  const relayA = await createRelayServer({ keys: [key], port: 0 })
  const relayB = await createRelayServer({ keys: [key], port: 0 })
  const stack = await startConnection()
  let fiber
  try {
    // Seed the identity file instead of pinning `key` in the config: a pinned
    // key cannot be rotated (`identity.rotate()` refuses), and rotation is part
    // of what this test has to cover.
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(dir, 'dsh2server'), { recursive: true })
    await writeFile(
      join(dir, 'dsh2server', 'identity.json'),
      JSON.stringify({ version: 1, instanceId: 'dsh-console', key, createdAt: new Date().toISOString() }),
      'utf8',
    )

    const plugin = await import('../index.js')
    fiber = stack.ctx.plugin(plugin, {
      endpoint: relayA.url,
      a2sConfigFile: join(dir, 'missing-a2s-config.json'),
      transport: 'http',
      pollWaitMs: 300,
      logLevel: 'silent',
      reconnectInitialDelayMs: 50,
      reconnectMaxDelayMs: 200,
    })

    /**
     * @param {string} path API path below `/api`.
     * @param {RequestInit} [init] fetch init.
     * @returns {Promise<{status: number, body: any}>} the response.
     */
    const call = async (path, init) => {
      const response = await stack.handler.fetch(new Request(`http://127.0.0.1${path}`, init))
      const text = await response.text()
      let body
      try {
        body = text ? JSON.parse(text) : undefined
      } catch {
        body = { raw: text }
      }
      return { status: response.status, body }
    }
    const post = (path, body) =>
      call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

    // The console is mounted asynchronously; poll until the route answers and
    // the first link has completed its handshake.
    await waitFor(async () => (await call(`${CONSOLE_BASE}/state`)).status === 200, 10000, 'the console route to mount')
    await waitFor(
      async () => (await call(`${CONSOLE_BASE}/state`)).body.connected === true,
      10000,
      'the first link to connect',
    )

    // ── state ────────────────────────────────────────────────────────────────
    const state = await call(`${CONSOLE_BASE}/state`)
    assert.equal(state.status, 200)
    assert.equal(state.body.ok, true)
    assert.equal(state.body.instanceId, 'dsh-console')
    assert.ok(state.body.key.startsWith('dshk_'))
    assert.match(state.body.keyFingerprint, /…/)
    assert.deepEqual(state.body.config.endpoints, [relayA.url])
    assert.equal(state.body.config.transport, 'http')
    assert.equal(state.body.connected, true)
    assert.equal(state.body.links.length, 1)
    assert.ok(state.body.methods.includes('session.prompt'))
    assert.ok(state.body.editableKeys.includes('endpoint'))
    assert.deepEqual(state.body.overriddenKeys, [])
    assert.match(state.body.configFile, /config\.json$/)
    assert.equal(state.body.plugin.name, 'dsh2server')

    // ── route table ──────────────────────────────────────────────────────────
    const notFound = await call(`${CONSOLE_BASE}/nope`)
    assert.equal(notFound.status, 404)
    const wrongMethod = await call(`${CONSOLE_BASE}/config`)
    assert.notEqual(wrongMethod.status, 200)

    // ── reconfiguration moves the live link ──────────────────────────────────
    const moved = await post(`${CONSOLE_BASE}/config`, { values: { endpoint: [relayB.url], transport: 'http' } })
    assert.equal(moved.status, 200, JSON.stringify(moved.body))
    assert.deepEqual(moved.body.config.endpoints, [relayB.url])
    assert.deepEqual([...moved.body.overriddenKeys].sort(), ['endpoint', 'transport'])
    await waitFor(async () => (await call(`${CONSOLE_BASE}/state`)).body.connected === true, 10000, 'the new link')
    await waitFor(() => liveOn(relayB, 'dsh-console'), 10000, 'the machine to attach to the new endpoint')
    assert.equal(
      liveOn(relayA, 'dsh-console'),
      false,
      'the old endpoint must see the machine leave (the plugin sends bye on the HTTP carrier)',
    )
    assert.ok(
      relayA.instances.get('dsh-console')?.disconnectedAt,
      'the old relay keeps the row but marks it disconnected rather than dropping it mid-reconnect',
    )

    const persistedConfig = JSON.parse(await readFile(join(dir, 'dsh2server', 'config.json'), 'utf8'))
    assert.deepEqual(persistedConfig.endpoint, [relayB.url])
    assert.equal(persistedConfig.transport, 'http')

    // ── a bad write is refused and changes nothing ───────────────────────────
    const rejected = await post(`${CONSOLE_BASE}/config`, { values: { endpoint: ['not-a-url'] } })
    assert.equal(rejected.status, 400)
    assert.equal(rejected.body.ok, false)
    assert.equal(rejected.body.error.code, 'invalid_config')
    assert.ok(Array.isArray(rejected.body.error.issues))
    const afterReject = await call(`${CONSOLE_BASE}/state`)
    assert.deepEqual(afterReject.body.config.endpoints, [relayB.url], 'a refused write must not take effect')

    const notEditable = await post(`${CONSOLE_BASE}/config`, { values: { key: 'x'.repeat(40) } })
    assert.equal(notEditable.status, 400)

    // ── reset returns to the composition layer ───────────────────────────────
    const partialReset = await post(`${CONSOLE_BASE}/config`, { reset: ['endpoint'] })
    assert.equal(partialReset.status, 200)
    assert.deepEqual(partialReset.body.config.endpoints, [relayA.url], 'a reset field must re-inherit the composition value')
    assert.deepEqual([...partialReset.body.overriddenKeys], ['transport'], 'only the reset key leaves the console layer')
    await waitFor(() => liveOn(relayA, 'dsh-console'), 10000, 'the composition endpoint to be restored')

    const fullReset = await post(`${CONSOLE_BASE}/config`, { reset: ['endpoint', 'transport'] })
    assert.equal(fullReset.status, 200)
    assert.deepEqual(fullReset.body.overriddenKeys, [])
    assert.deepEqual(fullReset.body.config.endpoints, [relayA.url])

    // ── reconnect ────────────────────────────────────────────────────────────
    const reconnected = await post(`${CONSOLE_BASE}/reconnect`, {})
    assert.equal(reconnected.status, 200)
    await waitFor(() => liveOn(relayA, 'dsh-console'), 10000, 'the link to come back after a manual reconnect')

    // ── key rotation ─────────────────────────────────────────────────────────
    const refused = await post(`${CONSOLE_BASE}/key/rotate`, { confirm: 'someone-else' })
    assert.equal(refused.status, 400)
    assert.equal(refused.body.error.code, 'confirmation_required')
    const oldKey = state.body.key
    const rotated = await post(`${CONSOLE_BASE}/key/rotate`, { confirm: 'dsh-console' })
    assert.equal(rotated.status, 200)
    assert.notEqual(rotated.body.key, oldKey)
    assert.ok(rotated.body.key.startsWith('dshk_'))
    const identity = JSON.parse(await readFile(join(dir, 'dsh2server', 'identity.json'), 'utf8'))
    assert.equal(identity.key, rotated.body.key, 'the rotated key must be persisted')

    // ── the declared route table matches what is actually served ─────────────
    for (const route of CONSOLE_ROUTES) {
      const method = route.methods[0]
      const response = await call(route.path, method === 'POST' ? { method: 'POST', body: '{}' } : undefined)
      assert.notEqual(response.status, 404, `${method} ${route.path} must exist`)
    }
  } finally {
    await fiber?.dispose?.()
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
    await stack.dispose()
    await relayA.close()
    await relayB.close()
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('console: an invalid stored layer is discarded at load instead of blocking the plugin', { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh2server-console-bad-'))
  const originalHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  const key = testKey('console-bad')
  const relay = await createRelayServer({ keys: [key], port: 0 })
  const stack = await startConnection()
  let fiber
  try {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(dir, 'dsh2server'), { recursive: true })
    // A layer that could never be applied: the schema must reject it and the
    // plugin must fall back to the composition value rather than fail to load.
    await writeFile(
      join(dir, 'dsh2server', 'config.json'),
      JSON.stringify({ version: 1, endpoint: ['https://ok.example.com/dsh-api'], transport: 'carrier-pigeon' }),
      'utf8',
    )

    const plugin = await import('../index.js')
    const logger = new Logger('silent')
    fiber = stack.ctx.plugin(plugin, {
      endpoint: relay.url,
      a2sConfigFile: join(dir, 'missing-a2s-config.json'),
      key,
      instanceId: 'dsh-console-bad',
      transport: 'http',
      pollWaitMs: 300,
      logLevel: 'silent',
    })
    void logger

    const call = async (path) => {
      const response = await stack.handler.fetch(new Request(`http://127.0.0.1${path}`))
      return { status: response.status, body: JSON.parse(await response.text()) }
    }
    await waitFor(async () => (await call(`${CONSOLE_BASE}/state`)).status === 200, 10000, 'the console route')
    const state = await call(`${CONSOLE_BASE}/state`)
    assert.deepEqual(state.body.config.endpoints, [relay.url], 'the composition endpoint must win after the bad layer is dropped')
    assert.equal(state.body.config.transport, 'http')
    await waitFor(() => liveOn(relay, 'dsh-console-bad'), 10000, 'the plugin to connect despite the bad stored layer')
  } finally {
    await fiber?.dispose?.()
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
    await stack.dispose()
    await relay.close()
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
