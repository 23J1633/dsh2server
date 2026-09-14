/**
 * HTTP long-poll carrier — the fallback used when WebSocket is unavailable or
 * blocked by a proxy.
 *
 * Two endpoints carry the same envelopes as the WebSocket carrier:
 *
 *   POST <eventsPath>   batched uplink of plugin → server frames
 *   GET  <inboxPath>    long-poll downlink of server → plugin frames
 *
 * The `hello` handshake still runs through these endpoints, so a backend
 * implements one protocol and chooses its carrier. Frames are batched
 * (`batchSize` / `batchIntervalMs`) because per-frame POSTs would be wasteful
 * on a link that streams tool output.
 *
 * @module dsh2server/lib/transport/http
 */

import { Transport, TRANSPORT_STATE } from './base.js'
import { delay, joinUrl, normalizeError } from '../util.js'

/** Consecutive carrier failures tolerated before the bridge is told to reconnect. */
const MAX_FAILURE_STREAK = 5

/** HTTP carrier implementing the plugin's transport contract. */
export class HttpTransport extends Transport {
  /**
   * @param {object} options carrier options.
   * @param {string} options.baseUrl absolute HTTP base URL of the server API.
   * @param {string} options.eventsPath uplink path.
   * @param {string} options.inboxPath downlink path.
   * @param {Record<string, string>} [options.headers] extra request headers.
   * @param {string} [options.queryKey] key appended to request URLs (`authMode: 'query'`).
   * @param {string} options.instanceId instance identity echoed on every request.
   * @param {number} [options.batchSize] frames per uplink request.
   * @param {number} [options.batchIntervalMs] maximum uplink delay.
   * @param {number} [options.pollWaitMs] server-side long-poll hold time.
   * @param {number} [options.requestTimeoutMs] client-side per-request budget.
   * @param {import('../log.js').Logger} options.logger plugin logger.
   * @param {number} [options.maxPayloadBytes] outbound frame byte budget.
   */
  constructor(options) {
    super(options)
    this.name = 'http'
    this.baseUrl = options.baseUrl
    this.eventsUrl = joinUrl(options.baseUrl, options.eventsPath)
    this.inboxUrl = joinUrl(options.baseUrl, options.inboxPath)
    this.headers = options.headers ?? {}
    this.queryKey = options.queryKey ?? ''
    this.instanceId = options.instanceId
    this.batchSize = options.batchSize ?? 50
    this.batchIntervalMs = options.batchIntervalMs ?? 200
    this.pollWaitMs = options.pollWaitMs ?? 25000
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30000
    /** @type {Array<Record<string, unknown>>} */
    this.outbox = []
    this.cursor = 0
    this.closed = false
    this.failures = 0
    /** @type {AbortController | undefined} */
    this.abort = undefined
    /** @type {Promise<void> | undefined} */
    this.pollLoop = undefined
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.flushTimer = undefined
    this.flushing = false
    this.stopping = false
  }

  /**
   * Mark the carrier open and start the downlink loop. There is no handshake to
   * await: the first uplink request delivers `hello`, and a rejection surfaces
   * through the normal error path.
   *
   * @returns {Promise<void>} always resolves.
   */
  async connect() {
    this.state = TRANSPORT_STATE.OPEN
    this.closed = false
    this.stopping = false
    this.abort = new AbortController()
    this.pollLoop = this.#runPollLoop()
    this.emit('open')
  }

  /**
   * @param {Record<string, unknown>} frame protocol frame.
   * @returns {boolean} whether the frame was queued (HTTP can always queue).
   */
  send(frame) {
    if (this.state !== TRANSPORT_STATE.OPEN) return false
    this.outbox.push(frame)
    if (this.outbox.length >= this.batchSize) {
      void this.flush()
    } else {
      this.#scheduleFlush()
    }
    return true
  }

