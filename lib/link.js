/**
 * One relay link: everything that belongs to a single server endpoint.
 *
 * The plugin may be configured with several endpoints at once — for example a
 * plain `http://` relay on the LAN **and** an `https://` relay reachable from
 * the internet — and each of them gets its own independent `Link`. A link owns:
 *
 *   · its carrier (WebSocket or HTTP long-poll) and its own subscription set,
 *   · its own handshake, heartbeat, backoff, and replay watermark.
 *
 * Everything that is genuinely per-machine — identity, the outbound event
 * sequence, the replay buffer, host services, paused sessions, pending
 * approvals — stays on {@link import('./bridge.js').Bridge} and is shared by
 * every link, so two servers always see the same instance state and the same
 * event numbering no matter which one reconnects first.
 *
 * @module dsh2server/lib/link
 */

import { ERROR_CODES, SERVER_FRAMES, fail, makeBye, makeErrorResponse, makeHello, makePing, makeResponse, parseFrame } from './protocol.js'
import { carrierOrder, createTransport, resolveUrls } from './transport/index.js'
import { GLOBAL_TOPICS } from './config.js'
import { deferred, hostFacts, normalizeError, withTimeout } from './util.js'
import { PLUGIN_VERSION, PROTOCOL_VERSION } from './version.js'
import { resolveLocale } from './locale.js'

/** Sentinel used until the server names a heartbeat cadence. */
const DEFAULT_HEARTBEAT_FLOOR_MS = 5000
const DEFAULT_HEARTBEAT_CEILING_MS = 600000

/**
 * One connection to one relay endpoint.
 */
export class Link {
  /**
   * @param {object} options link options.
   * @param {import('./bridge.js').Bridge} options.bridge owning bridge.
   * @param {string} options.endpoint configured endpoint URL.
   * @param {import('./log.js').Logger} options.logger plugin logger.
   */
  constructor(options) {
    this.bridge = options.bridge
    this.config = options.bridge.config
    this.identity = options.bridge.identity
    this.host = options.bridge.host
    this.logger = options.logger
    this.configuredEndpoint = options.endpoint
    /** @type {object | undefined} resolved URLs for this endpoint. */
    this.urls = undefined
    /** @type {import('./transport/base.js').Transport | undefined} */
    this.transport = undefined
    this.connected = false
    this.disposed = false
    this.attempts = 0
    this.wsFailures = 0
    /** @type {Record<string, unknown> | undefined} */
    this.error = undefined
    /**
     * A fatal server rejection (bad key, revoked instance). Kept so the log and
     * `instance.health` report the real cause instead of the generic transport
     * error the closed socket produces moments later.
     *
     * @type {Record<string, unknown> | undefined}
     */
    this.rejection = undefined
    this.connectedSince = undefined
    this.lastInboundAt = 0
    this.connectedOnce = false
    /** @type {number | undefined} */
    this.heartbeatOverride = undefined
    this.serverAckSeq = 0
    this.serverSeq = 0
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.reconnectTimer = undefined
    /** @type {(() => void) | undefined} */
    this.reconnectResolve = undefined
    /** @type {ReturnType<typeof setInterval> | undefined} */
    this.heartbeatTimer = undefined
    /** @type {{promise: Promise<any>, resolve: Function, reject: Function} | undefined} */
    this.handshake = undefined
    /** @type {{promise: Promise<void>, resolve: Function} | undefined} */
    this.disconnected = undefined
    /** @type {Set<string>} */
    this.topics = new Set()
    /** @type {Set<string>} */
    this.sessions = new Set()
    /** @type {Set<string>} */
    this.assistantStreams = new Set()
  }

  /** @returns {string} the human-readable name of this link. */
  get name() {
    return this.urls?.endpoint ?? this.configuredEndpoint ?? '(unconfigured)'
  }

  /** @returns {boolean} whether this link can carry frames right now. */
  isConnected() {
    return this.connected && !this.disposed
  }

