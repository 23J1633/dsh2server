import { copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { PLUGIN_VERSION } from './version.js'

// The desktop considers a runtime record fresh for two minutes. Five seconds
// keeps that lease comfortably alive without rewriting an otherwise unchanged
// JSON file more than once per second for the lifetime of the Harness host.
const STATUS_INTERVAL_MS = 5000
const CONTROL_INTERVAL_MS = 200
const RENAME_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EPERM'])
const RENAME_RETRY_COUNT = 40

/**
 * File-based local control plane shared with A2Switch.
 *
 * DSH loads dsh2server inside the long-running Harness host, so A2Switch cannot
 * own the bridge as a child process. This small channel lets it stop, resume,
 * and restart only the relay links without terminating the user's DSH UI or
 * active local sessions.
 */
export class A2SRuntimeControl {
  constructor({ sharedFile, bridge, logger, installPath }) {
    const runtimeDir = join(dirname(sharedFile), 'runtime')
    this.runtimeFile = join(runtimeDir, 'dsh.json')
    this.controlFile = join(runtimeDir, 'dsh-control.json')
    this.bridge = bridge
    this.sharedFile = sharedFile
    this.logger = logger
    this.installPath = installPath
    this.lastControlId = ''
    this.lastControl = null
    this.statusTimer = null
    this.controlTimer = null
    this.polling = false
    this.disposed = false
    this.writeChain = Promise.resolve()
  }

  async start() {
    const existing = await readJson(this.controlFile)
    this.lastControlId = typeof existing?.id === 'string' ? existing.id : ''
    await this.writeStatus()
    this.statusTimer = setInterval(() => void this.writeStatus(), STATUS_INTERVAL_MS)
    this.controlTimer = setInterval(() => void this.pollControl(), CONTROL_INTERVAL_MS)
    this.statusTimer.unref?.()
    this.controlTimer.unref?.()
  }

  async pollControl() {
    if (this.disposed || this.polling) return
    this.polling = true
    let shouldWriteStatus = false
    try {
      const command = await readJson(this.controlFile)
      if (!command || typeof command.id !== 'string' || !command.id || command.id === this.lastControlId) return
      this.lastControlId = command.id
      shouldWriteStatus = true
      const action = String(command.action || '')
      const requestedInstanceId = String(command.instanceId || '')
      if (requestedInstanceId && requestedInstanceId !== this.bridge.identity.instanceId) {
        throw new Error(`control command targets ${requestedInstanceId}, not ${this.bridge.identity.instanceId}`)
      }
      if (action === 'stop') await this.bridge.suspend('stopped by A2Switch')
      else if (action === 'start') {
        await this.reloadSharedSettings()
        await this.bridge.resume('started by A2Switch')
      } else if (action === 'restart') {
        await this.reloadSharedSettings()
        await this.bridge.restart('restarted by A2Switch')
      }
      else throw new Error(`unsupported control action: ${action || '(empty)'}`)
      this.lastControl = { id: command.id, action, ok: true, completedAt: new Date().toISOString() }
      this.logger.info(`A2Switch completed local control action: ${action}`)
    } catch (error) {
      shouldWriteStatus = true
      this.lastControl = {
        id: this.lastControlId,
        action: String((await readJson(this.controlFile))?.action || ''),
        ok: false,
        error: String(error?.message || error),
        completedAt: new Date().toISOString(),
      }
      this.logger.error(`A2Switch local control failed: ${this.lastControl.error}`)
    } finally {
      this.polling = false
      if (shouldWriteStatus) await this.writeStatus()
    }
  }

  async reloadSharedSettings() {
    const document = await readJson(this.sharedFile)
    if (!document) return
    const agent = document.agents?.dsh || {}
    const values = Array.isArray(agent.endpoints ?? document.server?.endpoints)
      ? (agent.endpoints ?? document.server.endpoints)
      : String(agent.endpoints ?? document.server?.endpoints ?? document.server?.endpoint ?? '').split(',')
    this.bridge.config.endpoints = [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))]
    this.bridge.config.endpoint = this.bridge.config.endpoints[0] || ''
    if (['auto', 'ws', 'http'].includes(agent.transport ?? document.server?.transport)) {
      this.bridge.config.transport = agent.transport ?? document.server.transport
    }
    if (['system', 'zh-CN', 'en-US'].includes(agent.locale)) this.bridge.config.locale = agent.locale
  }

  writeStatus(extra = {}) {
    if (this.disposed && extra.running !== false) return this.writeChain
    const description = this.bridge.describe()
    const document = {
      version: 1,
      plugin: 'dsh2server',
      pluginVersion: PLUGIN_VERSION,
      installPath: this.installPath,
      instanceId: this.bridge.identity.instanceId,
      pid: process.pid,
      running: true,
      connected: this.bridge.isConnected(),
      suspended: this.bridge.suspended,
      endpoints: description.links,
      configuredEndpoints: description.endpoints,
      updatedAt: new Date().toISOString(),
      ...(this.lastControl ? { control: this.lastControl } : {}),
      ...extra,
    }
    this.writeChain = this.writeChain
      .then(() => atomicJson(this.runtimeFile, document))
      .catch((error) => this.logger.warn(`cannot persist A2S runtime status: ${error.message}`))
    return this.writeChain
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    clearInterval(this.statusTimer)
    clearInterval(this.controlTimer)
    while (this.polling) await new Promise((resolve) => setTimeout(resolve, 20))
    await this.writeChain
    await atomicJson(this.runtimeFile, {
      version: 1,
      plugin: 'dsh2server',
      pluginVersion: PLUGIN_VERSION,
      installPath: this.installPath,
      instanceId: this.bridge.identity.instanceId,
      pid: process.pid,
      running: false,
      connected: false,
      suspended: false,
      stoppedAt: new Date().toISOString(),
      ...(this.lastControl ? { control: this.lastControl } : {}),
    }).catch((error) => this.logger.warn(`cannot persist stopped A2S runtime status: ${error.message}`))
  }
}

async function readJson(file) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      if (await hasFreshWriteLock(file)) throw new Error('file is being replaced')
      const text = await readFile(file, 'utf8')
      if (await hasFreshWriteLock(file)) throw new Error('file changed while being read')
      const value = JSON.parse(text)
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null
    } catch {
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  return null
}

async function atomicJson(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${process.hrtime.bigint()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, file)
        return
      } catch (error) {
        if (error?.code === 'EXDEV') {
          await replaceEncryptedFile(temporary, file)
          return
        }
        if (!RENAME_RETRY_CODES.has(error?.code) || attempt >= RENAME_RETRY_COUNT - 1) throw error
        // Windows can briefly reject replacement while A2Switch is reading the
        // old file. Retrying preserves the atomic old-or-new view; copying over
        // the destination would expose partial JSON and NUL-filled ranges.
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, 5 * (attempt + 1))))
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function replaceEncryptedFile(source, target) {
  const lockFile = `${target}.lock`
  await writeFile(lockFile, `${process.pid} ${Date.now()}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    await copyFile(source, target)
    const handle = await open(target, 'r+')
    try { await handle.sync() } finally { await handle.close() }
  } finally {
    await rm(lockFile, { force: true }).catch(() => undefined)
  }
}

async function hasFreshWriteLock(file) {
  try {
    const info = await stat(`${file}.lock`)
    return Date.now() - info.mtimeMs < 10000
  } catch {
    return false
  }
}
