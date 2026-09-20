/**
 * Plugin configuration: defaults, validation, and the Cordis schema export.
 *
 * Harness loads a plugin's exported `Config` through the Standard Schema
 * interface (`Config['~standard'].validate(raw)`); a plain object export is
 * rejected by Cordis, and an exported Schemastery schema would add a runtime
 * dependency to a plugin that otherwise has none. The implementation below is a
 * self-contained Standard Schema v1 object, so validation and defaulting happen
 * while the plugin loads and every invalid value fails loudly with an
 * actionable message.
 *
 * Only `endpoint` carries real user intent; every other key exists because two
 * deployments may reasonably want different values, and all of them default.
 *
 * @module dsh2server/lib/config
 */

import { LOG_LEVELS } from './log.js'
import { parseEndpoint } from './util.js'

/** Topics a server may subscribe to without addressing a single session. */
export const GLOBAL_TOPICS = ['instance', 'sessions', 'jobs', 'approvals', 'goals', 'terminal']

/** Per-session stream policies for `autoSubscribeSessions`. */
export const SESSION_SUBSCRIBE_MODES = ['none', 'running', 'all']

/** Transport preferences. */
export const TRANSPORTS = ['auto', 'ws', 'http']

/** How the bearer token reaches the server. */
export const AUTH_MODES = ['hello', 'query', 'header']

/** User-selectable plugin UI/runtime languages. */
export const LOCALES = ['system', 'zh-CN', 'en-US']

/**
 * Built-in defaults, one entry per accepted key.
 *
 * These are also what a deployment gets from the shipped `cordis.patch.yml`
 * row, so a profile may override any of them without editing this file.
 *
 * @type {Readonly<Record<string, unknown>>}
 */
export const CONFIG_DEFAULTS = Object.freeze({
  endpoint: '',
  endpoints: Object.freeze([]),
  key: '',
  keyFile: '',
  authMode: 'hello',
  instanceId: '',
  deviceId: '',
  a2sConfigFile: '',
  displayName: '',
  locale: 'system',
  transport: 'auto',
  wsPath: '/ws',
  eventsPath: '/events',
  inboxPath: '/inbox',
  heartbeatMs: 30000,
  heartbeatTimeoutMs: 90000,
  requestTimeoutMs: 30000,
  pollWaitMs: 25000,
  reconnect: true,
  reconnectInitialDelayMs: 1000,
  reconnectMaxDelayMs: 60000,
  reconnectFactor: 2,
  reconnectJitterRatio: 0.2,
  bufferSize: 2000,
  batchSize: 50,
  batchIntervalMs: 200,
  maxPayloadBytes: 1048576,
  autoSubscribe: Object.freeze(['instance', 'sessions', 'jobs', 'approvals']),
  autoSubscribeSessions: 'running',
  forwardApprovals: false,
  // Remote structured questions are part of the normal control loop. Leaving
  // this off makes a server-driven session look permanently "running" while
  // the local harness is waiting for an answer that the server cannot see.
  forwardQuestions: true,
  interactiveTimeoutMs: 300000,
  allowRemoteControl: true,
  allowRemotePrompt: true,
  allowRemoteCommand: true,
  // A shell is a separate high-risk surface and stays disabled until the
  // operator explicitly enables it in the A2Switch settings.
  allowRemoteTerminal: false,
  allowRemoteFileContent: false,
  pauseQueueLimit: 100,
  allowedCwdPrefixes: Object.freeze([]),
  deniedServerAddresses: Object.freeze([]),
  logLevel: 'info',
})

/** Environment variable consulted when `endpoint` is left empty in config. */
export const ENDPOINT_ENV = 'DSH2SERVER_ENDPOINT'

/**
 * Environment variable consulted when `key` is left empty in config.
 *
 * Setting it pins the instance key without touching the identity file; leaving
 * it unset makes the plugin generate and store one on this machine.
 */
export const KEY_ENV = 'DSH2SERVER_KEY'

/**
 * @param {unknown} value candidate.
 * @returns {boolean} whether `value` is a plain object record.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate one config document against {@link CONFIG_DEFAULTS}.
 *
 * Follows the Standard Schema contract: the returned object carries either
 * `value` (the normalized, defaulted config) or `issues` (one entry per
 * problem, each with a `message` and an optional `path`).
 *
 * @param {unknown} raw user configuration from `cordis.yml`.
 * @param {Record<string, string|undefined>} [env] environment fallback source.
 * @returns {{value?: Record<string, unknown>, issues?: Array<{message: string, path?: string[]}>}} validation result.
 */
