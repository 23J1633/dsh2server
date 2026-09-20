/**
 * Tests for the server-side capability extensions (PLUGIN-EXT.md): the raw
 * event window, message feedback, permission presets, attachments, workspace
 * mutation, the read-only file browser, and plugin management.
 *
 * These run the real dispatcher and host adapter against the fake harness, so a
 * regression in a method's contract, a capability bit, or the mapping between
 * the protocol's vocabulary and the deployment's own fails here.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Bridge } from '../lib/bridge.js'
import { HostAdapter, permissionProtocolId, wireSessionEvent } from '../lib/host.js'
import { validateConfig } from '../lib/config.js'
import { EventForwarder } from '../lib/forward.js'
import { Identity, generateKey } from '../lib/identity.js'
import { Logger } from '../lib/log.js'
import { toolIntentFromArguments } from '../lib/util.js'
import { FakeHost } from './helpers/fake-host.js'

/** @returns {Record<string, any>} a validated config pointed at a placeholder endpoint. */
function testConfig(overrides = {}) {
  const result = validateConfig({ endpoint: 'https://relay.example.com/dsh-api', logLevel: 'silent', ...overrides })
  assert.equal(result.issues, undefined, JSON.stringify(result.issues))
  return result.value
}

/** @returns {Promise<Identity>} a throwaway identity. */
async function identity() {
  return await new Identity({ explicitKey: generateKey(), logger: new Logger('silent') }).load()
}

/**
 * @param {FakeHost} host fake harness.
 * @param {Record<string, any>} [config] config overrides.
 * @returns {Promise<{bridge: Bridge, run: (method: string, params?: any) => Promise<any>}>} the bridge and a dispatcher.
 */
async function bridgeFor(host, config = {}) {
  const bridge = new Bridge({
    ctx: host.context(),
    config: testConfig(config),
    identity: await identity(),
    logger: new Logger('silent'),
  })
  const signal = new AbortController().signal
  return { bridge, run: (method, params = {}) => bridge.operations.dispatch(method, params, { signal }) }
}

/**
 * @param {FakeHost} host fake harness.
 * @param {Record<string, any>} event a `SessionEvent`.
 * @param {string} [sessionId] owning session.
 * @returns {Array<Record<string, any>>} the events the forwarder published.
 */
function forwardOne(host, event, sessionId = 'session-a') {
  const published = []
  const ctx = host.context()
  const forwarder = new EventForwarder({
    ctx,
    host: new HostAdapter({ ctx, logger: new Logger('silent'), config: testConfig() }),
    config: testConfig(),
    logger: new Logger('silent'),
    publish: (entry) => published.push(entry),
    isConnected: () => true,
    isSubscribed: () => true,
  })
  forwarder.start()
  ctx.emit('session/event', host.sessions.get(sessionId), event)
  forwarder.dispose()
  return published
}

// ── capability bits ──────────────────────────────────────────────────────────

test('extensions: capability bits report the composed extensions', async () => {
  const full = new HostAdapter({ ctx: new FakeHost().context(), logger: new Logger('silent'), config: testConfig() })
  const capabilities = full.capabilities()
  for (const key of [
    'sessionEvents',
    'sessionArchive',
    'messageFeedback',
    'permissionPresets',
    'agentPresets',
    'attachments',
    'workspaceMutation',
    'fileBrowser',
    'pluginManagement',
  ]) {
    assert.equal(capabilities[key], true, `${key} should be advertised`)
  }

  const bare = new HostAdapter({ ctx: new FakeHost().context({ fs: undefined }), logger: new Logger('silent'), config: testConfig() })
  assert.equal(bare.capabilities().fileBrowser, false)

  // A service that mounts after the first probe must still be discovered: the
  // adapter is not allowed to remember a miss.
  const late = new HostAdapter({ ctx: new FakeHost().context({ messageFeedback: undefined }), logger: new Logger('silent'), config: testConfig() })
  assert.equal(late.capabilities().messageFeedback, false)
  late.ctx.services.messageFeedback = { list: async () => ({ ok: true, value: { items: [] } }) }
  assert.equal(late.capabilities().messageFeedback, true)
})

