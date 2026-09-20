/**
 * The bridge: machine-level state, and the links that carry it to servers.
 *
 * The split matters. A **bridge** is one dsh instance's relay identity: the
 * instance key, the outbound event sequence, the replay buffer, the host
 * services, the paused sessions, the pending approvals, and the method table.
 * A **link** ({@link import('./link.js').Link}) is one connection to one server
 * endpoint, with its own carrier, subscriptions, heartbeat, and backoff.
 *
 * Because the machine-level state is shared, configuring several endpoints —
 * a plain `http://` relay on the LAN and an `https://` relay reachable from
 * outside, for instance — gives every server the same instance, the same event
 * numbering, and the same answer to any operation, while each connection fails,
 * retries, and replays entirely on its own. One unreachable server never
 * disturbs the other.
 *
 * @module dsh2server/lib/bridge
 */

import { EventBuffer } from './buffer.js'
import { SessionGate } from './gate.js'
import { EventForwarder } from './forward.js'
import { HostAdapter } from './host.js'
import { Link } from './link.js'
import { createOperations } from './ops/index.js'
import { BridgeError, ERROR_CODES, makeErrorResponse, makeEvent, makeResponse } from './protocol.js'
import { delay, newId, toWireJson } from './util.js'

/** How many inbound requests may run concurrently. */
const MAX_IN_FLIGHT = 8

/** Bounded request queue; beyond this the server is told to retry. */
const MAX_QUEUED_REQUESTS = 256

/** How often the composition is re-probed while waiting for it to settle. */
const SETTLE_POLL_MS = 250

/** How long a stable capability set must hold before the first hello is sent. */
const SETTLE_STABLE_POLLS = 3

/** Hard cap on the settle wait, so a pathological tree never blocks a connection. */
const SETTLE_MAX_MS = 8000

/**
 * The relay bridge of one dsh instance.
 */
export class Bridge {
  /**
   * @param {object} options bridge options.
   * @param {any} options.ctx cordis context of the plugin fiber.
   * @param {Record<string, any>} options.config validated plugin config.
   * @param {import('./identity.js').Identity} options.identity resolved instance identity.
   * @param {import('./log.js').Logger} options.logger plugin logger.
   */
  constructor(options) {
    this.ctx = options.ctx
    this.config = options.config
    this.identity = options.identity
    this.logger = options.logger
    this.startedAt = Date.now()

    this.buffer = new EventBuffer(this.config.bufferSize)
    this.seq = 0
    this.disposed = false
    this.suspended = false
    /** @type {Link[]} */
    this.links = []
    /** @type {Array<Record<string, any>>} */
    this.queue = []
    this.inFlight = 0
    this.shutdown = new AbortController()

    this.host = new HostAdapter({
      ctx: this.ctx,
      logger: this.logger,
      config: this.config,
      lastActivity: (sessionId) => this.forwarder?.lastActivity(sessionId),
      publish: (event) => this.publish(event),
    })

    this.forwarder = new EventForwarder({
      ctx: this.ctx,
      host: this.host,
      config: this.config,
      logger: this.logger,
      publish: (event) => this.publish(event),
      isConnected: () => this.isConnected(),
      isSubscribed: (topic, sessionId) => this.isSubscribed(topic, sessionId),
    })

    this.gate = new SessionGate({
      logger: this.logger,
      limit: this.config.pauseQueueLimit,
      ensureAgent: (sessionId) => this.host.ensureAgent(sessionId),
      getGoal: (sessionId) => this.host.getGoal(sessionId),
      goalAction: (action, sessionId) => this.host.goalAction(action, sessionId),
      deliver: (sessionId, prompt) => this.host.prompt({ sessionId, ...prompt }, this.shutdown.signal),
    })

    this.operations = createOperations({
      config: this.config,
      logger: this.logger,
      host: this.host,
      bridge: this,
      identity: this.identity,
      forwarder: this.forwarder,
      gate: this.gate,
      startedAt: this.startedAt,
      publish: (event) => this.publish(event),
    })
  }

  /** @returns {number} the highest event sequence number produced so far. */
  get lastSeq() {
    return this.seq
  }

  /** @returns {boolean} whether at least one endpoint is connected. */
  isConnected() {
    return !this.disposed && this.links.some((link) => link.isConnected())
  }

  /** @returns {Link | undefined} the first connected link, when any. */
  primaryLink() {
    return this.links.find((link) => link.isConnected()) ?? this.links[0]
  }

