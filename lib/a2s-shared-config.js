import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join, resolve } from 'node:path'

export function defaultA2SConfigFile(env = process.env, platform = process.platform) {
  if (env.A2S_CONFIG_PATH?.trim()) return resolve(env.A2S_CONFIG_PATH.trim())
  if (env.A2S_CONFIG_DIR?.trim()) return join(resolve(env.A2S_CONFIG_DIR.trim()), 'config.json')
  if (platform === 'win32') {
    return join(env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming'), 'A2S', 'config.json')
  }
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'A2S', 'config.json')
  return join(env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'), 'a2s', 'config.json')
}

export function readA2SConfig(file = defaultA2SConfigFile()) {
  try {
    const document = JSON.parse(readFileSync(file, 'utf8'))
    if (!document || typeof document !== 'object' || Array.isArray(document)) return null
    if (!document.device?.id || !document.device?.key) return null
    return { file, document }
  } catch {
    return null
  }
}

/**
 * Fill only values that were not explicitly configured by the DSH profile.
 * The DSH-specific environment variables retain their existing precedence.
 */
export function withA2SDefaults(rawConfig = {}, shared = readA2SConfig(), env = process.env) {
  const result = { ...(rawConfig || {}) }
  if (!shared?.document) return result

  const { document } = shared
  const agent = document.agents?.dsh || {}
  const endpoints = normalizeEndpoints(agent.endpoints ?? document.server?.endpoints ?? document.server?.endpoint)
  const configuredEndpoint = result.endpoint
  const endpointMissing = configuredEndpoint == null
    || configuredEndpoint === ''
    || (Array.isArray(configuredEndpoint) && configuredEndpoint.length === 0)

  if (endpointMissing && !env.DSH2SERVER_ENDPOINT && endpoints.length) result.endpoint = endpoints
  if (!result.key && !env.DSH2SERVER_KEY) result.key = String(agent.key || document.device.key || '')
  if (!result.instanceId) result.instanceId = String(agent.instanceId || `${document.device.id}:dsh`)
  if (!result.displayName) result.displayName = String(agent.displayName || document.device.name || safeHostname())
  // Cordis applies schema defaults before calling the plugin, so an omitted
  // locale arrives here as "system". In unified A2S mode that value means
  // "follow the workstation setting"; only an explicit zh-CN/en-US profile
  // value pins DSH independently from A2Switch.
  if (!result.locale || result.locale === 'system') result.locale = String(agent.locale || 'system')
  if (!result.deviceId) result.deviceId = String(document.device.id)
  if (!result.a2sConfigFile) result.a2sConfigFile = shared.file
  return result
}

function normalizeEndpoints(value) {
  const values = Array.isArray(value) ? value : String(value ?? '').split(',')
  return [...new Set(values.map((entry) => String(entry || '').trim()).filter(Boolean))]
}

function safeHostname() {
  try { return hostname() || 'unknown-host' } catch { return 'unknown-host' }
}
