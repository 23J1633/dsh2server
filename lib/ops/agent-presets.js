/**
 * `agentPreset.*`: the same per-session Agent composition picker exposed by
 * the local DSH UI.
 *
 * Listing and reading are harmless projections. Selecting, copying, and
 * deleting change the local harness and therefore share the bridge's
 * `allowRemoteControl` fence.
 *
 * @module dsh2server/lib/ops/agent-presets
 */

import { optionalString, requireString } from './params.js'

/**
 * @param {object} deps operation dependencies.
 * @returns {Record<string, Function>} the agent-preset handlers.
 */
export function createAgentPresetOps(deps) {
  const { host, publish } = deps

  const announce = (action, data = {}) => publish({
    topic: 'sessions',
    kind: 'agent-preset/changed',
    data: { action, ...data, at: Date.now() },
  })

  return {
    /** Path-free roster used by the hero picker and Settings page. */
    'agentPreset.list': async () => await host.listAgentPresets(),

    /** Read one preset composition for the Settings viewer. */
    'agentPreset.read': async (params) => {
      const agentPreset = requireString(params, 'agentPreset', { maxLength: 200 })
      return await host.readAgentPreset(agentPreset)
    },

    /** Select a composition for a blank session. */
    'agentPreset.select': async (params) => {
      const sessionId = requireString(params, 'sessionId', { maxLength: 200 })
      const agentPreset = requireString(params, 'agentPreset', { maxLength: 200 })
      const result = await host.selectAgentPreset(sessionId, agentPreset)
      announce('selected', { sessionId, agentPreset: result.agentPreset })
      return result
    },

    /** Copy a built-in or user preset into the harness's writable preset root. */
    'agentPreset.copy': async (params) => {
      const from = requireString(params, 'from', { maxLength: 200 })
      const agentPreset = requireString(params, 'agentPreset', { maxLength: 200 })
      const name = optionalString(params, 'name', { maxLength: 200 })
      const result = await host.copyAgentPreset({ from, agentPreset, name })
      announce('copied', { from, agentPreset })
      return result
    },

    /** Delete one user-authored preset; built-ins remain protected by DSH. */
    'agentPreset.delete': async (params) => {
      const agentPreset = requireString(params, 'agentPreset', { maxLength: 200 })
      const result = await host.deleteAgentPreset(agentPreset)
      announce('deleted', { agentPreset })
      return result
    },
  }
}