test('extensions: the full method catalogue is registered', async () => {
  const { bridge } = await bridgeFor(new FakeHost())
  for (const method of [
    'session.events',
    'session.archive',
    'message.feedback',
    'message.feedback.list',
    'session.permission',
    'agentPreset.list',
    'agentPreset.read',
    'agentPreset.select',
    'agentPreset.copy',
    'agentPreset.delete',
    'attachment.put',
    'attachment.get',
    'workspace.create',
    'workspace.rename',
    'workspace.remove',
    'workspace.fs.list',
    'workspace.fs.read',
    'workspace.fs.roots',
    'workspace.fs.mkdir',
    'plugin.list',
    'plugin.config',
    'plugin.setConfig',
    'plugin.setEnabled',
  ]) {
    assert.ok(bridge.operations.has(method), `${method} should be registered`)
  }
})

test('session.archive: uses the official workspace archive registry', async () => {
  const host = new FakeHost()
  const { run } = await bridgeFor(host)
  const outcome = await run('session.archive', { sessionId: 'session-a' })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.result.archived, true)
  assert.deepEqual(host.services.workspaceRegistry.archivedSessionIds, ['session-a'])
})

test('agent presets: lists, reads, selects, copies, and deletes through the real host service', async () => {
  const host = new FakeHost()
  const { run } = await bridgeFor(host)

  const roster = await run('agentPreset.list')
  assert.equal(roster.ok, true)
  assert.deepEqual(roster.result.presets.map((preset) => preset.id), ['standard', 'minimal'])
  assert.equal(roster.result.authorable, true)

  const document = await run('agentPreset.read', { agentPreset: 'standard' })
  assert.equal(document.result.agentPreset, 'standard')
  assert.match(document.result.content, /standard/)

  const selected = await run('agentPreset.select', { sessionId: 'session-a', agentPreset: 'minimal' })
  assert.deepEqual(selected.result, { agentPreset: 'minimal' })
  assert.deepEqual(host.agentPresetSelections.at(-1), { sessionId: 'session-a', agentPreset: 'minimal' })

  const copied = await run('agentPreset.copy', { from: 'standard', agentPreset: 'mine', name: 'Mine' })
  assert.equal(copied.result.accepted, true)
  assert.equal((await run('agentPreset.list')).result.presets.some((preset) => preset.id === 'mine'), true)

  const deleted = await run('agentPreset.delete', { agentPreset: 'mine' })
  assert.equal(deleted.result.accepted, true)
  assert.equal((await run('agentPreset.list')).result.presets.some((preset) => preset.id === 'mine'), false)
})

// ── §1 session.events ────────────────────────────────────────────────────────

test('session.events: pages the real log, newest page first, ascending', async () => {
  const host = new FakeHost()
  const { run } = await bridgeFor(host)
  const session = host.sessions.get('session-a')
  for (let seq = 1; seq <= 10; seq += 1) {
    session.appendLogEvent({ type: seq % 2 === 0 ? 'step/start' : 'turn/start', seq, time: 1_700_000_000_000 + seq, data: { seq } })
  }

  const missing = await run('session.events', { sessionId: 'session-a' })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'invalid_params')

  const page = await run('session.events', { sessionId: 'session-a', throughSeq: 10, limit: 4 })
  assert.equal(page.ok, true)
  assert.deepEqual(
    page.result.events.map((event) => event.seq),
    [7, 8, 9, 10],
  )
  assert.equal(page.result.oldestSeq, 7)
  assert.equal(page.result.newestSeq, 10)
  assert.equal(page.result.hasMore, true)
  // Real log positions and real times, not page-local indices.
  assert.equal(page.result.events[0].time, 1_700_000_000_007)

  const older = await run('session.events', { sessionId: 'session-a', throughSeq: 10, beforeSeq: 7, limit: 4 })
  assert.deepEqual(
    older.result.events.map((event) => event.seq),
    [3, 4, 5, 6],
  )
  assert.equal(older.result.hasMore, true)

  const filtered = await run('session.events', { sessionId: 'session-a', throughSeq: 10, limit: 2, kinds: ['step/start'] })
  assert.deepEqual(
    filtered.result.events.map((event) => event.seq),
    [8, 10],
  )
  assert.deepEqual(
    filtered.result.events.map((event) => event.type),
    ['step/start', 'step/start'],
  )
})

