/**
 * Unit tests for configuration, protocol, identity, buffering, gating, and the
 * operation dispatcher.
 *
 * These run against the real modules with a fake harness host, so a regression
 * in validation, envelope shape, or an operation's contract fails here rather
 * than against a live server.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Bridge } from '../lib/bridge.js'
import { EventBuffer } from '../lib/buffer.js'
import { Config, validateConfig } from '../lib/config.js'
import { SessionGate } from '../lib/gate.js'
import { Identity, generateKey, keyFingerprint, keysEqual, KEY_PREFIX } from '../lib/identity.js'
import { Logger } from '../lib/log.js'
import {
  BridgeError,
  ERROR_CODES,
  makeEvent,
  makeHello,
  makeResponse,
  parseFrame,
  toWireError,
} from '../lib/protocol.js'
import { joinUrl, parseEndpoint, toWireJson, truncate } from '../lib/util.js'
import { FakeHost } from './helpers/fake-host.js'

/** @returns {Promise<string>} a fresh temporary directory. */
async function tempDir() {
  return await mkdtemp(join(tmpdir(), 'dsh-bridge-test-'))
}

/** @returns {Record<string, any>} a validated config pointed at a placeholder endpoint. */
function testConfig(overrides = {}) {
  const result = validateConfig({ endpoint: 'https://relay.example.com/dsh-api', logLevel: 'silent', ...overrides })
  assert.equal(result.issues, undefined, JSON.stringify(result.issues))
  return result.value
}

test('config: applies defaults and tolerates an empty endpoint', () => {
  const result = validateConfig({})
  assert.equal(result.issues, undefined)
  assert.equal(result.value.endpoint, '')
  assert.equal(result.value.authMode, 'hello')
  assert.equal(result.value.transport, 'auto')
  assert.equal(result.value.locale, 'system')
  assert.equal(result.value.forwardQuestions, true)
  assert.equal(result.value.heartbeatMs, 30000)
  assert.deepEqual(result.value.autoSubscribe, ['instance', 'sessions', 'jobs', 'approvals'])
})

test('config: the standard-schema export reports issues with paths', () => {
  const outcome = Config['~standard'].validate({ transport: 'carrier-pigeon' })
  assert.ok(Array.isArray(outcome.issues))
  assert.equal(outcome.issues[0].path[0], 'transport')
})

test('config: environment fallback supplies endpoint and key', () => {
  const result = validateConfig({}, { DSH2SERVER_ENDPOINT: 'https://env.example.com/api', DSH2SERVER_KEY: 'k'.repeat(32) })
  assert.equal(result.value.endpoint, 'https://env.example.com/api')
  assert.equal(result.value.key, 'k'.repeat(32))
})

test('config: rejects a short explicit key and unknown auto-subscribe topics', () => {
  const shortKey = validateConfig({ key: 'too-short' })
  assert.ok(shortKey.issues.some((issue) => issue.path?.[0] === 'key'))
  const badTopic = validateConfig({ autoSubscribe: ['sessions', 'nonsense'] })
  assert.ok(badTopic.issues.some((issue) => issue.path?.[0] === 'autoSubscribe'))
  const badLocale = validateConfig({ locale: 'fr-FR' })
  assert.ok(badLocale.issues.some((issue) => issue.path?.[0] === 'locale'))
})

test('util: endpoint parsing accepts http(s) and ws(s) with and without a path', () => {
  const https = parseEndpoint('https://example.com/dsh-api/')
  assert.deepEqual(https, {
    ok: true,
    http: 'https://example.com/dsh-api',
    ws: 'wss://example.com/dsh-api',
    origin: 'https://example.com',
    path: '/dsh-api',
  })
  assert.equal(parseEndpoint('wss://example.com/dsh-api').http, 'https://example.com/dsh-api')
  assert.equal(parseEndpoint('http://127.0.0.1:8080').ws, 'ws://127.0.0.1:8080')
  assert.equal(parseEndpoint('ftp://example.com').ok, false)
  assert.equal(parseEndpoint('').ok, false)
  assert.equal(joinUrl('https://example.com/dsh-api', '/ws'), 'https://example.com/dsh-api/ws')
})

