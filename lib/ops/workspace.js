/**
 * `workspace.*` operations: the working directories this machine works in.
 *
 * @module dsh2server/lib/ops/workspace
 */

/**
 * @param {object} deps operation dependencies.
 * @returns {Record<string, Function>} the `workspace.*` handlers.
 */
export function createWorkspaceOps(deps) {
  const { host } = deps
  return {
    /**
     * Every working directory the deployment knows about.
     *
     * Uses the durable workspace registry when the composition has one, and
     * otherwise derives the list from the canonical `cwd` of every session —
     * which is what "all working directories" means to a remote operator even
     * in a minimal profile.
     */
    'workspace.list': async (_params, ctx) => await host.listWorkspaces(ctx.signal),
  }
}
