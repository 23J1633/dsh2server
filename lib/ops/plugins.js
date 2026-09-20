/**
 * `plugin.*`: the remote view of the deployment's own plugin list
 * (PLUGIN-EXT §8).
 *
 * Reading is the useful half: a console can show what this machine is actually
 * running, which Loader entry backs it, and which of them declare a
 * configuration schema worth rendering a form from. Writing is a deliberate
 * remote mutation of the local deployment, so it is fenced behind the same
 * `allowRemoteControl` switch as every other control operation, and each
 * accepted write is announced as a `plugin/changed` event.
 *
 * @module dsh2server/lib/ops/plugins
 */

import { ERROR_CODES, fail } from '../protocol.js'
import { requireBoolean, requireString } from './params.js'

/**
 * @param {object} deps operation dependencies.
 * @returns {Record<string, Function>} the plugin handlers.
 */
export function createPluginOps(deps) {
  const { host, publish } = deps

  /**
   * @param {Record<string, unknown>} item changed plugin row.
   */
  const announce = (item) => {
    publish({
      topic: 'instance',
      kind: 'plugin/changed',
      data: { item, at: Date.now() },
    })
  }

  return {
    /** Every Loader entry this deployment is running, plus per-preset rows. */
    'plugin.list': async () => await host.listPlugins(),

    /** One plugin's configuration schema and current values. */
    'plugin.config': async (params) => {
      const id = requireString(params, 'id', { maxLength: 400 })
      return await host.pluginConfig(id)
    },

    /**
     * Merge a patch into one plugin's configuration.
     *
     * The patch is shallow-merged over the values already on the entry, so a
     * caller can change one field without resending the rest.
     */
    'plugin.setConfig': async (params) => {
      const id = requireString(params, 'id', { maxLength: 400 })
      const patch = params.patch
      if (patch === undefined || patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        throw fail(ERROR_CODES.INVALID_PARAMS, '"patch" must be a JSON object', { details: { field: 'patch' } })
      }
      const result = await host.setPluginConfig(id, patch)
      announce((await host.listPlugins()).items.find((item) => item.id === id) ?? { id })
      return result
    },

    /** Enable or disable one Loader entry. */
    'plugin.setEnabled': async (params) => {
      const id = requireString(params, 'id', { maxLength: 400 })
      const enabled = requireBoolean(params, 'enabled')
      const result = await host.setPluginEnabled(id, enabled)
      announce(result.item)
      return result
    },
  }
}
