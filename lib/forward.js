/**
 * Host event forwarders.
 *
 * Turns Cordis events from the live harness into protocol events for the
 * server, and (optionally) turns remote decisions back into answers for the
 * harness's interactive waterfalls.
 *
 * Two properties matter more than completeness here:
 *
 * - **Cheap when nobody listens.** Every forwarder checks the subscription
 *   table before serializing anything, so an idle bridge costs one Set lookup
 *   per host event rather than a JSON encode per token delta.
 * - **Never the authority.** Interactive forwarding is opt-in and always
 *   delegates to the local answerer chain when the server does not answer in
 *   time, so enabling it can never wedge a local dsh session behind a dead link.
 *
 * @module dsh2server/lib/forward
 */

import { newId } from './util.js'

/** Topics this module can publish to. */
export const FORWARD_TOPICS = Object.freeze(['instance', 'sessions', 'session', 'jobs', 'approvals', 'goals'])

/**
 * Observes live harness events and publishes protocol events.
 */
export class EventForwarder {
  /**
   * @param {object} options forwarder options.
   * @param {any} options.ctx cordis context of the plugin fiber.
   * @param {import('./host.js').HostAdapter} options.host host capability layer.
   * @param {Record<string, any>} options.config validated plugin config.
   * @param {import('./log.js').Logger} options.logger plugin logger.
   * @param {(event: Record<string, unknown>) => void} options.publish publishes one protocol event.
   * @param {() => boolean} options.isConnected whether the link is currently established.
   * @param {(topic: string, sessionId?: string) => boolean} options.isSubscribed subscription test.
   * @returns {EventForwarder} the forwarder.
   */
  constructor(options) {
    this.ctx = options.ctx
    this.host = options.host
    this.config = options.config
    this.logger = options.logger
    this.publish = options.publish
    this.isConnected = options.isConnected
    this.isSubscribed = options.isSubscribed
    /** @type {Map<string, number>} last observed activity time per session. */
    this.activity = new Map()
    /** @type {Map<string, {kind: string, sessionId?: string, resolve: Function, timer: any}>} */
    this.pending = new Map()
    /** @type {Array<() => void>} disposers registered by {@link start}. */
    this.disposers = []
  }

  /**
   * @param {string} sessionId session identity.
   * @returns {number | undefined} the last observed activity time.
   */
  lastActivity(sessionId) {
    return this.activity.get(sessionId)
  }

  /**
   * Register every host listener. Each `ctx.on` registration is undone
   * automatically when the plugin unloads; the extra disposers cover the
   * non-Cordis subscriptions (job and projection observers).
   */
  start() {
    this.#observeSessionLifecycle()
    this.#observeSessionEvents()
    this.#observeAgentStatus()
    this.#observeAssistantStream()
    this.#observeControllerEvents()
    this.#observeJobs()
    this.#observeProjections()
    if (this.config.forwardApprovals) this.#forwardApprovals()
    if (this.config.forwardQuestions) this.#forwardQuestions()
  }

  /** Release the non-Cordis subscriptions. */
  dispose() {
    for (const disposer of this.disposers.splice(0)) {
      try {
        disposer()
      } catch (error) {
        this.logger.debug('forwarder disposer threw:', String(error))
      }
    }
    for (const entry of this.pending.values()) clearTimeout(entry.timer)
    this.pending.clear()
  }

