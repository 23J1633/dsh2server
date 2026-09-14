/**
 * `job.*` operations: background jobs (bash, subagent, …).
 *
 * Jobs are process-local: an owned job is only visible to the live agent that
 * owns it, so `sessionId` is required to address an owned job and is checked by
 * the registry itself.
 *
 * @module dsh2server/lib/ops/jobs
 */

import { optionalString, requireString } from './params.js'

/**
 * @param {object} deps operation dependencies.
 * @returns {Record<string, Function>} the `job.*` handlers.
 */
export function createJobOps(deps) {
  const { host, logger } = deps
  return {
    /** List jobs visible to one session, or every unowned job when omitted. */
    'job.list': async (params) => {
      const sessionId = optionalString(params, 'sessionId', { maxLength: 200 })
      return host.listJobs(sessionId)
    },

    /** Read the next output delta (or the idempotent final output) of a job. */
    'job.read': async (params) => {
      const jobId = requireString(params, 'jobId', { maxLength: 200 })
      const sessionId = optionalString(params, 'sessionId', { maxLength: 200 })
      return host.readJob(jobId, sessionId)
    },

    /** Request cancellation of a job. */
    'job.kill': async (params) => {
      const jobId = requireString(params, 'jobId', { maxLength: 200 })
      const sessionId = optionalString(params, 'sessionId', { maxLength: 200 })
      const reason = optionalString(params, 'reason', { maxLength: 500 })
      const result = host.killJob(jobId, sessionId, reason ?? 'killed from the relay server')
      logger.info(`job ${jobId}: ${result.result}`)
      return result
    },
  }
}
