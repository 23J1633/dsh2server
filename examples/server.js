/**
 * Reference relay backend for `dsh2server`.
 *
 * This is a complete, runnable implementation of the server half of the
 * protocol in `docs/API.md`, written with zero dependencies so it can be read,
 * copied, and re-implemented in any stack. It is a **pure relay**:
 *
 * - Nothing about your dsh instances is written to disk. Session lists, event
 *   history, and pending requests live in bounded in-memory structures that
 *   vanish when the process stops.
 * - The only file it reads is the key list, which is the operator's own
 *   credential store (one entry per authorized machine) and is reloaded
 *   whenever it changes.
 *
 * What it provides:
 *
 *   GET    /dsh-api/                          protocol info
 *   GET    /dsh-api/keys                      key list (fingerprints + labels)
 *   POST   /dsh-api/keys                      add a machine key   { key, label? }
 *   POST   /dsh-api/keys/remove               revoke a key        { key | fingerprint }
 *   GET    /dsh-api/instances                 connected machines + cached summaries
 *   GET    /dsh-api/instances/:id/events      in-memory event tail (?since=&limit=)
 *   POST   /dsh-api/instances/:id/request     issue one operation { method, params }
 *   POST   /dsh-api/instances/:id/subscribe   change stream subscriptions
 *   GET    /dsh-api/ws                        WebSocket endpoint (primary carrier)
 *   POST   /dsh-api/events                    HTTP uplink (fallback carrier)
 *   GET    /dsh-api/inbox                     HTTP long-poll downlink (fallback carrier)
 *
 * Run it with:
 *
 *   node examples/server.js --port 8787 --keys ./examples/keys.json
 *
 * @module dsh2server/examples/server
 */

import { createServer } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { readFileSync, watch, writeFileSync } from 'node:fs'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { attachWebSocket } from './ws.js'

/** Protocol version this relay speaks. */
export const PROTOCOL_VERSION = 1

/** Default path prefix; the plugin's `endpoint` points at this. */
export const DEFAULT_BASE_PATH = '/dsh-api'

/** Bounded per-instance event memory; the relay keeps nothing beyond this. */
const DEFAULT_EVENT_LIMIT = 1000

/** Long-poll hold time when the client does not ask for one. */
const DEFAULT_POLL_WAIT_MS = 25000

/**
 * Constant-time secret comparison.
 *
 * @param {string} a first secret.
 * @param {string} b second secret.
 * @returns {boolean} whether they match.
 */
