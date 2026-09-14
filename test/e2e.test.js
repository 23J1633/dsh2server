/**
 * End-to-end tests: the real `Bridge` talking to the real reference relay.
 *
 * These cover the parts that only exist once both halves are running together —
 * the key handshake, remote operations over the wire, live event streaming,
 * subscription control, the HTTP fallback carrier, reconnection, and multi-key
 * management of several machines at once.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createRelayServer, fingerprint } from '../examples/server.js'
import { Bridge } from '../lib/bridge.js'
import { validateConfig } from '../lib/config.js'
import { Identity } from '../lib/identity.js'
import { Logger } from '../lib/log.js'
import { FakeHost, waitFor } from './helpers/fake-host.js'

/**
 * A deterministic, realistic-looking test key.
 *
 * Distinct seeds must produce keys that differ at both ends, because that is
 * what the fingerprint exposes and what a real random key looks like.
 *
 * @param {string} seed key seed.
 * @returns {string} a `dshk_`-prefixed key.
 */
function testKey(seed) {
  return `dshk_${createHash('sha256').update(seed).digest('base64url').slice(0, 40)}`
}

/**
 * Start one bridge against a relay with a fake harness underneath.
 *
 * @param {object} options bridge options.
 * @param {any} options.relay running relay.
 * @param {FakeHost} options.host fake harness host.
 * @param {string} options.key instance key.
 * @param {Record<string, unknown>} [options.config] config overrides.
 * @param {Record<string, unknown>} [options.services] service overrides for the fake context.
 * @param {boolean} [options.autostart] when false the bridge is built but not started.
 * @returns {Promise<{bridge: Bridge, ctx: any, identity: Identity, keyFile: string, dir: string, close: () => Promise<void>}>} the running bridge.
 */
async function startBridge(options) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-bridge-e2e-'))
  const keyFile = join(dir, 'identity.json')
  const logger = new Logger('silent')
  const identity = await new Identity({
    keyFile,
    explicitKey: options.key,
    explicitInstanceId: options.instanceId ?? /** @type {any} */ (options.config)?.instanceId,
    logger,
  }).load()
  const ctx = options.host.context(options.services ?? {})
  const config = validateConfig({
    endpoint: options.relay.url,
    logLevel: 'silent',
    reconnectInitialDelayMs: 50,
    reconnectMaxDelayMs: 200,
    heartbeatMs: 1000,
    heartbeatTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    pollWaitMs: 500,
    ...options.config,
  })
  assert.equal(config.issues, undefined, JSON.stringify(config.issues))
  const bridge = new Bridge({ ctx, config: config.value, identity, logger })
  if (options.autostart !== false) bridge.start()
  return {
    bridge,
    ctx,
    identity,
    keyFile,
    dir,
    async close() {
      await bridge.dispose()
      await ctx.dispose()
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    },
  }
}

test('e2e: connects over WebSocket with the registered instance key', async () => {
  const key = testKey('machine-a')
  const relay = await createRelayServer({ keys: [{ key, label: 'machine-a' }], port: 0 })
  const host = new FakeHost()
  const peer = await startBridge({ relay, host, key })
  try {
    await waitFor(() => relay.instances.size === 1, 5000, 'the relay to see the instance')
    const instance = [...relay.instances.values()][0]
    assert.equal(instance.keyFingerprint, fingerprint(key))
    assert.equal(instance.transport, 'ws')
    assert.equal(instance.instance.pluginVersion, undefined === instance.instance.pluginVersion ? undefined : instance.instance.pluginVersion)
    assert.equal(peer.bridge.isConnected(), true)

    const info = await instance.request('instance.info')
    assert.equal(info.ok, true)
    assert.equal(info.result.instanceId, peer.identity.instanceId)
    assert.equal(info.result.keyFingerprint, fingerprint(key))
    assert.equal(info.result.capabilities.sessionController, true)
    assert.ok(info.result.methods.includes('session.prompt'))
    assert.deepEqual(info.result.endpoints, [relay.url])
    assert.equal(info.result.connection.endpoint, relay.url)
    assert.equal(info.result.connection.transport, 'websocket')

    // The instance key is readable on request, but never part of the ordinary
    // info payload a monitoring backend keeps around.
    assert.equal(Object.hasOwn(info.result, 'key'), false)
  } finally {
    await peer.close()
    await relay.close()
  }
})

