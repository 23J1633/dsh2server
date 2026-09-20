/**
 * Operation registry and dispatcher.
 *
 * Every inbound `request` frame resolves to exactly one handler here. Handlers
 * receive already-validated-shape parameters plus a context carrying a
 * cancellation signal, and either return a wire-serializable value or throw a
 * {@link BridgeError}. The dispatcher owns the only `try/catch` on the request
 * path, so no handler failure can escape into the carrier.
 *
 * @module dsh2server/lib/ops
 */

import { ERROR_CODES, fail, toWireError } from '../protocol.js'
import { withTimeout } from '../util.js'
import { createAttachmentOps } from './attachment.js'
import { createCommandOps } from './commands.js'
import { createEventOps } from './events.js'
import { createFeedbackOps } from './feedback.js'
import { createGoalOps } from './goals.js'
import { createInstanceOps } from './instance.js'
import { createInteractiveOps } from './interactive.js'
import { createJobOps } from './jobs.js'
import { createPermissionOps } from './permission.js'
import { createPluginOps } from './plugins.js'
import { createSessionOps } from './session.js'
import { createWorkspaceOps } from './workspace.js'

/**
 * Build the full method table for one bridge instance.
 *
 * @param {object} deps dependencies shared by every handler group.
 * @returns {{methods: string[], has: (method: string) => boolean, dispatch: Function}} dispatcher.
 */
export function createOperations(deps) {
  const handlers = {
    ...createInstanceOps(deps),
    ...createWorkspaceOps(deps),
    ...createSessionOps(deps),
    ...createEventOps(deps),
    ...createFeedbackOps(deps),
    ...createPermissionOps(deps),
    ...createAttachmentOps(deps),
    ...createJobOps(deps),
    ...createGoalOps(deps),
    ...createCommandOps(deps),
    ...createInteractiveOps(deps),
    ...createPluginOps(deps),
  }
  const methods = Object.keys(handlers).sort()
  const timeoutMs = deps.config.requestTimeoutMs

  return {
    methods,
    /**
     * @param {string} method method name.
     * @returns {boolean} whether the method exists.
     */
    has(method) {
      return Object.hasOwn(handlers, method)
    },

    /**
     * Run one method.
     *
     * @param {string} method method name.
     * @param {unknown} params raw request parameters.
     * @param {{requestId?: string, signal: AbortSignal}} baseContext caller context.
     * @returns {Promise<{ok: true, result: unknown} | {ok: false, error: Record<string, unknown>}>} outcome.
     */
    async dispatch(method, params, baseContext) {
      if (typeof method !== 'string' || method === '') {
        return { ok: false, error: toWireError(fail(ERROR_CODES.BAD_REQUEST, 'request.method must be a non-empty string')) }
      }
      const handler = handlers[method]
      if (typeof handler !== 'function') {
        return {
          ok: false,
          error: toWireError(
            fail(ERROR_CODES.UNKNOWN_METHOD, `unknown method "${method}"`, {
              details: { methods },
            }),
          ),
        }
      }
      const controller = new AbortController()
      const onAbort = () => controller.abort(baseContext?.signal?.reason)
      if (baseContext?.signal) {
        if (baseContext.signal.aborted) controller.abort(baseContext.signal.reason)
        else baseContext.signal.addEventListener('abort', onAbort, { once: true })
      }
      const context = { requestId: baseContext?.requestId, signal: controller.signal, link: baseContext?.link }
      try {
        const result = await withTimeout(
          Promise.resolve().then(() => handler(params, context)),
          timeoutMs,
          () =>
            fail(ERROR_CODES.TIMEOUT, `method "${method}" did not finish within ${timeoutMs}ms`, {
              details: { method, timeoutMs },
              retryable: true,
            }),
        )
        return { ok: true, result: result === undefined ? null : result }
      } catch (error) {
        return { ok: false, error: toWireError(error) }
      } finally {
        baseContext?.signal?.removeEventListener('abort', onAbort)
      }
    },
  }
}