  /** @returns {Record<string, unknown>} a snapshot of this link's state. */
  describe() {
    return {
      endpoint: this.name,
      configuredEndpoint: this.configuredEndpoint,
      insecure: this.urls?.insecure === true,
      state: this.disposed ? 'disposed' : this.connected ? 'connected' : this.transport ? 'connecting' : 'idle',
      transport: this.transport?.name ?? null,
      connectedSince: this.connectedSince,
      attempts: this.attempts,
      wsFailures: this.wsFailures,
      lastInboundAt: this.lastInboundAt || null,
      serverAckSeq: this.serverAckSeq,
      subscriptions: this.subscriptions(),
      rejected: this.rejection ?? null,
      lastError: this.error ?? null,
    }
  }

  /** @returns {{topics: string[], sessions: string[], assistantStreams: string[]}} this link's subscriptions. */
  subscriptions() {
    return {
      topics: [...this.topics].sort(),
      sessions: [...this.sessions].sort(),
      assistantStreams: [...this.assistantStreams].sort(),
    }
  }

  /**
   * @param {string} topic topic name.
   * @param {string} [sessionId] session identity for per-session topics.
   * @returns {boolean} whether the server on this link asked for this stream.
   */
  wants(topic, sessionId) {
    if (topic === 'assistant') return sessionId !== undefined && this.assistantStreams.has(sessionId)
    if (sessionId !== undefined && this.sessions.has(sessionId)) return true
    return GLOBAL_TOPICS.includes(topic) && this.topics.has(topic)
  }

  /** Resolve the endpoint, start forwarding configuration, and begin connecting. */
  start() {
    if (this.disposed) return
    if (!this.#refreshUrls()) return
    this.applyAutoSubscribe()
    void this.#run()
  }

  /**
   * (Re)resolve this link's carrier URLs from the current identity.
   *
   * Called on every connection attempt, not once at start: `instance.rotateKey`
   * changes the key at runtime, and the HTTP carrier presents the key on every
   * request. Caching the URLs would keep offering a revoked key forever.
   *
   * @returns {boolean} whether the endpoint resolved.
   */
  #refreshUrls() {
    const urls = resolveUrls(this.config, this.identity.instanceId, this.identity.key, this.configuredEndpoint)
    if (!urls.ok) {
      if (this.error === undefined) {
        this.logger.error(`endpoint "${this.configuredEndpoint}" is unusable: ${urls.reason}`)
      }
      this.error = { code: ERROR_CODES.INVALID_PARAMS, message: urls.reason, at: Date.now() }
      return false
    }
    const first = this.urls === undefined
    this.urls = urls
    if (first && urls.insecure) {
      this.logger.warn(
        `endpoint ${urls.endpoint} uses plain HTTP: the instance key and all session traffic travel unencrypted. ` +
          'Use it only on a trusted network or a loopback relay.',
      )
    }
    return true
  }

  /**
   * Stop this link.
   *
   * @param {string} [reason] diagnostic reason.
   * @param {boolean} [sayGoodbye] whether to send a `bye` frame first.
   * @returns {Promise<void>} resolves once closed.
   */
  async close(reason = 'link shutting down', sayGoodbye = false) {
    if (this.disposed) return
    this.disposed = true
    this.connected = false
    clearTimeout(this.reconnectTimer)
    clearInterval(this.heartbeatTimer)
    this.reconnectTimer = undefined
    this.reconnectResolve?.()
    this.disconnected?.resolve()
    this.handshake?.reject(new Error(reason))
    const transport = this.transport
    this.transport = undefined
    if (transport) {
      try {
        if (sayGoodbye) transport.send(makeBye(reason))
        await transport.close(reason)
      } catch (error) {
        this.logger.debug(`${this.name}: transport close threw:`, String(error))
      }
    }
  }

  /**
   * Drop the carrier and re-establish this link.
   *
   * @param {string} reason diagnostic reason.
   * @returns {Promise<void>} resolves once the old carrier is closed.
   */
  async reconnect(reason) {
    if (this.disposed) return
    this.logger.info(`${this.name}: reconnecting (${reason})`)
    const transport = this.transport
    this.transport = undefined
    this.connected = false
    clearInterval(this.heartbeatTimer)
    this.disconnected?.resolve()
    this.handshake?.reject(new Error(reason))
    if (transport) await transport.close(reason).catch(() => undefined)
  }