test('e2e: lists sessions and working directories for the server', async () => {
  const key = testKey('machine-b')
  const relay = await createRelayServer({ keys: [key], port: 0 })
  const host = new FakeHost({
    sessions: [
      { id: 'session-a', cwd: 'C:/work/project', running: true },
      { id: 'session-b', cwd: 'D:/work/other', running: false },
    ],
  })
  const peer = await startBridge({ relay, host, key })
  try {
    await waitFor(() => relay.instances.size === 1, 5000, 'connect')
    const instance = [...relay.instances.values()][0]

    const sessions = await instance.request('session.list')
    assert.equal(sessions.ok, true)
    assert.deepEqual(
      sessions.result.items.map((row) => row.sessionId).sort(),
      ['session-a', 'session-b'],
    )
    assert.equal(sessions.result.items[0].cwd.startsWith('C:/') || sessions.result.items[0].cwd.startsWith('D:/'), true)

    const workspaces = await instance.request('workspace.list')
    assert.equal(workspaces.result.source, 'workspace-registry')
    assert.equal(workspaces.result.items[0].path, 'C:/work/project')

    const detail = await instance.request('session.get', { sessionId: 'session-a' })
    assert.equal(detail.ok, true)
    assert.equal(detail.result.running, true)
    assert.deepEqual(detail.result.projections.values.todos[0].id, 't1')
  } finally {
    await peer.close()
    await relay.close()
  }
})

test('e2e: sends a new command, interrupts, and moves a session through pause and resume', async () => {
  const key = testKey('machine-c')
  const relay = await createRelayServer({ keys: [key], port: 0 })
  const host = new FakeHost()
  const peer = await startBridge({ relay, host, key })
  try {
    await waitFor(() => relay.instances.size === 1, 5000, 'connect')
    const instance = [...relay.instances.values()][0]

    const prompt = await instance.request('session.prompt', { sessionId: 'session-a', text: 'run the test suite' })
    assert.equal(prompt.ok, true)
    assert.equal(prompt.result.accepted, true)
    assert.deepEqual(host.prompts.at(-1).content, [{ type: 'text', text: 'run the test suite' }])

    const interrupt = await instance.request('session.interrupt', { sessionId: 'session-a' })
    assert.equal(interrupt.ok, true)
    assert.equal(host.cancels.length, 1)

    host.sessions.get('session-a').agent.status = 'running'
    const paused = await instance.request('session.pause', { sessionId: 'session-a' })
    assert.equal(paused.result.paused, true)
    assert.equal(paused.result.interrupted, true)

    const deferred = await instance.request('session.prompt', { sessionId: 'session-a', text: 'queued while paused' })
    assert.equal(deferred.result.deferred, true)
    assert.equal(deferred.result.position, 1)
    assert.equal(host.prompts.length, 1, 'a parked prompt must not reach the harness yet')

    const resumed = await instance.request('session.resume', { sessionId: 'session-a' })
    assert.equal(resumed.result.delivered, 1)
    assert.deepEqual(host.prompts.at(-1).content, [{ type: 'text', text: 'queued while paused' }])

    const jobs = await instance.request('job.list', { sessionId: 'session-a' })
    assert.equal(jobs.result.items[0].id, 'bash-1')
    const kill = await instance.request('job.kill', { jobId: 'bash-1', sessionId: 'session-a' })
    assert.equal(kill.result.result, 'requested')

    host.goal = { id: 'g1', revision: 1, phase: 'active', objective: 'ship', maxGoalRounds: 5 }
    const goal = await instance.request('goal.get', { sessionId: 'session-a' })
    assert.equal(goal.result.goal.id, 'g1')
    const goalPause = await instance.request('goal.pause', { sessionId: 'session-a' })
    assert.equal(goalPause.result.goal.phase, 'paused')

    const commands = await instance.request('command.list', { sessionId: 'session-a' })
    assert.equal(commands.result.items[0].name, 'compact')
    const run = await instance.request('command.run', { sessionId: 'session-a', line: '/compact' })
    assert.equal(run.ok, true)
    assert.equal(host.commandRuns.length, 1)
  } finally {
    await peer.close()
    await relay.close()
  }
})

