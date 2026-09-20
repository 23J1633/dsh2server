/**
 * `session.*` operations: the remote control surface for sessions and agents.
 *
 * This is the heart of the bridge: listing work, reading status, sending new
 * commands, interrupting, pausing, resuming, and inspecting history. Every
 * handler validates its parameters, honours the configured policy switches, and
 * reports a structured protocol error instead of letting a host exception
 * escape.
 *
 * @module dsh2server/lib/ops/session
 */

import { ERROR_CODES, fail } from '../protocol.js'
import { newId } from '../util.js'
import {
  optionalInt,
  optionalString,
  enumParam,
  promptContent,
  requireString,
} from './params.js'

/**
 * @param {object} deps operation dependencies.
 * @returns {Record<string, Function>} the `session.*` handlers.
 */
export function createSessionOps(deps) {
  const { host, gate, forwarder, logger } = deps

  /**
   * Refuse a session whose working directory is outside the allowlist.
   *
   * @param {string} sessionId session identity.
   */
  const assertSessionAllowed = (sessionId) => {
    const detail = host.sessionDetail(sessionId)
    const cwd = detail?.header?.cwd
    if (cwd !== undefined && !host.allowsCwd(cwd)) {
      throw fail(ERROR_CODES.FORBIDDEN, `working directory "${cwd}" is outside allowedCwdPrefixes`, {
        details: { sessionId, cwd },
      })
    }
    return detail
  }

  return {
    /** Every session this deployment can see, newest activity first. */
    'session.list': async (_params, ctx) => ({ items: await host.listSessions(ctx.signal) }),

    /**
     * Live runtime state for one session: attachment, agent status, model,
     * pending work, the composition's projections (todos, goal, model
     * selection, …), and this bridge's own pause state.
     */
    'session.get': async (params) => {
      const sessionId = requireString(params, 'sessionId', { maxLength: 200 })
      const detail = host.sessionDetail(sessionId)
      const exists = detail.attached || detail.header !== undefined
      if (!exists) {
        const known = (await host.listSessions(AbortSignal.timeout(5000))).some((row) => row.sessionId === sessionId)
        if (!known) {
          throw fail(ERROR_CODES.SESSION_NOT_FOUND, `unknown session "${sessionId}"`, { details: { sessionId } })
        }
      }
      assertSessionAllowed(sessionId)
      return {
        ...detail,
        paused: gate.isPaused(sessionId),
        queuedPrompts: gate.queuedCount(sessionId),
        approvalPolicy: host.approvalPolicyOf(sessionId),
        pendingDecisions: forwarder.pendingDecisions().filter((entry) => entry.sessionId === sessionId),
      }
    },

    /** Create or explicitly adopt a session in a working directory. */
    'session.create': async (params, ctx) => {
      const cwd = optionalString(params, 'cwd', { maxLength: 4096 })
      const sessionId = optionalString(params, 'sessionId', { maxLength: 200 })
      const workspaceId = optionalString(params, 'workspaceId', { maxLength: 200 })
      const agentPreset = optionalString(params, 'agentPreset', { maxLength: 200 })
      const value = await host.createSession({ cwd, sessionId, workspaceId, agentPreset }, ctx.signal)
      logger.info(`created session ${value.sessionId}${cwd ? ` in ${cwd}` : ''}`)
      return value
    },

    /**
     * Send a new command to a session.
     *
     * `mode: 'queue'` starts its own turn (the normal "new command" case);
     * `mode: 'steer'` feeds the running turn at its next step boundary.
     * While the session is paused the prompt is parked in memory and replayed on
     * resume — `deferred: true` says so, and the prompt is never dropped
     * silently.
     */
    'session.prompt': async (params, ctx) => {
      const sessionId = requireString(params, 'sessionId', { maxLength: 200 })
      const mode = enumParam(params, 'mode', ['queue', 'steer'], 'queue')
      const blocks = promptContent(params)
      const requestId = optionalString(params, 'requestId', { maxLength: 200 }) ?? newId()
      const clientTimeZone = optionalString(params, 'clientTimeZone', { maxLength: 100 })
      const force = params.force === true
      assertSessionAllowed(sessionId)

      // Attachment blocks are re-materialized here rather than at delivery, so
      // a prompt parked behind a pause carries the same bytes it would have
      // carried had the session been running.
      const content = await host.resolvePromptBlocks(sessionId, blocks, ctx.signal)

      if (gate.isPaused(sessionId) && !force) {
        const parked = gate.park(sessionId, { content, mode, requestId, clientTimeZone })
        if (!parked.queued) {
          throw fail(ERROR_CODES.CONFLICT, `session "${sessionId}" is paused and its prompt queue is full`, {
            details: { sessionId, reason: parked.dropped, retryable: true },
            retryable: true,
          })
        }
        return { accepted: true, deferred: true, paused: true, position: parked.position, requestId }
      }

      const result = await host.prompt({ sessionId, content, mode, requestId, clientTimeZone }, ctx.signal)
      return { ...result, requestId }
    },

    /** Abort the active turn, keeping queued work for a later turn. */
    'session.interrupt': async (params) => {
      const sessionId = requireString(params, 'sessionId', { maxLength: 200 })
      assertSessionAllowed(sessionId)
      const result = await host.interrupt(sessionId)
      logger.info(`interrupted the active turn of ${sessionId}`)
      return result
    },

    /** Abort the active turn and discard queued work. */
    'session.cancel': async (params) => {
      const sessionId = requireString(params, 'sessionId', { maxLength: 200 })
      assertSessionAllowed(sessionId)
      const result = await host.cancel(sessionId)
      logger.info(`cancelled the active turn of ${sessionId} (inbox dropped)`)
      return result
    },

    /**
     * Pause a session.
     *
     * Stops the active turn immediately, pauses an armed goal so the round
     * driver cannot start a new one, and parks subsequent prompts until resume.
     */
    'session.pause': async (params) => {
      const sessionId = requireString(params, 'sessionId', { maxLength: 200 })
      assertSessionAllowed(sessionId)
      const result = await gate.pause(sessionId)
      deps.publish({
        topic: 'sessions',
        kind: 'session/paused',
        sessionId,
        data: { sessionId, ...result, at: Date.now() },
      })
      return result
    },

    /** Resume a paused session, delivering every parked prompt in order. */
    'session.resume': async (params) => {
      const sessionId = requireString(params, 'sessionId', { maxLength: 200 })
      const result = await gate.resume(sessionId)
      deps.publish({
        topic: 'sessions',
        kind: 'session/resumed',
        sessionId,
        data: { sessionId, ...result, at: Date.now() },
      })
      return result
    },

    /** Rename a session (requires the session controller plugin). */
    'session.rename': async (params) => {
      const sessionId = requireString(params, 'sessionId', { maxLength: 200 })
      const title = requireString(params, 'title', { maxLength: 500 })
      return await host.rename(sessionId, title)
    },

    /** Fork a session at a completed-turn boundary. */
    'session.fork': async (params) => {
      const sessionId = requireString(params, 'sessionId', { maxLength: 200 })
      const atSeq = optionalInt(params, 'atSeq', 0, Number.MAX_SAFE_INTEGER)
      return await host.fork(sessionId, atSeq)
    },

    /**
     * Read one page of a session's durable history.
     *
     * `throughSeq` is required and must come from the `snapshot` frame of a
     * `subscribe` (or from the last event the server saw), because the harness
     * addresses history relative to a known log cut.
     */
    'session.history': async (params, ctx) => {
      const sessionId = requireString(params, 'sessionId', { maxLength: 200 })
      const throughSeq = optionalInt(params, 'throughSeq', 0, Number.MAX_SAFE_INTEGER)
      if (throughSeq === undefined) {
        throw fail(ERROR_CODES.INVALID_PARAMS, '"throughSeq" is required: take it from the follow snapshot or the last event seq', {
          details: { field: 'throughSeq' },
        })
      }
      const beforeSeq = optionalInt(params, 'beforeSeq', 0, Number.MAX_SAFE_INTEGER)
      const maxMessages = optionalInt(params, 'maxMessages', 1, 500)
      const addressKind = enumParam(params, 'addressKind', ['session', 'subagent'], 'session')
      const parentSessionId = optionalString(params, 'parentSessionId', { maxLength: 200 })
      const childSessionId = optionalString(params, 'childSessionId', { maxLength: 200 })
      const subagentMode = enumParam(params, 'subagentMode', ['one-shot', 'continuable'], 'one-shot')
      return await host.history(
        { sessionId, throughSeq, beforeSeq, maxMessages, addressKind, parentSessionId, childSessionId, subagentMode },
        ctx.signal,
      )
    },

    /** Full-text search over visible session content. */
    'session.search': async (params, ctx) => {
      const query = requireString(params, 'query', { maxLength: 500 })
      return await host.search(query, ctx.signal)
    },

    /** Select the provider/model a session's next request uses. */
    'session.selectModel': async (params) => {
      const sessionId = requireString(params, 'sessionId', { maxLength: 200 })
      const provider = requireString(params, 'provider', { maxLength: 200 })
      const model = requireString(params, 'model', { maxLength: 200 })
      const reasoningEffort = optionalString(params, 'reasoningEffort', { maxLength: 200 })
      return await host.selectModel({ sessionId, provider, model, reasoningEffort })
    },

    /** Every currently routable model, grouped by provider. */
    'session.modelCatalog': async () => await host.modelCatalog(),

    /** Edit, remove, or promote one still-pending queue item. */
    'session.queueUpdate': async (params) => {
      const sessionId = requireString(params, 'sessionId', { maxLength: 200 })
      const itemId = requireString(params, 'itemId', { maxLength: 200 })
      const action = params.action
      if (!action || typeof action !== 'object' || Array.isArray(action)) {
        throw fail(ERROR_CODES.INVALID_PARAMS, '"action" must be an object')
      }
      const kind = enumParam(action, 'kind', ['edit', 'remove', 'steer'])
      const normalized = { kind }
      if (kind === 'edit') {
        const content = action.content
        if (!Array.isArray(content) || content.length === 0) {
          throw fail(ERROR_CODES.INVALID_PARAMS, 'action.content must be a non-empty array of content blocks')
        }
        normalized.content = content.map((block) => {
          if (!block || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') {
            throw fail(ERROR_CODES.INVALID_PARAMS, 'action.content accepts only { "type": "text", "text": "…" } blocks')
          }
          return { type: 'text', text: block.text }
        })
      }
      return host.queueUpdate({ sessionId, itemId, action: normalized })
    },

    /**
     * Read or switch one session's approval policy.
     *
     * `'never'` makes every approval ask resolve `'rejected'` without prompting
     * anyone — the deterministic unattended stance; `'ask'` delegates to the
     * composed answerers (including this bridge when `forwardApprovals` is on).
     */
    'session.approvalPolicy': async (params) => {
      const sessionId = requireString(params, 'sessionId', { maxLength: 200 })
      const policy = optionalString(params, 'policy', { maxLength: 20 })
      if (policy === undefined) return { policy: host.approvalPolicyOf(sessionId) ?? null }
      if (policy !== 'ask' && policy !== 'never') {
        throw fail(ERROR_CODES.INVALID_PARAMS, '"policy" must be "ask" or "never"', { details: { field: 'policy' } })
      }
      const result = await host.setApprovalPolicy(sessionId, policy)
      deps.publish({
        topic: 'sessions',
        kind: 'session/approval-policy',
        sessionId,
        data: { sessionId, policy, at: Date.now() },
      })
      return result
    },
  }
}
