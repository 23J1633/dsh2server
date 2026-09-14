/**
 * `command.*` operations: the human slash-command registry.
 *
 * Commands run against a session without being sent to the model (`/compact`,
 * `/goal`, `/export`, …), which makes them a precise remote control surface: a
 * backend can offer the same command palette the local UI shows.
 *
 * @module dsh2server/lib/ops/commands
 */

import { ERROR_CODES, fail } from '../protocol.js'
import { requireString } from './params.js'

/**
 * @param {object} deps operation dependencies.
 * @returns {Record<string, Function>} the `command.*` handlers.
 */
export function createCommandOps(deps) {
  const { host } = deps
  return {
    /** Commands visible to one session, after scoped shadowing. */
    'command.list': async (params) => {
      const sessionId = requireString(params, 'sessionId', { maxLength: 200 })
      return await host.listCommands(sessionId)
    },

    /** Run one slash command against a session. */
    'command.run': async (params, ctx) => {
      const sessionId = requireString(params, 'sessionId', { maxLength: 200 })
      const line = requireString(params, 'line', { maxLength: 100000 })
      if (!line.trimStart().startsWith('/')) {
        throw fail(
          ERROR_CODES.INVALID_PARAMS,
          '"line" must be a slash command, for example "/compact" — use session.prompt to send a normal message',
          { details: { field: 'line' } },
        )
      }
      return await host.executeCommand(sessionId, line, ctx.signal)
    },
  }
}