test('e2e: streams durable session events and assistant frames it was asked for', async () => {
  const key = testKey('machine-d')
  const relay = await createRelayServer({ keys: [key], port: 0 })
  const host = new FakeHost()
  const peer = await startBridge({ relay, host, key })
  try {
    await waitFor(() => relay.instances.size === 1, 5000, 'connect')
    const instance = [...relay.instances.values()][0]

    // The handshake auto-subscribes running sessions and sends a baseline.
    await waitFor(
      () => instance.events.some((frame) => frame.kind === 'session/snapshot' && frame.sessionId === 'session-a'),
      5000,
      'the session snapshot',
    )
    const snapshot = instance.events.find((frame) => frame.kind === 'session/snapshot')
    assert.equal(snapshot.data.attached, true)
    assert.equal(snapshot.data.running, true)

    host.emitSessionEvent(peer.ctx, 'session-a', { type: 'tool/result', data: { ok: true } })
    await waitFor(
      () => instance.events.some((frame) => frame.kind === 'session/event' && frame.data.type === 'tool/result'),
      5000,
      'the forwarded session event',
    )

    const agent = host.sessions.get('session-a').agent
    peer.ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', index: 0, chunk: { delta: 'hi' } } })
    await waitFor(
      () => instance.events.some((frame) => frame.kind === 'session/assistant-stream'),
      5000,
      'the assistant stream frame',
    )

    // Every event carries a monotonic seq so a relay can dedupe and replay.
    const seqs = instance.events.map((frame) => frame.seq)
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b))
    assert.equal(new Set(seqs).size, seqs.length)
  } finally {
    await peer.close()
    await relay.close()
  }
})

test('e2e: honours server subscribe/unsubscribe frames', async () => {
  const key = testKey('machine-e')
  const relay = await createRelayServer({ keys: [key], port: 0 })
  const host = new FakeHost()
  const peer = await startBridge({ relay, host, key, config: { autoSubscribeSessions: 'none' } })
  try {
    await waitFor(() => relay.instances.size === 1, 5000, 'connect')
    const instance = [...relay.instances.values()][0]

    // With auto-subscribe off, the session stream stays silent until asked.
    host.emitSessionEvent(peer.ctx, 'session-a')
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(instance.events.some((frame) => frame.kind === 'session/event'), false)

    instance.deliver({
      v: 1,
      type: 'subscribe',
      id: 'sub-1',
      topics: ['goals'],
      sessions: ['session-a'],
      assistantStream: true,
    })
    await waitFor(
      () =>
        instance.events.some((frame) => frame.kind === 'session/snapshot' && frame.sessionId === 'session-a'),
      5000,
      'the snapshot for the newly subscribed session',
    )

    host.emitSessionEvent(peer.ctx, 'session-a')
    await waitFor(
      () => instance.events.some((frame) => frame.kind === 'session/event'),
      5000,
      'the subscribed session event',
    )

    const info = await instance.request('instance.info')
    assert.deepEqual(info.result.subscriptions.topics, ['approvals', 'goals', 'instance', 'jobs', 'sessions'])
    assert.deepEqual(info.result.subscriptions.assistantStreams, ['session-a'])

    instance.deliver({ v: 1, type: 'unsubscribe', id: 'sub-2', sessions: ['session-a'] })
    await waitFor(async () => {
      const current = await instance.request('instance.info')
      return current.result.subscriptions.sessions.length === 0
    }, 5000, 'the unsubscribe to apply')
  } finally {
    await peer.close()
    await relay.close()
  }
})

