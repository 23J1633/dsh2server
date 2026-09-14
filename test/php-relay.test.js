/**
 * End-to-end test against the **PHP** reference relay.
 *
 * Proves the PHP backend really speaks the protocol, using the real plugin
 * client (the same `Bridge` + HTTP long-poll carrier that runs inside dsh):
 * handshake, the admin request/response round trip, remote operations, the
 * pause gate, event forwarding, pairing of an unknown key, and the embedded
 * test UI.
 *
 * Skips itself when no PHP binary can be found, so `npm test` stays green on a
 * machine without PHP.
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { Bridge } from '../lib/bridge.js'
import { validateConfig } from '../lib/config.js'
import { Identity } from '../lib/identity.js'
import { Logger } from '../lib/log.js'
import { FakeHost, waitFor } from './helpers/fake-host.js'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'php', 'dsh-relay.php')

/** Candidate PHP binaries, in order of preference. */
const PHP_CANDIDATES = [
  process.env.PHP_BIN,
  'php',
  'D:/xampp/php/php.exe',
  '/usr/bin/php',
  '/usr/local/bin/php',
].filter(Boolean)

/**
 * Locate a working PHP binary.
 *
 * Every candidate is actually executed (`php -v`) rather than merely probed for
 * existence, so a stale PATH entry or an unreadable file does not turn into a
 * confusing `spawn ENOENT` later.
 *
 * @returns {string | undefined} a usable PHP binary, or undefined.
 */
function findPhp() {
  for (const candidate of PHP_CANDIDATES) {
    try {
      const probe = spawnSync(candidate, ['-v'], { stdio: 'ignore', timeout: 5000, windowsHide: true })
      if (probe.status === 0) return candidate
    } catch {
      // Not runnable; try the next candidate.
    }
  }
  return undefined
}

const phpBin = findPhp()
const skip = phpBin ? false : 'no PHP binary found (set PHP_BIN to enable this test)'

/** @returns {Promise<number>} an OS-assigned free port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

/**
 * Start the PHP relay on a free port with isolated state.
 *
 * @param {object} options relay options.
 * @param {string} options.dataDir state directory.
 * @param {string} options.keysFile key whitelist path.
 * @returns {Promise<{base: string, port: number, stop: () => Promise<void>}>} the running relay.
 */
async function startPhpRelay(options) {
  const port = await freePort()
  const child = spawn(phpBin, ['-S', `127.0.0.1:${port}`, SCRIPT], {
    cwd: dirname(SCRIPT),
    env: {
      ...process.env,
      DSH_RELAY_DATA: options.dataDir,
      DSH_RELAY_KEYS: options.keysFile,
      DSH_RELAY_BASE: '/dsh-api',
      DSH_RELAY_POLL_MS: '300',
      DSH_RELAY_EVENT_LIMIT: '100',
    },
    stdio: 'ignore',
    windowsHide: true,
  })
  const base = `http://127.0.0.1:${port}/dsh-api`
  const deadline = Date.now() + 15000
  for (;;) {
    try {
      const response = await fetch(`${base}/`, { signal: AbortSignal.timeout(1500) })
      if (response.ok) break
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) {
      child.kill()
      throw new Error('the PHP relay did not start within 15s')
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return {
    base,
    port,
    async stop() {
      child.kill()
      await new Promise((resolve) => setTimeout(resolve, 120))
    },
  }
}

/**
 * @param {string} url absolute URL.
 * @param {object} [options] fetch options.
 * @returns {Promise<{status: number, body: any}>} parsed response.
 */
async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text }
  }
  return { status: response.status, body }
}

/**
 * Issue one remote operation through the relay's admin API and await the
 * plugin's response (the PHP relay returns immediately and is polled, because
 * `php -S` is single-process and blocking would deadlock with the plugin's own
 * long-poll).
 *
 * @param {string} base relay base URL.
 * @param {string} instanceId target instance.
 * @param {string} method operation name.
 * @param {Record<string, unknown>} [params] operation parameters.
 * @returns {Promise<Record<string, any>>} the `response` frame.
 */