test('session.events: current feedback rides on the assistant message it belongs to', async () => {
  const host = new FakeHost()
  const { run } = await bridgeFor(host)
  const session = host.sessions.get('session-a')
  session.appendLogEvent({ type: 'assistant/message', seq: 3, time: 1, data: { message: { id: 'msg-1', role: 'assistant', content: [] } } })
  session.appendLogEvent({ type: 'assistant/message', seq: 4, time: 2, data: { message: { id: 'msg-2', role: 'assistant', content: [] } } })
  host.feedback.push({ sessionId: 'session-a', messageId: 'msg-2', rating: 'positive', version: 'v1', createdAt: 1, updatedAt: 9 })

  const page = await run('session.events', { sessionId: 'session-a', throughSeq: 9 })
  const [first, second] = page.result.events
  assert.equal(first.feedback, undefined)
  assert.deepEqual(second.feedback, { rating: 'like', updatedAt: 9 })
})

// ── §2 message.feedback ──────────────────────────────────────────────────────

test('message.feedback: sets, switches, and withdraws a rating', async () => {
  const host = new FakeHost()
  const { run } = await bridgeFor(host)
  host.sessions.get('session-a').appendLogEvent({
    type: 'assistant/message',
    seq: 5,
    time: 1,
    data: { message: { id: 'msg-1', role: 'assistant', content: [] } },
  })

  const liked = await run('message.feedback', { sessionId: 'session-a', seq: 5, rating: 'like' })
  assert.equal(liked.ok, true)
  assert.equal(liked.result.rating, 'like')
  assert.equal(host.feedback[0].rating, 'positive')

  const disliked = await run('message.feedback', { sessionId: 'session-a', seq: 5, rating: 'dislike' })
  assert.equal(disliked.result.rating, 'dislike')
  assert.equal(host.feedback[0].rating, 'negative')

  const cleared = await run('message.feedback', { sessionId: 'session-a', seq: 5, rating: 'none' })
  assert.equal(cleared.result.rating, null)
  assert.equal(host.feedback.length, 0)

  const badRating = await run('message.feedback', { sessionId: 'session-a', seq: 5, rating: 'meh' })
  assert.equal(badRating.error.code, 'invalid_params')

  const noMessage = await run('message.feedback', { sessionId: 'session-a', seq: 4, rating: 'like' })
  assert.equal(noMessage.error.code, 'not_found')
})

test('message.feedback.list: reports every rating against its log position', async () => {
  const host = new FakeHost()
  const { run } = await bridgeFor(host)
  const session = host.sessions.get('session-a')
  session.appendLogEvent({ type: 'assistant/message', seq: 2, time: 1, data: { message: { id: 'msg-1' } } })
  session.appendLogEvent({ type: 'turn/end', seq: 3, time: 2, data: { turn: 1 } })
  session.appendLogEvent({ type: 'assistant/message', seq: 6, time: 3, data: { message: { id: 'msg-2' } } })

  const empty = await run('message.feedback.list', { sessionId: 'session-a' })
  assert.deepEqual(empty.result, { items: [] })

  await run('message.feedback', { sessionId: 'session-a', seq: 2, rating: 'like' })
  await run('message.feedback', { sessionId: 'session-a', seq: 6, rating: 'dislike' })

  const listed = await run('message.feedback.list', { sessionId: 'session-a' })
  assert.deepEqual(
    listed.result.items.map((item) => [item.seq, item.rating]),
    [
      [2, 'like'],
      [6, 'dislike'],
    ],
  )

  // A rating on a message the log does not carry yet simply does not appear.
  host.feedback.push({ sessionId: 'session-a', messageId: 'msg-ghost', rating: 'positive', version: 'v9', createdAt: 0, updatedAt: 0 })
  const stillListed = await run('message.feedback.list', { sessionId: 'session-a' })
  assert.equal(stillListed.result.items.length, 2)
})

// ── §3 session.permission ────────────────────────────────────────────────────

test('session.permission: speaks protocol ids over the deployment table', async () => {
  const host = new FakeHost()
  const { run } = await bridgeFor(host)

  const read = await run('session.permission', { sessionId: 'session-a' })
  assert.equal(read.ok, true)
  assert.equal(read.result.preset, 'workspace-write')
  assert.deepEqual(read.result.available, ['read-only', 'workspace-write', 'full-access'])
  assert.equal(read.result.labels, undefined, 'undeclared labels must not be invented')

  const switched = await run('session.permission', { sessionId: 'session-a', preset: 'full-access' })
  assert.equal(switched.result.preset, 'full-access')
  // The deployment's own table name, not the protocol id.
  assert.equal(host.permission, 'danger-full-access')

  const bogus = await run('session.permission', { sessionId: 'session-a', preset: 'root' })
  assert.equal(bogus.error.code, 'invalid_params')

  assert.equal(permissionProtocolId('danger-full-access'), 'full-access')
  assert.equal(permissionProtocolId('custom'), 'custom')
})