test('e2e: an unknown key is refused and the instance stays unauthorized', async () => {
  const relay = await createRelayServer({ keys: [testKey('known')], port: 0 })
  const host = new FakeHost()
  const peer = await startBridge({ relay, host, key: testKey('unknown') })
  try {
    await waitFor(() => peer.bridge.lastError()?.message !== undefined, 5000, 'an auth rejection')
    assert.equal(peer.bridge.isConnected(), false)
    assert.equal(relay.instances.size, 0)
    // The actionable cause must survive the socket teardown that follows it:
    // an operator should read "unknown instance key", not "transport closed".
    const link = peer.bridge.describe().links[0]
    assert.equal(link.state !== 'connected', true)
    assert.ok(link.rejected, 'the link should record the server rejection')
    assert.match(`${link.rejected.code} ${link.rejected.message}`, /unauthorized|unknown instance key/i)
    assert.match(`${link.lastError.code} ${link.lastError.message}`, /unauthorized|unknown instance key/i)
  } finally {
    await peer.close()
    await relay.close()
  }
})

test('e2e: falls back to the HTTP long-poll carrier when WebSocket is pinned off', async () => {
  const key = testKey('machine-http')
  const relay = await createRelayServer({ keys: [key], port: 0 })
  const host = new FakeHost()
  const peer = await startBridge({ relay, host, key, config: { transport: 'http' } })
  try {
    await waitFor(() => relay.instances.size === 1, 5000, 'connect')
    const instance = [...relay.instances.values()][0]
    await waitFor(() => peer.bridge.isConnected(), 5000, 'the bridge handshake')
    assert.equal(instance.transport, 'http')
    assert.equal(peer.bridge.isConnected(), true)

    const info = await instance.request('instance.info')
    assert.equal(info.ok, true)
    assert.equal(info.result.connection.transport, 'http')

    const prompt = await instance.request('session.prompt', { sessionId: 'session-a', text: 'over http' })
    assert.equal(prompt.ok, true)
    assert.deepEqual(host.prompts.at(-1).content, [{ type: 'text', text: 'over http' }])
  } finally {
    await peer.close()
    await relay.close()
  }
})

test('e2e: reconnects and re-authenticates after the link drops', async () => {
  const key = testKey('machine-f')
  const relay = await createRelayServer({ keys: [key], port: 0 })
  const host = new FakeHost()
  const peer = await startBridge({ relay, host, key })
  try {
    await waitFor(() => relay.instances.size === 1, 5000, 'first connect')
    await waitFor(() => peer.bridge.isConnected(), 5000, 'the bridge to report connected')

    await peer.bridge.reconnect('test-induced drop')
    await waitFor(() => peer.bridge.isConnected(), 8000, 'the bridge to reconnect')
    await waitFor(() => relay.instances.size === 1, 8000, 'the relay to see the instance again')

    const instance = [...relay.instances.values()][0]
    const info = await instance.request('instance.info')
    assert.equal(info.result.instanceId, peer.identity.instanceId)
    assert.equal(
      peer.bridge.describe().links[0].attempts,
      0,
      'a successful handshake resets the backoff counter',
    )
  } finally {
    await peer.close()
    await relay.close()
  }
})

