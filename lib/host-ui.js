/**
 * Web console routes: the Host half of the graphical configuration card.
 *
 * The card that renders in **Settings → Plugins** lives in this same package
 * (`lib/client.js`, the browser half). The two halves talk over one small API
 * mounted on the Connection's own shared channel:
 *
 *     GET  /api/dsh2server/state        identity, key, effective config, link health
 *     POST /api/dsh2server/config       write the console config layer and reconnect
 *     POST /api/dsh2server/reconnect    drop and re-establish every link
 *     POST /api/dsh2server/key/rotate   mint a new instance key
 *
 * Registering routes on `ctx.connection.fetch` is a **public extension point**,
 * not a patch: they live under `/api`, so the Connection's Host/Origin fence and
 * browser-session authentication apply to them exactly as they do to every
 * built-in route. Nothing in the dsh installation is modified, and the routes
 * exist for any deployment that composes this bundle.
 *
 * When a profile has no Connection (a headless composition), the console is
 * simply absent: registration is skipped and the plugin keeps working.
 *
 * @module dsh2server/lib/host-ui
 */

import { EDITABLE_KEYS } from './settings-store.js'
import { PLUGIN_NAME, PLUGIN_VERSION, PROTOCOL_VERSION } from './version.js'

/** Absolute path prefix of the console API, below `/api`. */
export const CONSOLE_BASE = '/api/dsh2server'

/** The exact routes this plugin owns. Exported so tests and docs stay in sync. */
export const CONSOLE_ROUTES = Object.freeze([
  Object.freeze({ path: `${CONSOLE_BASE}/state`, methods: Object.freeze(['GET']) }),
  Object.freeze({ path: `${CONSOLE_BASE}/config`, methods: Object.freeze(['POST']) }),
  Object.freeze({ path: `${CONSOLE_BASE}/reconnect`, methods: Object.freeze(['POST']) }),
  Object.freeze({ path: `${CONSOLE_BASE}/key/rotate`, methods: Object.freeze(['POST']) }),
])

/** Configuration fields the console reports, in card order. */
const REPORTED_KEYS = Object.freeze([
  'endpoints',
  'endpoint',
  'transport',
  'pollWaitMs',
  'heartbeatMs',
  'logLevel',
  'autoSubscribeSessions',
  'authMode',
  'forwardApprovals',
  'forwardQuestions',
  'allowRemotePrompt',
  'allowRemoteControl',
  'allowRemoteCommand',
  'allowedCwdPrefixes',
  'bufferSize',
  'maxPayloadBytes',
])

/**
 * @param {number} status HTTP status.
 * @param {unknown} body JSON body.
 * @returns {Response} a JSON response.
 */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Register the console routes on the Connection's shared channel.
 *
 * @param {object} options registration options.
 * @param {any} options.ctx cordis context of the plugin fiber.
 * @param {import('./log.js').Logger} options.logger plugin logger.
 * @param {import('./identity.js').Identity} options.identity resolved instance identity.
 * @param {import('./settings-store.js').ConfigStore} options.store configuration store.
 * @param {import('./bridge.js').Bridge} options.bridge running bridge.
 * @param {number} options.startedAt plugin start time, epoch ms.
 * @returns {boolean} whether the console was mounted.
 */
