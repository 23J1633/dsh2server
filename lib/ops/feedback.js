/**
 * `message.feedback`: the 👍 / 👎 a human leaves under one assistant message
 * (PLUGIN-EXT §2).
 *
 * Feedback is addressed by the log sequence number of the `assistant/message`
 * event, because that is the only identity a server can see. The harness stores
 * it against the message's own durable id, so the handlers resolve one to the
 * other and report `not_found` when the seq holds no assistant message.
 *
 * @module dsh2server/lib/ops/feedback
 */

import { ERROR_CODES, fail } from '../protocol.js'
import { enumParam, optionalInt, requireString } from './params.js'

/**
 * @param {object} deps operation dependencies.
 * @returns {Record<string, Function>} the feedback handlers.
 */
export function createFeedbackOps(deps) {
  const { host } = deps
  return {
    /**
     * Set or withdraw one assistant message's feedback.
     *
     * `rating: "none"` withdraws an existing rating and succeeds whether or not
     * one was there, so a server can render "clear" without reading first.
     */
    'message.feedback': async (params, ctx) => {
      const sessionId = requireString(params, 'sessionId', { maxLength: 200 })
      const seq = optionalInt(params, 'seq', 0, Number.MAX_SAFE_INTEGER)
      if (seq === undefined) {
        throw fail(ERROR_CODES.INVALID_PARAMS, '"seq" is required: it is the assistant message event seq', {
          details: { field: 'seq' },
        })
      }
      const rating = enumParam(params, 'rating', ['like', 'dislike', 'none'])
      return await host.putFeedback(sessionId, seq, rating, ctx.signal)
    },

    /**
     * Every rating currently on a session, so a transcript renders with its
     * votes already filled in rather than fetching them one message at a time.
     */
    'message.feedback.list': async (params, ctx) => {
      const sessionId = requireString(params, 'sessionId', { maxLength: 200 })
      return { items: await host.listFeedbackBySeq(sessionId, ctx.signal) }
    },
  }
}
