/**
 * Transport factory.
 *
 * Resolves the URLs once per transport instance so `endpoint`, `wsPath`,
 * `eventsPath`, and `inboxPath` compose into absolute carriers, and applies the
 * configured authentication mode consistently for both carriers.
 *
 * @module dsh2server/lib/transport/index
 */

import { WebSocketTransport, resolveWebSocketUrl } from './ws.js'
import { HttpTransport } from './http.js'
import { parseEndpoint } from '../util.js'

/**
 * @param {Record<string, any>} config validated plugin config.
 * @param {string} instanceId resolved instance identity.
 * @param {string} [key] resolved instance key.
 * @param {string} [endpoint] one endpoint to resolve; defaults to the first configured.
 * @returns {object} the parsed endpoint plus any validation problem.
 */
export function resolveUrls(config, instanceId, key = '', endpoint = config.endpoints?.[0] ?? config.endpoint) {
  const parsed = parseEndpoint(endpoint)
  if (!parsed.ok) return parsed

  // `http://` is fully supported — a LAN or loopback relay is a legitimate
  // deployment — but the key travels in clear text there, so the caller reports
  // it rather than silently accepting it.
  const insecure = !parsed.http.startsWith('https://')

  // The WebSocket carrier authenticates however `authMode` says. The HTTP
  // carrier has no handshake frame, so its key must ride every request: it goes
  // in the Authorization header unless the operator explicitly asked for the
  // query form (which is what a proxy or a browser-ish client may need, at the
  // cost of the secret appearing in request logs).
  const wsHeaders = { 'x-dsh-instance-id': instanceId }
  let queryKey = ''
  if (key) {
    if (config.authMode === 'header') wsHeaders.authorization = `Bearer ${key}`
    if (config.authMode === 'query') queryKey = key
  }

  const httpHeaders = { 'x-dsh-instance-id': instanceId }
  if (key && config.authMode !== 'query') httpHeaders.authorization = `Bearer ${key}`

  return {
    ok: true,
    endpoint: parsed.http,
    insecure,
    http: parsed.http,
    ws: resolveWebSocketUrl(parsed.ws, config.wsPath),
    queryKey: config.authMode === 'query' ? key : '',
    authHeaders: wsHeaders,
    httpHeaders,
  }
}

/**
 * Build one carrier.
 *
 * @param {'ws'|'http'} kind carrier to build.
 * @param {object} options factory options.
 * @param {Record<string, any>} options.config validated plugin config.
 * @param {string} options.instanceId resolved instance identity.
 * @param {import('../log.js').Logger} options.logger plugin logger.
 * @param {object} options.urls result of {@link resolveUrls}.
 * @returns {import('./base.js').Transport} the carrier.
 */
export function createTransport(kind, options) {
  const { config, instanceId, logger, urls } = options
  if (kind === 'ws') {
    const url = new URL(urls.ws)
    if (urls.queryKey) url.searchParams.set('key', urls.queryKey)
    url.searchParams.set('instanceId', instanceId)
    url.searchParams.set('v', '1')
    return new WebSocketTransport({
      url: url.toString(),
      headers: urls.authHeaders,
      logger,
      maxPayloadBytes: config.maxPayloadBytes,
    })
  }
  return new HttpTransport({
    baseUrl: urls.http,
    eventsPath: config.eventsPath,
    inboxPath: config.inboxPath,
    headers: urls.httpHeaders,
    queryKey: urls.queryKey,
    instanceId,
    batchSize: config.batchSize,
    batchIntervalMs: config.batchIntervalMs,
    pollWaitMs: config.pollWaitMs,
    requestTimeoutMs: config.requestTimeoutMs,
    logger,
    maxPayloadBytes: config.maxPayloadBytes,
  })
}

/**
 * Decide the carrier order for one connection attempt.
 *
 * `auto` always tries WebSocket first and falls back to HTTP long-poll within
 * the same attempt. That is deliberately not "sticky": a server that was simply
 * down should be reached over WebSocket again as soon as it returns, and a
 * deployment whose proxy blocks the upgrade should pin `transport: 'http'`
 * rather than rely on the bridge guessing.
 *
 * @param {Record<string, any>} config validated plugin config.
 * @returns {Array<'ws'|'http'>} carriers to try, in order.
 */
export function carrierOrder(config) {
  if (config.transport === 'ws') return ['ws']
  if (config.transport === 'http') return ['http']
  return WebSocketTransport.supported() ? ['ws', 'http'] : ['http']
}