test('session.permission: reads a cold session from its log without activating it', async () => {
  const host = new FakeHost()
  const { run } = await bridgeFor(host)
  const session = host.sessions.get('session-a')
  // Detach it: a cold session keeps its log but is absent from the live store.
  host.services.sessions.get = (id) => (id === 'session-a' ? undefined : host.sessions.get(id))
  host.services.agents.get = () => undefined
  session.appendLogEvent({ type: 'sandbox/mode', seq: 1, time: 1, data: { mode: 'read-only' } })
  session.appendLogEvent({ type: 'permission/preset', seq: 2, time: 2, data: { preset: 'danger-full-access' } })
  session.appendLogEvent({ type: 'turn/start', seq: 3, time: 3, data: { turn: 1 } })

  const read = await run('session.permission', { sessionId: 'session-a' })
  assert.equal(read.ok, true)
  assert.equal(read.result.preset, 'full-access')
  assert.deepEqual(read.result.available, ['read-only', 'workspace-write', 'full-access'])
})

test('session.permission: switching publishes the matching event', async () => {
  const host = new FakeHost()
  const bridge = new Bridge({ ctx: host.context(), config: testConfig(), identity: await identity(), logger: new Logger('silent') })
  await bridge.operations.dispatch('session.permission', { sessionId: 'session-a', preset: 'read-only' }, { signal: new AbortController().signal })
  const event = bridge.buffer.items.at(-1)
  assert.equal(event.kind, 'session/permission')
  assert.equal(event.data.preset, 'read-only')
})

// ── §4 attachments ───────────────────────────────────────────────────────────

test('attachment: stores, returns, and refuses an oversized read', async () => {
  const host = new FakeHost()
  const { run } = await bridgeFor(host)

  const put = await run('attachment.put', { name: 'note.txt', mime: 'text/plain', dataBase64: Buffer.from('hello').toString('base64') })
  assert.equal(put.ok, true)
  assert.equal(put.result.bytes, 5)
  assert.equal(put.result.kind, 'file')

  const got = await run('attachment.get', { attachmentId: put.result.attachmentId })
  assert.equal(got.result.dataBase64, Buffer.from('hello').toString('base64'))
  assert.equal(got.result.truncated, false)

  const capped = await run('attachment.get', { attachmentId: put.result.attachmentId, maxBytes: 2 })
  assert.equal(capped.error.code, 'payload_too_large')

  const unknown = await run('attachment.get', { attachmentId: 'att_nope' })
  assert.equal(unknown.error.code, 'not_found')

  const noData = await run('attachment.put', { name: 'x', mime: 'text/plain', dataBase64: '' })
  assert.equal(noData.error.code, 'invalid_params')
})

test('attachment: prompt blocks resolve images and files into harness parts', async () => {
  const host = new FakeHost()
  const { run } = await bridgeFor(host)
  const image = await run('attachment.put', { name: 'shot.png', mime: 'image/png', dataBase64: Buffer.from([1, 2, 3]).toString('base64') })
  const file = await run('attachment.put', { name: 'report.pdf', mime: 'application/pdf', dataBase64: Buffer.from('pdf').toString('base64') })

  const prompted = await run('session.prompt', {
    sessionId: 'session-a',
    content: [
      { type: 'text', text: 'look at these' },
      { type: 'image', attachmentId: image.result.attachmentId, name: 'shot.png' },
      { type: 'file', attachmentId: file.result.attachmentId, name: 'report.pdf' },
    ],
  })
  assert.equal(prompted.ok, true)
  const content = host.prompts.at(-1).content
  assert.equal(content[0].type, 'text')
  assert.equal(content[1].type, 'image')
  assert.equal(content[1].mediaType, 'image/png')
  assert.equal(typeof content[1].data, 'string')
  assert.equal(content[2].type, 'file')
  assert.match(content[2].receiptId, /^rcpt-/)

  const dangling = await run('session.prompt', { sessionId: 'session-a', content: [{ type: 'image', attachmentId: 'att_nope' }] })
  assert.equal(dangling.error.code, 'invalid_params')
})

