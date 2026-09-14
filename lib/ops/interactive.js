/**
 * `approval.*` and `question.*` operations: answering forwarded interactive
 * prompts.
 *
 * These are the return path for the events `lib/forward.js` publishes when
 * `forwardApprovals` / `forwardQuestions` are enabled. A decision that arrives
 * after the harness-side request was already withdrawn simply finds no pending
 * entry and reports `matched: false`, which a backend should treat as benign.
 *
 * @module dsh2server/lib/ops/interactive
 */

import { ERROR_CODES, fail } from '../protocol.js'
import { enumParam, optionalString, requireString } from './params.js'

/** Approval outcomes the plugin may return to the harness. */
export const APPROVAL_OUTCOMES = ['allowed-once', 'rejected', 'cancelled']

/**
 * @param {object} deps operation dependencies.
 * @returns {Record<string, Function>} the `approval.*` / `question.*` handlers.
 */
export function createInteractiveOps(deps) {
  const { forwarder, config, logger } = deps

  return {
    /**
     * Decide one forwarded approval request.
     *
     * `allowed-once` is the only grant the harness recognizes; it applies to the
     * single request it answers and never to a class of actions.
     */
    'approval.respond': async (params) => {
      if (!config.forwardApprovals) {
        throw fail(
          ERROR_CODES.DISABLED,
          'approval forwarding is disabled: set "forwardApprovals: true" in the plugin config to answer approvals remotely',
        )
      }
      const requestId = requireString(params, 'requestId', { maxLength: 200 })
      const outcome = enumParam(params, 'outcome', APPROVAL_OUTCOMES)
      const matched = forwarder.respondToApproval(requestId, outcome)
      if (!matched) {
        logger.debug(`approval ${requestId} was already settled or unknown; ignoring "${outcome}"`)
      }
      return { accepted: true, matched }
    },

    /**
     * Answer one forwarded user question.
     *
     * `answers` mirrors the harness vocabulary: each entry names a question id
     * and the option labels selected for it, with an optional free-text
     * "Other" value.
     */
    'question.answer': async (params) => {
      if (!config.forwardQuestions) {
        throw fail(
          ERROR_CODES.DISABLED,
          'question forwarding is disabled: set "forwardQuestions: true" in the plugin config to answer questions remotely',
        )
      }
      const requestId = requireString(params, 'requestId', { maxLength: 200 })
      const raw = params.answers
      if (!Array.isArray(raw) || raw.length === 0) {
        throw fail(ERROR_CODES.INVALID_PARAMS, '"answers" must be a non-empty array')
      }
      const answers = raw.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          throw fail(ERROR_CODES.INVALID_PARAMS, 'each answer must be an object')
        }
        const id = requireString(entry, 'id', { maxLength: 200 })
        const selected = entry.selected
        if (!Array.isArray(selected) || selected.some((value) => typeof value !== 'string')) {
          throw fail(ERROR_CODES.INVALID_PARAMS, 'each answer needs "selected" as an array of option labels', {
            details: { questionId: id },
          })
        }
        const custom = optionalString(entry, 'custom', { maxLength: 10000 })
        return custom === undefined ? { id, selected } : { id, selected, custom }
      })
      const matched = forwarder.answerQuestion(requestId, answers)
      if (!matched) logger.debug(`question ${requestId} was already settled or unknown; ignoring the answer`)
      return { accepted: true, matched }
    },
  }
}
