/**
 * dsh2server — connect this DeepSeek Harness instance to a relay server.
 *
 * The plugin is a **bundle** (`dsh.bundle.patch` in `package.json`): installing
 * it into a profile appends `cordis.patch.yml` as a configuration layer that
 * inserts one loader row. That row's only required value is `endpoint`, the base
 * URL of your server's API.
 *
 * Design in one paragraph: the plugin opens an **outbound** WebSocket (with an
 * HTTP long-poll fallback) to that endpoint, authenticating with a locally
 * generated per-instance key. It streams live work state — sessions, working
 * directories, agent status, durable session events, tool activity, jobs,
 * goals, and interactive prompts — and accepts a fixed set of remote operations
 * (new command, interrupt, pause/resume, approvals, job control, session
 * lifecycle). The server is a pure relay: it may keep everything in memory and
 * store nothing, because the plugin can always resend a full snapshot.
 *
 * @module dsh2server
 */

import { Bridge } from './lib/bridge.js'
import { A2SRuntimeControl } from './lib/a2s-runtime-control.js'
import { readA2SConfig, withA2SDefaults } from './lib/a2s-shared-config.js'
import { Config, ENDPOINT_ENV, KEY_ENV, validateConfig } from './lib/config.js'
import { registerConsole } from './lib/host-ui.js'
import { Identity } from './lib/identity.js'
import { Logger } from './lib/log.js'
import { ConfigStore } from './lib/settings-store.js'
import { PLUGIN_NAME, PLUGIN_VERSION, PROTOCOL_VERSION, nowIso } from './lib/version.js'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url))

export { Config }
export { Bridge }
export { A2SRuntimeControl }
export { defaultA2SConfigFile, readA2SConfig, withA2SDefaults } from './lib/a2s-shared-config.js'
export { ConfigStore }
export { CONSOLE_BASE, CONSOLE_ROUTES } from './lib/host-ui.js'
export { PLUGIN_NAME, PLUGIN_VERSION, PROTOCOL_VERSION }

/** Cordis plugin name shown in loader diagnostics. */
export const name = 'dsh2server'

/**
 * No `inject` list on purpose.
 *
 * Every harness service this plugin touches (`agents`, `sessions`,
 * `sessionController`, `workspaceRegistry`, `jobs`, `goals`, `commands`,
 * `approval`, `userQuestions`, `sessionProjections`) is discovered at runtime
 * with `ctx.get(...)` and advertised in `hello.capabilities`. Declaring them as
 * hard dependencies would refuse to load the bridge in minimal compositions
 * that can still list sessions and stream events perfectly well.
 */

/**
 * Plugin entry point.
 *
 * @param {any} ctx cordis context of this plugin's fiber.
 * @param {Record<string, any>} [rawConfig] configuration from the loader row.
 * @returns {void} the plugin starts asynchronously through its effect.
 */
