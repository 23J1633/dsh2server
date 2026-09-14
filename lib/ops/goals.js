/**
 * `goal.*` operations: the persisted same-session goal and its continuation.
 *
 * A goal is what keeps an agent working across autonomous rounds, so it is the
 * remote operator's main lever over long unattended work: pause it to hold the
 * agent between rounds, resume it to let continuation continue, complete it to
 * declare the objective met.
 *
 * @module dsh2server/lib/ops/goals
 */

import { optionalString, requireString } from './params.js'

/**
 * @param {object} deps operation dependencies.
 * @returns {Record<string, Function>} the `goal.*` handlers.
 */
export function createGoalOps(deps) {
  const { host, publish } = deps

  /**
   * @param {'pause'|'resume'|'complete'|'clear'|'disarm'} action mutation.
   * @param {Record<string, any>} params request parameters.
   * @returns {Promise<Record<string, unknown>>} the resulting goal view.
   */
  const apply = async (action, params) => {
    const sessionId = requireString(params, 'sessionId', { maxLength: 200 })
    const id = optionalString(params, 'goalId', { maxLength: 200 })
    const revision = params.revision
    const reason = optionalString(params, 'reason', { maxLength: 500 })
    const ref = id && typeof revision === 'number' ? { id, revision } : undefined
    const result = await host.goalAction(action, sessionId, ref, reason)
    publish({
      topic: 'goals',
      kind: 'goal/changed',
      sessionId,
      data: { sessionId, source: 'operation', action, goal: result?.goal ?? null },
    })
    return result
  }

  return {
    /** The session's current goal, or `{ goal: null }`. */
    'goal.get': async (params) => {
      const sessionId = requireString(params, 'sessionId', { maxLength: 200 })
      return await host.getGoal(sessionId)
    },

    /** Pause an active goal and disarm automatic continuation. */
    'goal.pause': async (params) => await apply('pause', params),

    /** Resume a paused goal and re-arm continuation. */
    'goal.resume': async (params) => await apply('resume', params),

    /** Mark a goal complete. */
    'goal.complete': async (params) => await apply('complete', params),

    /** Remove the goal from the session. */
    'goal.clear': async (params) => await apply('clear', params),

    /** Drop process-local continuation authority without changing durable phase. */
    'goal.disarm': async (params) => await apply('disarm', params),
  }
}
