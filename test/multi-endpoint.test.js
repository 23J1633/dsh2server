/**
 * Multi-endpoint and dual-protocol tests.
 *
 * The plugin must be able to talk to **several servers at once**, and each of
 * them may be plain HTTP or TLS — for example a `http://` relay on the LAN for a
 * local console plus an `https://` relay reachable from outside. These tests
 * exercise that against real relays: one serving HTTP and HTTPS simultaneously,
 * one plain-HTTP-only, and one endpoint that is simply down.
 *
 * The HTTPS fixture uses a self-signed certificate (checked in under
 * `test/fixtures/`), so certificate verification is switched off **for this test
 * process only**. A real deployment either uses a public CA or points
 * `NODE_EXTRA_CA_CERTS` at its private CA.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createRelayServer } from '../examples/server.js'
import { Bridge } from '../lib/bridge.js'
import { validateConfig } from '../lib/config.js'
import { Identity } from '../lib/identity.js'
import { Logger } from '../lib/log.js'
import { FakeHost, waitFor } from './helpers/fake-host.js'

// Self-signed fixture certificate: accept it for this process only.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

/**
 * @param {string} seed key seed.
 * @returns {string} a deterministic test key.
 */
function testKey(seed) {
  return `dshk_${createHash('sha256').update(seed).digest('base64url').slice(0, 40)}`
}

/**
 * Start one bridge against a list of endpoints.
 *
 * @param {object} options bridge options.
 * @param {string[]} options.endpoints relays to connect to.
 * @param {string} options.key instance key.
 * @param {FakeHost} options.host fake harness host.
 * @param {Record<string, unknown>} [options.config] config overrides.
 * @returns {Promise<{bridge: Bridge, ctx: any, identity: Identity, dir: string, close: () => Promise<void>}>} the running bridge.
 */
async function startBridge(options) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-bridge-multi-'))
  const logger = new Logger('silent')
  const identity = await new Identity({
    keyFile: join(dir, 'identity.json'),
    explicitKey: options.key,
    explicitInstanceId: /** @type {any} */ (options.config)?.instanceId ?? 'dsh-multi',
    logger,
  }).load()
  const ctx = options.host.context()
  const config = validateConfig({
    endpoint: options.endpoints,
    logLevel: 'silent',
    reconnectInitialDelayMs: 50,
    reconnectMaxDelayMs: 200,
    requestTimeoutMs: 5000,
    pollWaitMs: 300,
    ...options.config,
  })
  assert.equal(config.issues, undefined, JSON.stringify(config.issues))
  const bridge = new Bridge({ ctx, config: config.value, identity, logger })
  bridge.start()
  return {
    bridge,
    ctx,
    identity,
    dir,
    async close() {
      await bridge.dispose()
      await ctx.dispose()
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    },
  }
}

/** @returns {Promise<{cert: string, key: string}>} the PEM fixture pair. */
async function tlsFixture() {
  const base = new URL('./fixtures/', import.meta.url)
  return {
    cert: await readFile(new URL('tls-cert.pem', base), 'utf8'),
    key: await readFile(new URL('tls-key.pem', base), 'utf8'),
  }
}

