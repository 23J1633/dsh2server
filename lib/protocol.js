/**
 * The wire protocol: envelope constructors, error vocabulary, and validation.
 *
 * The protocol is deliberately tiny and transport-agnostic. Every frame is one
 * JSON object with a `type` discriminator and `v` (protocol version); the same
 * objects travel as WebSocket text frames or as HTTP request/response bodies,
 * so a backend can be written against either carrier without changing a field.
 *
 * @module dsh2server/lib/protocol
 */

import { PROTOCOL_VERSION } from './version.js'
import { normalizeError } from './util.js'

/**
 * Frame types the plugin sends to the server.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const CLIENT_FRAMES = Object.freeze({
  HELLO: 'hello',
  PING: 'ping',
  EVENT: 'event',
  RESPONSE: 'response',
  ACK: 'ack',
  BYE: 'bye',
  LOG: 'log',
})

/**
 * Frame types the plugin accepts from the server.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const SERVER_FRAMES = Object.freeze({
  HELLO_ACK: 'hello.ack',
  PONG: 'pong',
  REQUEST: 'request',
  SUBSCRIBE: 'subscribe',
  UNSUBSCRIBE: 'unsubscribe',
  ACK: 'ack',
  ERROR: 'error',
})

/**
 * Stable machine-readable error codes used in `response.error.code`.
 *
 * Backends should branch on these, never on message text.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const ERROR_CODES = Object.freeze({
  BAD_FRAME: 'bad_frame',
  BAD_REQUEST: 'bad_request',
  INVALID_PARAMS: 'invalid_params',
  UNKNOWN_METHOD: 'unknown_method',
  NOT_FOUND: 'not_found',
  SESSION_NOT_FOUND: 'session_not_found',
  SESSION_PAUSED: 'session_paused',
  AGENT_BUSY: 'agent_busy',
  CAPABILITY_UNAVAILABLE: 'capability_unavailable',
  DISABLED: 'disabled',
  FORBIDDEN: 'forbidden',
  TIMEOUT: 'timeout',
  CONFLICT: 'conflict',
  RATE_LIMITED: 'rate_limited',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  INTERNAL: 'internal',
})

/**
 * Error carrying a protocol code, optional structured details, and an optional
 * retryability hint the backend can act on.
 */
export class BridgeError extends Error {
  /**
   * @param {string} code one of {@link ERROR_CODES}.
   * @param {string} message human-readable explanation.
   * @param {object} [options]
   * @param {unknown} [options.details] extra structured facts.
   * @param {boolean} [options.retryable] whether a retry may succeed.
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.details = options.details
    this.retryable = options.retryable === true
  }

  /** @returns {{code: string, message: string, retryable?: boolean, details?: unknown}} wire form. */
  toWire() {
    const wire = { code: this.code, message: this.message }
    if (this.retryable) wire.retryable = true
    if (this.details !== undefined) wire.details = this.details
    return wire
  }
}

/**
 * @param {string} code one of {@link ERROR_CODES}.
 * @param {string} message human-readable explanation.
 * @param {object} [options] see {@link BridgeError}.
 * @returns {BridgeError} the error.
 */
export function fail(code, message, options) {
  return new BridgeError(code, message, options)
}

/**
 * Convert any thrown value into a wire error object.
 *
 * A {@link BridgeError} keeps its code and details; anything else folds into
 * `internal` so no host-internal stack shape leaks to the server.
 *
 * @param {unknown} error thrown value.
 * @returns {{code: string, message: string, retryable?: boolean, details?: unknown}} wire error.
 */
export function toWireError(error) {
  if (error instanceof BridgeError) return error.toWire()
  const normalized = normalizeError(error, ERROR_CODES.INTERNAL)
  return { code: normalized.code === 'internal' ? ERROR_CODES.INTERNAL : normalized.code, message: normalized.message }
}

/**
 * @param {Record<string, unknown>} fields frame body.
 * @returns {Record<string, unknown>} the body with `v` stamped.
 */
function envelope(fields) {
  return { v: PROTOCOL_VERSION, ...fields }
}

