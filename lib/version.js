/**
 * Version constants for the plugin and the wire protocol it speaks.
 *
 * The plugin version is read from the shipped `package.json` so it can never
 * drift from what the user installed. The protocol version is a hand-maintained
 * integer: bump it only for a breaking envelope change, and keep both language
 * sides of `docs/API.md` in sync when you do.
 *
 * @module dsh2server/lib/version
 */

import { readFileSync } from 'node:fs'

/** Fallback identity used when `package.json` cannot be read. */
const FALLBACK = { name: 'dsh2server', version: '0.0.0' }

let pkg = FALLBACK
try {
  pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
} catch {
  // A missing or unreadable manifest must never prevent the plugin from loading.
}

/** npm package name of this plugin. */
export const PLUGIN_NAME = typeof pkg.name === 'string' && pkg.name ? pkg.name : FALLBACK.name

/** Installed plugin version. */
export const PLUGIN_VERSION = typeof pkg.version === 'string' && pkg.version ? pkg.version : FALLBACK.version

/**
 * Version of the server protocol implemented by this plugin.
 *
 * Sent as `v` on every envelope. A server may accept several versions; the
 * plugin refuses to run against a server that answers `hello.ack` with a
 * different major version.
 */
export const PROTOCOL_VERSION = 1

/** Local-time ISO timestamp used in log lines only (never on the wire). */
export function nowIso() {
  return new Date().toISOString()
}
