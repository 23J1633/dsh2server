/**
 * Bounded in-memory replay buffer for outbound events.
 *
 * The server is a relay and stores nothing durable, so a reconnecting server
 * may have missed events. Every outbound event gets a monotonic `seq`; the last
 * `bufferSize` of them are retained here, and a `hello.ack` carrying a
 * `resumeFromSeq` makes the bridge replay exactly the gap. Memory is bounded by
 * construction, so a long disconnect cannot grow the plugin's footprint.
 *
 * @module dsh2server/lib/buffer
 */

/** Ring buffer over the most recent outbound event frames. */
export class EventBuffer {
  /**
   * @param {number} limit maximum retained frames (`0` disables retention).
   */
  constructor(limit) {
    this.limit = Math.max(0, Math.floor(limit ?? 0))
    /** @type {Array<Record<string, any>>} */
    this.items = []
    this.dropped = 0
  }

  /**
   * @returns {number} the highest sequence number ever produced (0 before any).
   */
  get lastSeq() {
    const last = this.items[this.items.length - 1]
    return last ? Number(last.seq) : this.lastSeqWatermark ?? 0
  }

  /**
   * Record one outbound event.
   *
   * @param {Record<string, any>} frame event frame carrying `seq`.
   */
  push(frame) {
    this.lastSeqWatermark = Number(frame.seq) || this.lastSeqWatermark || 0
    if (this.limit === 0) return
    this.items.push(frame)
    while (this.items.length > this.limit) {
      this.items.shift()
      this.dropped += 1
    }
  }

  /**
   * Frames strictly newer than `seq`, in order.
   *
   * @param {number} seq acknowledge watermark from the server.
   * @returns {Array<Record<string, any>>} retained frames to replay.
   */
  since(seq) {
    const watermark = Number.isFinite(seq) ? Number(seq) : 0
    return this.items.filter((frame) => Number(frame.seq) > watermark)
  }

  /**
   * Whether the buffer still holds the frame right after `seq`.
   *
   * When it does not, the server's watermark is older than anything retained and
   * the bridge must tell the server to re-synchronize from a full snapshot
   * instead of pretending the replay is gap-free.
   *
   * @param {number} seq acknowledge watermark from the server.
   * @returns {boolean} whether a gap-free replay is possible.
   */
  canResumeFrom(seq) {
    const watermark = Number(seq)
    if (!Number.isFinite(watermark) || watermark <= 0) return true
    const oldest = this.items[0]
    if (!oldest) return false
    return Number(oldest.seq) <= watermark + 1
  }

  /** Drop every retained frame, keeping the sequence watermark. */
  clear() {
    this.items = []
  }
}