export function secretEquals(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8')
  const right = Buffer.from(String(b ?? ''), 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Non-secret display form of a key: enough to identify it, never enough to use
 * it. Mirrors the plugin's own fingerprint so both sides print the same label.
 *
 * @param {string} key full key.
 * @returns {string} `dshk_AbCdEf…9xYz`.
 */
export function fingerprint(key) {
  const text = String(key ?? '')
  if (text.length <= 16) return text ? `${text.slice(0, 4)}…` : ''
  return `${text.slice(0, 12)}…${text.slice(-4)}`
}

/**
 * The operator's key store: one entry per authorized machine.
 */
export class KeyStore {
  /**
   * @param {object} options store options.
   * @param {string} [options.file] JSON key file path.
   * @param {Array<Record<string, any>>} [options.entries] inline entries.
   */
  constructor(options = {}) {
    this.file = options.file
    /** @type {Array<{key: string, label?: string, instanceId?: string, addedAt?: string}>} */
    this.entries = []
    this.watcher = undefined
    if (options.entries) this.setEntries(options.entries)
    if (this.file) {
      this.reload()
      try {
        this.watcher = watch(this.file, { persistent: false }, () => this.reload())
      } catch {
        this.watcher = undefined
      }
    }
  }

  /**
   * @param {Array<Record<string, any>>} entries raw entries (objects or bare strings).
   */
  setEntries(entries) {
    this.entries = (Array.isArray(entries) ? entries : [])
      .map((entry) => (typeof entry === 'string' ? { key: entry } : entry))
      .filter((entry) => entry && typeof entry.key === 'string' && entry.key !== '')
      .map((entry) => ({
        key: entry.key,
        label: typeof entry.label === 'string' ? entry.label : undefined,
        instanceId: typeof entry.instanceId === 'string' ? entry.instanceId : undefined,
        addedAt: entry.addedAt,
      }))
  }

  /** Re-read the key file, tolerating a partially written document. */
  reload() {
    if (!this.file) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      const entries = Array.isArray(parsed) ? parsed : parsed?.keys
      this.setEntries(entries ?? [])
      this.loadError = undefined
    } catch (error) {
      this.loadError = String(error)
    }
  }

  /**
   * @param {string} key presented key.
   * @returns {{key: string, label?: string, instanceId?: string} | undefined} the matching entry.
   */
  authorize(key) {
    if (typeof key !== 'string' || key === '') return undefined
    for (const entry of this.entries) {
      if (secretEquals(entry.key, key)) return entry
    }
    return undefined
  }

  /**
   * @param {string} key key to add.
   * @param {string} [label] human label.
   * @returns {{key: string, label?: string, addedAt: string}} the stored entry.
   */
  add(key, label) {
    if (typeof key !== 'string' || key.length < 16) {
      throw new Error('a key must be a string of at least 16 characters')
    }
    if (this.authorize(key)) throw new Error('this key is already registered')
    const entry = { key, label, addedAt: new Date().toISOString() }
    this.entries.push(entry)
    this.#persist()
    return entry
  }

  /**
   * @param {string} selector full key or fingerprint.
   * @returns {boolean} whether an entry was removed.
   */
  remove(selector) {
    const before = this.entries.length
    this.entries = this.entries.filter((entry) => entry.key !== selector && fingerprint(entry.key) !== selector)
    const removed = this.entries.length !== before
    if (removed) this.#persist()
    return removed
  }

  /** Write the key file back, when one is configured. */
  #persist() {
    if (!this.file) return
    try {
      writeFileSync(this.file, `${JSON.stringify({ keys: this.entries }, null, 2)}\n`, { mode: 0o600 })
    } catch {
      // A read-only key source still works for the current process.
    }
  }

  /** @returns {Array<Record<string, unknown>>} non-secret list rows. */
  list() {
    return this.entries.map((entry) => ({
      fingerprint: fingerprint(entry.key),
      label: entry.label,
      instanceId: entry.instanceId,
      addedAt: entry.addedAt,
    }))
  }
}

/**
 * One connected dsh instance, held entirely in memory.
 */
export class InstanceSession {
  /**
   * @param {object} options session options.
   * @param {string} options.instanceId instance identity.
   * @param {Record<string, any>} options.hello the `hello` frame.
   * @param {Record<string, any>} options.keyEntry matched key entry.
   */
  constructor(options) {
    this.instanceId = options.instanceId
    this.hello = options.hello
    this.keyEntry = options.keyEntry
    this.keyFingerprint = fingerprint(options.keyEntry.key)
    this.connectedAt = Date.now()
    this.lastSeenAt = Date.now()
    this.transport = 'ws'
    /** Whether this instance reached the relay over TLS. */
    this.tls = false
    /** @type {import('./ws.js').WebSocketConnection | undefined} */
    this.connection = undefined
    /** @type {Map<string, {resolve: Function, timer: any}>} */
    this.pending = new Map()
    /** @type {Array<Record<string, any>>} */
    this.events = []
    this.eventLimit = DEFAULT_EVENT_LIMIT
    /** @type {Map<string, Array<Record<string, any>>>} */
    this.inbox = new Map()
    /** @type {Array<Record<string, any>>} queued server→plugin frames for the HTTP carrier. */
    this.httpOutbox = []
    /** @type {Array<() => void>} */
    this.waiters = []
    this.lastEvent = undefined
    this.subscriptions = { topics: [], sessions: [], assistantStreams: [] }
    this.capabilities = options.hello?.capabilities ?? {}
    this.instance = options.hello?.instance ?? {}
  }

  /**
   * Record one inbound event frame, keeping the in-memory ring bounded.
   *
   * @param {Record<string, any>} frame event frame.
   */
  record(frame) {
    this.lastSeenAt = Date.now()
    this.lastEvent = frame
    this.events.push(frame)
    while (this.events.length > this.eventLimit) this.events.shift()
  }

  /**
   * Queue one frame for delivery to the plugin.
   *
   * @param {Record<string, any>} frame protocol frame.
   */
  deliver(frame) {
    if (this.connection && !this.connection.closed) {
      this.connection.send(JSON.stringify(frame))
      return
    }
    this.httpOutbox.push(frame)
    while (this.httpOutbox.length > 1000) this.httpOutbox.shift()
    this.#wakeWaiters()
  }