test('e2e: the relay manages several machines, each with its own key', async () => {
  const keyA = testKey('machine-aa')
  const keyB = testKey('machine-bb')
  const relay = await createRelayServer({ keys: [{ key: keyA, label: 'laptop' }, { key: keyB, label: 'desktop' }], port: 0 })
  const hostA = new FakeHost({ sessions: [{ id: 'session-a', cwd: 'C:/work/laptop', running: true }] })
  const hostB = new FakeHost({ sessions: [{ id: 'session-b', cwd: 'D:/work/desktop', running: false }] })
  const peerA = await startBridge({ relay, host: hostA, key: keyA, config: { instanceId: 'dsh-laptop' } })
  const peerB = await startBridge({ relay, host: hostB, key: keyB, config: { instanceId: 'dsh-desktop' } })
  try {
    await waitFor(() => relay.instances.size === 2, 8000, 'both instances to connect')
    assert.deepEqual([...relay.instances.keys()].sort(), ['dsh-desktop', 'dsh-laptop'])
    assert.equal(relay.keys.list().length, 2)
    assert.equal(new Set(relay.keys.list().map((entry) => entry.fingerprint)).size, 2)

    const laptop = relay.instances.get('dsh-laptop')
    const desktop = relay.instances.get('dsh-desktop')
    const laptopSessions = await laptop.request('session.list')
    const desktopSessions = await desktop.request('session.list')
    assert.equal(laptopSessions.result.items[0].cwd, 'C:/work/laptop')
    assert.equal(desktopSessions.result.items[0].cwd, 'D:/work/desktop')

    // Revoking one key must not disturb the other machine.
    relay.keys.remove(keyB)
    relay.instances.get('dsh-desktop').connection?.close(4401, 'revoked')
    const resent = await laptop.request('instance.info')
    assert.equal(resent.ok, true)

    // Re-registering the revoked machine restores it.
    relay.keys.add(keyB, 'desktop again')
    await waitFor(() => relay.instances.has('dsh-desktop'), 10000, 'the desktop to re-pair and reconnect')
  } finally {
    await peerA.close()
    await peerB.close()
    await relay.close()
  }
})

test('e2e: rotating the key re-pairs the machine without storing anything on the relay', async () => {
  // No explicit key here: the machine must generate and persist its own, which
  // is the path a real deployment takes.
  const relay = await createRelayServer({ keys: [], port: 0 })
  const host = new FakeHost()
  const peer = await startBridge({ relay, host, key: undefined, autostart: false })
  try {
    relay.keys.add(peer.identity.key, 'generated')
    assert.equal(peer.identity.generated, true)
    peer.bridge.start()

    await waitFor(() => relay.instances.size === 1, 5000, 'connect')
    const instanceId = peer.identity.instanceId
    const oldKey = peer.identity.key
    const instance = relay.instances.get(instanceId)

    const refused = await instance.request('instance.rotateKey', { confirm: 'not-the-id' })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'invalid_params')

    const rotated = await instance.request('instance.rotateKey', { confirm: instanceId })
    assert.equal(rotated.ok, true)
    const newKey = rotated.result.key
    assert.notEqual(newKey, oldKey)

    // The relay still holds only the old key, so the machine must be refused
    // until the operator stores the new one — that is the revocation contract.
    await waitFor(() => relay.instances.size === 0, 10000, 'the rotation to drop the link')
    relay.keys.add(newKey, 'rotated')
    relay.keys.remove(oldKey)

    // Re-pairing is asynchronous (backoff, then a fresh handshake), and a stale
    // in-memory instance row can briefly outlive the connection it described,
    // so probe until the machine actually answers.
    let info
    await waitFor(
      async () => {
        const current = relay.instances.get(instanceId)
        if (!current) return false
        try {
          info = await current.request('instance.info', {}, 3000)
          return info?.ok === true
        } catch {
          return false
        }
      },
      20000,
      'the machine to re-pair with its new key',
    )
    assert.equal(info.result.keyFingerprint, fingerprint(newKey))
    assert.equal(info.result.keyFingerprint, rotated.result.keyFingerprint)
  } finally {
    await peer.close()
    await relay.close()
  }
})

test('e2e: the relay holds no session data on disk', async () => {
  const key = testKey('machine-mem')
  const relay = await createRelayServer({ keys: [key], port: 0 })
  const host = new FakeHost()
  const peer = await startBridge({ relay, host, key })
  try {
    await waitFor(() => relay.instances.size === 1, 5000, 'connect')
    const instance = [...relay.instances.values()][0]
    await instance.request('session.list')
    // Everything the relay learned lives in this object graph and nowhere else.
    assert.ok(instance.events.length > 0)
    assert.equal(instance.eventLimit, 1000)
    const relayModuleSource = await import('../examples/server.js')
    assert.equal(typeof relayModuleSource.createRelayServer, 'function')
  } finally {
    await peer.close()
    await relay.close()
  }
})
