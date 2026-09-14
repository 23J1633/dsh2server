/**
 * A minimal RFC 6455 WebSocket server, dependency-free.
 *
 * This exists so the reference backend in this directory runs on a bare Node
 * install — the same reason the plugin itself has no dependencies. It is not
 * meant to be a general-purpose library: it implements exactly the subset the
 * dsh2server protocol needs (text frames, ping/pong, close, and
 * fragmentation reassembly) and it is deliberately small enough to audit.
 *
 * A production backend should use its platform's mature WebSocket stack instead
 * (ws / uWebSockets / FastAPI / Gorilla / …); the wire protocol is what matters,
 * not this file.
 *
 * @module dsh2server/examples/ws
 */

import { createHash } from 'node:crypto'

/** Magic GUID from RFC 6455 §4.2.2. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Frame opcodes used by this implementation. */
export const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa }

/** Largest inbound frame accepted (guards against a hostile peer). */
const MAX_FRAME_BYTES = 16 * 1024 * 1024

/**
 * Compute the `Sec-WebSocket-Accept` value for a handshake key.
 *
 * @param {string} key client `Sec-WebSocket-Key`.
 * @returns {string} the accept token.
 */
export function acceptKey(key) {
  return createHash('sha1').update(`${key}${GUID}`).digest('base64')
}

/**
 * One connected WebSocket peer.
 */
export class WebSocketConnection {
  /**
   * @param {import('node:net').Socket} socket upgraded TCP socket.
   * @param {object} [options] connection options.
   * @param {string} [options.remoteAddress] peer address for logging/allowlists.
   */
  constructor(socket, options = {}) {
    this.socket = socket
    this.remoteAddress = options.remoteAddress
    /** Whether a close frame has been sent, so no further frame may be written. */
    this.closing = false
    /** Whether the connection is fully closed (set when the `close` event fires). */
    this.closed = false
    /** Whether the `close` event has already been emitted to listeners. */
    this.closeEmitted = false
    /** @type {Buffer} */
    this.pending = Buffer.alloc(0)
    /** @type {Buffer[]} */
    this.fragments = []
    this.fragmentOpcode = undefined
    /** @type {Map<string, Set<Function>>} */
    this.handlers = new Map()
    socket.on('data', (chunk) => this.#onData(chunk))
    socket.on('close', () => this.#emitClose())
    socket.on('error', () => this.#emitClose())
    socket.on('end', () => this.#emitClose())
  }

  /**
   * @param {string} event `message` | `close`.
   * @param {Function} handler listener.
   * @returns {() => void} disposer.
   */
  on(event, handler) {
    const set = this.handlers.get(event) ?? new Set()
    set.add(handler)
    this.handlers.set(event, set)
    return () => set.delete(handler)
  }

  /**
   * @param {string} event event name.
   * @param {...unknown} args listener arguments.
   */
  #emit(event, ...args) {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      try {
        handler(...args)
      } catch {
        // A subscriber error must not break the socket.
      }
    }
  }

  #emitClose() {
    if (this.closeEmitted) return
    this.closeEmitted = true
    this.closed = true
    this.#emit('close')
  }

  /**
   * Send one text frame.
   *
   * @param {string} text payload.
   * @returns {boolean} whether the frame was written.
   */
  send(text) {
    if (this.closing || this.closed) return false
    return this.#writeFrame(OPCODE.TEXT, Buffer.from(String(text), 'utf8'))
  }

  /**
   * Close the connection with a status code.
   *
   * @param {number} [code] close code.
   * @param {string} [reason] close reason.
   */
  close(code = 1000, reason = '') {
    if (this.closing || this.closed) return
    // Stop accepting further frames, but leave the `close` event to the socket
    // so the owner learns about the teardown exactly once.
    this.closing = true
    const reasonBuffer = Buffer.from(String(reason).slice(0, 120), 'utf8')
    const payload = Buffer.alloc(2 + reasonBuffer.length)
    payload.writeUInt16BE(code, 0)
    reasonBuffer.copy(payload, 2)
    this.#writeFrame(OPCODE.CLOSE, payload)
    this.socket.end()
  }