/**
 * Build the opening frame. It is the only frame that may carry the instance key.
 *
 * @param {object} input hello fields.
 * @param {string} input.instanceId stable instance identity.
 * @param {Record<string, unknown>} input.instance host/plugin facts.
 * @param {Record<string, unknown>} input.capabilities advertised capabilities.
 * @param {string} [input.key] instance key when `authMode` is `hello`.
 * @param {number} input.lastSeq highest outbound event seq this process has produced.
 * @param {number} input.resumeFromSeq highest outbound event seq the server confirmed.
 * @param {Record<string, unknown>} [input.subscriptions] topics already subscribed by config.
 * @param {number} input.ts send time, epoch ms.
 * @returns {Record<string, unknown>} the `hello` frame.
 */
export function makeHello(input) {
  const frame = envelope({
    type: CLIENT_FRAMES.HELLO,
    instanceId: input.instanceId,
    ts: input.ts,
    instance: input.instance,
    capabilities: input.capabilities,
    lastSeq: input.lastSeq ?? 0,
    resumeFromSeq: input.resumeFromSeq ?? 0,
    subscriptions: input.subscriptions ?? { topics: [], sessions: [] },
  })
  if (input.key) frame.auth = { type: 'instance-key', key: input.key, instanceId: input.instanceId }
  return frame
}

/**
 * @param {number} ts send time, epoch ms.
 * @returns {Record<string, unknown>} the `ping` frame.
 */
export function makePing(ts) {
  return envelope({ type: CLIENT_FRAMES.PING, ts })
}

/**
 * @param {number} seq highest received server frame seq.
 * @returns {Record<string, unknown>} the `ack` frame.
 */
export function makeAck(seq) {
  return envelope({ type: CLIENT_FRAMES.ACK, seq })
}

/**
 * Build one outbound event frame.
 *
 * @param {object} input event fields.
 * @param {number} input.seq monotonic outbound sequence number.
 * @param {string} input.topic one of the topic names.
 * @param {string} input.kind `<domain>/<action>` event name.
 * @param {number} input.ts event time, epoch ms.
 * @param {unknown} input.data event payload.
 * @param {string} [input.sessionId] addressed session, when the event is session-scoped.
 * @returns {Record<string, unknown>} the `event` frame.
 */
export function makeEvent(input) {
  const frame = envelope({
    type: CLIENT_FRAMES.EVENT,
    seq: input.seq,
    topic: input.topic,
    kind: input.kind,
    ts: input.ts,
    data: input.data,
  })
  if (input.sessionId !== undefined) frame.sessionId = input.sessionId
  return frame
}

/**
 * @param {string} id request id being answered.
 * @param {unknown} result successful result value.
 * @returns {Record<string, unknown>} the success `response` frame.
 */
export function makeResponse(id, result) {
  return envelope({ type: CLIENT_FRAMES.RESPONSE, id, ok: true, result: result === undefined ? null : result })
}

/**
 * @param {string} id request id being answered.
 * @param {unknown} error thrown value.
 * @returns {Record<string, unknown>} the failure `response` frame.
 */
export function makeErrorResponse(id, error) {
  return envelope({ type: CLIENT_FRAMES.RESPONSE, id, ok: false, error: toWireError(error) })
}

/**
 * @param {string} reason why the plugin is closing the link.
 * @returns {Record<string, unknown>} the `bye` frame.
 */
export function makeBye(reason) {
  return envelope({ type: CLIENT_FRAMES.BYE, reason })
}

/**
 * @param {'error'|'warn'|'info'|'debug'} level log severity.
 * @param {string} message log line.
 * @returns {Record<string, unknown>} the `log` frame.
 */
export function makeLog(level, message) {
  return envelope({ type: CLIENT_FRAMES.LOG, level, message, ts: Date.now() })
}

/**
 * Validate an inbound frame enough to route it.
 *
 * The plugin never trusts the server: a malformed frame is answered with
 * `bad_frame` (for requests) or dropped with a log line, never a crash.
 *
 * @param {unknown} raw parsed JSON value.
 * @returns {{ok: true, frame: Record<string, any>} | {ok: false, reason: string, code: string}} outcome.
 */
export function parseFrame(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'frame must be a JSON object', code: ERROR_CODES.BAD_FRAME }
  }
  const frame = /** @type {Record<string, any>} */ (raw)
  if (typeof frame.type !== 'string' || !frame.type) {
    return { ok: false, reason: 'frame.type must be a non-empty string', code: ERROR_CODES.BAD_FRAME }
  }
  if (frame.v !== undefined && frame.v !== PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: `unsupported protocol version ${JSON.stringify(frame.v)}; this plugin speaks v${PROTOCOL_VERSION}`,
      code: ERROR_CODES.BAD_FRAME,
    }
  }
  return { ok: true, frame }
}