// ── §5 workspace mutation ────────────────────────────────────────────────────

test('workspace: creates, renames, and removes by path or id', async () => {
  const host = new FakeHost()
  const { run } = await bridgeFor(host, { allowedCwdPrefixes: ['C:/work'] })

  const created = await run('workspace.create', { path: 'C:/work/other', title: 'Other' })
  assert.equal(created.ok, true)
  assert.equal(created.result.workspace.path, 'C:/work/other')
  assert.equal(created.result.workspace.title, 'Other')

  const row = host.workspaces.find((entry) => entry.path === 'C:/work/other')
  const renamed = await run('workspace.rename', { id: row.workspaceId, title: 'Renamed' })
  assert.equal(renamed.result.workspace.title, 'Renamed')

  const removed = await run('workspace.remove', { path: 'C:/work/other' })
  assert.deepEqual(removed.result, { removed: true })
  assert.equal(
    host.workspaces.some((entry) => entry.path === 'C:/work/other'),
    false,
  )

  const outside = await run('workspace.create', { path: 'D:/elsewhere' })
  assert.equal(outside.error.code, 'forbidden')

  const unknown = await run('workspace.remove', { path: 'C:/work/ghost' })
  assert.equal(unknown.error.code, 'not_found')

  const neither = await run('workspace.remove', {})
  assert.equal(neither.error.code, 'invalid_params')
})

// ── §6 file browser ──────────────────────────────────────────────────────────

test('workspace.fs: lists, previews text, and windows a binary file', async () => {
  const host = new FakeHost()
  const { run } = await bridgeFor(host, { allowedCwdPrefixes: ['C:/work'] })

  const listing = await run('workspace.fs.list', { path: 'C:/work/project' })
  assert.equal(listing.ok, true)
  assert.deepEqual(
    listing.result.entries.map((entry) => entry.name).sort(),
    ['blob.bin', 'notes.txt', 'src'],
  )
  assert.equal(listing.result.entries.find((entry) => entry.name === 'src').type, 'dir')

  const text = await run('workspace.fs.read', { path: 'C:/work/project/notes.txt' })
  assert.equal(text.result.binary, false)
  assert.equal(text.result.text, 'hello world')
  assert.equal(text.result.truncated, false)

  const clipped = await run('workspace.fs.read', { path: 'C:/work/project/notes.txt', maxBytes: 4 })
  assert.equal(clipped.result.truncated, true)
  assert.equal(clipped.result.text, 'hell')

  const binary = await run('workspace.fs.read', { path: 'C:/work/project/blob.bin', maxBytes: 2 })
  assert.equal(binary.result.binary, true)
  assert.equal(binary.result.truncated, true)
  assert.equal(binary.result.mime, 'application/octet-stream')
  assert.equal(binary.result.dataBase64, Buffer.from([0, 1]).toString('base64'))

  const outside = await run('workspace.fs.list', { path: 'D:/secrets' })
  assert.equal(outside.error.code, 'forbidden')

  const notDirectory = await run('workspace.fs.list', { path: 'C:/work/project/notes.txt' })
  assert.equal(notDirectory.error.code, 'invalid_params')
})

// ── §8 plugin management ─────────────────────────────────────────────────────

test('plugin: lists entries with their package facts and preset rows', async () => {
  const host = new FakeHost()
  const { run } = await bridgeFor(host)

  const list = await run('plugin.list', {})
  assert.equal(list.ok, true)
  const rows = list.result.items
  assert.equal(rows.length, 3)
  const one = rows.find((row) => row.id === 'p-one')
  assert.equal(one.enabled, true)
  assert.equal(one.state, 'active')
  assert.equal(one.scope, 'global')
  assert.equal(one.configurable, true)

  const two = rows.find((row) => row.id === 'p-two')
  assert.equal(two.enabled, false)
  assert.equal(two.state, 'disabled')

  const presetRow = rows.find((row) => row.id === 'p-tool')
  assert.equal(presetRow.scope, 'session')
  assert.equal(presetRow.preset, 'standard')
})