  /** Ensure a flush happens within `batchIntervalMs` even at low traffic. */
  #scheduleFlush() {
    if (this.flushTimer !== undefined) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flush()
    }, Math.max(0, this.batchIntervalMs))
    this.flushTimer.unref?.()
  }

  /**
   * Deliver queued frames in one POST.
   *
   * Frames are moved to an in-flight map before the request and re-queued at the
   * head on failure, so a transient network error loses nothing while the ring
   * buffer in the bridge still bounds total memory.
   *
   * @returns {Promise<void>} resolves when the flush attempt settled.
   */
  async flush() {
    if (this.flushing || this.closed || this.state !== TRANSPORT_STATE.OPEN) return
    const batch = this.outbox.splice(0, this.batchSize)
    if (batch.length === 0) return
    this.flushing = true
    try {
      const response = await this.#request('POST', this.eventsUrl, {
        body: JSON.stringify({
          v: 1,
          instanceId: this.instanceId,
          frames: batch,
          lastServerCursor: this.cursor,
        }),
      })
      if (response.status === 401 || response.status === 403) {
        this.failures += 1
        this.emit(
          'error',
          Object.assign(new Error(`server rejected the uplink with HTTP ${response.status}`), {
            fatal: true,
            status: response.status,
          }),
        )
      } else if (response.status >= 400) {
        throw new Error(`uplink failed with HTTP ${response.status}`)
      }
      this.failures = 0
    } catch (error) {
      this.outbox.unshift(...batch)
      const normalized = normalizeError(error)
      this.failures += 1
      this.emit('error', Object.assign(new Error(`uplink failed: ${normalized.message}`), { fatal: false }))
      if (this.failures >= MAX_FAILURE_STREAK) {
        this.#fail(normalized.message)
        return
      }
      await delay(Math.min(5000, 250 * this.failures))
    } finally {
      this.flushing = false
    }
    if (this.outbox.length > 0) this.#scheduleFlush()
  }

  /**
   * @returns {Promise<void>} resolves when the downlink loop exits.
   */
  async #runPollLoop() {
    while (!this.closed) {
      try {
        const url = this.#withQuery(this.inboxUrl, {
          instanceId: this.instanceId,
          cursor: String(this.cursor),
          waitMs: String(this.pollWaitMs),
        })
        const response = await this.#request('GET', url, {})
        if (response.status === 401 || response.status === 403) {
          this.emit(
            'error',
            Object.assign(new Error(`server rejected the downlink with HTTP ${response.status}`), {
              fatal: true,
              status: response.status,
            }),
          )
          await delay(5000)
          continue
        }
        if (response.status === 204) {
          this.failures = 0
          continue
        }
        if (response.status >= 400) throw new Error(`downlink failed with HTTP ${response.status}`)
        const payload = await response.json().catch(() => undefined)
        this.failures = 0
        // A successful poll proves the server is alive even when it has nothing
        // to say, which is what the bridge's heartbeat watchdog watches.
        this.emit('heartbeat')
        if (!payload || typeof payload !== 'object') continue
        if (typeof payload.cursor === 'number' && Number.isFinite(payload.cursor)) {
          this.cursor = Math.max(this.cursor, payload.cursor)
        }
        const frames = Array.isArray(payload.frames) ? payload.frames : []
        for (const frame of frames) {
          if (this.closed) return
          if (frame && typeof frame === 'object' && !Array.isArray(frame)) this.emit('message', frame)
        }
        if (typeof payload.waitMs === 'number' && payload.waitMs >= 0) this.pollWaitMs = Math.floor(payload.waitMs)
      } catch (error) {
        if (this.closed) return
        const normalized = normalizeError(error)
        this.failures += 1
        this.emit('error', Object.assign(new Error(`downlink failed: ${normalized.message}`), { fatal: false }))
        if (this.failures >= MAX_FAILURE_STREAK) {
          this.#fail(normalized.message)
          return
        }
        await delay(Math.min(5000, 250 * this.failures))
      }
    }
  }

  /**
   * Transition to failed: tell the bridge to reconnect, keeping queued frames.
   *
   * @param {string} reason failure summary.
   */
  #fail(reason) {
    if (this.closed) return
    this.closed = true
    this.state = TRANSPORT_STATE.CLOSED
    this.emit('close', { code: 1006, reason, wasOpen: true })
  }

  /**
   * @param {'GET'|'POST'} method HTTP method.
   * @param {string} url absolute URL.
   * @param {{body?: string}} options request options.
   * @returns {Promise<Response>} the response.
   */
  async #request(method, url, options) {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    this.abort?.signal.addEventListener('abort', onAbort, { once: true })
    const timeoutMs = method === 'GET' ? this.pollWaitMs + this.requestTimeoutMs : this.requestTimeoutMs
    const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs))
    try {
      return await fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...this.headers,
        },
        body: options.body,
        signal: controller.signal,
        redirect: 'error',
      })
    } finally {
      clearTimeout(timer)
      this.abort?.signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * @param {string} url absolute URL.
   * @param {Record<string, string>} params query parameters.
   * @returns {string} the URL with query parameters applied.
   */
  #withQuery(url, params) {
    const parsed = new URL(url)
    for (const [key, value] of Object.entries(params)) parsed.searchParams.set(key, value)
    if (this.queryKey) parsed.searchParams.set('key', this.queryKey)
    return parsed.toString()
  }

  /**
   * @param {string} [reason] close reason.
   * @returns {Promise<void>} resolves once loops stopped.
   */
  async close(reason = 'bridge shutting down') {
    if (this.closed && this.state === TRANSPORT_STATE.CLOSED) return
    this.stopping = true
    this.closed = true
    this.state = TRANSPORT_STATE.CLOSING
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    // One last best-effort uplink so buffered frames are not silently dropped.
    const pending = this.outbox.splice(0, this.batchSize)
    if (pending.length > 0 && this.abort && !this.abort.signal.aborted) {
      try {
        await fetch(this.eventsUrl, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json', ...this.headers },
          body: JSON.stringify({ v: 1, instanceId: this.instanceId, frames: pending, lastServerCursor: this.cursor, closing: true }),
          signal: AbortSignal.timeout(3000),
        })
      } catch {
        // Shutdown must never throw; the server will simply miss these frames.
      }
    }
    this.abort?.abort()
    try {
      await this.pollLoop
    } catch {
      // The loop already reports through events.
    }
    this.abort = undefined
    this.pollLoop = undefined
    this.state = TRANSPORT_STATE.CLOSED
    this.logger.debug(`http transport closed (${reason})`)
  }
}