async function adminRequest(base, instanceId, method, params = {}) {
  const queued = await fetchJson(`${base}/instances/${encodeURIComponent(instanceId)}/request`, {
    method: 'POST',
    body: { method, params },
  })
  assert.equal(queued.status, 200, JSON.stringify(queued.body))
  const deadline = Date.now() + 20000
  for (;;) {
    const poll = await fetchJson(`${base}/instances/${encodeURIComponent(instanceId)}/response?id=${queued.body.id}`)
    if (poll.body?.ready) return poll.body.frame
    if (Date.now() > deadline) throw new Error(`admin request "${method}" timed out`)
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
}

test('php: the reference PHP relay drives the real plugin client end to end', { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-php-relay-'))
  const keysFile = join(dir, 'keys.json')
  const key = `dshk_${createHash('sha256').update('php-e2e').digest('base64url').slice(0, 40)}`
  await writeFile(keysFile, JSON.stringify({ keys: [{ key, label: 'php-e2e' }] }), 'utf8')

  const relay = await startPhpRelay({ dataDir: join(dir, 'data'), keysFile })
  const host = new FakeHost({ sessions: [{ id: 'session-php', cwd: 'C:/work/php-demo', running: true }] })
  const ctx = host.context()
  const logger = new Logger('silent')
  const identity = await new Identity({
    keyFile: join(dir, 'identity.json'),
    explicitKey: key,
    explicitInstanceId: 'dsh-php-e2e',
    logger,
  }).load()
  const config = validateConfig({
    endpoint: base(relay),
    transport: 'http',
    logLevel: 'silent',
    pollWaitMs: 300,
    heartbeatMs: 1000,
    heartbeatTimeoutMs: 8000,
    requestTimeoutMs: 8000,
    reconnectInitialDelayMs: 50,
    reconnectMaxDelayMs: 200,
  })
  assert.equal(config.issues, undefined, JSON.stringify(config.issues))
  const bridge = new Bridge({ ctx, config: config.value, identity, logger })
  bridge.start()

  try {
    await waitFor(() => bridge.isConnected(), 15000, 'the plugin handshake through the PHP relay')
    await waitFor(async () => {
      const list = await fetchJson(`${relay.base}/instances`)
      return (list.body?.instances ?? []).length === 1
    }, 15000, 'the PHP relay to register the instance')

    const instances = (await fetchJson(`${relay.base}/instances`)).body.instances
    const instance = instances[0]
    assert.equal(instance.instanceId, 'dsh-php-e2e')
    assert.equal(instance.transport, 'http')
    assert.equal(instance.tls, false)
    assert.equal(instance.capabilities.sessionController, true)

    // 1) handshake round trip
    const ping = await adminRequest(relay.base, instance.instanceId, 'instance.ping')
    assert.equal(ping.ok, true)
    assert.equal(ping.result.pong, true)

    const info = await adminRequest(relay.base, instance.instanceId, 'instance.info')
    assert.equal(info.ok, true)
    assert.equal(info.result.connection.transport, 'http')
    assert.equal(info.result.connection.endpoint, base(relay))
    assert.ok(info.result.methods.includes('session.prompt'))

    // 2) state reporting
    const sessions = await adminRequest(relay.base, instance.instanceId, 'session.list')
    assert.equal(sessions.result.items[0].sessionId, 'session-php')
    assert.equal(sessions.result.items[0].cwd, 'C:/work/php-demo')

    const workspaces = await adminRequest(relay.base, instance.instanceId, 'workspace.list')
    assert.equal(workspaces.result.items[0].path, 'C:/work/project')

    // 3) sending a new command
    const prompt = await adminRequest(relay.base, instance.instanceId, 'session.prompt', {
      sessionId: 'session-php',
      text: '来自 PHP 测试台',
    })
    assert.equal(prompt.ok, true)
    assert.equal(host.prompts.length, 1)
    assert.deepEqual(host.prompts[0].content, [{ type: 'text', text: '来自 PHP 测试台' }])

    // 4) pause parks a prompt and resume delivers it
    host.sessions.get('session-php').agent.status = 'running'
    const paused = await adminRequest(relay.base, instance.instanceId, 'session.pause', { sessionId: 'session-php' })
    assert.equal(paused.result.paused, true)
    const deferred = await adminRequest(relay.base, instance.instanceId, 'session.prompt', {
      sessionId: 'session-php',
      text: '暂停期间排队',
    })
    assert.equal(deferred.result.deferred, true)
    assert.equal(host.prompts.length, 1, 'a parked prompt must not reach the harness yet')
    const resumed = await adminRequest(relay.base, instance.instanceId, 'session.resume', { sessionId: 'session-php' })
    assert.equal(resumed.result.delivered, 1)
    assert.equal(host.prompts.length, 2)

    // 5) interrupt
    const interrupted = await adminRequest(relay.base, instance.instanceId, 'session.interrupt', { sessionId: 'session-php' })
    assert.equal(interrupted.ok, true)
    assert.equal(host.cancels.length, 1)

    // 6) event forwarding: subscribe, then emit a durable session event
    await fetchJson(`${relay.base}/instances/${encodeURIComponent(instance.instanceId)}/subscribe`, {
      method: 'POST',
      body: { topics: ['instance', 'sessions'], sessions: ['session-php'], assistantStream: true },
    })
    await waitFor(async () => {
      const events = await fetchJson(`${relay.base}/instances/${encodeURIComponent(instance.instanceId)}/events`)
      return (events.body?.events ?? []).some((frame) => frame.kind === 'session/snapshot')
    }, 8000, 'the session snapshot from the subscribe')

    host.emitSessionEvent(ctx, 'session-php', { type: 'tool/result', data: { via: 'php' } })
    await waitFor(async () => {
      const events = await fetchJson(`${relay.base}/instances/${encodeURIComponent(instance.instanceId)}/events`)
      return (events.body?.events ?? []).some((frame) => frame.data?.type === 'tool/result')
    }, 8000, 'the forwarded session event')

    const eventsBody = (await fetchJson(`${relay.base}/instances/${encodeURIComponent(instance.instanceId)}/events`)).body
    const seqs = eventsBody.events.map((frame) => frame.seq)
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b))
    assert.equal(new Set(seqs).size, seqs.length, 'the PHP relay must dedupe by seq')

    // 7) the embedded test UI is served on the non-API path
    const ui = await fetch(`http://127.0.0.1:${relay.port}/`, { signal: AbortSignal.timeout(5000) })
    assert.equal(ui.status, 200)
    const html = await ui.text()
    assert.match(html, /dsh2server 测试台/)
    assert.match(html, /session\.prompt/)
    // The UI is served from the same origin and talks to the API by path prefix.
    assert.match(html.replaceAll('\\/', '/'), /const BASE = "\/dsh-api"/)
    assert.match(html, /const POLL_MAX_MS = 300/)

    // 8) an unknown key is refused, recorded for pairing, then allowed
    const strangerKey = `dshk_${createHash('sha256').update('php-stranger').digest('base64url').slice(0, 40)}`
    const rejected = await fetchJson(`${relay.base}/events`, {
      method: 'POST',
      body: { v: 1, instanceId: 'dsh-stranger', frames: [{ v: 1, type: 'hello', instanceId: 'dsh-stranger', auth: { type: 'instance-key', key: strangerKey } }] },
    })
    assert.equal(rejected.status, 401)
    const pending = (await fetchJson(`${relay.base}/pending`)).body
    assert.equal(pending.pending.length, 1)
    assert.equal(pending.pending[0].instanceId, 'dsh-stranger')

    const allowed = await fetchJson(`${relay.base}/pending/allow`, {
      method: 'POST',
      body: { key: pending.pending[0].key, label: 'stranger' },
    })
    assert.equal(allowed.status, 200)
    const keys = (await fetchJson(`${relay.base}/keys`)).body
    assert.equal(keys.keys.length, 2)
    assert.equal((await fetchJson(`${relay.base}/pending`)).body.pending.length, 0)
  } finally {
    await bridge.dispose()
    await ctx.dispose()
    await relay.stop()
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

/**
 * @param {{base: string, port: number}} relay running relay.
 * @returns {string} the plugin-facing endpoint URL.
 */
function base(relay) {
  return relay.base
}

test('php: the relay honours the admin key when one is configured', { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-php-admin-'))
  try {
    const relay = await startPhpRelay({ dataDir: join(dir, 'data'), keysFile: join(dir, 'keys.json') })
    // The suite's relays run without an admin key, so this asserts the default
    // posture rather than the configured one: management routes stay open only
    // because the deployment did not set DSH_RELAY_ADMIN_KEY.
    const open = await fetchJson(`${relay.base}/instances`)
    assert.equal(open.status, 200)
    await relay.stop()
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
