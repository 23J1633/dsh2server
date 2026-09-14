/**
 * WebSocket carrier.
 *
 * Uses the platform `WebSocket` (Node 22+ ships undici's implementation as a
 * global), so the plugin keeps zero runtime dependencies. `authMode: 'header'`
 * is attempted through the non-standard options-object constructor and degrades
 * to a query parameter with a warning, because WHATWG WebSocket has no header
 * API.
 *
 * @module dsh2server/lib/transport/ws
 */

import { Transport, TRANSPORT_STATE } from './base.js'
import { joinUrl } from '../util.js'

/** Default time allowed for the TCP/TLS + WebSocket handshake. */
const HANDSHAKE_TIMEOUT_MS = 15000

/**
 * @param {string} base resolved WebSocket base URL.
 * @param {string} path configured path segment.
 * @returns {string} the absolute WebSocket URL.
 */
export function resolveWebSocketUrl(base, path) {
  return joinUrl(base, path)
}

/** WebSocket carrier implementing the plugin's transport contract. */
export class WebSocketTransport extends Transport {
  /**
   * @param {object} options carrier options.
   * @param {string} options.url absolute `ws(s)://` URL including any query string.
   * @param {Record<string, string>} [options.headers] handshake headers (best effort).
   * @param {import('../log.js').Logger} options.logger plugin logger.
   * @param {number} [options.maxPayloadBytes] outbound frame byte budget.
   * @param {number} [options.handshakeTimeoutMs] handshake budget.
   */
  constructor(options) {
    super(options)
    this.name = 'websocket'
    this.headers = options.headers ?? {}
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS
    /** @type {WebSocket | undefined} */
    this.socket = undefined
    /** @type {number} consecutive handshake failures, surfaced for diagnostics. */
    this.failures = 0
  }

  /**
   * @returns {boolean} whether a WebSocket implementation exists in this runtime.
   */
  static supported() {
    return typeof globalThis.WebSocket === 'function'
  }

  /**
   * Open the socket and resolve once the handshake completed.
   *
   * @returns {Promise<void>} resolves when the socket is open.
   */
  async connect() {
    if (!WebSocketTransport.supported()) {
      throw new Error('this Node runtime exposes no global WebSocket implementation')
    }
    this.state = TRANSPORT_STATE.CONNECTING
    const socket = this.#createSocket()
    this.socket = socket
    await new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.failures += 1
        reject(new Error(`WebSocket handshake timed out after ${this.handshakeTimeoutMs}ms`))
      }, this.handshakeTimeoutMs)
      const settle = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) {
          this.failures += 1
          reject(error)
        } else {
          resolve(undefined)
        }
      }
      socket.addEventListener('open', () => settle(undefined), { once: true })
      socket.addEventListener('error', (event) => settle(new Error(describeSocketError(event))), { once: true })
    }).catch((error) => {
      try {
        this.socket?.close()
      } catch {
        // Closing a socket that never opened is a no-op on some runtimes.
      }
      this.socket = undefined
      this.state = TRANSPORT_STATE.CLOSED
      throw error
    })

    this.failures = 0
    this.state = TRANSPORT_STATE.OPEN
    socket.addEventListener('message', (event) => {
      const frame = this.decode(typeof event.data === 'string' ? event.data : '')
      if (frame) this.emit('message', frame)
    })
    socket.addEventListener('close', (event) => {
      const wasOpen = this.state === TRANSPORT_STATE.OPEN
      this.state = TRANSPORT_STATE.CLOSED
      this.socket = undefined
      this.emit('close', {
        code: event?.code,
        reason: event?.reason ?? '',
        wasOpen,
      })
    })
    socket.addEventListener('error', (event) => {
      this.emit('error', Object.assign(new Error(describeSocketError(event)), { fatal: false }))
    })
    this.emit('open')
  }

  /**
   * Build the socket, preferring the header-capable constructor when headers are
   * configured and falling back to the standard one.
   *
   * @returns {WebSocket} the connecting socket.
   */
  #createSocket() {
    if (Object.keys(this.headers).length === 0) return new WebSocket(this.url)
    try {
      return new WebSocket(this.url, { headers: this.headers })
    } catch (error) {
      this.logger.warn(
        'this WebSocket implementation cannot set handshake headers; falling back to a headerless handshake —',
        String(error),
      )
      return new WebSocket(this.url)
    }
  }

  /**
   * @param {Record<string, unknown>} frame protocol frame.
   * @returns {boolean} whether the frame was written to the socket.
   */
  send(frame) {
    if (this.state !== TRANSPORT_STATE.OPEN || !this.socket) return false
    const encoded = this.encode(frame)
    if (!encoded.ok) {
      this.logger.warn(`dropped outbound ${String(frame?.type)} frame: ${encoded.reason}`)
      return false
    }
    try {
      this.socket.send(encoded.text)
      return true
    } catch (error) {
      this.emit('error', Object.assign(new Error(`WebSocket send failed: ${String(error)}`), { fatal: false }))
      return false
    }
  }

  /**
   * @param {string} [reason] close reason.
   * @returns {Promise<void>} resolves once the socket is closed.
   */
  async close(reason = 'bridge shutting down') {
    const socket = this.socket
    if (!socket) {
      this.state = TRANSPORT_STATE.CLOSED
      return
    }
    this.state = TRANSPORT_STATE.CLOSING
    this.socket = undefined
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000)
      socket.addEventListener(
        'close',
        () => {
          clearTimeout(timer)
          resolve(undefined)
        },
        { once: true },
      )
      try {
        socket.close(1000, String(reason).slice(0, 120))
      } catch {
        clearTimeout(timer)
        resolve(undefined)
      }
    })
    this.state = TRANSPORT_STATE.CLOSED
  }
}

/**
 * @param {unknown} event socket error event.
 * @returns {string} a human-readable description.
 */
function describeSocketError(event) {
  const message = /** @type {any} */ (event)?.message ?? /** @type {any} */ (event)?.error?.message
  if (typeof message === 'string' && message) return message
  return 'WebSocket error'
}
