/**
 * Configuration store: one effective config, layered, editable from the GUI.
 *
 * The plugin's configuration can come from two places, and they must compose in
 * a predictable order:
 *
 *   1. the loader row's `config` in `cordis.yml` (the deployment's layer),
 *   2. `<DSH_HOME>/dsh2server/config.json` — the layer the web GUI writes.
 *
 * The GUI layer wins, key by key. Clearing a key from it (the card's "reset"
 * action) makes that key fall back to the deployment layer, which is the only
 * behaviour that lets an operator see what they overrode.
 *
 * The store owns **one** config object and mutates it in place on every reload,
 * so the bridge, the host adapter, and the forwarders — all of which hold a
 * reference to it — observe a new value without being rebuilt.
 *
 * @module dsh2server/lib/settings-store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CONFIG_DEFAULTS, validateConfig } from './config.js'
import { defaultHomeDir } from './identity.js'

/** Name of the GUI-written layer inside the plugin's home directory. */
export const CONFIG_FILE_NAME = 'config.json'

/** Current on-disk config-document version. */
const CONFIG_VERSION = 1

/**
 * Keys a configuration surface may write.
 *
 * Deliberately a curated list rather than "everything": the loader row keeps
 * owning the deployment posture (`key`, `allowedCwdPrefixes`, the safety rails),
 * while the GUI owns the values an operator actually changes while working.
 *
 * @type {readonly string[]}
 */
export const EDITABLE_KEYS = Object.freeze([
  'endpoint',
  'transport',
  'pollWaitMs',
  'heartbeatMs',
  'logLevel',
  'autoSubscribeSessions',
  'forwardApprovals',
  'forwardQuestions',
  'allowRemotePrompt',
  'allowRemoteControl',
  'allowRemoteCommand',
])

/** Keys whose value is a list, so a text control can round-trip them. */
export const LIST_KEYS = Object.freeze(['endpoint', 'allowedCwdPrefixes'])

/** Error carrying every schema issue from one rejected configuration write. */
export class ConfigWriteError extends Error {
  /**
   * @param {string} message summary.
   * @param {Array<{message: string, path?: string[]}>} issues schema issues.
   */
  constructor(message, issues) {
    super(message)
    this.name = 'ConfigWriteError'
    this.issues = issues
  }
}

/**
 * The layered configuration of one dsh2server instance.
 */
export class ConfigStore {
  /**
   * @param {object} options store options.
   * @param {Record<string, unknown>} options.composition the loader row's config.
   * @param {import('./log.js').Logger} options.logger plugin logger.
   * @param {string} [options.file] override file path.
   */
  constructor(options) {
    this.composition = { ...(options.composition ?? {}) }
    this.logger = options.logger
    this.file = options.file?.trim() || join(defaultHomeDir(), 'dsh2server', CONFIG_FILE_NAME)
    /** @type {Record<string, unknown>} the GUI-written layer. */
    this.override = {}
    /**
     * The single effective configuration object. Never replaced — only mutated
     * in place, so every holder keeps observing the current values.
     *
     * @type {Record<string, any>}
     */
    this.config = { ...CONFIG_DEFAULTS }
  }

  /**
   * Read the override layer and resolve the effective configuration.
   *
   * @returns {Promise<Record<string, any>>} the effective config.
   * @throws {ConfigWriteError} when the stored layer is invalid.
   */
  async load() {
    this.override = await this.#readOverride()
    return this.#recompute()
  }

  /**
   * Merge one sparse patch into the GUI layer and persist it.
   *
   * @param {Record<string, unknown>} values keys to set.
   * @param {readonly string[]} [reset] keys to drop back to the deployment layer.
   * @returns {Promise<Record<string, any>>} the new effective config.
   * @throws {ConfigWriteError} when the merged result fails validation.
   */
  async update(values, reset = []) {
    const next = { ...this.override }
    for (const key of reset) delete next[key]
    for (const [key, value] of Object.entries(values ?? {})) {
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    const unknown = Object.keys(next).filter((key) => !EDITABLE_KEYS.includes(key) && key !== 'allowedCwdPrefixes')
    if (unknown.length > 0) {
      throw new ConfigWriteError(`not editable from the web console: ${unknown.join(', ')}`, [
        { message: `must be one of ${EDITABLE_KEYS.join(' | ')}`, path: [unknown[0]] },
      ])
    }

    const previousOverride = this.override
    const previousConfig = { ...this.config }
    this.override = next
    try {
      this.#recompute()
    } catch (error) {
      // Refuse the write, not the next use: restore both layers and rethrow.
      this.override = previousOverride
      Object.assign(this.config, previousConfig)
      throw error
    }
    await this.#writeOverride()
    return this.config
  }

  /**
   * Drop the entire GUI layer.
   *
   * @returns {Promise<Record<string, any>>} the recomputed effective config.
   */
  async clear() {
    this.override = {}
    this.#recompute()
    await this.#writeOverride()
    return this.config
  }

  /**
   * @returns {Record<string, unknown>} a copy of the GUI-written layer.
   */
  overrideSnapshot() {
    return { ...this.override }
  }

  /**
   * @returns {Record<string, unknown>} the keys the GUI layer overrides.
   */
  overriddenKeys() {
    return Object.keys(this.override)
  }

  /**
   * Recompute the effective config into the existing object.
   *
   * @returns {Record<string, any>} the effective config.
   */
  #recompute() {
    const merged = { ...this.composition, ...this.override }
    const result = validateConfig(merged)
    if (result.issues) {
      throw new ConfigWriteError('the configuration is not valid', result.issues)
    }
    for (const key of Object.keys(this.config)) delete this.config[key]
    Object.assign(this.config, result.value)
    return this.config
  }

  /**
   * @returns {Promise<Record<string, unknown>>} the stored GUI layer, or `{}`.
   */
  async #readOverride() {
    try {
      const text = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const { version: _version, updatedAt: _updatedAt, ...values } = parsed
      return values
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'ENOENT') {
        this.logger.warn(`could not read the console configuration ${this.file}:`, String(error))
      }
      return {}
    }
  }

  /** Persist the GUI layer atomically. */
  async #writeOverride() {
    const document = { version: CONFIG_VERSION, ...this.override, updatedAt: new Date().toISOString() }
    try {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      const temporary = `${this.file}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.file)
    } catch (error) {
      this.logger.warn(`could not persist the console configuration to ${this.file}:`, String(error))
    }
  }
}