  /** @returns {Record<string, unknown>} a snapshot of the whole relay state. */
  describe() {
    return {
      state: this.disposed
        ? 'disposed'
        : this.suspended
          ? 'suspended'
        : this.isConnected()
          ? 'connected'
          : this.links.some((link) => link.transport)
            ? 'connecting'
            : 'idle',
      instanceId: this.identity.instanceId,
      keyFingerprint: this.identity.fingerprint(),
      endpoints: this.config.endpoints,
      connectedLinks: this.links.filter((link) => link.isConnected()).length,
      links: this.links.map((link) => link.describe()),
      lastSeq: this.seq,
      methods: this.operations.methods,
    }
  }

  /** @returns {Array<Record<string, unknown>>} the most recent error per link. */
  lastError() {
    const errors = this.links.map((link) => link.error).filter(Boolean)
    return errors.length > 0 ? errors[errors.length - 1] : null
  }

  /** @returns {Record<string, unknown>} buffer statistics for health reporting. */
  bufferStats() {
    return {
      size: this.buffer.items.length,
      limit: this.buffer.limit,
      dropped: this.buffer.dropped,
      lastSeq: this.seq,
    }
  }

  /** @returns {{topics: string[], sessions: string[], assistantStreams: string[]}} the union of every link's subscriptions. */
  subscriptions() {
    const topics = new Set()
    const sessions = new Set()
    const assistantStreams = new Set()
    for (const link of this.links) {
      for (const topic of link.topics) topics.add(topic)
      for (const sessionId of link.sessions) sessions.add(sessionId)
      for (const sessionId of link.assistantStreams) assistantStreams.add(sessionId)
    }
    return { topics: [...topics].sort(), sessions: [...sessions].sort(), assistantStreams: [...assistantStreams].sort() }
  }

  /**
   * @param {string} topic topic name.
   * @param {string} [sessionId] session identity for per-session topics.
   * @returns {boolean} whether any connected server asked for this stream.
   */
  isSubscribed(topic, sessionId) {
    return this.links.some((link) => link.isConnected() && link.wants(topic, sessionId))
  }

  /** Build one link per configured endpoint and start them all. */
  start() {
    if (this.disposed) return
    this.forwarder.start()
    // Follow sessions that start running so a backend subscribing to "running
    // work" keeps receiving their events without polling the session list.
    this.ctx.on('agent/status', (payload) => {
      if (payload?.status === 'running' && payload?.agent?.id) {
        for (const link of this.links) link.autoSubscribeRunning(String(payload.agent.id))
      }
    })
    void this.#settleThenSpawn()
  }