export function registerConsole(options) {
  const { ctx, logger, identity, store, bridge, startedAt } = options
  const connection = ctx.get?.('connection')
  if (!connection?.fetch?.register) {
    logger.debug('no Connection service in this composition; the web console card will not be served')
    return false
  }

  /**
   * @returns {Record<string, unknown>} the full console state payload.
   */
  const describeState = () => {
    const config = store.config
    const reported = {}
    for (const key of REPORTED_KEYS) reported[key] = config[key]
    return {
      ok: true,
      plugin: { name: PLUGIN_NAME, version: PLUGIN_VERSION, protocol: PROTOCOL_VERSION },
      instanceId: identity.instanceId,
      key: identity.key,
      keyFingerprint: identity.fingerprint(),
      keyFile: identity.keyFile,
      keyPersisted: identity.persistenceWarning === undefined,
      keyWarning: identity.persistenceWarning,
      uptimeMs: Date.now() - startedAt,
      config: reported,
      editableKeys: EDITABLE_KEYS,
      overriddenKeys: store.overriddenKeys(),
      compositionKeys: Object.keys(store.composition),
      configFile: store.file,
      connected: bridge.isConnected(),
      links: bridge.describe().links,
      methods: bridge.operations.methods,
    }
  }

  /**
   * Normalize one console write.
   *
   * @param {unknown} values raw `values` object.
   * @returns {Record<string, unknown>} normalized values.
   */
  const normalizeValues = (values) => {
    if (values === undefined || values === null) return {}
    if (typeof values !== 'object' || Array.isArray(values)) {
      throw new TypeError('"values" must be an object')
    }
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const [key, value] of Object.entries(values)) {
      if (key === 'endpoint') {
        const list = Array.isArray(value) ? value : String(value ?? '').split(',')
        const endpoints = list.map((entry) => String(entry).trim()).filter(Boolean)
        if (endpoints.some((entry) => entry.length > 2048)) throw new TypeError('an endpoint is too long')
        out.endpoint = endpoints
        continue
      }
      out[key] = value
    }
    return out
  }

  /** @type {Array<{path: string, methods: string[], requestBody: string, fetch: (request: Request) => Promise<Response>}>} */
  const routes = [
    {
      path: `${CONSOLE_BASE}/state`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => json(200, describeState()),
    },
    {
      path: `${CONSOLE_BASE}/config`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const body = await request.json().catch(() => undefined)
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return json(400, { ok: false, error: { code: 'invalid_request', message: 'body must be a JSON object' } })
        }
        try {
          const values = normalizeValues(body.values)
          const reset = Array.isArray(body.reset) ? body.reset.filter((key) => typeof key === 'string') : []
          const config = await store.update(values, reset)
          logger.info(
            `web console changed the configuration: ${Object.keys(values).join(', ') || '(none)'}` +
              `${reset.length > 0 ? `; reset ${reset.join(', ')}` : ''}`,
          )
          // Apply immediately: a new endpoint list reconnects without a restart.
          await bridge.applyConfig()
          logger.info(
            config.endpoints.length > 0
              ? `now connecting to ${config.endpoints.join(', ')}`
              : 'no endpoint configured; the bridge is idle',
          )
          return json(200, describeState())
        } catch (error) {
          const issues = /** @type {any} */ (error)?.issues
          return json(400, {
            ok: false,
            error: {
              code: 'invalid_config',
              message: String(/** @type {any} */ (error)?.message ?? error),
              issues: Array.isArray(issues) ? issues : undefined,
            },
          })
        }
      },
    },
    {
      path: `${CONSOLE_BASE}/reconnect`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => {
        logger.info('web console requested a reconnect')
        await bridge.reconnect('requested from the web console')
        return json(200, describeState())
      },
    },
    {
      path: `${CONSOLE_BASE}/key/rotate`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const body = await request.json().catch(() => ({}))
        if (body?.confirm !== identity.instanceId) {
          return json(400, {
            ok: false,
            error: {
              code: 'confirmation_required',
              message: 'send { "confirm": "<instanceId>" }; rotating disconnects this machine until the server stores the new key',
              instanceId: identity.instanceId,
            },
          })
        }
        try {
          await identity.rotate()
        } catch (error) {
          return json(400, { ok: false, error: { code: 'not_rotatable', message: String(error) } })
        }
        logger.warn(`instance key rotated; update the server key list to ${identity.fingerprint()}`)
        await bridge.reconnect('instance key rotated')
        return json(200, describeState())
      },
    },
  ]

  for (const route of routes) {
    ctx.effect(
      () => connection.fetch.register({ ...route, methods: [...route.methods] }),
      `dsh2server: console route ${route.path}`,
    )
  }
  logger.info(`web console available at ${CONSOLE_BASE}/state (Settings → Plugins → dsh2server)`)
  return true
}