test('multi: one relay serves HTTP and HTTPS at the same time', async () => {
  const key = testKey('dual')
  const tls = await tlsFixture()
  const relay = await createRelayServer({ keys: [key], port: 0, tlsPort: 0, tlsCert: tls.cert, tlsKey: tls.key })
  try {
    assert.ok(relay.httpsUrl, 'the relay should expose an HTTPS endpoint')
    assert.match(relay.httpUrl, /^http:\/\//)
    assert.match(relay.httpsUrl, /^https:\/\//)
    assert.notEqual(relay.port, relay.tlsPort)

    // Two bridges, one per protocol, both using the same key: the relay accepts
    // both and keeps them apart by instance id.
    const overHttp = await startBridge({ endpoints: [relay.httpUrl], key, host: new FakeHost(), config: { instanceId: 'dsh-multi' } })
    const overHttps = await startBridge({
      endpoints: [relay.httpsUrl],
      key,
      host: new FakeHost({ sessions: [{ id: 'session-tls', cwd: 'D:/work/tls', running: false }] }),
      config: { instanceId: 'dsh-tls' },
    })
    try {
      await waitFor(() => relay.instances.size === 2, 10000, 'both instances to attach')
      const plain = relay.instances.get('dsh-multi')
      const secure = relay.instances.get('dsh-tls')
      assert.equal(plain.tls, false)
      assert.equal(secure.tls, true)

      const secureInfo = await secure.request('instance.info')
      assert.equal(secureInfo.ok, true)
      assert.match(secureInfo.result.connection.endpoint, /^https:\/\//)
      assert.equal(secureInfo.result.connection.transport, 'websocket')
      assert.equal(secureInfo.result.connection.insecure, false)

      const plainInfo = await plain.request('instance.info')
      assert.equal(plainInfo.result.connection.insecure, true, 'plain HTTP must be reported as insecure')
    } finally {
      await overHttp.close()
      await overHttps.close()
    }
  } finally {
    await relay.close()
  }
})

test('multi: connects to several endpoints at once and mirrors state to all of them', async () => {
  const key = testKey('fanout')
  const tls = await tlsFixture()
  const primary = await createRelayServer({ keys: [key], port: 0, tlsPort: 0, tlsCert: tls.cert, tlsKey: tls.key })
  const secondary = await createRelayServer({ keys: [key], port: 0 })
  const host = new FakeHost({ sessions: [{ id: 'session-a', cwd: 'C:/work/project', running: true }] })
  const peer = await startBridge({ endpoints: [primary.httpUrl, secondary.url], key, host })
  try {
    await waitFor(() => primary.instances.size === 1 && secondary.instances.size === 1, 10000, 'both relays to attach')
    const first = [...primary.instances.values()][0]
    const second = [...secondary.instances.values()][0]

    const firstInfo = await first.request('instance.info')
    const secondInfo = await second.request('instance.info')
    assert.equal(firstInfo.result.instanceId, secondInfo.result.instanceId)
    assert.deepEqual(firstInfo.result.endpoints, [primary.httpUrl, secondary.url])
    assert.equal(firstInfo.result.connections.length, 2)
    assert.deepEqual(
      firstInfo.result.connections.map((link) => link.state),
      ['connected', 'connected'],
    )
    // Each server is told which endpoint the request came in on.
    assert.equal(firstInfo.result.connection.endpoint, primary.httpUrl)
    assert.equal(secondInfo.result.connection.endpoint, secondary.url)

    // Operations work from either server and see the same machine.
    const fromFirst = await first.request('session.list')
    const fromSecond = await second.request('session.list')
    assert.equal(fromFirst.result.items[0].cwd, 'C:/work/project')
    assert.deepEqual(fromSecond.result.items, fromFirst.result.items)

    // One event, one sequence number, delivered to both.
    host.emitSessionEvent(peer.ctx, 'session-a', { type: 'tool/result', data: { mirrored: true } })
    await waitFor(
      () =>
        first.events.some((frame) => frame.data?.type === 'tool/result') &&
        second.events.some((frame) => frame.data?.type === 'tool/result'),
      8000,
      'both relays to receive the forwarded event',
    )
    const firstEvent = first.events.find((frame) => frame.data?.type === 'tool/result')
    const secondEvent = second.events.find((frame) => frame.data?.type === 'tool/result')
    assert.equal(firstEvent.seq, secondEvent.seq, 'both servers must see the same sequence number')
  } finally {
    await peer.close()
    await primary.close()
    await secondary.close()
  }
})

test('multi: subscriptions are per server', async () => {
  const key = testKey('subs')
  const primary = await createRelayServer({ keys: [key], port: 0 })
  const secondary = await createRelayServer({ keys: [key], port: 0 })
  const host = new FakeHost()
  const peer = await startBridge({
    endpoints: [primary.url, secondary.url],
    key,
    host,
    config: { autoSubscribeSessions: 'none' },
  })
  try {
    await waitFor(() => primary.instances.size === 1 && secondary.instances.size === 1, 10000, 'both relays to attach')
    const first = [...primary.instances.values()][0]
    const second = [...secondary.instances.values()][0]

    // Only the first server asks for this session's event stream.
    first.deliver({ v: 1, type: 'subscribe', id: 's1', sessions: ['session-a'], assistantStream: true })
    await waitFor(
      () => first.events.some((frame) => frame.kind === 'session/snapshot'),
      5000,
      'the subscribed server to get its baseline',
    )

    host.emitSessionEvent(peer.ctx, 'session-a')
    await waitFor(
      () => first.events.some((frame) => frame.kind === 'session/event'),
      5000,
      'the subscribed server to get the event',
    )
    assert.equal(
      second.events.some((frame) => frame.kind === 'session/event'),
      false,
      'the server that did not subscribe must not receive the stream',
    )

    const info = await first.request('instance.info')
    const [primaryLink, secondaryLink] = info.result.connections
    assert.deepEqual(primaryLink.subscriptions.sessions, ['session-a'])
    assert.deepEqual(secondaryLink.subscriptions.sessions, [])
    assert.deepEqual(primaryLink.subscriptions.assistantStreams, ['session-a'])
    assert.deepEqual(secondaryLink.subscriptions.assistantStreams, [])
  } finally {
    await peer.close()
    await primary.close()
    await secondary.close()
  }
})

test('multi: an unreachable endpoint does not stop the others', async () => {
  const key = testKey('resilient')
  const relay = await createRelayServer({ keys: [key], port: 0 })
  const host = new FakeHost()
  // Port 1 refuses immediately, so this endpoint never succeeds.
  const peer = await startBridge({ endpoints: ['http://127.0.0.1:1/dsh-api', relay.url], key, host })
  try {
    await waitFor(() => relay.instances.size === 1, 10000, 'the reachable relay to attach')
    assert.equal(peer.bridge.isConnected(), true)

    const info = await [...relay.instances.values()][0].request('instance.info')
    assert.equal(info.ok, true)
    assert.equal(info.result.connections.length, 2)
    const states = info.result.connections.map((link) => link.state)
    assert.ok(states.includes('connected'))
    assert.ok(states.includes('connecting') || states.includes('idle'))
    assert.equal(info.result.connections[0].endpoint, 'http://127.0.0.1:1/dsh-api')
    assert.ok(info.result.connections[0].lastError, 'the dead endpoint should report a connection error')

    // A drop on the reachable link recovers without touching the dead one.
    await peer.bridge.reconnect('test-induced drop')
    await waitFor(() => relay.instances.size === 1, 10000, 'the reachable relay to reattach')
    const after = await [...relay.instances.values()][0].request('instance.info')
    assert.equal(after.ok, true)
  } finally {
    await peer.close()
    await relay.close()
  }
})

test('multi: a failing endpoint in one scheme does not block the other scheme', async () => {
  const key = testKey('schemes')
  const tls = await tlsFixture()
  const relay = await createRelayServer({ keys: [key], port: 0, tlsPort: 0, tlsCert: tls.cert, tlsKey: tls.key })
  const host = new FakeHost({ sessions: [{ id: 'session-a', cwd: 'C:/work/project', running: false }] })
  // The HTTP endpoint is alive; the TLS one points at a closed port.
  const peer = await startBridge({ endpoints: ['https://127.0.0.1:1/dsh-api', relay.httpUrl], key, host })
  try {
    await waitFor(() => relay.instances.size === 1, 10000, 'the HTTP endpoint to attach')
    const instance = [...relay.instances.values()][0]
    const info = await instance.request('instance.info')
    assert.equal(info.result.connection.endpoint, relay.httpUrl)
    assert.equal(info.result.connections[0].state !== 'connected', true)
    const list = await instance.request('session.list')
    assert.equal(list.result.items[0].sessionId, 'session-a')
  } finally {
    await peer.close()
    await relay.close()
  }
})

test('multi: config accepts a single URL, a list, and a comma-separated string', () => {
  const single = validateConfig({ endpoint: 'https://a.example.com/dsh-api' })
  assert.deepEqual(single.value.endpoints, ['https://a.example.com/dsh-api'])
  const list = validateConfig({ endpoint: ['https://a.example.com/dsh-api', 'http://10.0.0.5:8787/dsh-api'] })
  assert.equal(list.value.endpoints.length, 2)
  assert.equal(list.value.endpoint, 'https://a.example.com/dsh-api')
  const csv = validateConfig({ endpoint: 'https://a.example.com/dsh-api, http://10.0.0.5:8787/dsh-api' })
  assert.deepEqual(csv.value.endpoints, ['https://a.example.com/dsh-api', 'http://10.0.0.5:8787/dsh-api'])
  const bad = validateConfig({ endpoint: ['https://ok.example.com/dsh-api', 'not-a-url'] })
  assert.ok(bad.issues?.some((issue) => issue.path?.[0] === 'endpoint'))
  const wrongType = validateConfig({ endpoint: { url: 'https://x.example.com' } })
  assert.ok(wrongType.issues?.some((issue) => issue.path?.[0] === 'endpoint'))
})