  /**
   * Send one frame if this link is up.
   *
   * @param {Record<string, unknown>} frame protocol frame.
   * @returns {boolean} whether the frame was accepted by the carrier.
   */
  send(frame) {
    if (!this.connected || this.disposed) return false
    return this.transport?.send(frame) ?? false
  }

  // ── connection lifecycle ───────────────────────────────────────────────────

  /** The connect → hold → reconnect state machine for this endpoint. */
  async #run() {
    while (!this.disposed) {
      const connectedNow = await this.#attempt()
      if (this.disposed) return
      if (!connectedNow) {
        this.error = this.error ?? { code: 'connection_failed', message: 'the server could not be reached', at: Date.now() }
        if (!this.config.reconnect) {
          this.logger.error(`${this.name}: reconnection is disabled; this link stopped after one failed attempt`)
          return
        }
        this.#scheduleReconnect(this.error?.message ?? 'connect failed')
        await this.#waitForReconnect()
        continue
      }
      await this.#waitForDisconnect()
    }
  }

  /**
   * @returns {Promise<boolean>} whether a link was established.
   */
  async #attempt() {
    this.attempts += 1
    for (const kind of carrierOrder(this.config)) {
      if (this.disposed) return false
      try {
        await this.#connectOnce(kind)
        return true
      } catch (error) {
        const normalized = normalizeError(error)
        if (kind === 'ws') this.wsFailures += 1
        // A recorded rejection is the actionable cause; do not replace it with
        // the generic failure of the attempt that followed it.
        if (!this.rejection) {
          this.error = { code: 'connection_failed', message: normalized.message, at: Date.now() }
        }
        this.logger.warn(`${this.name}: ${kind} connect failed: ${normalized.message}`)
        const transport = this.transport
        this.transport = undefined
        if (transport) await transport.close('connect failed').catch(() => undefined)
      }
    }
    return false
  }

  /**
   * @param {'ws'|'http'} kind carrier kind.
   * @returns {Promise<void>} resolves once the handshake succeeded.
   */
  async #connectOnce(kind) {
    this.#refreshUrls()
    const transport = createTransport(kind, {
      config: this.config,
      instanceId: this.identity.instanceId,
      logger: this.logger,
      urls: this.urls,
    })
    this.transport = transport
    // Every handler is bound to THIS transport instance. A previous socket can
    // deliver its close/error event after its replacement is already
    // connecting, and without the guard it would clobber `this.transport` and
    // make the fresh handshake fail as "the carrier refused the hello frame".
    transport.on('message', (frame) => {
      if (this.transport === transport) this.#onFrame(frame)
    })
    transport.on('error', (error) => {
      if (this.transport === transport) this.#onTransportError(error)
    })
    transport.on('close', (info) => {
      if (this.transport === transport) this.#onTransportClose(info)
    })
    transport.on('heartbeat', () => {
      if (this.transport === transport) this.lastInboundAt = Date.now()
    })
    await transport.connect()
    if (this.disposed) {
      await transport.close('disposed during connect')
      throw new Error('the link was disposed during connect')
    }
    await this.#handshake()
  }

  /** Send `hello` and wait for `hello.ack`. */
  async #handshake() {
    const handshake = deferred()
    this.handshake = handshake
    const frame = makeHello({
      instanceId: this.identity.instanceId,
      ts: Date.now(),
      instance: this.host.instanceInfo(hostFacts(), {
        displayName: this.config.displayName || undefined,
        agentType: 'dsh',
        agentName: 'DeepSeek Harness',
        icon: 'dsh',
        deviceId: this.config.deviceId || undefined,
        locale: resolveLocale(this.config.locale),
        localeSetting: this.config.locale,
        pluginName: 'dsh2server',
        pluginVersion: PLUGIN_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        identityPersisted: this.identity.persistenceWarning === undefined,
        endpoints: this.config.endpoints,
      }),
      capabilities: this.host.capabilities(),
      key: this.config.authMode === 'hello' ? this.identity.key : undefined,
      lastSeq: this.bridge.lastSeq,
      resumeFromSeq: this.serverAckSeq,
      subscriptions: this.subscriptions(),
    })
    this.lastInboundAt = Date.now()
    if (!this.transport?.send(frame)) throw new Error('the carrier refused the hello frame')
    const ack = await withTimeout(handshake.promise, this.config.requestTimeoutMs, () =>
      fail(ERROR_CODES.TIMEOUT, `the server did not acknowledge hello within ${this.config.requestTimeoutMs}ms`),
    )
    if (this.handshake === handshake) this.handshake = undefined
    await this.#onHandshake(ack)
  }

  /**
   * @param {Record<string, any>} ack the `hello.ack` frame.
   */
  async #onHandshake(ack) {
    this.connected = true
    this.connectedSince = Date.now()
    this.attempts = 0
    this.wsFailures = 0
    this.error = undefined
    this.rejection = undefined
    this.disconnected = deferred()
    if (typeof ack.serverSeq === 'number') this.serverSeq = ack.serverSeq
    if (typeof ack.heartbeatMs === 'number' && ack.heartbeatMs > 0) {
      this.heartbeatOverride = Math.min(
        Math.max(Math.floor(ack.heartbeatMs), DEFAULT_HEARTBEAT_FLOOR_MS),
        DEFAULT_HEARTBEAT_CEILING_MS,
      )
    }
    this.#startHeartbeat()
    if (!this.connectedOnce) {
      this.connectedOnce = true
      this.logger.info(
        `connected to ${this.name} over ${this.transport?.name} as ${this.identity.instanceId} (key ${this.identity.fingerprint()})`,
      )
    } else {
      this.logger.info(`reconnected to ${this.name} over ${this.transport?.name}`)
    }

    this.#replayFrom(ack)
    this.applyAutoSubscribe()
    this.bridge.publish({
      topic: 'instance',
      kind: 'bridge/connected',
      data: {
        instanceId: this.identity.instanceId,
        endpoint: this.name,
        transport: this.transport?.name,
        protocol: PROTOCOL_VERSION,
        pluginVersion: PLUGIN_VERSION,
        at: Date.now(),
      },
    })
    await this.bridge.publishSnapshots(this, [...this.sessions])
  }

  /**
   * Replay buffered events the server says it missed.
   *
   * @param {Record<string, any>} ack the `hello.ack` frame.
   */
  #replayFrom(ack) {
    const resumeFrom = typeof ack.resumeFromSeq === 'number' ? ack.resumeFromSeq : undefined
    if (resumeFrom === undefined) return
    this.serverAckSeq = Math.max(this.serverAckSeq, resumeFrom)
    const outcome = this.bridge.replayTo(this, resumeFrom)
    if (outcome === 'gap') {
      this.logger.warn(
        `${this.name}: asked to resume from seq ${resumeFrom}, older than the retained buffer; sending a resync notice`,
      )
      this.bridge.publish({
        topic: 'instance',
        kind: 'bridge/resync',
        data: {
          endpoint: this.name,
          reason: 'resume window exceeded',
          requested: resumeFrom,
          retainedFrom: this.bridge.buffer.items[0]?.seq ?? null,
          lastSeq: this.bridge.lastSeq,
        },
      })
    } else if (outcome > 0) {
      this.logger.info(`${this.name}: replayed ${outcome} buffered event(s) the server missed`)
    }
  }

  /** Start or restart this link's heartbeat loop. */
  #startHeartbeat() {
    clearInterval(this.heartbeatTimer)
    const period = this.heartbeatOverride ?? this.config.heartbeatMs
    this.heartbeatTimer = setInterval(() => {
      if (!this.connected || this.disposed) return
      const silence = Date.now() - this.lastInboundAt
      if (silence > this.config.heartbeatTimeoutMs) {
        void this.reconnect(`no frame from the server for ${silence}ms`)
        return
      }
      this.transport?.send(makePing(Date.now()))
    }, period)
    this.heartbeatTimer.unref?.()
  }

  /**
   * @param {string} reason diagnostic reason recorded in the log.
   */
  #scheduleReconnect(reason) {
    if (this.disposed || this.reconnectTimer !== undefined) return
    const base = Math.min(
      this.config.reconnectMaxDelayMs,
      this.config.reconnectInitialDelayMs * this.config.reconnectFactor ** Math.max(0, this.attempts - 1),
    )
    const jitter = base * this.config.reconnectJitterRatio * (Math.random() * 2 - 1)
    const delayMs = Math.max(50, Math.round(base + jitter))
    this.logger.debug(`${this.name}: next connect attempt in ${delayMs}ms (${reason})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.reconnectResolve?.()
      this.reconnectResolve = undefined
    }, delayMs)
    this.reconnectTimer.unref?.()
  }

  /** @returns {Promise<void>} resolves when the scheduled backoff elapsed. */
  #waitForReconnect() {
    if (this.disposed) return Promise.resolve()
    if (this.reconnectTimer === undefined) return Promise.resolve()
    return new Promise((resolve) => {
      this.reconnectResolve = resolve
    })
  }

  /** @returns {Promise<void>} resolves when this link drops. */
  #waitForDisconnect() {
    if (this.disposed) return Promise.resolve()
    return this.disconnected?.promise ?? Promise.resolve()
  }

  // ── inbound ────────────────────────────────────────────────────────────────

  /**
   * @param {unknown} raw inbound frame.
   */
  #onFrame(raw) {
    this.lastInboundAt = Date.now()
    const parsed = parseFrame(raw)
    if (!parsed.ok) {
      this.logger.warn(`${this.name}: ignoring inbound frame: ${parsed.reason}`)
      const id = /** @type {any} */ (raw)?.id
      if (typeof id === 'string' && id !== '') {
        this.transport?.send(makeErrorResponse(id, fail(parsed.code, parsed.reason)))
      }
      return
    }
    const frame = parsed.frame
    if (typeof frame.seq === 'number' && Number.isFinite(frame.seq)) {
      this.serverSeq = Math.max(this.serverSeq, frame.seq)
    }
    switch (frame.type) {
      case SERVER_FRAMES.HELLO_ACK:
        this.handshake?.resolve(frame)
        break
      case SERVER_FRAMES.PONG:
        break
      case SERVER_FRAMES.ACK:
        if (typeof frame.seq === 'number') this.serverAckSeq = Math.max(this.serverAckSeq, frame.seq)
        break
      case SERVER_FRAMES.REQUEST:
        this.bridge.enqueueRequest(frame, this)
        break
      case SERVER_FRAMES.SUBSCRIBE:
        void this.#onSubscribe(frame)
        break
      case SERVER_FRAMES.UNSUBSCRIBE:
        this.#onUnsubscribe(frame)
        break
      case SERVER_FRAMES.ERROR:
        this.#onServerError(frame)
        break
      default:
        this.logger.debug(`${this.name}: ignoring unknown frame type "${frame.type}"`)
    }
  }

  /**
   * @param {Record<string, any>} frame `subscribe` frame.
   */
  async #onSubscribe(frame) {
    const id = typeof frame.id === 'string' && frame.id !== '' ? frame.id : undefined
    try {
      const topics = Array.isArray(frame.topics) ? frame.topics : []
      const sessions = Array.isArray(frame.sessions) ? frame.sessions : []
      const unknownTopics = topics.filter((topic) => !GLOBAL_TOPICS.includes(topic))
      if (unknownTopics.length > 0) {
        throw fail(ERROR_CODES.INVALID_PARAMS, `unknown topic(s) ${unknownTopics.join(', ')}`, {
          details: { allowed: GLOBAL_TOPICS },
        })
      }
      for (const topic of topics) this.topics.add(topic)

      const sessionIds = sessions.filter((value) => typeof value === 'string' && value !== '')
      const added = sessionIds.filter((sessionId) => !this.sessions.has(sessionId))
      for (const sessionId of sessionIds) this.sessions.add(sessionId)
      if (frame.assistantStream === true) {
        const targets = sessionIds.length > 0 ? sessionIds : [...this.sessions]
        for (const sessionId of targets) this.assistantStreams.add(sessionId)
      } else if (frame.assistantStream === false) {
        const targets = sessionIds.length > 0 ? sessionIds : [...this.assistantStreams]
        for (const sessionId of targets) this.assistantStreams.delete(sessionId)
      }

      const result = this.subscriptions()
      if (id) this.send(makeResponse(id, result))
      if (frame.snapshot !== false) await this.bridge.publishSnapshots(this, added)
    } catch (error) {
      if (id) this.send(makeErrorResponse(id, error))
      else this.logger.warn(`${this.name}: subscribe failed: ${String(error)}`)
    }
  }

  /**
   * @param {Record<string, any>} frame `unsubscribe` frame.
   */
  #onUnsubscribe(frame) {
    const id = typeof frame.id === 'string' && frame.id !== '' ? frame.id : undefined
    for (const topic of Array.isArray(frame.topics) ? frame.topics : []) this.topics.delete(topic)
    const removed = []
    for (const sessionId of Array.isArray(frame.sessions) ? frame.sessions : []) {
      if (typeof sessionId !== 'string') continue
      this.sessions.delete(sessionId)
      this.assistantStreams.delete(sessionId)
      removed.push(sessionId)
    }
    if (frame.assistantStream === false && !Array.isArray(frame.sessions)) this.assistantStreams.clear()
    if (id) this.send(makeResponse(id, { ...this.subscriptions(), removed }))
  }

  /**
   * @param {Record<string, any>} frame server `error` frame.
   */
  #onServerError(frame) {
    const code = typeof frame.code === 'string' ? frame.code : 'server_error'
    const message = typeof frame.message === 'string' ? frame.message : 'the server reported an error'
    if (frame.fatal === true) {
      this.rejection = { code, message, at: Date.now() }
      this.error = this.rejection
      this.logger.error(`${this.name}: server rejected the link: ${code} — ${message}`)
      void this.reconnect(`server error ${code}`)
      return
    }
    this.error = { code, message, at: Date.now() }
    this.logger.warn(`${this.name}: server error: ${code} — ${message}`)
  }

  /**
   * @param {any} error transport error.
   */
  #onTransportError(error) {
    // A recorded rejection is the actionable cause; the socket error that
    // follows it is a symptom and must not overwrite the explanation.
    if (!this.rejection) {
      this.error = { code: 'transport_error', message: String(error?.message ?? error), at: Date.now() }
    }
    if (error?.fatal === true) {
      this.logger.error(`${this.name}: transport reported a fatal error: ${String(error?.message ?? error)}`)
      void this.reconnect('fatal transport error')
      return
    }
    this.logger.warn(`${this.name}: transport error: ${String(error?.message ?? error)}`)
  }

  /**
   * @param {{code?: number, reason?: string, wasOpen?: boolean}} info close info.
   */
  #onTransportClose(info) {
    const wasConnected = this.connected
    this.connected = false
    clearInterval(this.heartbeatTimer)
    if (this.disposed) return
    const reason = `transport closed${info?.code ? ` (${info.code})` : ''}${info?.reason ? `: ${info.reason}` : ''}`
    if (wasConnected) {
      this.logger.warn(`${this.name}: ${reason}; reconnecting`)
      this.bridge.publish({
        topic: 'instance',
        kind: 'bridge/disconnected',
        data: { endpoint: this.name, reason, at: Date.now() },
      })
    }
    if (!this.rejection) this.error = { code: 'connection_failed', message: reason, at: Date.now() }
    this.transport = undefined
    this.topics.clear()
    this.sessions.clear()
    this.assistantStreams.clear()
    this.applyAutoSubscribe()
    this.handshake?.reject(new Error(reason))
    this.handshake = undefined
    this.disconnected?.resolve()
  }

  /** Apply the configured auto-subscribe policy to this link's subscription sets. */
  applyAutoSubscribe() {
    for (const topic of this.config.autoSubscribe) this.topics.add(topic)
    if (this.config.autoSubscribeSessions === 'none') return
    const sessions = this.host.service('sessions')
    const list = sessions?.list?.() ?? []
    for (const session of list) {
      const id = String(session?.id ?? '')
      if (!id) continue
      const agent = this.host.service('agents')?.get?.(id)
      if (this.config.autoSubscribeSessions === 'all' || agent?.status === 'running') {
        this.sessions.add(id)
        this.assistantStreams.add(id)
      }
    }
  }

  /**
   * Subscribe this link to a session that just started running.
   *
   * @param {string} sessionId session identity.
   */
  autoSubscribeRunning(sessionId) {
    if (this.config.autoSubscribeSessions === 'none' || this.disposed) return
    if (this.sessions.has(sessionId)) return
    this.sessions.add(sessionId)
    this.assistantStreams.add(sessionId)
    if (this.connected) void this.bridge.publishSnapshots(this, [sessionId])
  }
}
