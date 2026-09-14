/**
 * Per-session pause gate.
 *
 * "Pause" in this bridge means: stop the session's active turn now, and hold
 * everything the server sends afterwards until it says resume. The harness has
 * no global pause switch — an agent is either idle or driving a turn — so the
 * honest implementation is a coordinated pair:
 *
 *   1. `agent.cancel({kind:'user'}, {keepInbox:true})` aborts the current turn
 *      while durably preserving the queued work.
 *   2. Prompts arriving while paused are parked here, in memory, in order, and
 *      delivered on resume. They are never silently dropped, and the server
 *      learns the real outcome through the `session/paused` event.
 *
 * When the goal service is composed, an active goal is paused too, because the
 * goal round driver would otherwise start a fresh turn and defeat the pause.
 *
 * @module dsh2server/lib/gate
 */

/**
 * Tracks paused sessions and the prompts held behind each pause.
 */
export class SessionGate {
  /**
   * @param {object} options gate options.
   * @param {import('./log.js').Logger} options.logger plugin logger.
   * @param {number} options.limit maximum parked prompts per session.
   * @param {(sessionId: string) => Promise<any>} options.ensureAgent resolves a live agent.
   * @param {(sessionId: string) => any} options.getGoal reads the session's current goal.
   * @param {(action: string, sessionId: string) => Promise<any>} options.goalAction applies a goal mutation.
   * @param {(sessionId: string, prompt: Record<string, unknown>) => Promise<unknown>} options.deliver delivers a parked prompt.
   */
  constructor(options) {
    this.logger = options.logger
    this.limit = Math.max(0, Math.floor(options.limit ?? 0))
    this.ensureAgent = options.ensureAgent
    this.getGoal = options.getGoal
    this.goalAction = options.goalAction
    this.deliver = options.deliver
    /** @type {Map<string, {since: number, goalPaused: boolean, queue: Array<Record<string, unknown>>}>} */
    this.paused = new Map()
  }

  /**
   * @param {string} sessionId session identity.
   * @returns {boolean} whether the session is currently paused.
   */
  isPaused(sessionId) {
    return this.paused.has(sessionId)
  }

  /**
   * @returns {string[]} every paused session id.
   */
  pausedSessions() {
    return [...this.paused.keys()]
  }

  /**
   * Pause one session: abort the active turn and start parking prompts.
   *
   * @param {string} sessionId session identity.
   * @returns {Promise<Record<string, unknown>>} pause outcome.
   */
  async pause(sessionId) {
    if (this.paused.has(sessionId)) {
      const entry = this.paused.get(sessionId)
      return { paused: true, alreadyPaused: true, queued: entry?.queue.length ?? 0 }
    }
    const entry = { since: Date.now(), goalPaused: false, queue: [] }
    this.paused.set(sessionId, entry)

    let interrupted = false
    let agent
    try {
      agent = await this.ensureAgent(sessionId)
    } catch (error) {
      this.logger.debug(`pause(${sessionId}): no live agent —`, String(error))
    }
    if (agent) {
      try {
        if (agent.status === 'running') {
          agent.cancel({ kind: 'user' }, { keepInbox: true })
          interrupted = true
        }
      } catch (error) {
        this.logger.warn(`pause(${sessionId}): could not interrupt the active turn —`, String(error))
      }
    }

    // A running goal round driver would open a new turn immediately, so an
    // armed goal must be paused as well for the pause to mean anything.
    try {
      const goal = await this.getGoal(sessionId)
      if (goal?.goal && goal.goal.phase === 'active') {
        await this.goalAction('pause', sessionId)
        entry.goalPaused = true
      }
    } catch (error) {
      this.logger.debug(`pause(${sessionId}): goal pause skipped —`, String(error))
    }

    return { paused: true, interrupted, goalPaused: entry.goalPaused, queued: 0 }
  }

  /**
   * Resume one session and deliver every parked prompt in order.
   *
   * @param {string} sessionId session identity.
   * @returns {Promise<Record<string, unknown>>} resume outcome.
   */
  async resume(sessionId) {
    const entry = this.paused.get(sessionId)
    if (!entry) return { paused: false, alreadyRunning: true, delivered: 0 }
    this.paused.delete(sessionId)

    let goalResumed = false
    if (entry.goalPaused) {
      try {
        await this.goalAction('resume', sessionId)
        goalResumed = true
      } catch (error) {
        this.logger.warn(`resume(${sessionId}): could not resume the goal —`, String(error))
      }
    }

    let delivered = 0
    const failures = []
    for (const prompt of entry.queue) {
      try {
        await this.deliver(sessionId, prompt)
        delivered += 1
      } catch (error) {
        failures.push({ requestId: prompt.requestId, message: String(error) })
      }
    }
    return { paused: false, delivered, goalResumed, failed: failures.length > 0 ? failures : undefined }
  }

  /**
   * Park a prompt behind a pause.
   *
   * @param {string} sessionId session identity.
   * @param {Record<string, unknown>} prompt prompt request to replay on resume.
   * @returns {{queued: boolean, position?: number, dropped?: string}} outcome.
   */
  park(sessionId, prompt) {
    const entry = this.paused.get(sessionId)
    if (!entry) return { queued: false }
    if (this.limit === 0) return { queued: false, dropped: 'pauseQueueLimit is 0, so nothing may be parked' }
    if (entry.queue.length >= this.limit) {
      return { queued: false, dropped: `pause queue for ${sessionId} is full (${this.limit})` }
    }
    entry.queue.push(prompt)
    return { queued: true, position: entry.queue.length }
  }

  /**
   * @param {string} sessionId session identity.
   * @returns {number} how many prompts are parked behind this session's pause.
   */
  queuedCount(sessionId) {
    return this.paused.get(sessionId)?.queue.length ?? 0
  }

  /**
   * Drop every pause and parked prompt (used on plugin unload).
   *
   * @returns {number} how many parked prompts were discarded.
   */
  clear() {
    let dropped = 0
    for (const entry of this.paused.values()) dropped += entry.queue.length
    this.paused.clear()
    return dropped
  }
}
