/**
 * `workspace.*` operations: the working directories this machine works in, and
 * the read-only file browser over them (PLUGIN-EXT §5 and §6).
 *
 * The file browser never writes — edits go through the agent's own tools, which
 * is what keeps the sandbox and approval policy in the loop. The workspace
 * mutations change the *registry only*: removing a workspace unregisters it and
 * leaves the directory and every session in it exactly as they were.
 *
 * @module dsh2server/lib/ops/workspace
 */

import { ERROR_CODES, fail } from '../protocol.js'
import { optionalInt, optionalString, requireString } from './params.js'

/** Default and maximum preview window for `workspace.fs.read`. */
const DEFAULT_MAX_BYTES = 256 * 1024
const MAX_MAX_BYTES = 4 * 1024 * 1024

/**
 * @param {object} deps operation dependencies.
 * @returns {Record<string, Function>} the `workspace.*` handlers.
 */
export function createWorkspaceOps(deps) {
  const { host, publish } = deps

  /**
   * @param {'created'|'renamed'|'removed'} action what happened.
   * @param {Record<string, unknown> | null} workspace the affected workspace.
   */
  const announce = (action, workspace) => {
    publish({
      topic: 'sessions',
      kind: 'workspace/changed',
      data: { action, workspace, at: Date.now() },
    })
  }

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

    /** Register a directory as a workspace. */
    'workspace.create': async (params) => {
      const path = requireString(params, 'path', { maxLength: 4096 })
      const title = optionalString(params, 'title', { maxLength: 200 })
      const result = await host.createWorkspace({ path, title })
      announce('created', result.workspace)
      return result
    },

    /**
     * Rename one registered workspace.
     *
     * The workspace may be addressed by `id` or by `path`; when both are given
     * the id wins, so a caller that already holds a row does not have to
     * re-derive the path.
     */
    'workspace.rename': async (params) => {
      const id = optionalString(params, 'id', { maxLength: 200 })
      const path = optionalString(params, 'path', { maxLength: 4096 })
      const title = requireString(params, 'title', { maxLength: 200 })
      if (id === undefined && path === undefined) {
        throw fail(ERROR_CODES.INVALID_PARAMS, 'either "id" or "path" is required', { details: { field: 'id' } })
      }
      const result = await host.renameWorkspace({ id, path, title })
      announce('renamed', result.workspace)
      return result
    },

    /**
     * Remove one workspace registration.
     *
     * **This deletes the registration only.** The directory, its files, and
     * every session that references it are left untouched on disk.
     */
    'workspace.remove': async (params) => {
      const id = optionalString(params, 'id', { maxLength: 200 })
      const path = optionalString(params, 'path', { maxLength: 4096 })
      if (id === undefined && path === undefined) {
        throw fail(ERROR_CODES.INVALID_PARAMS, 'either "id" or "path" is required', { details: { field: 'id' } })
      }
      const result = await host.removeWorkspace({ id, path })
      announce('removed', null)
      return result
    },

    /** List one directory for the file panel. Read-only. */
    'workspace.fs.list': async (params, ctx) => {
      const path = requireString(params, 'path', { maxLength: 4096 })
      return await host.listDirectory(path, ctx.signal)
    },

    /** Preview one file for the file panel. Read-only. */
    'workspace.fs.read': async (params) => {
      const path = requireString(params, 'path', { maxLength: 4096 })
      const maxBytes = optionalInt(params, 'maxBytes', 1, MAX_MAX_BYTES) ?? DEFAULT_MAX_BYTES
      optionalString(params, 'encoding', { maxLength: 40 })
      return await host.readFile({ path, maxBytes })
    },
  }
}
