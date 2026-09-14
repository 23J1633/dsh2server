#!/usr/bin/env node
/**
 * Print this machine's dsh2server identity and instance key.
 *
 * Pairing a machine with a relay server is a copy-paste step: the plugin
 * generates a key on first start and prints it in the dsh log, and the operator
 * adds it to the server's key list. This script exists for the cases where the
 * log has scrolled away or the operator wants to gate the key behind a separate
 * step, and it is the only supported way to read a key without running dsh.
 *
 * Usage:
 *   node scripts/show-key.js [--json] [--rotate] [--key-file <path>]
 *
 * `--rotate` replaces the stored key. The machine will be refused by the relay
 * until the operator stores the new key there, which is exactly how revocation
 * of the old key works.
 *
 * @module dsh2server/scripts/show-key
 */

import { Identity, defaultKeyFile } from '../lib/identity.js'
import { Logger } from '../lib/log.js'

const args = process.argv.slice(2)

/**
 * @param {string} name flag name.
 * @returns {string | undefined} the flag's value.
 */
function flag(name) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : undefined
}

const keyFile = flag('key-file')
const logger = new Logger(args.includes('--quiet') ? 'silent' : 'warn')
const identity = await new Identity({ keyFile, logger }).load()

if (args.includes('--rotate')) {
  if (identity.explicitKey) {
    console.error('this identity uses a configured "key"; rotate it in your secret store instead')
    process.exitCode = 1
    process.exit()
  }
  await identity.rotate()
}

if (args.includes('--json')) {
  console.log(
    JSON.stringify(
      {
        instanceId: identity.instanceId,
        key: identity.key,
        keyFingerprint: identity.fingerprint(),
        keyFile: identity.keyFile || defaultKeyFile(),
        persisted: identity.persistenceWarning === undefined,
        createdAt: identity.createdAt,
        rotatedAt: identity.rotatedAt,
      },
      null,
      2,
    ),
  )
} else {
  console.log('')
  console.log(`  instance id     : ${identity.instanceId}`)
  console.log(`  instance key    : ${identity.key}`)
  console.log(`  key fingerprint : ${identity.fingerprint()}`)
  console.log(`  stored in       : ${identity.keyFile || defaultKeyFile()}`)
  if (identity.persistenceWarning) console.log(`  warning         : ${identity.persistenceWarning}`)
  console.log('')
  console.log('  Add the instance key to your relay server, for example:')
  console.log('    curl -X POST http://127.0.0.1:8787/dsh-api/keys \\')
  console.log('         -H "content-type: application/json" \\')
  console.log(`         -d '{"key":"${identity.key}","label":"$(hostname)"}'`)
  console.log('')
}
