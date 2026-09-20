/**
 * `session.events`: the raw durable event window (PLUGIN-EXT §1).
 *
 * `session.history` answers "which messages exist" — a message-aligned view
 * whose sequence numbers are page-local and whose times are zeroed. A remote
 * trajectory view needs the opposite: the log itself, with the real `seq` and
 * the real `time`, so turn boundaries, step durations, tool activity and
 * context pressure can all be reconstructed, and so history splices onto the
 * live `session/event` firehose without a seam.
 *
 * @module dsh2server/lib/ops/events
 */

import { ERROR_CODES, fail } from '../protocol.js'
import { optionalInt, optionalStringArray, requireString } from './params.js'

/** Default and maximum page size, per the extension contract. */
const DEFAULT_LIMIT = 500
const MAX_LIMIT = 2000

/**
 * @param {object} deps operation dependencies.
 * @returns {Record<string, Function>} the event-window handlers.
 */
export function createEventOps(deps) {
  const { host } = deps
  return {
    /**
     * One page of a session's durable event log, oldest-first.
     *
     * `throughSeq` is required and must come from a known log cut — the
     * `session/snapshot` frame or the last `session/event` the server saw —
     * because the harness addresses history relative to a cut it can honour.
     * `beforeSeq` pages backwards: pass the previous page's `oldestSeq` and the
     * next page holds only strictly older events.
     */
    'session.events': async (params, ctx) => {
      const sessionId = requireString(params, 'sessionId', { maxLength: 200 })
      const throughSeq = optionalInt(params, 'throughSeq', 0, Number.MAX_SAFE_INTEGER)
      if (throughSeq === undefined) {
        throw fail(
          ERROR_CODES.INVALID_PARAMS,
          '"throughSeq" is required: take it from the follow snapshot or the last event seq',
          { details: { field: 'throughSeq' } },
        )
      }
      const beforeSeq = optionalInt(params, 'beforeSeq', 0, Number.MAX_SAFE_INTEGER)
      const limit = optionalInt(params, 'limit', 1, MAX_LIMIT) ?? DEFAULT_LIMIT
      const kinds = optionalStringArray(params, 'kinds', { maxItems: 128, maxLength: 120 })
      return await host.rawEvents({ sessionId, throughSeq, beforeSeq, limit, kinds }, ctx.signal)
    },
  }
}