  /**
   * Send a request and await the plugin's response.
   *
   * @param {string} method method name.
   * @param {Record<string, unknown>} params request parameters.
   * @param {number} [timeoutMs] response budget.
   * @returns {Promise<Record<string, any>>} the `response` frame.
   */
  request(method, params, timeoutMs = 30000) {
    const id = randomUUID()
    const frame = { v: PROTOCOL_VERSION, type: 'request', id, method, params: params ?? {} }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`request "${method}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, timer })
      this.deliver(frame)
    })
  }

  /**
   * Resolve a pending request from a `response` frame.
   *
   * @param {Record<string, any>} frame response frame.
   * @returns {boolean} whether a pending request matched.
   */
  settle(frame) {
    const entry = this.pending.get(frame.id)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.pending.delete(frame.id)
    entry.resolve(frame)
    return true
  }

  /** @returns {void} */
  close() {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.resolve({ ok: false, error: { code: 'disconnected', message: 'the instance disconnected' } })
    }
    this.pending.clear()
    this.#wakeWaiters()
  }

  /**
   * Block until a frame is queued (HTTP carrier long-poll).
   *
   * @param {number} waitMs maximum hold time.
   * @param {AbortSignal} [signal] caller cancellation.
   * @returns {Promise<void>} resolves when woken or the hold elapsed.
   */
  waitForFrames(waitMs, signal) {
    if (this.httpOutbox.length > 0) return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', finish)
        this.waiters = this.waiters.filter((waiter) => waiter !== finish)
        resolve()
      }
      const timer = setTimeout(finish, waitMs)
      this.waiters.push(finish)
      signal?.addEventListener?.('abort', finish, { once: true })
    })
  }

  #wakeWaiters() {
    for (const waiter of [...this.waiters]) waiter()
  }
}

/**
 * Build the relay server.
 *
 * Plain HTTP and HTTPS can be served **at the same time**: pass
 * `tlsCert`/`tlsKey` and both listeners come up on the same request handler,
 * the same key store, and the same instance table. That is the deployment this
 * protocol is designed for — an `http://` endpoint for a trusted LAN or a
 * loopback console, and an `https://` endpoint for anything crossing a network
 * you do not control.
 *
 * @param {object} [options] server options.
 * @param {number} [options.port] plain-HTTP TCP port (`0` asks the OS).
 * @param {string} [options.host] bind address for both listeners.
 * @param {number} [options.tlsPort] HTTPS port; defaults to `port + 1` (`0` asks the OS).
 * @param {string} [options.tlsCert] PEM certificate path or inline PEM (enables HTTPS).
 * @param {string} [options.tlsKey] PEM private-key path or inline PEM (enables HTTPS).
 * @param {string} [options.keysFile] key list path.
 * @param {Array<Record<string, any>>} [options.keys] inline key entries.
 * @param {string} [options.adminKey] secret required by management routes.
 * @param {string} [options.basePath] path prefix (default `/dsh-api`).
 * @param {(level: string, message: string) => void} [options.log] logger.
 * @returns {Promise<{server: import('node:http').Server, tlsServer?: import('node:https').Server, httpUrl: string, httpsUrl: string|null, url: string, basePath: string, port: number, tlsPort: number|null, instances: Map<string, InstanceSession>, keys: KeyStore, close: () => Promise<void>}>} the running relay.
 */
export async function createRelayServer(options = {}) {
  const basePath = options.basePath ?? DEFAULT_BASE_PATH
  const log = options.log ?? ((level, message) => console.log(`[relay:${level}] ${message}`))
  const keys = options.keysFile
    ? new KeyStore({ file: options.keysFile })
    : new KeyStore({ entries: options.keys ?? [] })
  /** @type {Map<string, InstanceSession>} */
  const instances = new Map()

  const server = createServer((request, response) => {
    handleHttp(request, response).catch((error) => {
      log('error', `unhandled: ${String(error)}`)
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'internal', message: String(error) } }))
    })
  })

  /** TLS material, when the deployment asked for an HTTPS listener too. */
  const tls = options.tlsCert && options.tlsKey ? { cert: loadPem(options.tlsCert), key: loadPem(options.tlsKey) } : undefined
  const tlsServer = tls
    ? createTlsServer(tls, (request, response) => {
        handleHttp(request, response).catch((error) => {
          log('error', `unhandled: ${String(error)}`)
          if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { code: 'internal', message: String(error) } }))
        })
      })
    : undefined

  /**
   * @param {import('node:http').IncomingMessage} request inbound request.
   * @param {import('node:http').ServerResponse} response outbound response.
   */
  async function handleHttp(request, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    if (!url.pathname.startsWith(basePath)) return sendJson(response, 404, { error: { code: 'not_found' } })
    const route = url.pathname.slice(basePath.length) || '/'
    const method = request.method ?? 'GET'

    if (route === '/' || route === '') {
      return sendJson(response, 200, {
        name: 'dsh2server reference relay',
        protocol: PROTOCOL_VERSION,
        basePath,
        endpoints: {
          websocket: `${basePath}/ws`,
          events: `${basePath}/events`,
          inbox: `${basePath}/inbox`,
          instances: `${basePath}/instances`,
          keys: `${basePath}/keys`,
        },
        listeners: {
          http: `http://${request.headers.host ?? 'localhost'}${basePath}`,
          https: tlsServer ? `https://${request.headers.host ?? 'localhost'}${basePath}` : null,
        },
        connectedInstances: instances.size,
        registeredKeys: keys.list().length,
      })
    }

    // ── management routes (operator plane) ────────────────────────────────────
    if (route === '/keys' && method === 'GET') {
      if (!requireAdmin(request, response, url)) return
      return sendJson(response, 200, { keys: keys.list(), loadError: keys.loadError })
    }
    if (route === '/keys' && method === 'POST') {
      if (!requireAdmin(request, response, url)) return
      const body = await readJson(request)
      try {
        const entry = keys.add(body.key, body.label)
        log('info', `registered key ${fingerprint(entry.key)}${entry.label ? ` (${entry.label})` : ''}`)
        return sendJson(response, 200, { added: { fingerprint: fingerprint(entry.key), label: entry.label } })
      } catch (error) {
        return sendJson(response, 400, { error: { code: 'invalid', message: String(error.message ?? error) } })
      }
    }
    if (route === '/keys/remove' && method === 'POST') {
      if (!requireAdmin(request, response, url)) return
      const body = await readJson(request)
      const removed = keys.remove(String(body.key ?? body.fingerprint ?? ''))
      return sendJson(response, removed ? 200 : 404, { removed })
    }
    if (route === '/instances' && method === 'GET') {
      if (!requireAdmin(request, response, url)) return
      return sendJson(response, 200, {
        instances: [...instances.values()].map((instance) => ({
          instanceId: instance.instanceId,
          label: instance.instance.label?.displayName ?? instance.instance.hostname,
          keyFingerprint: instance.keyFingerprint,
          transport: instance.transport,
          tls: instance.tls === true,
          connectedAt: instance.connectedAt,
          lastSeenAt: instance.lastSeenAt,
          disconnectedAt: instance.disconnectedAt ?? null,
          protocol: instance.hello?.v,
          pluginVersion: instance.instance.pluginVersion,
          capabilities: instance.capabilities,
          subscriptions: instance.subscriptions,
          pausedSessions: instance.instance?.pausedSessions,
          eventCount: instance.events.length,
          lastEventKind: instance.lastEvent?.kind,
        })),
      })
    }

    const instanceRoute = route.match(/^\/instances\/([^/]+)\/(events|request|subscribe)$/)
    if (instanceRoute) {
      if (!requireAdmin(request, response, url)) return
      const instanceId = decodeURIComponent(instanceRoute[1])
      const action = instanceRoute[2]
      const instance = instances.get(instanceId)
      if (!instance) return sendJson(response, 404, { error: { code: 'not_found', message: `no connected instance "${instanceId}"` } })
      if (action === 'events' && method === 'GET') {
        const since = Number(url.searchParams.get('since') ?? 0)
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 1000)
        const events = instance.events.filter((frame) => Number(frame.seq ?? 0) > since).slice(-limit)
        return sendJson(response, 200, { events, lastSeq: instance.events.at(-1)?.seq ?? 0 })
      }
      if (action === 'request' && method === 'POST') {
        const body = await readJson(request)
        if (typeof body.method !== 'string') {
          return sendJson(response, 400, { error: { code: 'invalid', message: 'method is required' } })
        }
        try {
          const frame = await instance.request(body.method, body.params ?? {}, Number(body.timeoutMs) || 30000)
          return sendJson(response, 200, frame)
        } catch (error) {
          return sendJson(response, 504, { ok: false, error: { code: 'timeout', message: String(error.message ?? error) } })
        }
      }
      if (action === 'subscribe' && method === 'POST') {
        const body = await readJson(request)
        const id = randomUUID()
        instance.deliver({
          v: PROTOCOL_VERSION,
          type: 'subscribe',
          id,
          topics: body.topics,
          sessions: body.sessions,
          assistantStream: body.assistantStream,
          snapshot: body.snapshot !== false,
        })
        return sendJson(response, 202, { queued: true, id })
      }
    }

    // ── HTTP carrier (fallback transport) ────────────────────────────────────
    if (route === '/events' && method === 'POST') {
      const body = await readJson(request)
      const instance = authenticateHttp(request, url, body)
      if (!instance) return sendJson(response, 401, { error: { code: 'unauthorized', message: 'unknown or missing instance key' } })
      for (const frame of Array.isArray(body.frames) ? body.frames : []) {
        ingest(instance, frame)
      }
      return sendJson(response, 200, { accepted: instance.lastEvent?.seq ?? 0 })
    }
    if (route === '/inbox' && method === 'GET') {
      const instance = authenticateHttp(request, url, undefined)
      if (!instance) return sendJson(response, 401, { error: { code: 'unauthorized', message: 'unknown or missing instance key' } })
      const waitMs = Math.min(Number(url.searchParams.get('waitMs') ?? DEFAULT_POLL_WAIT_MS) || 0, 60000)
      if (instance.httpOutbox.length === 0 && waitMs > 0) {
        const controller = new AbortController()
        request.on('close', () => controller.abort())
        await instance.waitForFrames(waitMs, controller.signal)
      }
      const frames = instance.httpOutbox.splice(0, 100)
      return sendJson(response, 200, { frames, cursor: instance.lastEvent?.seq ?? 0 })
    }

    return sendJson(response, 404, { error: { code: 'not_found', message: `no route for ${method} ${route}` } })
  }

  /**
   * @param {import('node:http').IncomingMessage} request inbound request.
   * @param {import('node:http').ServerResponse} response outbound response.
   * @param {URL} url parsed URL.
   * @returns {boolean} whether the caller is authorized to use management routes.
   */
  function requireAdmin(request, response, url) {
    const adminKey = options.adminKey
    if (adminKey) {
      const header = request.headers['x-admin-key']
      const provided = typeof header === 'string' ? header : url.searchParams.get('adminKey') ?? ''
      if (!secretEquals(adminKey, provided)) {
        sendJson(response, 401, { error: { code: 'unauthorized', message: 'management routes need x-admin-key' } })
        return false
      }
      return true
    }
    const address = request.socket.remoteAddress ?? ''
    const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
    if (!loopback) {
      sendJson(response, 403, {
        error: { code: 'forbidden', message: 'management routes are loopback-only unless adminKey is configured' },
      })
      return false
    }
    return true
  }

  /**
   * Authenticate one HTTP-carrier request from its key material.
   *
   * @param {import('node:http').IncomingMessage} request inbound request.
   * @param {URL} url parsed URL.
   * @param {Record<string, any> | undefined} body parsed body.
   * @returns {InstanceSession | undefined} the instance session.
   */
  function authenticateHttp(request, url, body) {
    const frames = Array.isArray(body?.frames) ? body.frames : []
    const helloFrame = frames.find((frame) => frame?.type === 'hello')
    const header = request.headers.authorization
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : ''
    const key = bearer || url.searchParams.get('key') || body?.key || helloFrame?.auth?.key || ''
    const entry = keys.authorize(key)
    if (!entry) return undefined
    const instanceId = String(
      body?.instanceId || helloFrame?.instanceId || url.searchParams.get('instanceId') || entry.instanceId || '',
    )
    if (!instanceId) return undefined
    let instance = instances.get(instanceId)
    if (!instance) {
      instance = new InstanceSession({ instanceId, hello: { type: 'hello', v: PROTOCOL_VERSION }, keyEntry: entry })
      instance.transport = 'http'
      instances.set(instanceId, instance)
      log('info', `instance ${instanceId} attached over HTTP long-poll (key ${fingerprint(entry.key)})`)
    }
    return instance
  }

  /**
   * Process one frame from an authenticated instance.
   *
   * @param {InstanceSession} instance origin instance.
   * @param {Record<string, any>} frame protocol frame.
   */
  function ingest(instance, frame) {
    if (!frame || typeof frame !== 'object') return
    instance.lastSeenAt = Date.now()
    switch (frame.type) {
      case 'hello': {
        instance.hello = frame
        instance.instance = frame.instance ?? {}
        instance.capabilities = frame.capabilities ?? {}
        instance.disconnectedAt = undefined
        const ack = {
          v: PROTOCOL_VERSION,
          type: 'hello.ack',
          instanceId: instance.instanceId,
          serverTime: Date.now(),
          heartbeatMs: 30000,
          resumeFromSeq: Number(frame.resumeFromSeq ?? 0),
        }
        instance.deliver(ack)
        // Subscribe to the streams a remote console wants by default. A real
        // backend would drive this from its own state.
        instance.deliver({
          v: PROTOCOL_VERSION,
          type: 'subscribe',
          id: randomUUID(),
          topics: ['instance', 'sessions', 'jobs', 'approvals'],
          sessions: Array.isArray(frame.subscriptions?.sessions) ? frame.subscriptions.sessions : [],
        })
        log('info', `instance ${instance.instanceId} said hello (plugin ${instance.instance.pluginVersion ?? '?'})`)
        return
      }
      case 'event':
        instance.record(frame)
        return
      case 'response':
        instance.settle(frame)
        return
      case 'ping':
        instance.deliver({ v: PROTOCOL_VERSION, type: 'pong', ts: Date.now() })
        return
      case 'ack':
        instance.serverAckSeq = frame.seq
        return
      case 'bye':
        // The HTTP carrier has no socket-close event, so an orderly shutdown is
        // only visible through this frame. Mark it rather than deleting the row:
        // a reconnect can already be in flight and would race a deletion.
        instance.disconnectedAt = Date.now()
        log('info', `instance ${instance.instanceId} said goodbye: ${frame.reason ?? ''}`)
        return
      case 'log':
        log(frame.level ?? 'info', `${instance.instanceId}: ${frame.message}`)
        return
      default:
        log('warn', `instance ${instance.instanceId} sent unknown frame type "${frame.type}"`)
    }
  }

  attachWebSocket(server, {
    path: `${basePath}/ws`,
    onConnection: onWebSocketConnection,
  })
  if (tlsServer) {
    attachWebSocket(tlsServer, { path: `${basePath}/ws`, onConnection: onWebSocketConnection })
  }

  /**
   * One WebSocket connection handler, shared by both listeners.
   *
   * @param {import('./ws.js').WebSocketConnection} connection upgraded socket.
   * @param {import('node:http').IncomingMessage} request upgrade request.
   */
  function onWebSocketConnection(connection, request) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    let instance
    let authenticated = false
    let helloTimer = setTimeout(() => connection.close(4408, 'hello timeout'), 15000)

    connection.on('message', (text) => {
      let frame
      try {
        frame = JSON.parse(text)
      } catch {
        connection.close(4400, 'invalid json')
        return
      }
      if (!authenticated) {
        if (frame?.type !== 'hello') {
          connection.close(4401, 'expected hello first')
          return
        }
        const header = request.headers.authorization
        const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : ''
        const key = frame.auth?.key || bearer || url.searchParams.get('key') || ''
        const entry = keys.authorize(key)
        if (!entry) {
          connection.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: 'error',
              code: 'unauthorized',
              message: 'unknown instance key: add it with POST /keys on the relay',
              fatal: true,
            }),
          )
          connection.close(4401, 'unauthorized')
          return
        }
        authenticated = true
        clearTimeout(helloTimer)
        helloTimer = undefined
        const instanceId = String(frame.instanceId ?? entry.instanceId ?? '')
        instance = new InstanceSession({ instanceId, hello: frame, keyEntry: entry })
        instance.connection = connection
        instance.tls = Boolean(tlsServer && request.socket.encrypted)
        instances.set(instanceId, instance)
        log(
          'info',
          `instance ${instanceId} connected over WebSocket${instance.tls ? ' (TLS)' : ''} (key ${fingerprint(entry.key)})`,
        )
      }
      ingest(instance, frame)
    })

    connection.on('close', () => {
      if (helloTimer) clearTimeout(helloTimer)
      if (instance && instance.connection === connection) {
        instance.connection = undefined
        instance.close()
        instances.delete(instance.instanceId)
        log('info', `instance ${instance.instanceId} disconnected`)
      }
    })
  }

  const tlsPort = tlsServer ? (options.tlsPort ?? (options.port === 0 ? 0 : (options.port ?? 8787) + 1)) : null
  const bindHost = options.host ?? '127.0.0.1'
  const listeners = [[server, options.port ?? 8787]]
  if (tlsServer) listeners.push([tlsServer, tlsPort])
  await Promise.all(
    listeners.map(
      ([target, port]) =>
        new Promise((resolve, reject) => {
          target.once('error', reject)
          target.listen(port, bindHost, () => {
            target.off('error', reject)
            resolve(undefined)
          })
        }),
    ),
  )
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  const tlsAddress = tlsServer?.address()
  const resolvedTlsPort = typeof tlsAddress === 'object' && tlsAddress ? tlsAddress.port : tlsPort
  return {
    server,
    tlsServer,
    port,
    tlsPort: resolvedTlsPort ?? null,
    basePath,
    httpUrl: `http://${bindHost}:${port}${basePath}`,
    httpsUrl: tlsServer ? `https://${bindHost}:${resolvedTlsPort}${basePath}` : null,
    // `url` stays the plain-HTTP endpoint so existing callers keep working.
    url: `http://${bindHost}:${port}${basePath}`,
    instances,
    keys,
    async close() {
      for (const instance of instances.values()) instance.close()
      instances.clear()
      await Promise.all(
        [server, tlsServer]
          .filter(Boolean)
          .map(
            (target) =>
              new Promise((resolve) => {
                /** @type {any} */
                const nodeServer = target
                nodeServer.close(resolve)
                // A relay must never hang on shutdown because a plugin is still
                // holding a socket open — force the remaining connections down.
                nodeServer.closeAllConnections?.()
              }),
          ),
      )
    },
  }
}