export function validateConfig(raw, env = process.env) {
  /** @type {Array<{message: string, path?: string[]}>} */
  const issues = []
  if (raw !== undefined && raw !== null && !isRecord(raw)) {
    return { issues: [{ message: 'configuration must be an object' }] }
  }
  const input = isRecord(raw) ? raw : {}
  const config = { ...CONFIG_DEFAULTS, ...input }

  if ((config.key === '' || config.key === undefined || config.key === null) && env?.[KEY_ENV]) {
    config.key = String(env[KEY_ENV])
  }
  if (typeof config.endpoint === 'string' && config.endpoint.trim() === '' && env?.[ENDPOINT_ENV]) {
    config.endpoint = String(env[ENDPOINT_ENV])
  }

  // `endpoint` accepts one URL or an ordered list (a comma-separated string is
  // accepted too, because YAML env substitution usually produces a string).
  // Both `http://` and `https://` are valid, in any mixture.
  const endpointList = []
  const rawEndpoint = config.endpoint
  if (typeof rawEndpoint === 'string') {
    for (const part of rawEndpoint.split(',')) {
      const trimmed = part.trim()
      if (trimmed) endpointList.push(trimmed)
    }
  } else if (Array.isArray(rawEndpoint)) {
    for (const entry of rawEndpoint) {
      if (typeof entry !== 'string') {
        issues.push({ message: 'every entry must be a URL string', path: ['endpoint'] })
        continue
      }
      const trimmed = entry.trim()
      if (trimmed) endpointList.push(trimmed)
    }
  } else {
    issues.push({ message: 'must be a URL string or an array of URL strings', path: ['endpoint'] })
  }
  for (const candidate of endpointList) {
    const parsed = parseEndpoint(candidate)
    if (!parsed.ok) issues.push({ message: parsed.reason, path: ['endpoint'] })
  }
  config.endpoints = endpointList
  config.endpoint = endpointList[0] ?? ''

  /**
   * @param {string} key config key.
   * @param {readonly string[]} allowed accepted values.
   */
  const checkEnum = (key, allowed) => {
    if (!allowed.includes(config[key])) {
      issues.push({ message: `must be one of ${allowed.join(' | ')}, got ${JSON.stringify(config[key])}`, path: [key] })
    }
  }
  /**
   * @param {string} key config key.
   * @param {number} min inclusive lower bound.
   * @param {number} max inclusive upper bound.
   */
  const checkInt = (key, min, max) => {
    const value = config[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
      issues.push({ message: `must be an integer between ${min} and ${max}, got ${JSON.stringify(value)}`, path: [key] })
    }
  }
  /**
   * @param {string} key config key.
   */
  const checkBool = (key) => {
    if (typeof config[key] !== 'boolean') {
      issues.push({ message: `must be a boolean, got ${JSON.stringify(config[key])}`, path: [key] })
    }
  }
  /**
   * @param {string} key config key.
   * @param {readonly string[]} [allowed] accepted values, when constrained.
   */
  const checkString = (key, allowed) => {
    const value = config[key]
    if (typeof value !== 'string') {
      issues.push({ message: `must be a string, got ${JSON.stringify(value)}`, path: [key] })
      return
    }
    if (allowed && value !== '' && !allowed.includes(value)) {
      issues.push({ message: `must be one of ${allowed.join(' | ')}, got ${JSON.stringify(value)}`, path: [key] })
    }
  }

  checkString('key')
  checkString('keyFile')
  checkString('instanceId')
  checkString('deviceId')
  checkString('a2sConfigFile')
  checkString('displayName')
  checkString('locale', LOCALES)
  checkEnum('transport', TRANSPORTS)
  checkEnum('authMode', AUTH_MODES)
  checkEnum('autoSubscribeSessions', SESSION_SUBSCRIBE_MODES)
  checkEnum('logLevel', LOG_LEVELS)
  checkString('wsPath')
  checkString('eventsPath')
  checkString('inboxPath')
  checkInt('heartbeatMs', 1000, 3600000)
  checkInt('heartbeatTimeoutMs', 1000, 7200000)
  checkInt('requestTimeoutMs', 100, 3600000)
  checkInt('pollWaitMs', 0, 600000)
  checkBool('reconnect')
  checkInt('reconnectInitialDelayMs', 50, 3600000)
  checkInt('reconnectMaxDelayMs', 100, 7200000)
  checkInt('bufferSize', 0, 1000000)
  checkInt('batchSize', 1, 10000)
  checkInt('batchIntervalMs', 0, 60000)
  checkInt('maxPayloadBytes', 1024, 268435456)
  checkInt('interactiveTimeoutMs', 1000, 86400000)
  checkBool('forwardApprovals')
  checkBool('forwardQuestions')
  checkBool('allowRemoteControl')
  checkBool('allowRemotePrompt')
  checkBool('allowRemoteCommand')
  checkBool('allowRemoteTerminal')
  checkBool('allowRemoteFileContent')
  checkInt('pauseQueueLimit', 0, 100000)

  if (typeof config.reconnectFactor !== 'number' || !(config.reconnectFactor >= 1) || config.reconnectFactor > 100) {
    issues.push({ message: 'must be a number between 1 and 100', path: ['reconnectFactor'] })
  }
  if (
    typeof config.reconnectJitterRatio !== 'number' ||
    !(config.reconnectJitterRatio >= 0) ||
    config.reconnectJitterRatio > 1
  ) {
    issues.push({ message: 'must be a number between 0 and 1', path: ['reconnectJitterRatio'] })
  }
  if (!Array.isArray(config.autoSubscribe) || config.autoSubscribe.some((topic) => typeof topic !== 'string')) {
    issues.push({ message: 'must be an array of topic names', path: ['autoSubscribe'] })
  } else {
    const unknown = config.autoSubscribe.filter((topic) => !GLOBAL_TOPICS.includes(topic))
    if (unknown.length > 0) {
      issues.push({
        message: `unknown topic(s) ${unknown.join(', ')}; expected a subset of ${GLOBAL_TOPICS.join(' | ')}`,
        path: ['autoSubscribe'],
      })
    }
  }
  if (!Array.isArray(config.allowedCwdPrefixes) || config.allowedCwdPrefixes.some((v) => typeof v !== 'string')) {
    issues.push({ message: 'must be an array of path prefixes', path: ['allowedCwdPrefixes'] })
  }
  if (!Array.isArray(config.deniedServerAddresses) || config.deniedServerAddresses.some((v) => typeof v !== 'string')) {
    issues.push({ message: 'must be an array of addresses', path: ['deniedServerAddresses'] })
  }
  if (config.reconnectMaxDelayMs < config.reconnectInitialDelayMs) {
    issues.push({ message: 'must be >= reconnectInitialDelayMs', path: ['reconnectMaxDelayMs'] })
  }
  if (config.heartbeatTimeoutMs < config.heartbeatMs) {
    issues.push({ message: 'must be >= heartbeatMs', path: ['heartbeatTimeoutMs'] })
  }
  if (typeof config.key === 'string' && config.key !== '' && config.key.length < 16) {
    issues.push({
      message:
        'a configured key must be at least 16 characters; leave it empty to let the plugin generate and store one',
      path: ['key'],
    })
  }

  if (issues.length > 0) return { issues }
  return { value: config }
}

/**
 * The Cordis/Standard-Schema entry point for this plugin.
 *
 * Cordis calls `Config['~standard'].validate(rawConfig)` while the plugin loads
 * and fails the fiber with every reported issue when validation fails.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh2server',
    /**
     * @param {unknown} value raw configuration.
     * @returns {{value: Record<string, unknown>} | {issues: Array<{message: string, path?: string[]}>}} result.
     */
    validate(value) {
      const result = validateConfig(value)
      return result.issues ? { issues: result.issues } : { value: result.value }
    },
  },
}

/**
 * Normalize an already-validated config into the runtime shape the bridge uses.
 *
 * @param {Record<string, any>} config validated config.
 * @returns {Record<string, any>} the same object with derived, frozen lists.
 */
export function normalizeConfig(config) {
  return {
    ...config,
    endpoints: [...(config.endpoints ?? [])],
    autoSubscribe: [...(config.autoSubscribe ?? [])],
    allowedCwdPrefixes: [...(config.allowedCwdPrefixes ?? [])],
    deniedServerAddresses: [...(config.deniedServerAddresses ?? [])],
  }
}