test('util: oversized payloads are reported rather than thrown', () => {
  const big = { text: 'x'.repeat(64) }
  assert.equal(toWireJson(big, { maxBytes: 16 }).ok, false)
  assert.equal(toWireJson(big).ok, true)
  const cyclic = {}
  cyclic.self = cyclic
  assert.equal(toWireJson(cyclic).ok, false)
  assert.equal(truncate('abcdef', 4), 'abc…')
})

test('protocol: envelopes carry the protocol version and the instance key only in hello', () => {
  const hello = makeHello({
    instanceId: 'dsh-1',
    ts: 1,
    instance: {},
    capabilities: {},
    key: 'dshk_secret',
    lastSeq: 0,
    resumeFromSeq: 0,
  })
  assert.equal(hello.v, 1)
  assert.deepEqual(hello.auth, { type: 'instance-key', key: 'dshk_secret', instanceId: 'dsh-1' })

  const event = makeEvent({ seq: 4, topic: 'sessions', kind: 'session/status', ts: 1, data: { running: true }, sessionId: 's' })
  assert.equal(event.seq, 4)
  assert.equal(event.sessionId, 's')
  assert.equal(Object.hasOwn(event, 'auth'), false)

  const response = makeResponse('r1', { accepted: true })
  assert.deepEqual(response, { v: 1, type: 'response', id: 'r1', ok: true, result: { accepted: true } })
})

test('protocol: frame parsing rejects junk and version drift', () => {
  assert.equal(parseFrame('nope').ok, false)
  assert.equal(parseFrame({ type: 'request' }).ok, true)
  assert.equal(parseFrame({ type: 'request', v: 99 }).ok, false)
  const wire = toWireError(new BridgeError(ERROR_CODES.NOT_FOUND, 'missing', { retryable: true, details: { id: 1 } }))
  assert.deepEqual(wire, { code: 'not_found', message: 'missing', retryable: true, details: { id: 1 } })
  assert.equal(toWireError(new Error('boom')).code, ERROR_CODES.INTERNAL)
})