export function apply(ctx, rawConfig) {
  // A profile may pin a dedicated shared-config file (useful for portable
  // installs and deterministic tests); otherwise use the platform default.
  const sharedConfigFile = typeof rawConfig?.a2sConfigFile === 'string'
    ? rawConfig.a2sConfigFile.trim()
    : ''
  const shared = readA2SConfig(sharedConfigFile || undefined)
  const effectiveComposition = withA2SDefaults(rawConfig ?? {}, shared)
  // Cordis already validated the config through `Config`; validating again makes
  // the module directly usable (tests, scripts) and keeps defaults in one place.
  const validated = validateConfig(effectiveComposition)
  if (validated.issues) {
    const detail = validated.issues
      .map((issue) => `${issue.path ? `${issue.path.join('.')}: ` : ''}${issue.message}`)
      .join('; ')
    throw new TypeError(`invalid ${PLUGIN_NAME} config: ${detail}`)
  }

  // The console layer (`<DSH_HOME>/dsh2server/config.json`) wins over the loader
  // row key by key. The store owns ONE config object and mutates it in place, so
  // the bridge, host adapter, and forwarders always observe the current values.
  const logger = new Logger('info', { ctx })
  const store = new ConfigStore({ composition: effectiveComposition, logger })

  if ((effectiveComposition.endpoint ?? '') === '' || (Array.isArray(effectiveComposition.endpoint) && effectiveComposition.endpoint.length === 0)) {
    logger.info(
      `${PLUGIN_NAME} ${PLUGIN_VERSION}: no endpoint on the loader row — open ` +
        `Settings → Plugins → dsh2server in the web GUI to set one, or export ${ENDPOINT_ENV}.`,
    )
  }

  /** @type {Bridge | undefined} */
  let bridge
  let runtimeControl
  let disposed = false

  ctx.effect(() => {
    void (async () => {
      try {
        // Resolve the layered configuration before touching the identity file.
        try {
          await store.load()
        } catch (error) {
          logger.error(`the stored console configuration is invalid and was ignored: ${String(error)}`)
          await store.clear().catch(() => undefined)
        }
        logger.setLevel(store.config.logLevel)
        if (shared) logger.info(`using the shared A2S device identity from ${shared.file}`)

        const identity = await new Identity({
          keyFile: store.config.keyFile,
          explicitKey: store.config.key,
          explicitInstanceId: store.config.instanceId,
          logger,
        }).load()
        if (disposed) return
        announceIdentity(logger, identity, store.config)

        bridge = new Bridge({ ctx, config: store.config, identity, logger })
        bridge.start()
        if (shared?.file) {
          runtimeControl = new A2SRuntimeControl({ sharedFile: shared.file, bridge, logger, installPath: PLUGIN_ROOT })
          try {
            await runtimeControl.start()
          } catch (error) {
            logger.warn(`A2S local control is unavailable: ${String(error)}`)
            runtimeControl = undefined
          }
        }
        // Wait for the Connection service rather than probing once: the web
        // composition may mount it after this plugin, and a headless profile
        // never mounts it at all — in which case the console simply never
        // appears and everything else keeps working.
        ctx.inject(['connection'], (connectionCtx) => {
          registerConsole({ ctx: connectionCtx, logger, identity, store, bridge, startedAt: Date.now() })
        })
      } catch (error) {
        logger.error(`failed to start: ${String(error)}`)
      }
    })()
    return async () => {
      disposed = true
      const current = bridge
      const currentRuntimeControl = runtimeControl
      bridge = undefined
      runtimeControl = undefined
      if (currentRuntimeControl) await currentRuntimeControl.dispose()
      if (current) await current.dispose()
    }
  })
}

/**
 * Print the identity facts an operator needs, once per start.
 *
 * The key is a secret, but it is *this machine's own* secret and the operator
 * must copy it into the server's key list; printing it to the local dsh log is
 * the documented pairing step. It is never sent anywhere except the configured
 * endpoint.
 *
 * @param {Logger} logger plugin logger.
 * @param {Identity} identity loaded identity.
 * @param {Record<string, any>} config validated config.
 */
function announceIdentity(logger, identity, config) {
  logger.info(`${PLUGIN_NAME} ${PLUGIN_VERSION} (protocol v${PROTOCOL_VERSION}) starting at ${nowIso()}`)
  if (identity.persistenceWarning) {
    logger.warn(identity.persistenceWarning)
  }
  const target = (config.endpoints ?? []).join(', ')
  if (identity.shouldAnnounceKey) {
    logger.info(
      [
        '',
        '  ┌──────────────────────────────────────────────────────────────────────',
        `  │ This dsh instance generated its unique server key.`,
        `  │`,
        `  │   instance id : ${identity.instanceId}`,
        `  │   key         : ${identity.key}`,
        `  │   stored in   : ${identity.keyFile}`,
        `  │`,
        `  │ Add this key to your relay server's key list to authorize this machine.`,
        `  │ The same key works for every configured endpoint:`,
        `  │   ${target}`,
        `  │`,
        `  │ One key per machine, so a server can manage many dsh instances`,
        `  │ independently and revoke any one of them by deleting its key.`,
        `  └──────────────────────────────────────────────────────────────────────`,
        '',
      ].join('\n'),
    )
  } else {
    logger.info(
      `instance ${identity.instanceId}, key ${identity.fingerprint()}${identity.keyFile ? ` (${identity.keyFile})` : ''}`,
    )
  }
  if (config.authMode === 'hello') {
    logger.debug(`authenticating with the instance key inside the hello frame (${KEY_ENV} can pin it via env)`)
  }
}