/**
 * Read a PEM value that may be a file path or an inline PEM document.
 *
 * @param {string} value path or inline PEM.
 * @returns {string} PEM text.
 */
function loadPem(value) {
  const text = String(value)
  if (text.includes('-----BEGIN')) return text
  return readFileSync(text, 'utf8')
}

/**
 * @param {import('node:http').IncomingMessage} request inbound request.
 * @returns {Promise<Record<string, any>>} parsed JSON body, or an empty object.
 */
async function readJson(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > 16 * 1024 * 1024) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * @param {import('node:http').ServerResponse} response outbound response.
 * @param {number} status HTTP status.
 * @param {unknown} body JSON body.
 */
function sendJson(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  response.end(text)
}

/** CLI entry point. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const readFlag = (name, fallback) => {
    const index = args.indexOf(`--${name}`)
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback
  }
  const tlsCert = readFlag('tls-cert', process.env.DSH_RELAY_TLS_CERT)
  const tlsKey = readFlag('tls-key', process.env.DSH_RELAY_TLS_KEY)
  const relay = await createRelayServer({
    port: Number(readFlag('port', process.env.DSH_RELAY_PORT ?? 8787)),
    host: readFlag('host', process.env.DSH_RELAY_HOST ?? '127.0.0.1'),
    tlsPort: readFlag('tls-port', process.env.DSH_RELAY_TLS_PORT)
      ? Number(readFlag('tls-port', process.env.DSH_RELAY_TLS_PORT))
      : undefined,
    tlsCert,
    tlsKey,
    keysFile: readFlag('keys', process.env.DSH_RELAY_KEYS),
    adminKey: readFlag('admin-key', process.env.DSH_RELAY_ADMIN_KEY),
  })
  console.log(`dsh2server reference relay`)
  console.log(`  HTTP  endpoint : ${relay.httpUrl}`)
  if (relay.httpsUrl) console.log(`  HTTPS endpoint : ${relay.httpsUrl}`)
  console.log(`  WebSocket      : ${(relay.httpsUrl ?? relay.httpUrl).replace('https', 'wss').replace('http', 'ws')}/ws`)
  console.log(`  management     : ${relay.httpUrl}/instances`)
  console.log(`  registered keys: ${relay.keys.list().length}`)
  console.log('')
  console.log('  Point the plugin at exactly one of the endpoints printed above, for example:')
  console.log(`    endpoint: '${relay.httpUrl}'    # or a list, to feed several relays at once`)
}
