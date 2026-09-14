/**
 * `instance.*` operations: identity, key management, and link health.
 *
 * @module dsh2server/lib/ops/instance
 */

import { ERROR_CODES, fail } from '../protocol.js'
import { PLUGIN_NAME, PLUGIN_VERSION, PROTOCOL_VERSION } from '../version.js'
import { redact } from '../util.js'
import { optionalString } from './params.js'

/**
 * @param {object} deps operation dependencies.
 * @returns {Record<string, Function>} the `instance.*` handlers.
 */
export function createInstanceOps(deps) {
  const { config, bridge, identity, host, forwarder, startedAt, logger } = deps

  return {
    /**
     * Everything a freshly connected backend needs to label and route this
     * machine, without duplicating the `hello` frame.
     *
     * `connection` describes the link the request arrived on; `connections`
     * lists every configured endpoint, so a console attached to one server can
     * still see whether the machine also reaches the others.
     */
    'instance.info': async (_params, ctx) => ({
      instanceId: identity.instanceId,
      displayName: config.displayName || undefined,
      keyFingerprint: identity.fingerprint(),
      keyFile: identity.keyFile,
      keyPersisted: identity.persistenceWarning === undefined,
      plugin: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
      protocol: PROTOCOL_VERSION,
      uptimeMs: Date.now() - startedAt,
      capabilities: host.capabilities(),
      endpoints: config.endpoints,
      methods: bridge.operations.methods,
      connection: ctx?.link?.describe() ?? bridge.describe(),
      connections: bridge.describe().links,
      subscriptions: bridge.subscriptions(),
      pausedSessions: deps.gate.pausedSessions(),
      pendingDecisions: forwarder.pendingDecisions(),
      config: redact({
        endpoint: config.endpoint,
        endpoints: config.endpoints,
        transport: config.transport,
        authMode: config.authMode,
        autoSubscribe: config.autoSubscribe,
        autoSubscribeSessions: config.autoSubscribeSessions,
        forwardApprovals: config.forwardApprovals,
        forwardQuestions: config.forwardQuestions,
        allowedCwdPrefixes: config.allowedCwdPrefixes,
        logLevel: config.logLevel,
      }),
    }),

    /** Liveness probe that never touches the host. */
    'instance.ping': async () => ({ pong: true, ts: Date.now() }),

    /** Connectivity and error summary for a monitoring backend. */
    'instance.health': async () => ({
      ok: true,
      connected: bridge.isConnected(),
      endpoints: config.endpoints,
      links: bridge.describe().links,
      transport: bridge.primaryLink()?.describe() ?? null,
      lastError: bridge.lastError(),
      buffer: bridge.bufferStats(),
      liveSessions: host.service('sessions')?.list?.()?.length ?? 0,
    }),

    /**
     * Read this machine's instance key.
     *
     * The caller already authenticated with this key, so reading it back leaks
     * nothing new; it exists so a server operator can re-pair a machine whose
     * key entry was lost.
     */
    'instance.key': async () => {
      if (!config.allowRemoteControl) {
        throw fail(ERROR_CODES.DISABLED, 'reading the instance key is disabled by plugin configuration')
      }
      return {
        instanceId: identity.instanceId,
        key: identity.key,
        keyFingerprint: identity.fingerprint(),
        keyFile: identity.keyFile,
        persisted: identity.persistenceWarning === undefined,
        warning: identity.persistenceWarning,
      }
    },

    /**
     * Replace the instance key with a fresh one.
     *
     * The link is dropped immediately afterwards, because the server no longer
     * recognizes the instance until it stores the returned key. This is the
     * revocation path: rotate, then delete the old entry on the server.
     */
    'instance.rotateKey': async (params) => {
      if (!config.allowRemoteControl) {
        throw fail(ERROR_CODES.DISABLED, 'rotating the instance key is disabled by plugin configuration')
      }
      const confirm = optionalString(params, 'confirm')
      if (confirm !== identity.instanceId) {
        throw fail(
          ERROR_CODES.INVALID_PARAMS,
          'rotating the key disconnects this machine until the server stores the new key; pass "confirm" set to the instanceId',
          { details: { instanceId: identity.instanceId } },
        )
      }
      const key = await identity.rotate()
      logger.warn(`instance key rotated; update the server key list to ${identity.fingerprint()}`)
      // Give the response time to leave before the credential changes.
      setTimeout(() => void bridge.reconnect('instance key rotated'), 250)
      return {
        instanceId: identity.instanceId,
        key,
        keyFingerprint: identity.fingerprint(),
        note: 'the link is being re-established with the new key; store it on the server now',
      }
    },
  }
}
