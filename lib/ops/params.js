/**
 * Inbound parameter validation.
 *
 * The plugin treats the server as untrusted input: every method validates its
 * parameters and answers with `invalid_params` rather than letting a malformed
 * value reach a host service. The helpers below keep that uniform and keep the
 * handlers readable.
 *
 * @module dsh2server/lib/ops/params
 */

import { ERROR_CODES, fail } from '../protocol.js'

/**
 * @param {unknown} params raw request parameters.
 * @returns {Record<string, any>} the parameters, or an empty object.
 */
export function asParams(params) {
  if (params === undefined || params === null) return {}
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw fail(ERROR_CODES.INVALID_PARAMS, 'params must be an object')
  }
  return /** @type {Record<string, any>} */ (params)
}

/**
 * @param {Record<string, any>} params parameters.
 * @param {string} name field name.
 * @param {{maxLength?: number}} [options] constraints.
 * @returns {string} the required non-empty string.
 */
export function requireString(params, name, options = {}) {
  const value = params[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw fail(ERROR_CODES.INVALID_PARAMS, `"${name}" must be a non-empty string`, { details: { field: name } })
  }
  if (options.maxLength && value.length > options.maxLength) {
    throw fail(ERROR_CODES.INVALID_PARAMS, `"${name}" must be at most ${options.maxLength} characters`, {
      details: { field: name },
    })
  }
  return value
}

/**
 * @param {Record<string, any>} params parameters.
 * @param {string} name field name.
 * @param {{maxLength?: number}} [options] constraints.
 * @returns {string | undefined} the optional string.
 */
export function optionalString(params, name, options = {}) {
  const value = params[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw fail(ERROR_CODES.INVALID_PARAMS, `"${name}" must be a string`, { details: { field: name } })
  }
  if (options.maxLength && value.length > options.maxLength) {
    throw fail(ERROR_CODES.INVALID_PARAMS, `"${name}" must be at most ${options.maxLength} characters`, {
      details: { field: name },
    })
  }
  return value
}

/**
 * @param {Record<string, any>} params parameters.
 * @param {string} name field name.
 * @param {number} min inclusive lower bound.
 * @param {number} max inclusive upper bound.
 * @returns {number | undefined} the optional integer.
 */
export function optionalInt(params, name, min, max) {
  const value = params[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw fail(ERROR_CODES.INVALID_PARAMS, `"${name}" must be an integer between ${min} and ${max}`, {
      details: { field: name },
    })
  }
  return value
}

/**
 * @param {Record<string, any>} params parameters.
 * @param {string} name field name.
 * @param {readonly string[]} allowed accepted values.
 * @param {string} [fallback] default when the field is absent.
 * @returns {string} the validated enum value.
 */
export function enumParam(params, name, allowed, fallback) {
  const value = params[name]
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback
    throw fail(ERROR_CODES.INVALID_PARAMS, `"${name}" is required and must be one of ${allowed.join(' | ')}`, {
      details: { field: name },
    })
  }
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw fail(ERROR_CODES.INVALID_PARAMS, `"${name}" must be one of ${allowed.join(' | ')}`, {
      details: { field: name, allowed },
    })
  }
  return value
}

/**
 * @param {Record<string, any>} params parameters.
 * @param {string} name field name.
 * @returns {boolean} the required boolean.
 */
export function requireBoolean(params, name) {
  const value = params[name]
  if (typeof value !== 'boolean') {
    throw fail(ERROR_CODES.INVALID_PARAMS, `"${name}" must be a boolean`, { details: { field: name } })
  }
  return value
}

/**
 * Normalize a prompt request into model-facing content blocks.
 *
 * Accepts either `text` (the common case for a remote console) or an explicit
 * `content` array, so a backend with a rich composer can send structured blocks
 * while a minimal one sends a string.
 *
 * @param {Record<string, any>} params prompt parameters.
 * @returns {Array<{type: 'text', text: string}>} content blocks.
 */
export function promptContent(params) {
  const explicit = params.content
  if (explicit !== undefined && explicit !== null) {
    if (!Array.isArray(explicit) || explicit.length === 0) {
      throw fail(ERROR_CODES.INVALID_PARAMS, '"content" must be a non-empty array of content blocks')
    }
    const blocks = explicit.map((block) => {
      if (!block || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') {
        throw fail(
          ERROR_CODES.INVALID_PARAMS,
          'this plugin accepts only text content blocks: { "type": "text", "text": "…" }',
        )
      }
      return { type: 'text', text: block.text }
    })
    if (!blocks.some((block) => block.text.trim() !== '')) {
      throw fail(ERROR_CODES.INVALID_PARAMS, 'at least one content block must contain non-whitespace text')
    }
    return blocks
  }
  const text = requireString(params, 'text', { maxLength: 1000000 })
  return [{ type: 'text', text }]
}