test('plugin: reads a schema as the JSON Schema subset and writes config', async () => {
  const host = new FakeHost()
  const { run } = await bridgeFor(host)

  const config = await run('plugin.config', { id: 'p-one' })
  assert.equal(config.ok, true)
  assert.equal(config.result.values.answer, 42)
  assert.deepEqual(config.result.schema, {
    default: {},
    type: 'object',
    properties: {
      answer: { default: 42, type: 'number' },
      mode: { default: 'a', description: 'pick one', enum: ['a', 'b'] },
    },
  })

  const written = await run('plugin.setConfig', { id: 'p-one', patch: { answer: 7 } })
  assert.equal(written.ok, true)
  assert.deepEqual(host.pluginWrites, [{ id: 'p-one', patch: { config: { answer: 7 } } }])

  const badPatch = await run('plugin.setConfig', { id: 'p-one', patch: [] })
  assert.equal(badPatch.error.code, 'invalid_params')

  const toggled = await run('plugin.setEnabled', { id: 'p-one', enabled: false })
  assert.equal(toggled.result.item.enabled, false)
  assert.deepEqual(host.pluginWrites.at(-1), { id: 'p-one', patch: { disabled: true } })

  const unknown = await run('plugin.config', { id: 'p-ghost' })
  assert.equal(unknown.error.code, 'not_found')
})

test('plugin: writing is refused when remote control is off', async () => {
  const host = new FakeHost()
  const { run } = await bridgeFor(host, { allowRemoteControl: false })
  const refused = await run('plugin.setEnabled', { id: 'p-one', enabled: false })
  assert.equal(refused.error.code, 'disabled')
})

// ── §9 payload enrichments ───────────────────────────────────────────────────

test('session/event: tool calls carry the model-declared intent', () => {
  const host = new FakeHost()
  const published = forwardOne(host, {
    type: 'tool/call',
    seq: 7,
    time: 5,
    data: { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'ls', description: 'List files in current directory' }) },
  })
  const forwarded = published.find((entry) => entry.kind === 'session/event')
  assert.equal(forwarded.data.data.description, 'List files in current directory')
  // The raw arguments are still there, untouched.
  assert.equal(JSON.parse(forwarded.data.data.arguments).command, 'ls')
})

test('session/event: turn/end carries the files the turn changed', () => {
  const host = new FakeHost()
  const session = host.sessions.get('session-a')
  const ctx = host.context()
  const published = []
  const forwarder = new EventForwarder({
    ctx,
    host: new HostAdapter({ ctx, logger: new Logger('silent'), config: testConfig() }),
    config: testConfig(),
    logger: new Logger('silent'),
    publish: (entry) => published.push(entry),
    isConnected: () => true,
    isSubscribed: () => true,
  })
  forwarder.start()

  ctx.emit('session/event', session, {
    type: 'tool/result',
    seq: 1,
    time: 1,
    data: { turn: 3, step: 1, meta: { diffs: [{ path: 'src/a.ts', oldText: 'one\ntwo', newText: 'one\ntwo\nthree' }] } },
  })
  ctx.emit('session/event', session, {
    type: 'tool/result',
    seq: 2,
    time: 2,
    data: { turn: 3, step: 2, meta: { diffs: [{ path: 'src/a.ts', oldText: 'x', newText: 'y\nz' }] } },
  })
  ctx.emit('session/event', session, { type: 'turn/end', seq: 3, time: 3, data: { turn: 3, reason: { kind: 'completed' } } })
  forwarder.dispose()

  const end = published.filter((entry) => entry.kind === 'session/event' && entry.data.type === 'turn/end').at(-1)
  assert.deepEqual(end.data.data.files, [{ path: 'src/a.ts', added: 5, removed: 3 }])
  // The turn's reason survives the enrichment.
  assert.deepEqual(end.data.data.reason, { kind: 'completed' })
})

test('session/event: a locally switched preset is reported on the sessions topic', () => {
  const host = new FakeHost()
  const published = forwardOne(host, { type: 'permission/preset', seq: 2, time: 100, data: { preset: 'danger-full-access' } })
  const forwarded = published.find((entry) => entry.kind === 'session/permission')
  assert.equal(forwarded.topic, 'sessions')
  assert.equal(forwarded.data.preset, 'full-access')
})

