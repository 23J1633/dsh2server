/**
 * Per-instance identity and secret key.
 *
 * Every dsh install that loads this plugin owns one stable identity:
 *
 *   `instanceId` — a routing label the server uses to tell machines apart.
 *   `key`        — a high-entropy secret (`dshk_…`) that authenticates the
 *                  instance to the server.
 *
 * The key is generated locally on first run and stored **on this machine only**
 * (`<DSH_HOME>/dsh2server/identity.json`, mode 0600). It is never written to
 * the relay server's storage; the operator copies it into the server's key list
 * once, and the server keeps it as the credential for this machine. Because the
 * key is stable, a restart reconnects as the same machine; because it is
 * generated from a CSPRNG and compared in constant time on the server side, one
 * machine's key cannot be replayed by another.
 *
 * @module dsh2server/lib/identity
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { shortHash } from './util.js'

/** Prefix every generated key carries, so operators can recognize one on sight. */
export const KEY_PREFIX = 'dshk_'

/** Entropy of a generated key, in bytes (base64url-encoded to 43 characters). */
const KEY_BYTES = 32

/** Current on-disk identity document version. */
const IDENTITY_VERSION = 1

/**
 * @returns {string} this machine's dsh home directory.
 */
export function defaultHomeDir() {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

/**
 * @returns {string} the default identity file path for this machine.
 */
export function defaultKeyFile() {
  return join(defaultHomeDir(), 'dsh2server', 'identity.json')
}

/**
 * Generate one new instance key.
 *
 * @returns {string} a `dshk_`-prefixed base64url secret.
 */
export function generateKey() {
  return `${KEY_PREFIX}${randomBytes(KEY_BYTES).toString('base64url')}`
}

/**
 * Short, non-secret display form of a key.
 *
 * Safe to log and to echo to the server: it identifies a key without revealing
 * enough of it to authenticate. It keeps both ends of the secret so two keys
 * that happen to share a prefix (or a test fixture) stay distinguishable.
 *
 * @param {string} key full key, or any string.
 * @returns {string} the fingerprint, e.g. `dshk_AbCdEf…9xYz`.
 */
export function keyFingerprint(key) {
  const text = String(key ?? '')
  if (text.length <= 16) return text ? `${text.slice(0, 4)}…` : ''
  return `${text.slice(0, 12)}…${text.slice(-4)}`
}

/**
 * Constant-time comparison of two keys.
 *
 * Exported for the reference backend and for tests; the plugin itself only ever
 * presents its key, but a backend that shares this module must not compare
 * secrets with `===`.
 *
 * @param {string} a first key.
 * @param {string} b second key.
 * @returns {boolean} whether the keys are equal.
 */
export function keysEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8')
  const right = Buffer.from(String(b ?? ''), 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * The loaded (or freshly created) identity of this dsh install.
 */
export class Identity {
  /**
   * @param {object} options identity options.
   * @param {string} [options.keyFile] identity file path; defaults to {@link defaultKeyFile}.
   * @param {string} [options.explicitKey] operator-supplied key that overrides the stored one.
   * @param {string} [options.explicitInstanceId] operator-supplied instance id.
   * @param {import('./log.js').Logger} options.logger plugin logger.
   */
  constructor(options) {
    this.keyFile = options.keyFile?.trim() || defaultKeyFile()
    this.explicitKey = options.explicitKey?.trim() ?? ''
    this.explicitInstanceId = options.explicitInstanceId?.trim() ?? ''
    this.logger = options.logger
    /** @type {string} */
    this.instanceId = ''
    /** @type {string} */
    this.key = ''
    /** @type {string | undefined} */
    this.createdAt = undefined
    /** @type {string | undefined} */
    this.rotatedAt = undefined
    /** @type {boolean} whether the key came from a fresh generation this run. */
    this.generated = false
    /** @type {string | undefined} why persistence is unavailable, when it is. */
    this.persistenceWarning = undefined
    /** @type {boolean} whether the key must be shown to the operator. */
    this.shouldAnnounceKey = false
  }

  /**
   * Load the stored identity, creating one when absent.
   *
   * Never throws: an unreadable or unwritable identity file degrades to an
   * in-memory identity with a warning, because refusing to start would be a
   * worse outcome than a key that changes on the next restart.
   *
   * @returns {Promise<Identity>} this instance.
   */
  async load() {
    const stored = await this.#read()
    const derivedInstanceId = this.explicitInstanceId || stored?.instanceId || deriveInstanceId()
    this.instanceId = derivedInstanceId
    this.createdAt = stored?.createdAt
    this.rotatedAt = stored?.rotatedAt

    if (this.explicitKey) {
      this.key = this.explicitKey
      this.generated = false
      // Persist only the instance id so the identity stays stable; the operator
      // owns the key in this mode.
      if (stored?.key !== this.explicitKey) await this.#write({ announce: false })
      return this
    }

    if (typeof stored?.key === 'string' && stored.key.startsWith(KEY_PREFIX) && stored.key.length > KEY_PREFIX.length + 20) {
      this.key = stored.key
      this.generated = false
      return this
    }

    this.key = generateKey()
    this.generated = true
    this.shouldAnnounceKey = true
    this.createdAt = new Date().toISOString()
    await this.#write({ announce: true })
    return this
  }

  /**
   * Replace the key with a fresh one and persist it.
   *
   * The caller is responsible for telling the server the new key; the plugin
   * keeps presenting the new key immediately, so the current link is dropped
   * and re-established (the server rejects the old key).
   *
   * @returns {Promise<string>} the new key.
   */
  async rotate() {
    if (this.explicitKey) {
      throw new Error('the key is supplied by configuration ("key"), so the plugin cannot rotate it')
    }
    this.key = generateKey()
    this.rotatedAt = new Date().toISOString()
    this.generated = true
    this.shouldAnnounceKey = true
    await this.#write({ announce: true })
    return this.key
  }

  /** @returns {string} the non-secret fingerprint of the current key. */
  fingerprint() {
    return keyFingerprint(this.key)
  }

  /**
   * @returns {Promise<Record<string, any> | undefined>} the stored document, or undefined.
   */
  async #read() {
    try {
      const text = await readFile(this.keyFile, 'utf8')
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') return parsed
      this.logger.warn(`identity file ${this.keyFile} does not contain an object; regenerating`)
      return undefined
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'ENOENT') {
        this.logger.warn(`could not read identity file ${this.keyFile}:`, String(error))
      }
      return undefined
    }
  }

  /**
   * Persist the current identity atomically.
   *
   * @param {{announce: boolean}} options whether a failure should be reported as a warning.
   * @returns {Promise<boolean>} whether the file was written.
   */
  async #write(options) {
    const document = {
      version: IDENTITY_VERSION,
      instanceId: this.instanceId,
      key: this.key,
      createdAt: this.createdAt ?? new Date().toISOString(),
      ...(this.rotatedAt ? { rotatedAt: this.rotatedAt } : {}),
    }
    const body = `${JSON.stringify(document, null, 2)}\n`
    try {
      await mkdir(dirname(this.keyFile), { recursive: true, mode: 0o700 })
      const temporary = `${this.keyFile}.${process.pid}.tmp`
      await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.keyFile)
      this.persistenceWarning = undefined
      return true
    } catch (error) {
      this.persistenceWarning = `identity could not be persisted to ${this.keyFile}: ${String(error)}`
      this.logger.warn(
        `${this.persistenceWarning} — the instance key will change on the next start, so the server will see a new machine`,
      )
      if (options.announce) this.shouldAnnounceKey = true
      return false
    }
  }
}

/**
 * Derive a stable instance id from machine facts, used before the first write.
 *
 * @returns {string} an id of the form `dsh-<12 hex chars>`.
 */
export function deriveInstanceId() {
  const seed = `${safeHostname()}|${process.env.DSH_HOME ?? ''}|${process.env.USERNAME ?? process.env.USER ?? ''}`
  return `dsh-${shortHash(seed)}`
}

/**
 * @returns {string} the host name, or `unknown-host` when the platform refuses.
 */
function safeHostname() {
  try {
    return hostname()
  } catch {
    return 'unknown-host'
  }
}