  /**
   * @param {number} opcode frame opcode.
   * @param {Buffer} payload frame payload.
   * @returns {boolean} whether the frame was written.
   */
  #writeFrame(opcode, payload) {
    if (this.socket.destroyed) return false
    const length = payload.length
    let header
    if (length < 126) {
      header = Buffer.alloc(2)
      header[1] = length
    } else if (length < 65536) {
      header = Buffer.alloc(4)
      header[1] = 126
      header.writeUInt16BE(length, 2)
    } else {
      header = Buffer.alloc(10)
      header[1] = 127
      header.writeBigUInt64BE(BigInt(length), 2)
    }
    header[0] = 0x80 | opcode
    try {
      this.socket.write(Buffer.concat([header, payload]))
      return true
    } catch {
      return false
    }
  }

  /**
   * Feed one TCP chunk through the frame parser.
   *
   * @param {Buffer} chunk inbound bytes.
   */
  #onData(chunk) {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    // Parse as many complete frames as the buffer holds.
    for (;;) {
      const frame = this.#parseFrame()
      if (!frame) return
      this.#handleFrame(frame)
      if (this.closing) return
    }
  }

  /**
   * @returns {{fin: boolean, opcode: number, payload: Buffer} | undefined} one frame, or undefined when incomplete.
   */
  #parseFrame() {
    const buffer = this.pending
    if (buffer.length < 2) return undefined
    const fin = (buffer[0] & 0x80) !== 0
    const opcode = buffer[0] & 0x0f
    const masked = (buffer[1] & 0x80) !== 0
    let length = buffer[1] & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < offset + 2) return undefined
      length = buffer.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buffer.length < offset + 8) return undefined
      const big = buffer.readBigUInt64BE(offset)
      if (big > BigInt(MAX_FRAME_BYTES)) {
        this.close(1009, 'frame too large')
        return undefined
      }
      length = Number(big)
      offset += 8
    }
    if (length > MAX_FRAME_BYTES) {
      this.close(1009, 'frame too large')
      return undefined
    }
    let mask
    if (masked) {
      if (buffer.length < offset + 4) return undefined
      mask = buffer.subarray(offset, offset + 4)
      offset += 4
    }
    if (buffer.length < offset + length) return undefined
    const payload = Buffer.from(buffer.subarray(offset, offset + length))
    this.pending = buffer.subarray(offset + length)
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
    }
    return { fin, opcode, payload }
  }

  /**
   * @param {{fin: boolean, opcode: number, payload: Buffer}} frame parsed frame.
   */
  #handleFrame(frame) {
    switch (frame.opcode) {
      case OPCODE.PING:
        this.#writeFrame(OPCODE.PONG, frame.payload)
        return
      case OPCODE.PONG:
        return
      case OPCODE.CLOSE:
        this.close(1000, '')
        return
      case OPCODE.CONTINUATION:
        this.fragments.push(frame.payload)
        if (frame.fin) this.#flushFragments()
        return
      case OPCODE.TEXT:
      case OPCODE.BINARY:
        if (!frame.fin) {
          this.fragmentOpcode = frame.opcode
          this.fragments = [frame.payload]
          return
        }
        this.#deliver(frame.opcode, frame.payload)
        return
      default:
        this.close(1003, 'unsupported opcode')
    }
  }

  /** Reassemble a fragmented message and deliver it. */
  #flushFragments() {
    const opcode = this.fragmentOpcode ?? OPCODE.TEXT
    const payload = Buffer.concat(this.fragments)
    this.fragments = []
    this.fragmentOpcode = undefined
    this.#deliver(opcode, payload)
  }

  /**
   * @param {number} opcode final message opcode.
   * @param {Buffer} payload message bytes.
   */
  #deliver(opcode, payload) {
    if (opcode === OPCODE.BINARY) return
    this.#emit('message', payload.toString('utf8'))
  }
}

/**
 * Attach a WebSocket endpoint to an existing `node:http` server.
 *
 * @param {import('node:http').Server} server HTTP server to upgrade.
 * @param {object} options endpoint options.
 * @param {string} options.path pathname that accepts upgrades.
 * @param {(connection: WebSocketConnection, request: import('node:http').IncomingMessage) => void} options.onConnection connection handler.
 * @returns {() => void} disposer removing the upgrade listener.
 */
export function attachWebSocket(server, options) {
  const handler = (request, socket, head) => {
    let pathname
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    } catch {
      socket.destroy()
      return
    }
    if (pathname !== options.path) {
      socket.destroy()
      return
    }
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey(key)}`,
        '\r\n',
      ].join('\r\n'),
    )
    const connection = new WebSocketConnection(socket, { remoteAddress: socket.remoteAddress })
    if (head && head.length > 0) connection.pending = Buffer.from(head)
    options.onConnection(connection, request)
  }
  server.on('upgrade', handler)
  return () => server.off('upgrade', handler)
}