test('session/event: a locally left rating is reported against its message seq', () => {
  const host = new FakeHost()
  const session = host.sessions.get('session-a')
  const ctx = host.context()
  const published = []
  const forwarder = new EventForwarder({
    ctx,
    host: new HostAdapter({ ctx, logger: new Logger('silent'), config: testConfig() }),
    config: testConfig(),
    logger: new Logger('silent'),
    publish: (entry) => published.push(entry),
    isConnected: () => true,
    isSubscribed: () => true,
  })
  forwarder.start()

  ctx.emit('session/event', session, { type: 'assistant/message', seq: 11, time: 1, data: { message: { id: 'msg-9' } } })
  ctx.emit('session/event', session, { type: 'feedback/message-put', seq: 12, time: 2, data: { item: { messageId: 'msg-9', rating: 'positive' } } })
  ctx.emit('session/event', session, { type: 'feedback/message-delete', seq: 13, time: 3, data: { item: { messageId: 'msg-9' } } })
  forwarder.dispose()

  const rated = published.filter((entry) => entry.kind === 'message/feedback')
  assert.deepEqual(rated.map((entry) => entry.data), [
    { seq: 11, rating: 'like', at: 2 },
    { seq: 11, rating: 'none', at: 3 },
  ])
})

test('history: message-aligned records gain the tool-call intent', async () => {
  const host = new FakeHost()
  const { run } = await bridgeFor(host)
  host.services.sessionController.page = async () => ({
    records: [
      {
        type: 'event',
        event: {
          type: 'assistant/message',
          seq: 4,
          time: 9,
          data: {
            message: {
              id: 'm1',
              role: 'assistant',
              content: [
                { type: 'text', text: 'working' },
                { type: 'tool-call', id: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'ls', description: 'List files' }) },
              ],
            },
          },
        },
      },
    ],
    hasMore: false,
  })

  const history = await run('session.history', { sessionId: 'session-a', throughSeq: 10 })
  assert.equal(history.ok, true)
  const blocks = history.result.records[0].event.data.message.content
  assert.equal(blocks[1].description, 'List files')
  // The parts the log itself recorded are untouched.
  assert.equal(blocks[0].text, 'working')
  assert.equal(blocks[1].arguments, JSON.stringify({ command: 'ls', description: 'List files' }))
})

// ── helpers ──────────────────────────────────────────────────────────────────

test('helpers: intent extraction and event shaping tolerate hostile input', () => {
  assert.equal(toolIntentFromArguments('{"description":"do a thing"}'), 'do a thing')
  assert.equal(toolIntentFromArguments('{"description":"   "}'), undefined)
  assert.equal(toolIntentFromArguments('{"description":42}'), undefined)
  assert.equal(toolIntentFromArguments('not json'), undefined)
  assert.equal(toolIntentFromArguments(undefined), undefined)

  assert.deepEqual(wireSessionEvent({ type: 'turn/start', seq: 3, time: 7, data: { turn: 1 } }), {
    type: 'turn/start',
    seq: 3,
    time: 7,
    data: { turn: 1 },
  })
  assert.deepEqual(wireSessionEvent({ type: 'x', seq: 1, time: 2, data: {}, ignorable: true }), {
    type: 'x',
    seq: 1,
    time: 2,
    data: {},
    ignorable: true,
  })
})

test('extensions: refused operations report capability_unavailable, never throw', async () => {
  const host = new FakeHost()
  const { run } = await bridgeFor(host)
  const cases = [
    ['message.feedback', { sessionId: 'session-a', seq: 1, rating: 'like' }, { messageFeedback: undefined }],
    ['session.permission', { sessionId: 'session-a' }, { permissionPresets: undefined }],
    ['attachment.put', { name: 'x', mime: 'text/plain', dataBase64: 'aGk=' }, { attachments: undefined }],
    ['workspace.fs.list', { path: 'C:/work' }, { fs: undefined }],
    ['workspace.create', { path: 'C:/work/x' }, { workspaceController: undefined }],
    ['plugin.list', {}, { pluginInventory: undefined }],
  ]
  for (const [method, params, overrides] of cases) {
    const strict = new Bridge({
      ctx: host.context(overrides),
      config: testConfig(),
      identity: await identity(),
      logger: new Logger('silent'),
    })
    const outcome = await strict.operations.dispatch(method, params, { signal: new AbortController().signal })
    assert.equal(outcome.ok, false, `${method} should fail without its service`)
    assert.equal(outcome.error.code, 'capability_unavailable', `${method} should report a missing capability`)
  }
})
