/**
 * Minimal leveled logger.
 *
 * The plugin logs through the Cordis logger service when the composition
 * provides one (`ctx.logger('dsh2server')`), and falls back to `console`
 * otherwise. Log output is intentionally chatty only at `info` and below the
 * `debug` threshold; a relay bridge that prints on every heartbeat is useless
 * in a real deployment.
 *
 * @module dsh2server/lib/log
 */

/** Severity ordering used by {@link Logger}. */
const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 }

/** Accepted `logLevel` config values. */
export const LOG_LEVELS = Object.keys(LEVELS)

/**
 * Resolve the Cordis logger facade once, tolerating every shape a composition
 * may hand us (a callable service, a plain object, or nothing at all).
 *
 * @param {unknown} ctx cordis context.
 * @param {string} name logger facade name.
 * @returns {{error: Function, warn: Function, info: Function, debug: Function} | undefined}
 */
function resolveCordisLogger(ctx, name) {
  try {
    const service = ctx?.logger
    if (!service) return undefined
    if (typeof service === 'function') {
      const facade = service.call(ctx, name)
      if (facade && typeof facade.info === 'function') return facade
    }
    if (typeof service.info === 'function') return service
  } catch {
    // Logging must never be the reason the plugin fails to load.
  }
  return undefined
}

/**
 * A tiny severity-filtered logger with a stable `[dsh2server]` prefix.
 */
export class Logger {
  /**
   * @param {string} level one of {@link LOG_LEVELS}.
   * @param {object} [options]
   * @param {unknown} [options.ctx] cordis context carrying a logger service.
   * @param {string} [options.scope] prefix shown on every line.
   */
  constructor(level = 'info', options = {}) {
    this.level = Object.hasOwn(LEVELS, level) ? level : 'info'
    this.threshold = LEVELS[this.level]
    this.scope = options.scope ?? 'dsh2server'
    this.cordis = resolveCordisLogger(options.ctx, this.scope)
    /** @type {string[]} recent lines, exposed for diagnostics and tests. */
    this.recent = []
  }

  /**
   * Change this logger's severity threshold at runtime.
   *
   * The plugin's own `logLevel` is resolved *after* the logger exists (the
   * console configuration layer is read from disk first), so the level is
   * applied rather than passed at construction.
   *
   * @param {string} level one of {@link LOG_LEVELS}.
   */
  setLevel(level) {
    this.level = Object.hasOwn(LEVELS, level) ? level : 'info'
    this.threshold = LEVELS[this.level]
  }

  /**
   * @param {'error'|'warn'|'info'|'debug'} severity message severity.
   * @returns {boolean} whether a line at this severity is emitted.
   */
  enabled(severity) {
    return LEVELS[severity] <= this.threshold
  }

  /**
   * Emit one line at the given severity.
   *
   * @param {'error'|'warn'|'info'|'debug'} severity message severity.
   * @param {unknown[]} args printf-ish arguments forwarded to the sink.
   */
  emit(severity, args) {
    if (!this.enabled(severity)) return
    const line = `[${this.scope}] ${args.map((value) => formatValue(value)).join(' ')}`
    this.recent.push(line)
    if (this.recent.length > 200) this.recent.shift()
    const sink = this.cordis?.[severity]
    if (typeof sink === 'function') {
      try {
        sink.apply(this.cordis, args)
        return
      } catch {
        // Fall through to the console when the composition's sink rejects.
      }
    }
    const consoleMethod = severity === 'debug' ? 'log' : severity
    // eslint-disable-next-line no-console
    console[consoleMethod](line)
  }

  /** @param {...unknown} args */
  error(...args) {
    this.emit('error', args)
  }

  /** @param {...unknown} args */
  warn(...args) {
    this.emit('warn', args)
  }

  /** @param {...unknown} args */
  info(...args) {
    this.emit('info', args)
  }

  /** @param {...unknown} args */
  debug(...args) {
    this.emit('debug', args)
  }
}

/**
 * Render one log argument without ever throwing on a hostile value.
 *
 * @param {unknown} value any value.
 * @returns {string} a single-line representation.
 */
export function formatValue(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
