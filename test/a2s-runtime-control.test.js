import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { A2SRuntimeControl } from '../lib/a2s-runtime-control.js'
import { waitFor } from './helpers/fake-host.js'

test('A2S runtime control acknowledges stop, start, and restart commands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-a2s-control-'))
  const sharedFile = join(dir, 'config.json')
  await writeFile(sharedFile, `${JSON.stringify({
    server: { endpoints: ['http://relay.changed/a2s-api'], transport: 'http' },
    agents: { dsh: { locale: 'en-US' } },
  })}\n`, 'utf8')
  const calls = []
  const bridge = {
    identity: { instanceId: 'device:dsh' },
    config: { endpoints: ['http://relay.test/a2s-api'], endpoint: 'http://relay.test/a2s-api', transport: 'auto', locale: 'system' },
    suspended: false,
    connected: true,
    isConnected() { return this.connected },
    describe() { return { endpoints: ['http://relay.test/a2s-api'], links: [], state: this.suspended ? 'suspended' : 'connected' } },
    async suspend() { calls.push('stop'); this.suspended = true; this.connected = false },
    async resume() { calls.push('start'); this.suspended = false; this.connected = true },
    async restart() { calls.push('restart'); this.suspended = false; this.connected = true },
  }
  const logger = { info() {}, warn() {}, error() {} }
  const control = new A2SRuntimeControl({ sharedFile, bridge, logger, installPath: dir })
  try {
    await control.start()
    for (const action of ['stop', 'start', 'restart']) {
      const id = `${action}-${Date.now()}`
      await writeFile(control.controlFile, `${JSON.stringify({ version: 1, id, action, instanceId: 'device:dsh' })}\n`, 'utf8')
      await waitFor(async () => {
        const status = JSON.parse(await readFile(control.runtimeFile, 'utf8'))
        return status.control?.id === id && status.control?.ok === true
      }, 5000, `${action} acknowledgement`)
    }
    assert.deepEqual(calls, ['stop', 'start', 'restart'])
    assert.deepEqual(bridge.config.endpoints, ['http://relay.changed/a2s-api'])
    assert.equal(bridge.config.transport, 'http')
    assert.equal(bridge.config.locale, 'en-US')
  } finally {
    await control.dispose()
    const stopped = JSON.parse(await readFile(control.runtimeFile, 'utf8'))
    assert.equal(stopped.running, false)
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('A2S runtime status remains valid JSON during concurrent reads and writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-a2s-status-'))
  const sharedFile = join(dir, 'config.json')
  await writeFile(sharedFile, '{}\n', 'utf8')
  const bridge = {
    identity: { instanceId: 'device:dsh' },
    config: { endpoints: [], endpoint: '', transport: 'auto', locale: 'system' },
    suspended: false,
    isConnected() { return true },
    describe() { return { endpoints: [], links: [], state: 'connected' } },
  }
  const warnings = []
  const control = new A2SRuntimeControl({
    sharedFile,
    bridge,
    logger: { info() {}, warn(message) { warnings.push(message) }, error() {} },
    installPath: dir,
  })
  try {
    await control.start()
    let invalidReads = 0
    const writes = Array.from({ length: 30 }, (_, index) => control.writeStatus({ sample: index }))
    const reader = (async () => {
      for (let index = 0; index < 300; index += 1) {
        try {
          JSON.parse(await readFile(control.runtimeFile, 'utf8'))
        } catch (error) {
          if (error?.code !== 'ENOENT') invalidReads += 1
        }
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
    })()
    await Promise.all([...writes, reader])
    clearInterval(control.statusTimer)
    await control.writeStatus({ sample: 29 })
    assert.equal(invalidReads, 0)
    assert.deepEqual(warnings, [])
    assert.equal(JSON.parse(await readFile(control.runtimeFile, 'utf8')).sample, 29)
  } finally {
    await control.dispose()
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
