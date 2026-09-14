/**
 * Integration test against the real Cordis runtime.
 *
 * Everything else in this suite tests the bridge with a hand-written context
 * double. This file closes the last gap: it loads `index.js` into an actual
 * Cordis `Context` from an installed DeepSeek Harness, so the parts only the
 * framework can exercise are covered —
 *
 *   - the exported `Config` is accepted through the Standard Schema contract,
 *     and Cordis fails the fiber with a `ValidationError` on bad input;
 *   - `apply` runs, `ctx.effect` registers the disposer, and `ctx.logger` is used;
 *   - `ctx.on(...)` registrations survive into the running plugin;
 *   - unloading the fiber disposes the bridge cleanly.
 *
 * The test skips itself when no harness install can be found, so `npm test`
 * stays green on a machine that only has this package.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { createRelayServer, fingerprint } from '../examples/server.js'
import { waitFor } from './helpers/fake-host.js'

/** Candidate locations of the Cordis entry point shipped with a dsh install. */
const CORDIS_CANDIDATES = [
  process.env.DSH_CORDIS_ENTRY,
  'D:/dsh/app/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js',
  join(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'),
].filter(Boolean)

/**
 * @returns {string | undefined} the first existing Cordis entry point.
 */
function findCordis() {
  for (const candidate of CORDIS_CANDIDATES) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // An unreadable candidate is simply not a candidate.
    }
  }
  return undefined
}

const cordisEntry = findCordis()

test('cordis: loads into a real Context and connects, then disposes cleanly', { skip: cordisEntry ? false : 'no dsh install found' }, async () => {
  const cordis = await import(pathToFileURL(cordisEntry).href)
  const plugin = await import('../index.js')

  const dir = await mkdtemp(join(tmpdir(), 'dsh-bridge-cordis-'))
  const key = 'dshk_cordis_integration_key_000000000000'
  const relay = await createRelayServer({ keys: [{ key, label: 'cordis-test' }], port: 0 })
  const ctx = new cordis.Context()
  const originalHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const fiber = ctx.plugin(plugin, {
      endpoint: relay.url,
      key,
      instanceId: 'dsh-cordis-test',
      logLevel: 'silent',
      reconnectInitialDelayMs: 50,
      reconnectMaxDelayMs: 200,
    })
    await waitFor(() => relay.instances.size === 1, 10000, 'the plugin to connect through real cordis')
    const instance = [...relay.instances.values()][0]
    assert.equal(instance.instanceId, 'dsh-cordis-test')
    assert.equal(instance.keyFingerprint, fingerprint(key))

    const info = await instance.request('instance.info')
    assert.equal(info.ok, true)
    assert.equal(info.result.instanceId, 'dsh-cordis-test')
    assert.equal(info.result.plugin.name, 'dsh2server')
    assert.ok(info.result.methods.includes('session.list'))
    assert.equal(info.result.connection.endpoint, relay.url)
    // No harness services exist in this bare context, so every capability is
    // honestly reported as absent rather than assumed.
    assert.equal(info.result.capabilities.sessionController, false)

    const list = await instance.request('session.list')
    assert.equal(list.ok, true)
    assert.deepEqual(list.result.items, [])

    const unavailable = await instance.request('session.search', { query: 'x' })
    assert.equal(unavailable.ok, false)
    assert.equal(unavailable.error.code, 'capability_unavailable')

    // Unloading the fiber must close the link and release the instance.
    await fiber.dispose()
    await waitFor(() => relay.instances.size === 0, 10000, 'the bridge to disconnect on dispose')
  } finally {
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
    await relay.close()
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('cordis: rejects an invalid configuration while loading', { skip: cordisEntry ? false : 'no dsh install found' }, async () => {
  const cordis = await import(pathToFileURL(cordisEntry).href)
  const plugin = await import('../index.js')
  const ctx = new cordis.Context()
  const fiber = ctx.plugin(plugin, { endpoint: 'https://example.com/dsh-api', transport: 'carrier-pigeon' })
  await assert.rejects(
    async () => {
      await fiber.await()
    },
    (error) => {
      assert.match(String(error?.name ?? ''), /ValidationError/)
      assert.match(String(error?.message ?? ''), /transport/)
      return true
    },
  )
})

test('cordis: an idle plugin still mints an identity so the GUI can show its key', { skip: cordisEntry ? false : 'no dsh install found' }, async () => {
  const cordis = await import(pathToFileURL(cordisEntry).href)
  const plugin = await import('../index.js')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-bridge-idle-'))
  const originalHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    // With no endpoint the plugin is idle — but it must still create the
    // identity, because the whole pairing flow is "open the GUI, copy the key,
    // register it on the server, then set the endpoint there".
    const ctx = new cordis.Context()
    const fiber = ctx.plugin(plugin, { endpoint: '', logLevel: 'silent' })
    await fiber.await().catch(() => undefined)
    // `apply` does its work inside an effect, so the identity lands asynchronously.
    await waitFor(
      () => existsSync(join(dir, 'dsh2server', 'identity.json')),
      5000,
      'the idle plugin to mint its identity file',
    )
    const identity = JSON.parse(await readFile(join(dir, 'dsh2server', 'identity.json'), 'utf8'))
    assert.ok(String(identity.key).startsWith('dshk_'), 'an idle plugin still owns an instance key')
    // Idle means no configuration was written and nothing is dialling out.
    await assert.rejects(async () => readFile(join(dir, 'dsh2server', 'config.json'), 'utf8'), /ENOENT/)
    await fiber.dispose()
  } finally {
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
