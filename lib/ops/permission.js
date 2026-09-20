/**
 * `session.permission`: the input-box permission preset (PLUGIN-EXT §3).
 *
 * This is a different axis from `session.approvalPolicy`. The approval policy
 * decides *whether a human is asked*; the permission preset decides *what the
 * agent may do* — read-only, workspace-write, or full access. Both are kept,
 * and switching a preset emits its own event so a server can follow along.
 *
 * The protocol speaks three stable preset ids; the deployment's own table is
 * translated in the host layer, and only the ids it can actually reach are
 * advertised as `available`.
 *
 * @module dsh2server/lib/ops/permission
 */

import { ERROR_CODES, fail } from '../protocol.js'
import { optionalString, requireString } from './params.js'

/** The three preset ids the protocol defines. */
export const PERMISSION_PRESETS = Object.freeze(['read-only', 'workspace-write', 'full-access'])

/**
 * @param {object} deps operation dependencies.
 * @returns {Record<string, Function>} the permission handlers.
 */
export function createPermissionOps(deps) {
  const { host, publish } = deps
  return {
    /**
     * Read, or switch, one session's permission preset.
     *
     * Switching is a privilege change, so it answers with the same view a read
     * does — a caller never has to guess which preset it actually landed on.
     */
    'session.permission': async (params, ctx) => {
      const sessionId = requireString(params, 'sessionId', { maxLength: 200 })
      const preset = optionalString(params, 'preset', { maxLength: 40 })
      if (preset === undefined) {
        const view = await host.permissionOf(sessionId, ctx.signal)
        if (view === undefined) {
          throw fail(
            ERROR_CODES.CAPABILITY_UNAVAILABLE,
            'permission presets require the permission-presets plugin, and a session whose log can be read',
            { details: { sessionId } },
          )
        }
        return view
      }
      if (!PERMISSION_PRESETS.includes(preset)) {
        throw fail(ERROR_CODES.INVALID_PARAMS, `"preset" must be one of ${PERMISSION_PRESETS.join(' | ')}`, {
          details: { field: 'preset', allowed: [...PERMISSION_PRESETS] },
        })
      }
      const view = await host.setPermission(sessionId, preset)
      publish({
        topic: 'sessions',
        kind: 'session/permission',
        sessionId,
        data: { sessionId, preset: view.preset, at: Date.now() },
      })
      return view
    },
  }
}