test('identity: generates, persists, reloads, and rotates a stable key', async () => {
  const dir = await tempDir()
  try {
    const keyFile = join(dir, 'identity.json')
    const logger = new Logger('silent')
    const first = await new Identity({ keyFile, logger }).load()
    assert.ok(first.key.startsWith(KEY_PREFIX))
    assert.ok(first.generated)
    assert.equal(first.persistenceWarning, undefined)
    // The key is never logged in full by accident: the fingerprint is short.
    assert.ok(keyFingerprint(first.key).includes('…'))
    assert.ok(!keyFingerprint(first.key).includes(first.key))

    const second = await new Identity({ keyFile, logger }).load()
    assert.equal(second.key, first.key)
    assert.equal(second.instanceId, first.instanceId)
    assert.equal(second.generated, false)

    const document = JSON.parse(await readFile(keyFile, 'utf8'))
    assert.equal(document.key, first.key)
    assert.equal(document.version, 1)

    const rotated = await second.rotate()
    assert.notEqual(rotated, first.key)
    const third = await new Identity({ keyFile, logger }).load()
    assert.equal(third.key, rotated)
    assert.ok(keysEqual(third.key, rotated))
    assert.equal(keysEqual(rotated, first.key), false)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('identity: an explicitly configured key is never generated over', async () => {
  const dir = await tempDir()
  try {
    const keyFile = join(dir, 'identity.json')
    const logger = new Logger('silent')
    const identity = await new Identity({ keyFile, explicitKey: 'operator-supplied-key-1234', logger }).load()
    assert.equal(identity.key, 'operator-supplied-key-1234')
    assert.equal(identity.shouldAnnounceKey, false)
    await assert.rejects(() => identity.rotate(), /supplied by configuration/)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('identity: an unwritable key file degrades instead of failing', async () => {
  const logger = new Logger('silent')
  // A path whose parent is a file, not a directory, cannot be created.
  const dir = await tempDir()
  try {
    const identity = await new Identity({ keyFile: join(dir, 'identity.json', 'nested.json'), logger }).load()
    assert.ok(identity.key.startsWith(KEY_PREFIX) || identity.persistenceWarning !== undefined)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('buffer: keeps a bounded window and knows when a resume is impossible', () => {
  const buffer = new EventBuffer(3)
  for (let seq = 1; seq <= 5; seq += 1) buffer.push({ seq, type: 'event' })
  assert.equal(buffer.items.length, 3)
  assert.equal(buffer.dropped, 2)
  assert.equal(buffer.lastSeq, 5)
  assert.deepEqual(buffer.since(3).map((frame) => frame.seq), [4, 5])
  assert.equal(buffer.canResumeFrom(2), true)
  assert.equal(buffer.canResumeFrom(1), false)
  assert.equal(buffer.canResumeFrom(0), true)
})

test('gate: pauses a session, parks prompts, and replays them on resume', async () => {
  const delivered = []
  const gate = new SessionGate({
    logger: new Logger('silent'),
    limit: 2,
    ensureAgent: async () => ({ status: 'running', cancel: () => delivered.push({ method: 'cancel' }) }),
    getGoal: async () => ({ goal: { phase: 'active' } }),
    goalAction: async (action) => delivered.push({ method: `goal:${action}` }),
    deliver: async (sessionId, prompt) => delivered.push({ method: 'prompt', sessionId, prompt }),
  })

  const pause = await gate.pause('session-a')
  assert.equal(pause.paused, true)
  assert.equal(pause.interrupted, true)
  assert.equal(pause.goalPaused, true)
  assert.ok(delivered.some((entry) => entry.method === 'cancel'))
  assert.ok(delivered.some((entry) => entry.method === 'goal:pause'))

  assert.deepEqual(gate.park('session-a', { requestId: 'r1' }), { queued: true, position: 1 })
  assert.deepEqual(gate.park('session-a', { requestId: 'r2' }), { queued: true, position: 2 })
  assert.equal(gate.park('session-a', { requestId: 'r3' }).queued, false)
  assert.equal(gate.queuedCount('session-a'), 2)

  const resume = await gate.resume('session-a')
  assert.equal(resume.paused, false)
  assert.equal(resume.delivered, 2)
  assert.ok(delivered.some((entry) => entry.method === 'goal:resume'))
  assert.equal(gate.isPaused('session-a'), false)
})

test('operations: unknown methods and bad parameters fail with stable codes', async () => {
  const host = new FakeHost()
  const ctx = host.context()
  const bridge = new Bridge({ ctx, config: testConfig(), identity: await identity(), logger: new Logger('silent') })

  const unknown = await bridge.operations.dispatch('nope.nope', {}, { signal: new AbortController().signal })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, ERROR_CODES.UNKNOWN_METHOD)
  assert.ok(unknown.error.details.methods.includes('session.prompt'))

  const badParams = await bridge.operations.dispatch('session.prompt', { sessionId: 'session-a' }, { signal: new AbortController().signal })
  assert.equal(badParams.ok, false)
  assert.equal(badParams.error.code, ERROR_CODES.INVALID_PARAMS)

  const refused = await bridge.operations.dispatch('command.run', { sessionId: 'session-a', line: 'pnpm test' }, { signal: new AbortController().signal })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, ERROR_CODES.INVALID_PARAMS)
})

test('operations: session lifecycle, prompts, pause/resume, jobs, goals, and commands', async () => {
  const host = new FakeHost()
  const ctx = host.context()
  const config = testConfig({ pauseQueueLimit: 4 })
  const bridge = new Bridge({ ctx, config, identity: await identity(), logger: new Logger('silent') })
  const signal = new AbortController().signal
  const run = (method, params) => bridge.operations.dispatch(method, params, { signal })

  const list = await run('session.list', {})
  assert.equal(list.ok, true)
  assert.equal(list.result.items.length, 1)
  assert.equal(list.result.items[0].cwd, 'C:/work/project')
  assert.equal(list.result.items[0].running, true)

  const detail = await run('session.get', { sessionId: 'session-a' })
  assert.equal(detail.ok, true)
  assert.equal(detail.result.paused, false)
  assert.deepEqual(detail.result.projections.values.todos, [{ id: 't1', text: 'ship it', status: 'pending' }])

  const prompt = await run('session.prompt', { sessionId: 'session-a', text: 'run the tests' })
  assert.equal(prompt.ok, true)
  assert.equal(prompt.result.accepted, true)
  assert.equal(host.prompts.length, 1)
  assert.deepEqual(host.prompts[0].content, [{ type: 'text', text: 'run the tests' }])
  assert.equal(host.sessions.get('session-a').agent.calls.at(-1).method, 'followup')

  const steer = await run('session.prompt', { sessionId: 'session-a', text: 'also lint', mode: 'steer' })
  assert.equal(steer.ok, true)
  assert.equal(host.sessions.get('session-a').agent.calls.at(-1).method, 'steer')

  const interrupt = await run('session.interrupt', { sessionId: 'session-a' })
  assert.equal(interrupt.ok, true)
  assert.equal(host.cancels.length, 1)

  // Pause aborts the turn and parks the prompt; resume replays it.
  host.sessions.get('session-a').agent.status = 'running'
  const paused = await run('session.pause', { sessionId: 'session-a' })
  assert.equal(paused.result.paused, true)
  const deferred = await run('session.prompt', { sessionId: 'session-a', text: 'after resume' })
  assert.equal(deferred.result.deferred, true)
  assert.equal(deferred.result.position, 1)
  assert.equal(host.prompts.length, 2)
  const resumed = await run('session.resume', { sessionId: 'session-a' })
  assert.equal(resumed.result.delivered, 1)
  assert.equal(host.prompts.length, 3)
  assert.deepEqual(host.prompts.at(-1).content, [{ type: 'text', text: 'after resume' }])

  const created = await run('session.create', { cwd: 'C:/work/other' })
  assert.equal(created.ok, true)
  assert.ok(host.sessions.has(created.result.sessionId))

  const jobs = await run('job.list', { sessionId: 'session-a' })
  assert.equal(jobs.result.items[0].id, 'bash-1')
  const killed = await run('job.kill', { jobId: 'bash-1', sessionId: 'session-a' })
  assert.equal(killed.result.result, 'requested')

  host.goal = { id: 'g1', revision: 1, phase: 'active', objective: 'ship', maxGoalRounds: 3 }
  const goalPause = await run('goal.pause', { sessionId: 'session-a' })
  assert.equal(goalPause.result.goal.phase, 'paused')
  const goalGet = await run('goal.get', { sessionId: 'session-a' })
  assert.equal(goalGet.result.goal.id, 'g1')

  const commands = await run('command.list', { sessionId: 'session-a' })
  assert.equal(commands.result.items[0].name, 'compact')
  const executed = await run('command.run', { sessionId: 'session-a', line: '/compact' })
  assert.equal(executed.ok, true)
  assert.equal(host.commandRuns.length, 1)

  const policy = await run('session.approvalPolicy', { sessionId: 'session-a', policy: 'never' })
  assert.equal(policy.result.policy, 'never')
  assert.equal(host.approvalPolicy, 'never')

  const policyRead = await run('session.approvalPolicy', { sessionId: 'session-a' })
  assert.equal(policyRead.result.policy, 'never')

  const workspaces = await run('workspace.list', {})
  assert.equal(workspaces.result.source, 'workspace-registry')
  assert.equal(workspaces.result.items[0].path, 'C:/work/project')
})

test('operations: session.get returns the controller cut and projections for a cold session', async () => {
  const host = new FakeHost()
  const coldSummary = {
    sessionId: 'session-cold',
    updatedAt: 123,
    running: false,
    blank: false,
    cwd: 'C:/work/project',
    projections: {
      asOfSeq: 49,
      values: {
        agentPreset: 'standard',
        modelSelection: { next: { provider: 'fake', model: 'fake-model', reasoningEffort: 'high' } },
        inbox: { 'next-turn': [{ id: 'queued' }], 'next-step': [] },
      },
    },
  }
  const sessionController = {
    ...host.services.sessionController,
    list: async () => ({ items: [coldSummary] }),
  }
  const ctx = host.context({
    sessions: { list: () => [], get: () => undefined },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    sessionController,
  })
  const bridge = new Bridge({ ctx, config: testConfig(), identity: await identity(), logger: new Logger('silent') })

  const detail = await bridge.operations.dispatch(
    'session.get',
    { sessionId: 'session-cold' },
    { signal: new AbortController().signal },
  )

  assert.equal(detail.ok, true)
  assert.equal(detail.result.attached, false)
  assert.equal(detail.result.status, 'detached')
  assert.equal(detail.result.header.cwd, 'C:/work/project')
  assert.equal(detail.result.seq, 49)
  assert.equal(detail.result.projections.asOfSeq, 49)
  assert.equal(detail.result.model.model, 'fake-model')
  assert.deepEqual(detail.result.pending, { nextTurn: 1, nextStep: 0 })
})

test('operations: cwd allowlist blocks a session outside the configured prefixes', async () => {
  const host = new FakeHost({ sessions: [{ id: 'session-x', cwd: 'D:/private/secret', running: false }] })
  const ctx = host.context()
  const bridge = new Bridge({
    ctx,
    config: testConfig({ allowedCwdPrefixes: ['C:/work'] }),
    identity: await identity(),
    logger: new Logger('silent'),
  })
  const signal = new AbortController().signal
  const list = await bridge.operations.dispatch('session.list', {}, { signal })
  assert.deepEqual(list.result.items, [])
  const prompt = await bridge.operations.dispatch('session.prompt', { sessionId: 'session-x', text: 'hi' }, { signal })
  assert.equal(prompt.ok, false)
  assert.equal(prompt.error.code, ERROR_CODES.FORBIDDEN)
})

test('operations: disabled capabilities are refused explicitly', async () => {
  const host = new FakeHost()
  const ctx = host.context()
  const bridge = new Bridge({
    ctx,
    config: testConfig({ allowRemotePrompt: false, allowRemoteControl: false }),
    identity: await identity(),
    logger: new Logger('silent'),
  })
  const signal = new AbortController().signal
  const prompt = await bridge.operations.dispatch('session.prompt', { sessionId: 'session-a', text: 'hi' }, { signal })
  assert.equal(prompt.error.code, ERROR_CODES.DISABLED)
  const interrupt = await bridge.operations.dispatch('session.interrupt', { sessionId: 'session-a' }, { signal })
  assert.equal(interrupt.error.code, ERROR_CODES.DISABLED)
  const approval = await bridge.operations.dispatch('approval.respond', { requestId: 'r', outcome: 'allowed-once' }, { signal })
  assert.equal(approval.error.code, ERROR_CODES.DISABLED)
})

test('operations: a composition without the session controller degrades to the live store', async () => {
  const host = new FakeHost()
  const ctx = host.context({ sessionController: undefined, workspaceRegistry: undefined })
  const bridge = new Bridge({ ctx, config: testConfig(), identity: await identity(), logger: new Logger('silent') })
  const signal = new AbortController().signal
  const list = await bridge.operations.dispatch('session.list', {}, { signal })
  assert.equal(list.ok, true)
  assert.equal(list.result.items[0].sessionId, 'session-a')

  const prompt = await bridge.operations.dispatch('session.prompt', { sessionId: 'session-a', text: 'fallback' }, { signal })
  assert.equal(prompt.ok, true)
  const message = host.sessions.get('session-a').agent.calls.at(-1).message
  assert.equal(message.role, 'user')
  assert.deepEqual(message.content, [{ type: 'text', text: 'fallback' }])

  const workspaces = await bridge.operations.dispatch('workspace.list', {}, { signal })
  assert.equal(workspaces.result.source, 'session-cwd')
  assert.deepEqual(workspaces.result.items[0].sessionIds, ['session-a'])

  const rename = await bridge.operations.dispatch('session.rename', { sessionId: 'session-a', title: 'x' }, { signal })
  assert.equal(rename.error.code, ERROR_CODES.CAPABILITY_UNAVAILABLE)
})

/** @returns {Promise<Identity>} a throwaway identity for dispatcher tests. */
async function identity() {
  const dir = await tempDir()
  const identity = await new Identity({ keyFile: join(dir, 'identity.json'), logger: new Logger('silent') }).load()
  identity.__dir = dir
  return identity
}

test.after(async () => {
  await rm(join(tmpdir(), 'dsh-bridge-test-'), { recursive: true, force: true })
})

test('identity: generated keys are unique across instances', () => {
  const keys = new Set(Array.from({ length: 50 }, () => generateKey()))
  assert.equal(keys.size, 50)
})