  /**
   * Wait for the composition to settle, then open the links.
   *
   * This plugin mounts as one bundle layer among many, and its `apply` can run
   * while the rest of the tree is still coming up. A `hello` built at that
   * moment advertises a capability set missing every service that mounts a
   * heartbeat later — and a server lights its UI from exactly that set, so the
   * machine would look far less capable than it is until the next reconnect.
   * Waiting for the probe to hold still costs a fraction of a second in a
   * healthy deployment and is capped so it can never hold up a connection.
   *
   * @returns {Promise<void>} resolves once the links have been spawned.
   */
  async #settleThenSpawn() {
    const deadline = Date.now() + SETTLE_MAX_MS
    let previous = JSON.stringify(this.host.capabilities())
    let stable = 0
    while (!this.disposed && stable < SETTLE_STABLE_POLLS && Date.now() < deadline) {
      await delay(SETTLE_POLL_MS)
      if (this.disposed) return
      const next = JSON.stringify(this.host.capabilities())
      stable = next === previous ? stable + 1 : 0
      previous = next
    }
    if (this.disposed) return
    this.#spawnLinks()
  }

  /**
   * Re-read the configuration and reconnect every link.
   *
   * Used when the web console changes the endpoint list. The machine-level state
   * (identity, event sequence, replay buffer, parked prompts, forwarded
   * listeners) is deliberately left alone, so a configuration change costs one
   * reconnection and can never duplicate event forwarding.
   *
   * @returns {Promise<void>} resolves once the old links are closed and the new
   *   ones have begun connecting.
   */
  async applyConfig() {
    if (this.disposed) return
    const previous = this.links
    this.links = []
    // Say goodbye on the way out: on the HTTP carrier a `bye` frame is the only
    // signal that lets the old server mark this machine as gone instead of
    // leaving it looking connected until its own liveness window expires.
    await Promise.all(previous.map((link) => link.close('configuration changed', true)))
    if (this.disposed) return
    this.#spawnLinks()
  }

  /** Build one link per configured endpoint and start them. */
  #spawnLinks() {
    if (this.suspended) {
      this.logger.info('the relay bridge is suspended; no links will be opened')
      return
    }
    const endpoints = this.config.endpoints ?? []
    if (endpoints.length === 0) {
      this.logger.warn('no endpoint is configured; the relay bridge stays idle until one is set')
      return
    }
    this.links = endpoints.map((endpoint) => new Link({ bridge: this, endpoint, logger: this.logger }))
    for (const link of this.links) link.start()
  }

  /**
   * Force every link to reconnect.
   *
   * @param {string} reason diagnostic reason.
   * @returns {Promise<void>} resolves once every carrier was closed.
   */
  async reconnect(reason) {
    if (this.suspended) {
      await this.resume(reason)
      return
    }
    await Promise.all(this.links.map((link) => link.reconnect(reason)))
  }

  /**
   * Stop every relay link while keeping the Harness host and plugin loaded.
   *
   * This is the local-control equivalent of stopping the standalone Claude or
   * Codex bridge: sessions remain available in DSH, but the server can no
   * longer reach them until {@link resume} is called.
   *
   * @param {string} [reason] operator-facing disconnect reason.
   * @returns {Promise<void>} resolves after every link has sent its goodbye.
   */
  async suspend(reason = 'suspended by local control') {
    if (this.disposed || this.suspended) return
    this.suspended = true
    const previous = this.links
    this.links = []
    await Promise.all(previous.map((link) => link.close(reason, true)))
    this.logger.info('relay bridge suspended; the Harness host remains running')
  }

  /**
   * Resume a locally suspended bridge without restarting the Harness host.
   *
   * @param {string} [_reason] operator-facing reason retained for API symmetry.
   * @returns {Promise<void>} resolves once new links have begun connecting.
   */
  async resume(_reason = 'resumed by local control') {
    if (this.disposed) return
    if (!this.suspended && this.links.length > 0) return
    this.suspended = false
    this.#spawnLinks()
    this.logger.info('relay bridge resumed')
  }

  /**
   * Recreate all relay links, resuming the bridge first when it was suspended.
   *
   * @param {string} [reason] operator-facing disconnect reason.
   * @returns {Promise<void>} resolves once replacement links begin connecting.
   */
  async restart(reason = 'restarted by local control') {
    if (this.disposed) return
    this.suspended = false
    const previous = this.links
    this.links = []
    await Promise.all(previous.map((link) => link.close(reason, true)))
    if (!this.disposed) this.#spawnLinks()
    this.logger.info('relay bridge restarted')
  }

  /** Tear everything down: links, forwarded events, parked prompts. */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.shutdown.abort(new Error('plugin unloading'))
    this.forwarder.dispose()
    const dropped = this.gate.clear()
    if (dropped > 0) this.logger.warn(`discarded ${dropped} prompt(s) parked behind a pause at unload`)
    await Promise.all(this.links.map((link) => link.close('plugin unloading', true)))
    this.links = []
  }

  // ── outbound ───────────────────────────────────────────────────────────────

  /**
   * Assign a sequence number, buffer once, and fan out to the links that asked
   * for this stream.
   *
   * @param {object} input event fields.
   * @param {string} input.topic topic name.
   * @param {string} input.kind `<domain>/<action>` event name.
   * @param {unknown} input.data event payload.
   * @param {string} [input.sessionId] addressed session.
   * @param {Link} [input.target] send only to this link (used for subscribe snapshots).
   */
  publish(input) {
    if (this.disposed) return
    const safe = this.#safeData(input.data)
    const frame = { ...this.#eventFrame(input, safe.data) }
    if (safe.truncated) frame.truncated = safe.truncated
    this.buffer.push(frame)
    const targets = input.target ? [input.target] : this.links
    for (const link of targets) {
      if (!link.isConnected()) continue
      if (!input.target && !link.wants(input.topic, input.sessionId)) continue
      link.send(frame)
    }
  }

  /**
   * @param {object} input event fields.
   * @param {unknown} data wire-safe payload.
   * @returns {Record<string, unknown>} the event frame.
   */
  #eventFrame(input, data) {
    return makeEvent({
      seq: ++this.seq,
      topic: input.topic,
      kind: input.kind,
      sessionId: input.sessionId,
      ts: Date.now(),
      data,
    })
  }

  /**
   * Publish a baseline snapshot for each session to one link.
   *
   * @param {Link} link target link.
   * @param {string[]} sessionIds sessions to snapshot.
   * @returns {Promise<void>} resolves once every snapshot was published.
   */
  async publishSnapshots(link, sessionIds) {
    for (const sessionId of sessionIds) {
      try {
        const detail = this.host.sessionDetail(sessionId)
        this.publish({
          topic: 'session',
          kind: 'session/snapshot',
          sessionId,
          target: link,
          data: {
            ...detail,
            paused: this.gate.isPaused(sessionId),
            queuedPrompts: this.gate.queuedCount(sessionId),
          },
        })
      } catch (error) {
        this.logger.debug(`snapshot for ${sessionId} failed:`, String(error))
      }
    }
  }

  /**
   * Replay buffered events to one link.
   *
   * @param {Link} link target link.
   * @param {number} resumeFrom the watermark the server reported.
   * @returns {number | 'gap'} how many frames were replayed, or `'gap'` when the
   *   requested watermark is older than anything still buffered.
   */
  replayTo(link, resumeFrom) {
    if (!this.buffer.canResumeFrom(resumeFrom)) return 'gap'
    const replay = this.buffer.since(resumeFrom)
    for (const frame of replay) link.send(frame)
    return replay.length
  }

  /**
   * Guarantee one payload is JSON-serializable and inside the frame budget.
   *
   * Oversized payloads are replaced by a small marker rather than dropped, so a
   * backend still learns that something happened and can fetch details through a
   * request method (`session.history`, `job.read`).
   *
   * @param {unknown} data candidate payload.
   * @returns {{data: unknown, truncated?: Record<string, unknown>}} wire-safe payload.
   */
  #safeData(data) {
    const budget = Math.max(1024, Math.floor(this.config.maxPayloadBytes * 0.9))
    const encoded = toWireJson(data, { maxBytes: budget })
    if (encoded.ok) return { data: encoded.value }
    const plain = toWireJson(data)
    const bytes = plain.ok ? Buffer.byteLength(JSON.stringify(plain.value), 'utf8') : undefined
    return {
      data: null,
      truncated: { reason: encoded.reason, bytes, maxPayloadBytes: this.config.maxPayloadBytes },
    }
  }

  // ── request dispatch ───────────────────────────────────────────────────────

  /**
   * @param {Record<string, any>} frame `request` frame.
   * @param {Link} link link the request arrived on.
   */
  enqueueRequest(frame, link) {
    if (this.queue.length >= MAX_QUEUED_REQUESTS) {
      const id = typeof frame.id === 'string' && frame.id !== '' ? frame.id : undefined
      if (id) {
        link.send(
          makeErrorResponse(
            id,
            new BridgeError(ERROR_CODES.RATE_LIMITED, 'too many requests queued; retry shortly', { retryable: true }),
          ),
        )
      }
      return
    }
    this.queue.push({ frame, link })
    this.#drainQueue()
  }

  /** Start queued requests while concurrency allows. */
  #drainQueue() {
    while (this.inFlight < MAX_IN_FLIGHT && this.queue.length > 0) {
      const entry = /** @type {{frame: Record<string, any>, link: Link}} */ (this.queue.shift())
      this.inFlight += 1
      void this.#runRequest(entry.frame, entry.link).finally(() => {
        this.inFlight -= 1
        this.#drainQueue()
      })
    }
  }

  /**
   * @param {Record<string, any>} frame `request` frame.
   * @param {Link} link link that must receive the response.
   */
  async #runRequest(frame, link) {
    const id = typeof frame.id === 'string' && frame.id !== '' ? frame.id : newId()
    const method = frame.method
    if (typeof method !== 'string' || method === '') {
      link.send(
        makeErrorResponse(id, new BridgeError(ERROR_CODES.BAD_REQUEST, 'request.method must be a non-empty string')),
      )
      return
    }
    const controller = new AbortController()
    const onShutdown = () => controller.abort(new Error('bridge disposing'))
    this.shutdown.signal.addEventListener('abort', onShutdown, { once: true })
    try {
      this.logger.debug(`→ ${method} (${link.name})`)
      const outcome = await this.operations.dispatch(method, frame.params, {
        requestId: id,
        signal: controller.signal,
        link,
      })
      if (outcome.ok) {
        link.send(makeResponse(id, outcome.result))
        this.logger.debug(`← ${method} ok`)
      } else {
        const wire = outcome.error ?? { code: ERROR_CODES.INTERNAL, message: 'unknown failure' }
        if (wire.code !== ERROR_CODES.INTERNAL) this.logger.debug(`← ${method} ${wire.code}: ${wire.message}`)
        else this.logger.warn(`← ${method} failed internally: ${wire.message}`)
        link.send(
          makeErrorResponse(
            id,
            new BridgeError(wire.code, wire.message, { retryable: wire.retryable, details: wire.details }),
          ),
        )
      }
    } catch (error) {
      link.send(makeErrorResponse(id, error))
    } finally {
      this.shutdown.signal.removeEventListener('abort', onShutdown)
    }
  }
}