  /** Session creation and disposal. */
  #observeSessionLifecycle() {
    this.ctx.on('session/created', (session) => {
      this.#touch(session)
      if (!this.isSubscribed('sessions')) return
      this.publish({
        topic: 'sessions',
        kind: 'session/created',
        sessionId: String(session?.id ?? ''),
        data: { sessionId: String(session?.id ?? ''), header: wireHeader(session?.header) },
      })
    })
    this.ctx.on('session/disposed', (session) => {
      if (!this.isSubscribed('sessions')) return
      this.publish({
        topic: 'sessions',
        kind: 'session/disposed',
        sessionId: String(session?.id ?? ''),
        data: { sessionId: String(session?.id ?? '') },
      })
    })
  }

  /** The durable session event firehose. */
  #observeSessionEvents() {
    this.ctx.on('session/event', (session, event) => {
      const sessionId = String(session?.id ?? '')
      this.#touch(session, event?.time)
      if (!this.isSubscribed('session', sessionId)) return
      this.publish({
        topic: 'session',
        kind: 'session/event',
        sessionId,
        data: {
          sessionId,
          type: event?.type,
          seq: event?.seq,
          time: event?.time,
          data: event?.data,
          surfaceOp: event?.surfaceOp,
          sourceEventSeqs: event?.sourceEventSeqs,
          ignorable: event?.ignorable,
        },
      })
    })
  }

  /** Agent running/idle transitions. */
  #observeAgentStatus() {
    this.ctx.on('agent/status', (payload) => {
      const sessionId = String(payload?.agent?.id ?? '')
      if (!this.isSubscribed('sessions')) return
      this.publish({
        topic: 'sessions',
        kind: 'session/status',
        sessionId,
        data: { sessionId, running: payload?.status === 'running', status: payload?.status },
      })
    })
  }

  /** Process-local assistant streaming frames (token deltas). */
  #observeAssistantStream() {
    this.ctx.on('agent/assistant-stream', (payload) => {
      const sessionId = String(payload?.agent?.id ?? '')
      // Token deltas are the highest-volume events on the link, so they are
      // forwarded only when the server explicitly opted into them for this
      // session (`subscribe` with `assistantStream: true`, or the configured
      // auto-subscribe policy).
      if (!this.isSubscribed('assistant', sessionId)) return
      this.publish({
        topic: 'session',
        kind: 'session/assistant-stream',
        sessionId,
        data: { sessionId, frame: payload?.frame },
      })
    })
  }

  /** Session-controller notifications, when that plugin is composed. */
  #observeControllerEvents() {
    this.ctx.on('api-session/added', (summary) => {
      this.#touch({ id: summary?.sessionId })
      if (!this.isSubscribed('sessions')) return
      this.publish({ topic: 'sessions', kind: 'session/added', sessionId: String(summary?.sessionId ?? ''), data: summary })
    })
    this.ctx.on('api-session/removed', (sessionId) => {
      if (!this.isSubscribed('sessions')) return
      this.publish({ topic: 'sessions', kind: 'session/removed', sessionId: String(sessionId ?? ''), data: { sessionId } })
    })
    this.ctx.on('api-session/status', (sessionId, running) => {
      if (!this.isSubscribed('sessions')) return
      this.publish({
        topic: 'sessions',
        kind: 'session/status',
        sessionId: String(sessionId ?? ''),
        data: { sessionId, running: running === true, status: running ? 'running' : 'idle' },
      })
    })
    this.ctx.on('api-session/activity', (sessionId, updatedAt) => {
      this.activity.set(String(sessionId), Number(updatedAt) || Date.now())
      if (!this.isSubscribed('sessions')) return
      this.publish({
        topic: 'sessions',
        kind: 'session/activity',
        sessionId: String(sessionId ?? ''),
        data: { sessionId, updatedAt },
      })
    })
    this.ctx.on('api-session/error', (sessionId, message) => {
      if (!this.isSubscribed('sessions')) return
      this.publish({
        topic: 'sessions',
        kind: 'session/error',
        sessionId: String(sessionId ?? ''),
        data: { sessionId, message },
      })
    })
  }

  /** Background job set changes. */
  #observeJobs() {
    const jobs = this.host.service('jobs')
    if (typeof jobs?.onJobsChanged !== 'function') return
    try {
      const disposer = jobs.onJobsChanged((owner) => {
        if (!this.isSubscribed('jobs')) return
        const sessionId = owner?.id ? String(owner.id) : undefined
        this.publish({
          topic: 'jobs',
          kind: 'jobs/changed',
          sessionId,
          data: { sessionId: sessionId ?? null, at: Date.now() },
        })
      })
      if (typeof disposer === 'function') this.disposers.push(disposer)
    } catch (error) {
      this.logger.debug('job change observer unavailable:', String(error))
    }
  }

  /** Session projection changes, narrowed to the keys worth forwarding. */
  #observeProjections() {
    const registry = this.host.service('sessionProjections')
    if (typeof registry?.onChanged !== 'function') return
    try {
      const disposer = registry.onChanged((session, key, value, seq) => {
        if (key !== 'goal' && key !== 'todos') return
        const sessionId = String(session?.id ?? '')
        if (!this.isSubscribed('goals') && !this.isSubscribed('session', sessionId)) return
        // Both projection-driven and operation-driven changes publish the same
        // `goal`/`todos` field so a backend has one shape to render.
        this.publish({
          topic: key === 'goal' ? 'goals' : 'session',
          kind: key === 'goal' ? 'goal/changed' : 'todos/changed',
          sessionId,
          data: {
            sessionId,
            source: 'projection',
            seq,
            ...(key === 'goal'
              ? { goal: /** @type {any} */ (value)?.goal ?? null, roundsStarted: /** @type {any} */ (value)?.roundsStarted }
              : { todos: value ?? null }),
          },
        })
      })
      if (typeof disposer === 'function') this.disposers.push(disposer)
    } catch (error) {
      this.logger.debug('projection observer unavailable:', String(error))
    }
  }

  /**
   * Forward approval questions to the server, delegating to the local chain when
   * the server is not reachable or does not answer in time.
   */
  #forwardApprovals() {
    this.ctx.on('approval/request', async (request, next) => {
      const sessionId = String(request?.agent?.id ?? '')
      if (!this.isConnected()) return next()
      const requestId = newId()
      const wanted = this.isSubscribed('approvals') || this.isSubscribed('session', sessionId)
      if (!wanted) return next()
      this.publish({
        topic: 'approvals',
        kind: 'approval/request',
        sessionId,
        data: {
          requestId,
          sessionId,
          toolName: request?.toolName,
          callId: request?.callId,
          reason: request?.reason,
          at: Date.now(),
        },
      })
      const outcome = await this.#awaitDecision('approval', requestId, sessionId, request?.signal)
      if (outcome === undefined) return next()
      return outcome
    })
  }

  /**
   * Forward structured user questions to the server, delegating to the local
   * answerer chain on timeout or when no answer arrives.
   */
  #forwardQuestions() {
    this.ctx.on('user-questions/request', async (request, next) => {
      const sessionId = String(request?.agent?.id ?? '')
      if (!this.isConnected()) return next()
      const requestId = newId()
      const wanted = this.isSubscribed('approvals') || this.isSubscribed('session', sessionId)
      if (!wanted) return next()
      this.publish({
        topic: 'approvals',
        kind: 'question/request',
        sessionId,
        data: { requestId, sessionId, questions: request?.questions, at: Date.now() },
      })
      const answer = await this.#awaitDecision('question', requestId, sessionId, request?.signal)
      if (answer === undefined) return next()
      return answer
    })
  }

  /**
   * Wait for a remote decision.
   *
   * @param {'approval'|'question'} kind pending request kind.
   * @param {string} requestId correlation id sent to the server.
   * @param {string} sessionId owning session.
   * @param {AbortSignal} [signal] harness-side cancellation.
   * @returns {Promise<any | undefined>} the decision, or undefined to delegate.
   */
  #awaitDecision(kind, requestId, sessionId, signal) {
    const timeoutMs = this.config.interactiveTimeoutMs
    return new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(entry.timer)
        this.pending.delete(requestId)
        signal?.removeEventListener?.('abort', onAbort)
        resolve(value)
      }
      const onAbort = () => finish(undefined)
      const entry = {
        kind,
        sessionId,
        resolve: finish,
        timer: setTimeout(() => {
          if (settled) return
          this.logger.debug(`no remote answer for ${kind} ${requestId}; delegating to the local answerer chain`)
          finish(undefined)
        }, timeoutMs),
      }
      this.pending.set(requestId, entry)
      if (signal) {
        if (signal.aborted) return onAbort()
        signal.addEventListener?.('abort', onAbort, { once: true })
      }
    })
  }

  /**
   * Resolve a pending approval request from the server.
   *
   * @param {string} requestId correlation id from the forwarded event.
   * @param {string} outcome one of `allowed-once`, `rejected`, `cancelled`, `unavailable`.
   * @returns {boolean} whether a matching pending request existed.
   */
  respondToApproval(requestId, outcome) {
    const entry = this.pending.get(requestId)
    if (!entry || entry.kind !== 'approval') return false
    entry.resolve(outcome)
    return true
  }

  /**
   * Resolve a pending user question from the server.
   *
   * @param {string} requestId correlation id from the forwarded event.
   * @param {Array<{id: string, selected: string[], custom?: string}>} answers structured answers.
   * @returns {boolean} whether a matching pending request existed.
   */
  answerQuestion(requestId, answers) {
    const entry = this.pending.get(requestId)
    if (!entry || entry.kind !== 'question') return false
    entry.resolve({ answers })
    return true
  }

  /**
   * @returns {Array<{requestId: string, kind: string, sessionId?: string}>} currently pending remote decisions.
   */
  pendingDecisions() {
    return [...this.pending.entries()].map(([requestId, entry]) => ({
      requestId,
      kind: entry.kind,
      sessionId: entry.sessionId,
    }))
  }

  /**
   * Record activity for one session.
   *
   * @param {any} session live session object.
   * @param {number} [time] event time, epoch ms.
   */
  #touch(session, time) {
    const id = session?.id
    if (!id) return
    this.activity.set(String(id), Number(time) || Date.now())
  }
}

/**
 * @param {any} header session header.
 * @returns {Record<string, unknown> | undefined} the wire form.
 */
function wireHeader(header) {
  if (!header) return undefined
  return {
    version: header.version,
    id: header.id,
    createdAt: header.createdAt,
    cwd: header.cwd,
    parentSession: header.parentSession,
    isSeeded: header.isSeeded,
    origin: header.origin,
    delegationDepth: header.delegationDepth,
    agentPreset: header.agentPreset,
  }
}
