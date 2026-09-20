import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'

const MAX_TERMINALS = 4
const MAX_REPLAY_BYTES = 1024 * 1024
const LEASE_TIMEOUT_MS = 120000

/** Process-backed terminal manager for hosts without a native PTY package. */
export class TerminalManager extends EventEmitter {
  constructor(config, logger) { super(); this.config = config; this.logger = logger; this.items = new Map(); this.timer = setInterval(() => this.sweep(), 30000); this.timer.unref?.() }
  open(params = {}) {
    if (this.items.size >= MAX_TERMINALS) throw new Error(`最多同时打开 ${MAX_TERMINALS} 个终端`)
    const terminalId = `term-${randomUUID()}`
    const cwd = String(params.cwd || this.config.defaultCwd || homedir())
    const isWindows = process.platform === 'win32'
    const shell = isWindows
      ? (this.config?.shell || process.env.A2S_TERMINAL_SHELL || 'powershell.exe')
      : (process.env.SHELL || '/bin/bash')
    const args = isWindows
      ? ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-']
      : ['-i']
    const child = spawn(shell, args, { cwd, env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const item = { terminalId, child, cwd, cols: Number(params.cols) || 80, rows: Number(params.rows) || 24, replay: '', createdAt: Date.now(), lastSeenAt: Date.now() }
    this.items.set(terminalId, item)
    const output = (chunk) => { const data = String(chunk); item.lastSeenAt = Date.now(); item.replay = (item.replay + data).slice(-MAX_REPLAY_BYTES); this.emit('output', { terminalId, data }) }
    child.stdout.on('data', output); child.stderr.on('data', output)
    child.once('error', (error) => this.emit('output', { terminalId, data: `\r\n[terminal error] ${error.message}\r\n` }))
    child.once('exit', (code, signal) => { this.items.delete(terminalId); this.emit('exit', { terminalId, code, signal }) })
    return { terminalId, cwd, cols: item.cols, rows: item.rows, replay: item.replay }
  }
  get(terminalId) { return this.items.get(String(terminalId)) || null }
  list() { return [...this.items.values()].map(({ terminalId, cwd, cols, rows, createdAt, lastSeenAt }) => ({ terminalId, cwd, cols, rows, createdAt, lastSeenAt })) }
  attach(terminalId) { const item = this.get(terminalId); if (!item) throw new Error('终端不存在或已退出'); return { terminalId: item.terminalId, cwd: item.cwd, cols: item.cols, rows: item.rows, replay: item.replay, lastSeenAt: item.lastSeenAt } }
  keepAlive(terminalId) { const item = this.get(terminalId); if (!item) throw new Error('终端不存在或已退出'); item.lastSeenAt = Date.now(); return { terminalId: item.terminalId, lastSeenAt: item.lastSeenAt } }
  write(terminalId, data) { const item = this.get(terminalId); if (!item) throw new Error('终端不存在或已退出'); const value = String(data ?? ''); item.lastSeenAt = Date.now(); item.child.stdin.write(value); return { terminalId: item.terminalId, bytes: Buffer.byteLength(value) } }
  resize(terminalId, cols, rows) { const item = this.get(terminalId); if (!item) throw new Error('终端不存在或已退出'); item.cols = Math.max(1, Number(cols) || item.cols); item.rows = Math.max(1, Number(rows) || item.rows); return { terminalId: item.terminalId, cols: item.cols, rows: item.rows } }
  close(terminalId) { const item = this.get(terminalId); if (!item) return { terminalId: String(terminalId), closed: false }; this.items.delete(item.terminalId); try { item.child.kill() } catch { /* already exited */ } return { terminalId: item.terminalId, closed: true } }
  closeAll() { for (const terminalId of [...this.items.keys()]) this.close(terminalId); clearInterval(this.timer) }
  sweep() { const cutoff = Date.now() - LEASE_TIMEOUT_MS; for (const item of [...this.items.values()]) if (item.lastSeenAt < cutoff) this.close(item.terminalId) }
}
