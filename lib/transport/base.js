/**
 * Transport contract shared by the WebSocket and HTTP carriers.
 *
 * A transport owns exactly one concern: moving already-built protocol frames
 * between the plugin and the server. It knows nothing about sessions, agents,
 * or methods, so the two carriers are interchangeable and the bridge above them
 * stays carrier-agnostic.
 *
 * @module dsh2server/lib/transport/base
 */

/** Transport lifecycle states. */
export const TRANSPORT_STATE = Object.freeze({
  CLOSED: 'closed',
  CONNECTING: 'connecting',
  OPEN: 'open',
  CLOSING: 'closing',
})

/**
 * Base class: callback registry plus the state machine every carrier shares.
 *
 * Subclasses implement {@link Transport.connect}, {@link Transport.send}, and
 * {@link Transport.close}.
 */
export class Transport {
  /**
   * @param {object} options transport options.
   * @param {string} options.url absolute carrier URL.
   * @param {import('../log.js').Logger} options.logger plugin logger.
   * @param {number} options.maxPayloadBytes outbound frame byte budget.
   */
  constructor(options) {
    /** @type {string} */
    this.url = options.url
    /** @type {import('../log.js').Logger} */
    this.logger = options.logger
    /** @type {number} */
    this.maxPayloadBytes = options.maxPayloadBytes ?? 0
    /** @type {string} */
    this.state = TRANSPORT_STATE.CLOSED
    /** @type {Map<string, Set<Function>>} */
    this.handlers = new Map()
    /** @type {string} human-readable carrier name used in diagnostics. */
    this.name = 'transport'
  }

  /**
   * Register a listener. Supported events: `open`, `message`, `close`, `error`.
   *
   * @param {string} event event name.
   * @param {Function} handler listener.
   * @returns {() => void} disposer removing the listener.
   */
  on(event, handler) {
    const set = this.handlers.get(event) ?? new Set()
    set.add(handler)
    this.handlers.set(event, set)
    return () => set.delete(handler)
  }

  /**
   * Invoke every listener for one event, containing each failure so one bad
   * listener cannot break the carrier.
   *
   * @param {string} event event name.
   * @param {...unknown} args listener arguments.
   */
  emit(event, ...args) {
    const set = this.handlers.get(event)
    if (!set) return
    for (const handler of [...set]) {
      try {
        handler(...args)
      } catch (error) {
        this.logger.error(`listener for "${event}" threw:`, error)
      }
    }
  }

  /** Remove every listener. */
  removeAllListeners() {
    this.handlers.clear()
  }

  /**
   * Open the carrier.
   *
   * @returns {Promise<void>} resolves once the carrier can send frames.
   */
  async connect() {
    throw new Error('connect() not implemented')
  }

  /**
   * Hand one frame to the carrier. Must never throw: a full or closing carrier
   * reports `false` so the caller can decide whether to buffer.
   *
   * @param {Record<string, unknown>} frame protocol frame.
   * @returns {boolean} whether the frame was accepted for delivery.
   */
  send() {
    return false
  }

  /**
   * Close the carrier.
   *
   * @param {string} [reason] diagnostic reason.
   * @returns {Promise<void>} resolves once closed.
   */
  async close() {
    this.state = TRANSPORT_STATE.CLOSED
  }

  /**
   * Serialize one frame with the payload budget applied.
   *
   * @param {Record<string, unknown>} frame protocol frame.
   * @returns {{ok: true, text: string} | {ok: false, reason: string}} outcome.
   */
  encode(frame) {
    let text
    try {
      text = JSON.stringify(frame)
    } catch (error) {
      return { ok: false, reason: `frame is not JSON-serializable: ${String(error)}` }
    }
    if (typeof text !== 'string') return { ok: false, reason: 'frame encodes to a non-string value' }
    if (this.maxPayloadBytes > 0 && Buffer.byteLength(text, 'utf8') > this.maxPayloadBytes) {
      return { ok: false, reason: `frame exceeds maxPayloadBytes (${this.maxPayloadBytes})` }
    }
    return { ok: true, text }
  }

  /**
   * Parse one inbound carrier payload.
   *
   * @param {string} text raw payload.
   * @returns {Record<string, unknown> | undefined} the parsed frame, or undefined when unusable.
   */
  decode(text) {
    if (typeof text !== 'string' || text.length === 0) return undefined
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        this.logger.warn('dropped inbound payload: not a JSON object')
        return undefined
      }
      return parsed
    } catch (error) {
      this.logger.warn('dropped inbound payload: invalid JSON —', String(error))
      return undefined
    }
  }
}
