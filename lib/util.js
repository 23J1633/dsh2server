/**
 * Small, dependency-free helpers shared by the bridge modules.
 *
 * Everything here is defensive by construction: the bridge runs inside a live
 * agent host, so a helper that throws on a surprising value would take down the
 * harness instead of one remote call.
 *
 * @module dsh2server/lib/util
 */

import { createHash, randomUUID } from 'node:crypto'
import { hostname, platform, arch, release, type, cpus, totalmem } from 'node:os'

/**
 * Promise resolved after `ms` milliseconds.
 *
 * @param {number} ms delay in milliseconds.
 * @returns {Promise<void>} resolves after the delay.
 */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

/**
 * A promise plus its externally callable settle functions.
 *
 * @template T
 * @returns {{promise: Promise<T>, resolve: (value: T) => void, reject: (error: unknown) => void}}
 */
export function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * Race a promise against a timer without leaking the timer.
 *
 * @template T
 * @param {Promise<T>} promise work to bound.
 * @param {number} ms timeout in milliseconds; `<= 0` disables the bound.
 * @param {() => Error} [onTimeout] error factory used when the bound elapses.
 * @returns {Promise<T>} the work's value, or a rejection from `onTimeout`.
 */
export async function withTimeout(promise, ms, onTimeout) {
  if (!(ms > 0)) return promise
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout ? onTimeout() : new Error(`timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Coerce an unknown thrown value into a stable `{code, message}` pair.
 *
 * @param {unknown} error thrown value.
 * @param {string} [fallbackCode] code used when the error carries none.
 * @returns {{code: string, message: string}} normalized error facts.
 */
export function normalizeError(error, fallbackCode = 'internal') {
  if (error && typeof error === 'object') {
    const code = typeof error.code === 'string' && error.code ? error.code : fallbackCode
    const message = typeof error.message === 'string' && error.message ? error.message : String(error)
    return { code, message }
  }
  return { code: fallbackCode, message: String(error) }
}

/**
 * Best-effort JSON round trip that never throws.
 *
 * Used to guarantee that every value leaving the plugin is wire-serializable:
 * a session event carries `JsonValue` by contract, but a plugin-contributed
 * event could still smuggle a `BigInt`, a cycle, or a `Date` in.
 *
 * @param {unknown} value candidate value.
 * @param {{maxBytes?: number}} [options] byte budget for the encoded form.
 * @returns {{ok: true, value: unknown} | {ok: false, reason: string}} outcome.
 */
export function toWireJson(value, options = {}) {
  const maxBytes = options.maxBytes ?? 0
  let encoded
  try {
    encoded = JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return `${item}n`
      if (typeof item === 'function' || typeof item === 'symbol') return undefined
      if (typeof item === 'number' && !Number.isFinite(item)) return null
      if (item === undefined) return null
      return item
    })
  } catch (error) {
    return { ok: false, reason: `value is not JSON-serializable: ${normalizeError(error).message}` }
  }
  if (encoded === undefined) return { ok: false, reason: 'value encodes to undefined' }
  if (maxBytes > 0 && Buffer.byteLength(encoded, 'utf8') > maxBytes) {
    return { ok: false, reason: `value exceeds maxPayloadBytes (${maxBytes})` }
  }
  return { ok: true, value: JSON.parse(encoded) }
}

/**
 * Truncate one string to a code-point budget.
 *
 * @param {string} text source text.
 * @param {number} max maximum code points.
 * @returns {string} the original text or a clipped copy ending in `…`.
 */
export function truncate(text, max) {
  if (typeof text !== 'string' || !(max > 0)) return text
  const points = Array.from(text)
  if (points.length <= max) return text
  return `${points.slice(0, Math.max(0, max - 1)).join('')}…`
}

/**
 * Remove obviously secret-looking fields from a value before it is logged or
 * echoed back on the wire.
 *
 * @param {unknown} value any value.
 * @param {number} [depth] remaining recursion budget.
 * @returns {unknown} a redacted deep copy.
 */
export function redact(value, depth = 4) {
  if (depth <= 0) return '[redacted-depth]'
  if (Array.isArray(value)) return value.map((item) => redact(item, depth - 1))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = /token|secret|password|apikey|api_key|authorization|credential/i.test(key)
        ? '[redacted]'
        : redact(item, depth - 1)
    }
    return out
  }
  return value
}

/**
 * Deterministic short hash used to build a stable instance id.
 *
 * @param {string} input source text.
 * @returns {string} 12-character hex digest.
 */
export function shortHash(input) {
  return createHash('sha256').update(String(input)).digest('hex').slice(0, 12)
}

/** @returns {string} a fresh opaque request/correlation id. */
export function newId() {
  return randomUUID()
}

/**
 * Snapshot the host facts reported in `hello`.
 *
 * Kept deliberately small: the server is a relay, so it needs enough to label
 * and route the connection, not a full inventory of the machine.
 *
 * @returns {Record<string, unknown>} host facts.
 */
export function hostFacts() {
  let cpuModel
  try {
    cpuModel = cpus()?.[0]?.model
  } catch {
    cpuModel = undefined
  }
  let memoryBytes
  try {
    memoryBytes = totalmem()
  } catch {
    memoryBytes = undefined
  }
  return {
    hostname: safeCall(hostname),
    platform: safeCall(platform),
    arch: safeCall(arch),
    osRelease: safeCall(release),
    osType: safeCall(type),
    cpuModel,
    memoryBytes,
    nodeVersion: process.version,
    pid: process.pid,
  }
}

/**
 * @param {() => string} fn value producer that may throw on exotic platforms.
 * @returns {string | undefined} the value, or undefined when it threw.
 */
function safeCall(fn) {
  try {
    return fn()
  } catch {
    return undefined
  }
}

/**
 * Normalize the configured endpoint into absolute HTTP and WebSocket base URLs.
 *
 * Accepted inputs (all equivalent):
 *   `https://example.com/dsh-api`
 *   `https://example.com/dsh-api/`
 *   `wss://example.com/dsh-api`
 *
 * @param {string} endpoint raw configured endpoint.
 * @returns {{ok: true, http: string, ws: string, origin: string, path: string} | {ok: false, reason: string}} parsed form.
 */
export function parseEndpoint(endpoint) {
  const raw = String(endpoint ?? '').trim()
  if (!raw) return { ok: false, reason: 'endpoint is empty' }
  let url
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: `endpoint is not a valid absolute URL: ${raw}` }
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase()
  const schemeMap = { http: 'http', https: 'https', ws: 'http', wss: 'https' }
  if (!Object.hasOwn(schemeMap, scheme)) {
    return { ok: false, reason: `endpoint scheme must be http(s) or ws(s), got "${scheme}"` }
  }
  url.hash = ''
  url.search = ''
  const path = url.pathname.replace(/\/+$/, '')
  const http = `${schemeMap[scheme]}://${url.host}${path}`
  const ws = `${schemeMap[scheme] === 'https' ? 'wss' : 'ws'}://${url.host}${path}`
  return { ok: true, http, ws, origin: url.origin, path }
}

/**
 * Join an absolute base URL and a path segment, tolerating either side's slashes.
 *
 * @param {string} base absolute base URL.
 * @param {string} suffix path or absolute URL to append.
 * @returns {string} the joined URL.
 */
export function joinUrl(base, suffix) {
  const text = String(suffix ?? '')
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text
  const trimmedBase = String(base).replace(/\/+$/, '')
  const trimmedSuffix = text.replace(/^\/+/, '')
  return trimmedSuffix ? `${trimmedBase}/${trimmedSuffix}` : trimmedBase
}
