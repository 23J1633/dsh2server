/**
 * Host capability layer.
 *
 * Every host interaction the bridge performs goes through this module, so the
 * operation handlers above it never touch a Cordis service directly and the
 * whole surface can be unit-tested with a fake context.
 *
 * Two rules shape the design:
 *
 * 1. **Nothing is required.** A plugin that declares `inject` for optional
 *    services refuses to load in compositions that lack them. This bridge
 *    instead probes with `ctx.get(...)` and advertises what it found in
 *    `hello.capabilities`, so a minimal headless profile still connects and
 *    still answers the operations its composition supports.
 * 2. **Degrade, never throw.** Every probe is contained; a service that throws
 *    on access is treated as absent, and every failure reaches the server as a
 *    structured `capability_unavailable` (or a more specific) error instead of
 *    a dropped connection.
 *
 * @module dsh2server/lib/host
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ERROR_CODES, fail } from './protocol.js'
import { newId, toolIntentFromArguments, truncate } from './util.js'

/** Service names probed at startup, in the order they appear in capabilities. */
const PROBED_SERVICES = [
  'agents',
  'sessions',
  'sessionController',
  'sessionPersistence',
  'sessionProjections',
  'workspaceRegistry',
  'workspaceController',
  'jobs',
  'goals',
  'commands',
  'approval',
  'userQuestions',
  'messageFeedback',
  'permissionPresets',
  'attachments',
  'fileUploads',
  'fs',
  'pluginInventory',
  'loader',
]

/**
 * Protocol-level permission preset ids mapped onto the deployment's own preset
 * table. The server speaks the three stable ids below; a deployment may name
 * its table entries anything, so the bridge translates both ways and reports
 * only the ids it can actually reach.
 */
const PERMISSION_ALIASES = Object.freeze({
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
  'full-access': 'danger-full-access',
})

/** Reverse of {@link PERMISSION_ALIASES}: deployment preset name → protocol id. */
const PERMISSION_IDS = Object.freeze(
  Object.fromEntries(Object.entries(PERMISSION_ALIASES).map(([id, name]) => [name, id])),
)

/**
 * Translate one deployment preset name into the protocol's stable preset id.
 *
 * @param {string} name a preset name from the deployment's table.
 * @returns {string} the protocol id, or the name unchanged when it has none.
 */
export function permissionProtocolId(name) {
  return PERMISSION_IDS[name] ?? String(name)
}

/**
 * Adapter over the live DSH host.
 */
export class HostAdapter {
  /**
   * @param {object} options adapter options.
   * @param {any} options.ctx cordis context of the plugin fiber.
   * @param {import('./log.js').Logger} options.logger plugin logger.
   * @param {Record<string, any>} options.config validated plugin config.
   * @param {(sessionId: string) => number | undefined} [options.lastActivity] returns the last observed activity time for a session.
   */
  constructor(options) {
    this.ctx = options.ctx
    this.logger = options.logger
    this.config = options.config
    this.lastActivity = options.lastActivity ?? (() => undefined)
    /** @type {Map<string, unknown>} */
    this.cache = new Map()
    /**
     * Attachments stored on the server's behalf, keyed by the id handed back to
     * it. The harness owns the bytes; this map only remembers which durable
     * reference an id names, so `attachment.get` and an attachment-bearing
     * `session.prompt` can resolve it again within this plugin lifetime.
     * @type {Map<string, {kind: 'image'|'file', ref: Record<string, any>, name: string, mime: string, bytes: number}>}
     */
    this.attachments = new Map()
  }

  /**
   * Resolve one service, tolerating a context that throws on unknown keys.
   *
   * Only a *found* service is remembered. The composition mounts its plugins
   * asynchronously and this bridge starts as soon as its own configuration and
   * identity are ready, so an early probe can legitimately miss a service that
   * is mounted a moment later — and a cached miss would then hide that service
   * for the whole process lifetime. A miss is cheap to repeat (`ctx.get` is a
   * scope lookup), so misses are never cached.
   *
   * @param {string} name service key.
   * @returns {any | undefined} the service, or undefined when absent.
   */
  service(name) {
    if (this.cache.has(name)) return this.cache.get(name)
    let value
    try {
      if (typeof this.ctx?.get === 'function') value = this.ctx.get(name)
      else value = this.ctx?.[name]
    } catch {
      value = undefined
    }
    if (value !== undefined) this.cache.set(name, value)
    return value
  }

  /**
   * Drop cached service lookups so the next call re-probes. Used when the
   * composition changes underneath a long-lived bridge (HMR, provider swap).
   */
  invalidate() {
    this.cache.clear()
  }

  /**
   * @returns {Record<string, boolean>} which optional capabilities exist here.
   */
  capabilities() {
    // Report the composition as it is *now*: the capability set is what a
    // server lights its UI from, and the tree can still be settling when the
    // first hello is built.
    this.invalidate()
    const present = {}
    for (const name of PROBED_SERVICES) present[name] = this.service(name) !== undefined
    return {
      ...present,
      sessions: true,
      sessionList: present.sessionController || present.sessionPersistence || present.sessions,
      sessionHistory: present.sessionController || present.sessions,
      sessionCreate: present.sessionController || present.agents,
      sessionPrompt: present.sessionController || present.agents,
      sessionInterrupt: present.sessionController || present.agents,
      sessionFork: present.sessionController || present.sessions,
      sessionRename: present.sessionController,
      sessionSearch: present.sessionController,
      sessionSelectModel: present.sessionController,
      queueUpdate: present.sessionController,
      modelCatalog: present.sessionController,
      commands: present.commands,
      jobs: present.jobs,
      goals: present.goals,
      approvalPolicy: present.approval,
      approvalAnswer: present.approval,
      questions: present.userQuestions,
      workspaces: present.workspaceRegistry || present.sessionList,
      projections: present.sessionProjections,
      // ── extension capabilities (server-side PLUGIN-EXT.md) ──────────────────
      // `plugin.list` needs the inventory gateway; enabling/configuring a plugin
      // needs the Loader that owns the entry.
      sessionEvents: present.sessionController || present.sessions || present.sessionPersistence,
      messageFeedback: present.messageFeedback,
      permissionPresets: present.permissionPresets,
      attachments: present.attachments && present.fileUploads,
      workspaceMutation: present.workspaceController,
      fileBrowser: present.fs,
      pluginManagement: present.pluginInventory && present.loader,
    }
  }

  /**
   * Build the `instance` block of the `hello` frame.
   *
   * @param {Record<string, unknown>} hostFacts platform facts from `os`.
   * @param {Record<string, unknown>} extra plugin-side facts.
   * @returns {Record<string, unknown>} instance description.
   */
  instanceInfo(hostFacts, extra) {
    const sessions = this.service('sessions')
    const liveSessions = safeCall(() => sessions?.list()?.length)
    return {
      ...hostFacts,
      ...extra,
      dshHome: process.env.DSH_HOME,
      liveSessions: typeof liveSessions === 'number' ? liveSessions : undefined,
      capabilities: this.capabilities(),
    }
  }

  /**
   * Refuse a session whose working directory is outside the allowlist.
   *
   * @param {string | undefined} cwd session working directory.
   * @returns {boolean} whether the session may be exposed.
   */
  allowsCwd(cwd) {
    const prefixes = this.config.allowedCwdPrefixes
    if (!prefixes || prefixes.length === 0) return true
    if (typeof cwd !== 'string' || cwd === '') return false
    const normalized = cwd.replace(/\\/g, '/').toLowerCase()
    return prefixes.some((prefix) => normalized.startsWith(String(prefix).replace(/\\/g, '/').toLowerCase()))
  }

  /**
   * List every session the deployment knows about.
   *
   * Prefers the Session Controller, which reads both live and persisted
   * sessions through the same projection. The fallback path merges the live
   * store with the persistence listing and reports the fields it can know
   * without a controller.
   *
   * @param {AbortSignal} signal caller lifetime.
   * @returns {Promise<Array<Record<string, unknown>>>} normalized session rows.
   */
  async listSessions(signal) {
    const controller = this.service('sessionController')
    if (controller?.list) {
      const value = await controller.list({}, signal)
      const items = Array.isArray(value?.items) ? value.items : []
      return items
        .map((item) => this.#normalizeSummary(item))
        .filter((row) => this.allowsCwd(/** @type {any} */ (row).cwd))
    }
    const rows = new Map()
    const sessions = this.service('sessions')
    for (const session of safeCall(() => sessions?.list() ?? []) ?? []) {
      const row = this.#liveSummary(session)
      if (row) rows.set(row.sessionId, row)
    }
    const persistence = this.service('sessionPersistence')
    if (persistence?.list) {
      const stored = await persistence.list({ signal })
      for (const snapshot of stored ?? []) {
        const header = snapshot?.header
        if (!header?.id || rows.has(header.id)) continue
        rows.set(header.id, {
          sessionId: header.id,
          updatedAt: header.createdAt ?? 0,
          running: false,
          blank: true,
          cwd: header.cwd,
          parentSessionId: header.parentSession,
          origin: header.origin,
          agentPreset: header.agentPreset,
          attached: false,
        })
      }
    }
    return [...rows.values()].filter((row) => this.allowsCwd(row.cwd)).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * @param {Record<string, any>} item a `SessionSummary` from the controller.
   * @returns {Record<string, unknown>} normalized row.
   */
  #normalizeSummary(item) {
    const sessionId = String(item.sessionId)
    const live = this.service('agents')?.get?.(sessionId)
    return {
      sessionId,
      updatedAt: Number(item.updatedAt ?? 0),
      running: item.running === true || live?.status === 'running',
      blank: item.blank === true,
      cwd: item.cwd,
      parentSessionId: item.parentSessionId,
      origin: item.origin,
      attached: live !== undefined,
      projections: item.projections,
    }
  }

  /**
   * @param {any} session live `Session`.
   * @returns {Record<string, unknown> | undefined} normalized row, or undefined when unusable.
   */
  #liveSummary(session) {
    try {
      const id = String(session.id)
      const agent = this.service('agents')?.get?.(id)
      return {
        sessionId: id,
        updatedAt: this.lastActivity(id) ?? session.header?.createdAt ?? 0,
        running: agent?.status === 'running',
        blank: false,
        cwd: session.header?.cwd,
        parentSessionId: session.header?.parentSession,
        origin: session.header?.origin,
        agentPreset: session.header?.agentPreset,
        attached: true,
      }
    } catch {
      return undefined
    }
  }

  /**
   * Read one session's live runtime state plus whatever projections the
   * composition registers (todos, goal, model selection, inbox, …).
   *
   * @param {string} sessionId durable session identity.
   * @returns {Record<string, unknown>} session detail.
   */
  sessionDetail(sessionId) {
    const session = this.service('sessions')?.get?.(sessionId)
    const agent = this.service('agents')?.get?.(sessionId)
    /** @type {Record<string, unknown>} */
    const detail = {
      sessionId,
      attached: session !== undefined,
      running: agent?.status === 'running',
      status: agent?.status ?? (session ? 'idle' : 'detached'),
      header: undefined,
      seq: undefined,
      projections: undefined,
      model: undefined,
      pending: undefined,
    }
    if (session) {
      detail.header = safeCall(() => this.#wireHeader(session.header))
      detail.seq = safeCall(() => Number(session.seq))
      detail.projections = this.#projections(session)
    }
    if (agent) {
      detail.model = safeCall(() => {
        const selection = agent.options ?? {}
        return { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort }
      })
      detail.pending = safeCall(() => ({
        nextTurn: agent.inbox?.nextTurn?.length ?? 0,
        nextStep: agent.inbox?.nextStep?.length ?? 0,
      }))
    }
    return detail
  }

  /**
   * @param {any} session live session.
   * @returns {Record<string, unknown> | undefined} projection values, when the registry exists.
   */
  #projections(session) {
    const registry = this.service('sessionProjections')
    if (!registry?.snapshot) return undefined
    try {
      const snapshot = registry.snapshot(session)
      return { asOfSeq: snapshot?.asOfSeq, values: snapshot?.values }
    } catch (error) {
      this.logger.debug(`projection snapshot failed for ${session?.id}:`, String(error))
      return undefined
    }
  }

  /**
   * @param {any} header session header.
   * @returns {Record<string, unknown>} the wire form of the header.
   */
  #wireHeader(header) {
    if (!header) return undefined
    return {
      version: header.version,
      id: header.id,
      createdAt: header.createdAt,
      cwd: header.cwd,
      parentSession: header.parentSession,
      isSeeded: header.isSeeded,
      origin: header.origin,
      delegationDepth: header.delegationDepth,
      agentPreset: header.agentPreset,
    }
  }

  /**
   * Resolve a session to its live agent, resuming a cold session when the
   * composition allows it.
   *
   * @param {string} sessionId durable session identity.
   * @returns {Promise<any>} the live agent.
   * @throws {import('./protocol.js').BridgeError} when the session cannot be activated.
   */
  async ensureAgent(sessionId) {
    const live = this.service('agents')?.get?.(sessionId)
    if (live) return live
    const controller = this.service('sessionController')
    if (controller?.resolveAgent) {
      const result = await controller.resolveAgent(sessionId)
      if (result?.agent) return result.agent
      const error = result?.error
      throw fail(
        error?.code === 'session/not-found' ? ERROR_CODES.SESSION_NOT_FOUND : ERROR_CODES.AGENT_BUSY,
        error?.message ?? `session "${sessionId}" could not be activated`,
        { details: { sessionId } },
      )
    }
    const agents = this.service('agents')
    if (agents?.resume && this.service('sessionPersistence')) {
      const handle = await agents.resume({ resumeSessionId: sessionId })
      if (handle?.agent) return handle.agent
    }
    if (!this.service('sessions')?.get?.(sessionId) && !this.service('sessionPersistence')) {
      throw fail(ERROR_CODES.SESSION_NOT_FOUND, `unknown session "${sessionId}"`, { details: { sessionId } })
    }
    throw fail(
      ERROR_CODES.CAPABILITY_UNAVAILABLE,
      `session "${sessionId}" is not live and this composition cannot resume it (no session controller or agent factory)`,
      { details: { sessionId } },
    )
  }

  /**
   * @param {string} sessionId durable session identity.
   * @returns {any | undefined} the live session object, when attached.
   */
  liveSession(sessionId) {
    return this.service('sessions')?.get?.(sessionId)
  }

  /**
   * Create or adopt a session.
   *
   * @param {object} params creation parameters.
   * @param {string} [params.sessionId] explicit identity to adopt.
   * @param {string} [params.cwd] working directory for the new session.
   * @param {string} [params.workspaceId] workspace to create the session in.
   * @param {string} [params.agentPreset] agent preset id.
   * @param {AbortSignal} signal caller lifetime.
   * @returns {Promise<Record<string, unknown>>} `{ sessionId, agentPreset? }`.
   */
  async createSession(params, signal) {
    if (!this.config.allowRemoteControl) {
      throw fail(ERROR_CODES.DISABLED, 'remote control is disabled by plugin configuration')
    }
    if (params.cwd !== undefined && !this.allowsCwd(params.cwd)) {
      throw fail(ERROR_CODES.FORBIDDEN, `working directory "${params.cwd}" is outside allowedCwdPrefixes`, {
        details: { cwd: params.cwd },
      })
    }
    const controller = this.service('sessionController')
    if (controller?.create) {
      const request = {}
      if (params.sessionId) request.sessionId = params.sessionId
      if (params.cwd) request.cwd = params.cwd
      if (params.workspaceId) request.workspaceId = params.workspaceId
      if (params.agentPreset) request.agentPreset = params.agentPreset
      const value = await controller.create(request)
      return { sessionId: String(value?.sessionId), agentPreset: value?.agentPreset }
    }
    const agents = this.service('agents')
    if (!agents?.create) {
      throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'this composition cannot create sessions')
    }
    const sessionId = params.sessionId ?? `session-${randomUUID()}`
    const handle = await agents.create({
      sessionId,
      meta: params.cwd ? { cwd: params.cwd } : undefined,
      signal,
    })
    return { sessionId: String(handle?.agent?.id ?? sessionId) }
  }

  /**
   * Admit one prompt into a session.
   *
   * @param {object} params prompt parameters.
   * @param {string} params.sessionId target session.
   * @param {Array<{type: 'text', text: string}>} params.content model-facing content blocks.
   * @param {'queue'|'steer'} params.mode delivery mode.
   * @param {string} [params.requestId] client-minted correlation id.
   * @param {string} [params.clientTimeZone] IANA time zone reported by the caller.
   * @param {AbortSignal} signal caller lifetime.
   * @returns {Promise<Record<string, unknown>>} `{ accepted: true }`.
   */
  async prompt(params, signal) {
    if (!this.config.allowRemotePrompt) {
      throw fail(ERROR_CODES.DISABLED, 'remote prompts are disabled by plugin configuration')
    }
    const controller = this.service('sessionController')
    if (controller?.prompt) {
      const request = {
        sessionId: params.sessionId,
        requestId: params.requestId ?? randomUUID(),
        mode: params.mode,
        content: params.content,
      }
      if (params.clientTimeZone) request.clientTimeZone = params.clientTimeZone
      const value = await controller.prompt(request, signal)
      return { accepted: value?.accepted === true }
    }
    const agent = await this.ensureAgent(params.sessionId)
    const message = {
      id: randomUUID(),
      role: 'user',
      content: params.content,
      source: { kind: 'user' },
    }
    if (params.mode === 'steer') agent.steer(message)
    else agent.followup(message)
    return { accepted: true }
  }

  /**
   * Interrupt a running turn while keeping queued work.
   *
   * @param {string} sessionId target session.
   * @returns {Promise<Record<string, unknown>>} `{ accepted: true }`.
   */
  async interrupt(sessionId) {
    if (!this.config.allowRemoteControl) {
      throw fail(ERROR_CODES.DISABLED, 'remote control is disabled by plugin configuration')
    }
    const controller = this.service('sessionController')
    if (controller?.cancel) {
      // `sessionController.cancel` is the documented "abort the active turn,
      // keep the inbox" operation, so it is the primary path.
      const value = controller.cancel({ sessionId })
      return { accepted: value?.accepted === true }
    }
    const agent = await this.ensureAgent(sessionId)
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    return { accepted: true }
  }

  /**
   * Abort the active turn without keeping the inbox.
   *
   * @param {string} sessionId target session.
   * @returns {Promise<Record<string, unknown>>} `{ accepted: true }`.
   */
  async cancel(sessionId) {
    if (!this.config.allowRemoteControl) {
      throw fail(ERROR_CODES.DISABLED, 'remote control is disabled by plugin configuration')
    }
    const agent = await this.ensureAgent(sessionId)
    agent.cancel({ kind: 'user' })
    return { accepted: true }
  }

  /**
   * @param {string} sessionId target session.
   * @param {string} title new title.
   * @returns {Promise<Record<string, unknown>>} `{ title, seq }`.
   */
  async rename(sessionId, title) {
    const controller = this.service('sessionController')
    if (!controller?.rename) {
      throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'session rename requires the session controller plugin')
    }
    const value = await controller.rename({ sessionId, title })
    return { title: value?.title, seq: value?.seq }
  }

  /**
   * @param {string} sessionId source session.
   * @param {number} [atSeq] inclusive event anchor.
   * @returns {Promise<Record<string, unknown>>} `{ sessionId }` of the new session.
   */
  async fork(sessionId, atSeq) {
    const controller = this.service('sessionController')
    if (controller?.fork) {
      const value = await controller.fork(atSeq === undefined ? { sessionId } : { sessionId, atSeq })
      return { sessionId: String(value?.sessionId) }
    }
    const sessions = this.service('sessions')
    if (!sessions?.fork) {
      throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'this composition cannot fork sessions')
    }
    const child = sessions.fork(sessionId, atSeq)
    return { sessionId: String(child?.id) }
  }

  /**
   * @param {string} query literal message-content query.
   * @param {AbortSignal} signal caller lifetime.
   * @returns {Promise<Record<string, unknown>>} `{ items, hasMore }`.
   */
  async search(query, signal) {
    const controller = this.service('sessionController')
    if (!controller?.search) {
      throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'session search requires the session controller plugin')
    }
    const value = await controller.search({ query }, signal)
    return { items: value?.items ?? [], hasMore: value?.hasMore === true }
  }

  /**
   * Read one message-aligned history page.
   *
   * @param {object} params page parameters.
   * @param {string} params.sessionId target session.
   * @param {string} [params.addressKind] `session` (default) or `subagent`.
   * @param {string} [params.parentSessionId] parent session for a subagent address.
   * @param {string} [params.childSessionId] child session for a subagent address.
   * @param {'one-shot'|'continuable'} [params.subagentMode] subagent durability mode.
   * @param {number} params.throughSeq inclusive log cut.
   * @param {number} [params.beforeSeq] exclusive backwards cursor.
   * @param {number} [params.maxMessages] page budget.
   * @param {AbortSignal} signal caller lifetime.
   * @returns {Promise<Record<string, unknown>>} `{ records, hasMore }`.
   */
  async history(params, signal) {
    const controller = this.service('sessionController')
    if (controller?.page) {
      const request = {
        address: this.#address(params),
        throughSeq: params.throughSeq,
      }
      if (params.beforeSeq !== undefined) request.beforeSeq = params.beforeSeq
      if (params.maxMessages !== undefined) request.maxMessages = params.maxMessages
      const page = await controller.page(request, signal)
      return { records: (page?.records ?? []).map(decorateHistoryRecord), hasMore: page?.hasMore === true }
    }
    const session = this.liveSession(params.sessionId)
    if (!session) {
      throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'history for a detached session requires the session controller plugin')
    }
    return { records: this.#liveHistory(session, params).map(decorateHistoryRecord), hasMore: false }
  }

  /**
   * @param {Record<string, any>} params history parameters.
   * @returns {Record<string, unknown>} a `SessionAddress`.
   */
  #address(params) {
    if (params.addressKind === 'subagent') {
      return {
        kind: 'subagent',
        parentSessionId: params.parentSessionId,
        childSessionId: params.childSessionId,
        mode: params.subagentMode ?? 'one-shot',
      }
    }
    return { kind: 'session', sessionId: params.sessionId }
  }

  /**
   * Best-effort transcript for a live session in compositions without the
   * session controller: derived messages projected back into wire records.
   *
   * @param {any} session live session.
   * @param {Record<string, any>} params history parameters.
   * @returns {Array<Record<string, unknown>>} wire-shaped records.
   */
  #liveHistory(session, params) {
    let messages = []
    try {
      messages = session.deriveMessages?.() ?? []
    } catch (error) {
      this.logger.debug('deriveMessages failed:', String(error))
      return []
    }
    const budget = Number.isSafeInteger(params.maxMessages) ? params.maxMessages : 50
    const slice = messages.slice(Math.max(0, messages.length - Math.max(1, budget)))
    return slice.map((message, index) => ({
      type: 'event',
      event: {
        type: message?.role === 'assistant' ? 'assistant/message' : 'user/message',
        seq: index,
        time: 0,
        data: { message, derived: true },
        synthetic: true,
      },
    }))
  }

  /**
   * @param {object} params selection parameters.
   * @param {string} params.sessionId target session.
   * @param {string} params.provider provider route.
   * @param {string} params.model model id.
   * @param {string} [params.reasoningEffort] adapter-owned effort id.
   * @returns {Promise<Record<string, unknown>>} `{ selected }`.
   */
  async selectModel(params) {
    const controller = this.service('sessionController')
    if (!controller?.selectModel) {
      throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'model selection requires the session controller plugin')
    }
    const request = { sessionId: params.sessionId, provider: params.provider, model: params.model }
    if (params.reasoningEffort !== undefined) request.reasoningEffort = params.reasoningEffort
    const value = await controller.selectModel(request)
    return { selected: value?.selected }
  }

  /**
   * @returns {Promise<Record<string, unknown>>} the deployment model catalog.
   */
  async modelCatalog() {
    const controller = this.service('sessionController')
    if (!controller?.modelCatalog) {
      throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'the model catalog requires the session controller plugin')
    }
    return await controller.modelCatalog()
  }

  /**
   * Mutate one still-pending queue item.
   *
   * @param {object} params mutation parameters.
   * @param {string} params.sessionId target session.
   * @param {string} params.itemId pending message identity.
   * @param {Record<string, unknown>} params.action `{ kind: 'edit'|'remove'|'steer', content? }`.
   * @returns {Record<string, unknown>} `{ accepted: true }`.
   */
  queueUpdate(params) {
    const controller = this.service('sessionController')
    if (!controller?.updateQueue) {
      throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'queue editing requires the session controller plugin')
    }
    const value = controller.updateQueue({ sessionId: params.sessionId, itemId: params.itemId, action: params.action })
    return { accepted: value?.accepted === true }
  }

  /**
   * @param {string} sessionId target session.
   * @returns {string | undefined} the session's durable approval policy override.
   */
  approvalPolicyOf(sessionId) {
    const approval = this.service('approval')
    const session = this.liveSession(sessionId)
    if (!approval?.overrideOf || !session) return undefined
    return safeCall(() => approval.overrideOf(session))
  }

  /**
   * Switch one live session's approval policy.
   *
   * @param {string} sessionId target session.
   * @param {'ask'|'never'} policy new policy.
   * @returns {Promise<Record<string, unknown>>} `{ policy }`.
   */
  async setApprovalPolicy(sessionId, policy) {
    const approval = this.service('approval')
    if (!approval?.setPolicy) {
      throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'approval policy control requires the user-approval plugin')
    }
    const agent = await this.ensureAgent(sessionId)
    approval.setPolicy(agent, policy)
    return { policy }
  }

  /**
   * @param {string} sessionId target session.
   * @returns {Promise<Record<string, unknown>>} the command descriptors visible to the session.
   */
  async listCommands(sessionId) {
    const commands = this.service('commands')
    if (!commands?.list) {
      throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'the command registry is not composed')
    }
    const agent = await this.ensureAgent(sessionId)
    const descriptors = commands.list(agent) ?? []
    return {
      items: descriptors.map((descriptor) => ({
        name: descriptor?.name,
        description: descriptor?.description,
        input: descriptor?.input,
      })),
    }
  }

  /**
   * Execute one slash command against a session without sending it to the model.
   *
   * @param {string} sessionId target session.
   * @param {string} line complete slash-command line.
   * @param {AbortSignal} signal caller lifetime.
   * @returns {Promise<Record<string, unknown>>} the settled execution.
   */
  async executeCommand(sessionId, line, signal) {
    if (!this.config.allowRemoteCommand) {
      throw fail(ERROR_CODES.DISABLED, 'remote command execution is disabled by plugin configuration')
    }
    const commands = this.service('commands')
    if (!commands?.execute) {
      throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'the command registry is not composed')
    }
    const agent = await this.ensureAgent(sessionId)
    const execution = await commands.execute(agent, line, [], signal)
    if (execution === undefined) {
      throw fail(ERROR_CODES.NOT_FOUND, `"${truncate(line, 120)}" is not a known command`)
    }
    return {
      commandId: execution?.commandId,
      result: execution?.result,
    }
  }

  /**
   * List background jobs visible to a session (or every unowned job).
   *
   * @param {string} [sessionId] owning session.
   * @returns {Record<string, unknown>} `{ items }`.
   */
  listJobs(sessionId) {
    const jobs = this.service('jobs')
    if (!jobs?.list) {
      throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'the job registry is not composed')
    }
    const caller = sessionId ? this.service('agents')?.get?.(sessionId) : undefined
    if (sessionId && !caller) {
      throw fail(ERROR_CODES.SESSION_NOT_FOUND, `session "${sessionId}" is not live; jobs are process-local`, {
        details: { sessionId },
      })
    }
    const snapshots = jobs.list(caller) ?? []
    return { items: snapshots.map(wireJob) }
  }

  /**
   * @param {string} jobId job identity.
   * @param {string} [sessionId] owning session (required to authorize an owned job).
   * @param {string} [reason] reason forwarded to the producer.
   * @returns {Record<string, unknown>} `{ result }`.
   */
  killJob(jobId, sessionId, reason) {
    const jobs = this.service('jobs')
    if (!jobs?.kill) {
      throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'the job registry is not composed')
    }
    const caller = sessionId ? this.service('agents')?.get?.(sessionId) : undefined
    const result = jobs.kill(jobId, caller, reason)
    return { result }
  }

  /**
   * @param {string} jobId job identity.
   * @param {string} [sessionId] owning session.
   * @returns {Record<string, unknown>} `{ text, job }`.
   */
  readJob(jobId, sessionId) {
    const jobs = this.service('jobs')
    if (!jobs?.read) {
      throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'the job registry is not composed')
    }
    const caller = sessionId ? this.service('agents')?.get?.(sessionId) : undefined
    const value = jobs.read(jobId, caller)
    return { text: value?.text ?? '', job: value?.snapshot ? wireJob(value.snapshot) : undefined }
  }

  /**
   * @param {string} sessionId target session.
   * @returns {Promise<Record<string, unknown>>} the current goal view or `{ goal: null }`.
   */
  async getGoal(sessionId) {
    const goals = this.service('goals')
    if (!goals?.get) throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'the goal service is not composed')
    const agent = await this.ensureAgent(sessionId)
    return { goal: goals.get(agent) ?? null }
  }

  /**
   * Apply one goal lifecycle mutation.
   *
   * @param {'pause'|'resume'|'complete'|'clear'|'disarm'} action mutation to apply.
   * @param {string} sessionId target session.
   * @param {{id: string, revision: number}} [ref] compare-and-set reference; omitted for `clear`/`disarm`.
   * @param {string} [reason] block reason (only used by `block`).
   * @returns {Promise<Record<string, unknown>>} `{ goal }`.
   */
  async goalAction(action, sessionId, ref, reason) {
    const goals = this.service('goals')
    if (!goals) throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'the goal service is not composed')
    const agent = await this.ensureAgent(sessionId)
    if (action === 'disarm') return { goal: goals.disarm?.(agent) ?? null }
    if (!ref?.id) {
      const current = goals.get?.(agent)
      if (!current) throw fail(ERROR_CODES.NOT_FOUND, 'this session has no current goal')
      ref = { id: current.id, revision: current.revision }
    }
    if (action === 'pause') return { goal: goals.pause(agent, ref) }
    if (action === 'resume') return { goal: goals.resume(agent, ref) }
    if (action === 'complete') return { goal: goals.complete(agent, ref) }
    if (action === 'clear') return { goal: goals.clear(agent, ref) }
    if (action === 'block') return { goal: goals.block(agent, ref, { code: 'remote', message: reason ?? 'blocked remotely' }) }
    throw fail(ERROR_CODES.INVALID_PARAMS, `unknown goal action "${action}"`)
  }

  /**
   * List workspaces, falling back to the distinct working directories seen in
   * the session list when no workspace registry is composed.
   *
   * @param {AbortSignal} signal caller lifetime.
   * @returns {Promise<Record<string, unknown>>} `{ items }`.
   */
  async listWorkspaces(signal) {
    const registry = this.service('workspaceRegistry')
    if (registry?.list) {
      const workspaces = registry.list() ?? []
      return {
        source: 'workspace-registry',
        items: workspaces
          .map((workspace) => ({
            id: workspace?.id,
            path: workspace?.path,
            title: workspace?.title,
            createdAt: workspace?.createdAt,
            updatedAt: workspace?.updatedAt,
            sessionIds: workspace?.sessionIds ?? [],
          }))
          .filter((workspace) => this.allowsCwd(workspace.path)),
      }
    }
    const sessions = await this.listSessions(signal)
    /** @type {Map<string, {path: string, sessionIds: string[], running: number}>} */
    const byPath = new Map()
    for (const session of sessions) {
      const path = session.cwd
      if (typeof path !== 'string' || path === '') continue
      const entry = byPath.get(path) ?? { path, sessionIds: [], running: 0 }
      entry.sessionIds.push(session.sessionId)
      if (session.running) entry.running += 1
      byPath.set(path, entry)
    }
    return {
      source: 'session-cwd',
      items: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
    }
  }

  // ── raw session events (PLUGIN-EXT §1 `sessionEvents`) ─────────────────────

  /**
   * Read a page of one session's durable event log.
   *
   * The message-aligned `session.history` view is useless for a trajectory
   * renderer: it carries neither real log sequence numbers nor real times. This
   * returns the log itself — the same envelope the live `session/event`
   * firehose carries — so a server can splice history and live events by `seq`.
   *
   * @param {object} params page parameters.
   * @param {string} params.sessionId target session.
   * @param {number} params.throughSeq inclusive log cut.
   * @param {number} [params.beforeSeq] exclusive backwards cursor; the returned
   *   page holds only events with a strictly smaller `seq`.
   * @param {number} params.limit maximum events on the page.
   * @param {string[]} [params.kinds] optional event-type whitelist.
   * @param {AbortSignal} signal caller lifetime.
   * @returns {Promise<Record<string, unknown>>} the ascending page plus its bounds.
   */
  async rawEvents(params, signal) {
    const all = await this.readLog(params.sessionId, 0, params.throughSeq + 1, signal)
    const wanted = params.kinds === undefined ? undefined : new Set(params.kinds)
    const bounded = all.filter((event) => {
      const seq = Number(event?.seq)
      if (!Number.isSafeInteger(seq) || seq > params.throughSeq) return false
      if (params.beforeSeq !== undefined && seq >= params.beforeSeq) return false
      if (wanted !== undefined && !wanted.has(String(event?.type))) return false
      return true
    })
    const hasMore = bounded.length > params.limit
    const page = hasMore ? bounded.slice(bounded.length - params.limit) : bounded
    // Ratings ride along with the page rather than needing a second call: the
    // harness stores them per message id, and the page already holds every
    // assistant message that could carry one.
    const feedback = await this.#feedbackByMessage(params.sessionId)
    return {
      events: page.map((event) => withFeedback(wireSessionEvent(event), event, feedback)),
      oldestSeq: page.length > 0 ? Number(page[0].seq) : null,
      newestSeq: page.length > 0 ? Number(page[page.length - 1].seq) : null,
      hasMore,
      bufferFloor: 0,
    }
  }

  /**
   * @param {string} sessionId target session.
   * @returns {Promise<Map<string, Record<string, any>>>} current feedback keyed by message id.
   */
  async #feedbackByMessage(sessionId) {
    const service = this.service('messageFeedback')
    if (!service?.list) return new Map()
    try {
      const result = await service.list({ sessionId })
      if (result?.ok === false) return new Map()
      return new Map((result?.value?.items ?? []).map((item) => [String(item.messageId), item]))
    } catch {
      return new Map()
    }
  }

  /**
   * Read a half-open slice of one session's event log.
   *
   * Prefers the live session (its snapshot is already in memory), then the
   * per-session persistence handle — which bounds the read to the requested
   * prefix instead of loading the whole log — and only then the session
   * controller's cold inspection.
   *
   * @param {string} sessionId target session.
   * @param {number} fromSeq inclusive first sequence number.
   * @param {number} toSeqExclusive exclusive last sequence number.
   * @param {AbortSignal} [signal] caller lifetime.
   * @returns {Promise<readonly any[]>} events in log order.
   */
  async readLog(sessionId, fromSeq, toSeqExclusive, signal) {
    const live = this.liveSession(sessionId)
    if (typeof live?.snapshotEvents === 'function') {
      const events = safeCall(() => live.snapshotEvents(fromSeq, toSeqExclusive)) ?? []
      if (events.length > 0 || typeof live.seq === 'number') return events
    }
    const persistence = this.service('sessionPersistence')
    if (persistence?.open) {
      let handle
      try {
        handle = await persistence.open(sessionId, 'read', signal === undefined ? {} : { signal })
      } catch (error) {
        throw this.#persistenceError(error, sessionId)
      }
      try {
        const result = await handle.read(fromSeq, Math.max(0, toSeqExclusive - fromSeq), signal === undefined ? {} : { signal })
        return result?.events ?? []
      } finally {
        await handle.close().catch(() => undefined)
      }
    }
    const controller = this.service('sessionController')
    if (controller?.inspect) {
      const inspection = await controller.inspect(sessionId, signal)
      const events = inspection?.events ?? []
      return events.filter((event) => Number(event?.seq) >= fromSeq && Number(event?.seq) < toSeqExclusive)
    }
    throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'this composition cannot read a session event log', {
      details: { sessionId },
    })
  }

  /**
   * Map one persistence failure onto the protocol's stable error vocabulary.
   *
   * @param {unknown} error failure thrown by the persistence backend.
   * @param {string} sessionId addressed session.
   * @returns {import('./protocol.js').BridgeError} the protocol error.
   */
  #persistenceError(error, sessionId) {
    const name = String(/** @type {any} */ (error)?.name ?? '')
    if (name.includes('NotFound')) {
      return fail(ERROR_CODES.SESSION_NOT_FOUND, `unknown session "${sessionId}"`, { details: { sessionId } })
    }
    return fail(ERROR_CODES.INTERNAL, `session log for "${sessionId}" could not be opened: ${String(error)}`, {
      details: { sessionId },
    })
  }

  // ── message feedback (PLUGIN-EXT §2 `messageFeedback`) ─────────────────────

  /**
   * @param {string} sessionId target session.
   * @returns {Promise<Array<Record<string, unknown>>>} every feedback item, newest state only.
   */
  async listFeedback(sessionId) {
    const service = this.service('messageFeedback')
    if (!service?.list) {
      throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'message feedback requires the message-feedback plugin')
    }
    const result = await service.list({ sessionId })
    if (result?.ok === false) {
      throw this.#feedbackError(result.error, sessionId)
    }
    return result?.value?.items ?? []
  }

  /**
   * Read, set, or clear the feedback attached to one assistant message.
   *
   * @param {string} sessionId target session.
   * @param {number} seq the `assistant/message` event's log sequence number.
   * @param {'like'|'dislike'|'none'} rating desired state.
   * @param {AbortSignal} [signal] caller lifetime.
   * @returns {Promise<Record<string, unknown>>} `{ rating, seq, updatedAt }`.
   */
  async putFeedback(sessionId, seq, rating, signal) {
    const service = this.service('messageFeedback')
    if (!service?.put || !service?.list) {
      throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'message feedback requires the message-feedback plugin')
    }
    const messageId = await this.messageIdAt(sessionId, seq, signal)
    if (messageId === undefined) {
      throw fail(ERROR_CODES.NOT_FOUND, `no assistant message is recorded at seq ${seq}`, { details: { sessionId, seq } })
    }
    const existing = (await this.listFeedback(sessionId)).find((item) => String(item.messageId) === messageId)
    const now = Date.now()
    if (rating === 'none') {
      if (existing === undefined) return { accepted: true, seq, rating: null, updatedAt: now }
      const result = await service.delete({ sessionId, messageId, ifVersion: existing.version })
      if (result?.ok === false) throw this.#feedbackError(result.error, sessionId)
      return { accepted: true, seq, rating: null, updatedAt: now }
    }
    const wanted = rating === 'like' ? 'positive' : 'negative'
    if (existing?.rating === wanted) {
      return { accepted: true, seq, rating, updatedAt: Number(existing.updatedAt ?? now) }
    }
    const result = await service.put({
      sessionId,
      messageId,
      rating: wanted,
      ifVersion: existing?.version ?? null,
    })
    if (result?.ok === false) throw this.#feedbackError(result.error, sessionId)
    return { accepted: true, seq, rating, updatedAt: Number(result?.value?.updatedAt ?? now) }
  }

  /**
   * Resolve the durable message identity recorded at one log position.
   *
   * @param {string} sessionId target session.
   * @param {number} seq the log sequence number to inspect.
   * @param {AbortSignal} [signal] caller lifetime.
   * @returns {Promise<string | undefined>} the `MessageId`, when that seq holds an assistant message.
   */
  async messageIdAt(sessionId, seq, signal) {
    const events = await this.readLog(sessionId, seq, seq + 1, signal)
    const event = events.find((candidate) => Number(candidate?.seq) === seq)
    if (event?.type !== 'assistant/message') return undefined
    const id = event?.data?.message?.id
    return id === undefined || id === null ? undefined : String(id)
  }

  /**
   * Map one message-feedback failure onto the protocol's error vocabulary.
   *
   * @param {Record<string, any>} error the service's business failure.
   * @param {string} sessionId addressed session.
   * @returns {import('./protocol.js').BridgeError} the protocol error.
   */
  #feedbackError(error, sessionId) {
    const code = String(error?.code ?? '')
    if (code === 'session-not-found') {
      return fail(ERROR_CODES.SESSION_NOT_FOUND, `unknown session "${sessionId}"`, { details: { sessionId } })
    }
    if (code === 'target-not-found') {
      return fail(ERROR_CODES.NOT_FOUND, 'that message is not recorded in this session', { details: error })
    }
    if (code === 'version-conflict') {
      return fail(ERROR_CODES.CONFLICT, 'the feedback changed concurrently; read it again and retry', {
        details: error,
        retryable: true,
      })
    }
    return fail(ERROR_CODES.INVALID_PARAMS, `message feedback was refused: ${code || 'unknown reason'}`, { details: error })
  }

  // ── permission presets (PLUGIN-EXT §3 `permissionPresets`) ─────────────────

  /**
   * Read one session's permission preset.
   *
   * @param {string} sessionId target session.
   * @returns {Record<string, unknown> | undefined} the preset view, or undefined when unavailable.
   */
  permissionOf(sessionId) {
    const service = this.service('permissionPresets')
    const session = this.liveSession(sessionId)
    if (!service?.current || !session) return undefined
    return safeCall(() => this.#permissionView(service, session))
  }

  /**
   * Build the protocol view of one session's permission presets.
   *
   * Presets are advertised under the three stable protocol ids; a deployment
   * that names its table entries differently keeps its own labels, which are
   * only reported when they differ from the id so the server can fall back to
   * its built-in copy.
   *
   * @param {any} service the permission-preset service.
   * @param {any} session live session.
   * @returns {Record<string, unknown>} `{ preset, available, labels? }`.
   */
  #permissionView(service, session) {
    const names = Array.isArray(service.names) ? service.names : []
    const labels = {}
    const available = []
    for (const name of names) {
      const id = PERMISSION_IDS[name] ?? String(name)
      available.push(id)
      const option = safeCall(() => service.optionOf(name))
      const label = option?.name
      if (typeof label === 'string' && label !== '' && label !== id) labels[id] = label
    }
    const current = String(service.current(session))
    return {
      preset: PERMISSION_IDS[current] ?? current,
      available,
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
    }
  }

  /**
   * Switch one session's permission preset.
   *
   * @param {string} sessionId target session.
   * @param {string} preset one of the three protocol preset ids.
   * @returns {Promise<Record<string, unknown>>} the resulting preset view.
   */
  async setPermission(sessionId, preset) {
    const service = this.service('permissionPresets')
    if (!service?.set) {
      throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'permission presets require the permission-presets plugin')
    }
    const name = PERMISSION_ALIASES[preset] ?? preset
    try {
      service.resolve(name)
    } catch {
      throw fail(
        ERROR_CODES.INVALID_PARAMS,
        `this deployment has no "${preset}" preset; available: ${(service.names ?? []).join(', ')}`,
        { details: { field: 'preset', allowed: [...(service.names ?? [])].map((entry) => PERMISSION_IDS[entry] ?? entry) } },
      )
    }
    const agent = await this.ensureAgent(sessionId)
    const session = agent?.session ?? this.liveSession(sessionId)
    if (!session) {
      throw fail(ERROR_CODES.SESSION_NOT_FOUND, `session "${sessionId}" is not live`, { details: { sessionId } })
    }
    service.set(session, name)
    return this.#permissionView(service, session)
  }

  // ── attachments (PLUGIN-EXT §4 `attachments`) ──────────────────────────────

  /** Media types the harness accepts for image attachments. */
  static IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

  /**
   * Store one uploaded attachment and mint the id the server refers to it by.
   *
   * @param {object} params upload parameters.
   * @param {string} params.name display name.
   * @param {string} params.mime declared media type.
   * @param {string} params.dataBase64 canonical base64 bytes.
   * @param {AbortSignal} [signal] caller lifetime.
   * @returns {Promise<Record<string, unknown>>} `{ attachmentId, name, mime, bytes, kind }`.
   */
  async putAttachment(params, signal) {
    const store = this.service('attachments')
    if (!store) {
      throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'attachments require the attachment plugin')
    }
    const bytes = decodeBase64(params.dataBase64)
    const isImage = HostAdapter.IMAGE_TYPES.includes(String(params.mime))
    const attachmentId = `att_${newId().replace(/-/g, '').slice(0, 12)}`
    if (isImage) {
      const ref = await store.saveImage({ data: bytes, mediaType: params.mime, name: params.name })
      this.attachments.set(attachmentId, {
        kind: 'image',
        ref,
        name: String(ref?.name ?? params.name),
        mime: String(ref?.mediaType ?? params.mime),
        bytes: Number(ref?.bytes ?? bytes.byteLength),
      })
      return {
        attachmentId,
        name: String(ref?.name ?? params.name),
        mime: String(ref?.mediaType ?? params.mime),
        bytes: Number(ref?.bytes ?? bytes.byteLength),
        kind: 'image',
      }
    }
    const ref = await store.admitEncodedFile({ data: params.dataBase64, name: params.name })
    this.attachments.set(attachmentId, {
      kind: 'file',
      ref,
      name: String(ref?.name ?? params.name),
      mime: String(params.mime),
      bytes: Number(ref?.bytes ?? bytes.byteLength),
    })
    return {
      attachmentId,
      name: String(ref?.name ?? params.name),
      mime: String(params.mime),
      bytes: Number(ref?.bytes ?? bytes.byteLength),
      kind: 'file',
    }
  }

  /**
   * Read one previously stored attachment back.
   *
   * @param {object} params read parameters.
   * @param {string} params.attachmentId id minted by {@link putAttachment}.
   * @param {number} [params.maxBytes] refusal threshold; nothing is truncated.
   * @param {AbortSignal} [signal] caller lifetime.
   * @returns {Promise<Record<string, unknown>>} the base64 payload.
   */
  async getAttachment(params, signal) {
    const entry = this.attachments.get(params.attachmentId)
    if (entry === undefined) {
      throw fail(ERROR_CODES.NOT_FOUND, `unknown attachment "${params.attachmentId}"`, {
        details: { attachmentId: params.attachmentId },
      })
    }
    const bytes = await this.#attachmentBytes(entry, signal)
    if (params.maxBytes !== undefined && bytes.byteLength > params.maxBytes) {
      throw fail(
        ERROR_CODES.PAYLOAD_TOO_LARGE,
        `attachment is ${bytes.byteLength} bytes, above the requested maxBytes of ${params.maxBytes}`,
        { details: { attachmentId: params.attachmentId, bytes: bytes.byteLength, maxBytes: params.maxBytes } },
      )
    }
    return {
      attachmentId: params.attachmentId,
      name: entry.name,
      mime: entry.mime,
      bytes: bytes.byteLength,
      truncated: false,
      dataBase64: Buffer.from(bytes).toString('base64'),
    }
  }

  /**
   * @param {{kind: 'image'|'file', ref: Record<string, any>}} entry stored attachment.
   * @param {AbortSignal} [signal] caller lifetime.
   * @returns {Promise<Uint8Array>} the attachment bytes.
   */
  async #attachmentBytes(entry, signal) {
    const store = this.service('attachments')
    if (entry.kind === 'image') {
      const stored = await store.readImage(entry.ref, signal)
      return stored?.data ?? new Uint8Array()
    }
    const chunks = []
    for await (const chunk of store.readFileStream(entry.ref, signal)) chunks.push(chunk)
    return concatBytes(chunks)
  }

  /**
   * Turn protocol content blocks into prompt parts the harness can admit.
   *
   * `text` passes through; `image`/`file` blocks name an attachment this bridge
   * stored earlier, which is re-read here and re-uploaded in the form the
   * harness's prompt path consumes — inline base64 for images, a staged upload
   * receipt for files.
   *
   * @param {string} sessionId target session.
   * @param {Array<Record<string, any>>} blocks protocol content blocks.
   * @param {AbortSignal} [signal] caller lifetime.
   * @returns {Promise<Array<Record<string, any>>>} harness prompt parts.
   */
  async resolvePromptBlocks(sessionId, blocks, signal) {
    const needsFiles = blocks.some((block) => block?.type === 'file')
    const agent = needsFiles ? await this.ensureAgent(sessionId) : undefined
    /** @type {Array<Record<string, any>>} */
    const content = []
    for (const block of blocks) {
      if (block?.type === 'text') {
        content.push({ type: 'text', text: String(block.text) })
        continue
      }
      const entry = this.attachments.get(String(block?.attachmentId))
      if (entry === undefined) {
        throw fail(ERROR_CODES.INVALID_PARAMS, `unknown attachment "${block?.attachmentId}"`, {
          details: { field: 'content', attachmentId: block?.attachmentId },
        })
      }
      const bytes = await this.#attachmentBytes(entry, signal)
      if (block.type === 'image') {
        if (entry.kind !== 'image') {
          throw fail(ERROR_CODES.INVALID_PARAMS, `attachment "${block.attachmentId}" is not an image`, {
            details: { field: 'content' },
          })
        }
        content.push({
          type: 'image',
          mediaType: entry.mime,
          data: Buffer.from(bytes).toString('base64'),
          ...(entry.name ? { name: entry.name } : {}),
        })
        continue
      }
      const uploads = this.service('fileUploads')
      if (!uploads?.upload) {
        throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'file attachments require the file-upload plugin')
      }
      const staged = await uploads.upload(
        agent,
        { data: Buffer.from(bytes).toString('base64'), name: entry.name },
        signal,
      )
      content.push({ type: 'file', receiptId: staged?.receiptId })
    }
    return content
  }

  // ── workspace mutation (PLUGIN-EXT §5 `workspaceMutation`) ─────────────────

  /**
   * Register a directory as a workspace.
   *
   * @param {object} params creation parameters.
   * @param {string} params.path directory to register.
   * @param {string} [params.title] initial display title.
   * @returns {Promise<Record<string, unknown>>} `{ workspace }`.
   */
  async createWorkspace(params) {
    const controller = this.service('workspaceController')
    if (!controller?.create) {
      throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'workspace management requires the workspace-controller plugin')
    }
    if (!this.allowsCwd(params.path)) {
      throw fail(ERROR_CODES.FORBIDDEN, `"${params.path}" is outside allowedCwdPrefixes`, {
        details: { path: params.path },
      })
    }
    const value = await controller.create({ path: params.path })
    let workspace = value?.workspace
    if (params.title !== undefined && workspace?.workspaceId !== undefined) {
      const renamed = await controller.rename({ workspaceId: workspace.workspaceId, title: params.title })
      workspace = renamed?.workspace ?? workspace
    }
    return { workspace: wireWorkspace(workspace) }
  }

  /**
   * Rename one registered workspace.
   *
   * @param {object} params rename parameters.
   * @param {string} [params.id] workspace id.
   * @param {string} [params.path] workspace path, when no id is given.
   * @param {string} params.title new title.
   * @returns {Promise<Record<string, unknown>>} `{ workspace }`.
   */
  async renameWorkspace(params) {
    const controller = this.service('workspaceController')
    if (!controller?.rename) {
      throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'workspace management requires the workspace-controller plugin')
    }
    const workspace = await this.findWorkspace(params.id, params.path)
    const value = await controller.rename({ workspaceId: workspace.workspaceId, title: params.title })
    return { workspace: wireWorkspace(value?.workspace ?? workspace) }
  }

  /**
   * Remove one workspace registration.
   *
   * The registration is all that is removed — the directory and its sessions
   * are left exactly as they are on disk. This bridge never deletes files.
   *
   * @param {object} params removal parameters.
   * @param {string} [params.id] workspace id.
   * @param {string} [params.path] workspace path, when no id is given.
   * @returns {Promise<Record<string, unknown>>} `{ removed: true }`.
   */
  async removeWorkspace(params) {
    const controller = this.service('workspaceController')
    if (!controller?.delete) {
      throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'workspace management requires the workspace-controller plugin')
    }
    const workspace = await this.findWorkspace(params.id, params.path)
    await controller.delete({ workspaceId: workspace.workspaceId })
    return { removed: true }
  }

  /**
   * @param {string} [id] workspace id.
   * @param {string} [path] workspace path.
   * @returns {Promise<Record<string, any>>} the matching registered workspace.
   */
  async findWorkspace(id, path) {
    const registry = this.service('workspaceRegistry')
    const workspaces = safeCall(() => registry?.list?.() ?? []) ?? []
    const match =
      id !== undefined
        ? workspaces.find((entry) => String(entry?.id) === String(id))
        : workspaces.find((entry) => samePath(entry?.path, path))
    if (match === undefined) {
      throw fail(ERROR_CODES.NOT_FOUND, id !== undefined ? `unknown workspace "${id}"` : `no workspace is registered for "${path}"`, {
        details: id !== undefined ? { id } : { path },
      })
    }
    return match
  }

  // ── file browser (PLUGIN-EXT §6 `fileBrowser`) ─────────────────────────────

  /**
   * List one directory.
   *
   * Read-only: the panel browses, it never writes. Paths are checked against
   * `allowedCwdPrefixes` both before and after resolution, so a symlink cannot
   * walk the caller out of the permitted tree.
   *
   * @param {string} path directory to list.
   * @param {AbortSignal} [signal] caller lifetime.
   * @returns {Promise<Record<string, unknown>>} `{ path, entries, truncated }`.
   */
  async listDirectory(path, signal) {
    const fs = this.#requireFs()
    this.#assertPathAllowed(path)
    const target = await fs.resolve(path, signal === undefined ? {} : { signal })
    const info = await fs.stat(target, signal)
    if (info === undefined) throw fail(ERROR_CODES.NOT_FOUND, `"${path}" does not exist`, { details: { path } })
    if (info.type !== 'directory') {
      throw fail(ERROR_CODES.INVALID_PARAMS, `"${path}" is not a directory`, { details: { path } })
    }
    this.#assertPathAllowed(fs.processPath(target))
    const entries = (await fs.listDir(target, signal)) ?? []
    return {
      path,
      entries: entries.map((entry) => {
        const entryPath = safeCall(() => fs.processPath(entry.target)) ?? entry.name
        return {
          name: entry.name,
          path: entryPath,
          type: entry.type === 'directory' ? 'dir' : entry.type === 'file' ? 'file' : 'other',
          ...(entry.size === undefined ? {} : { size: Number(entry.size) }),
          binary: false,
        }
      }),
      truncated: false,
    }
  }

  /**
   * Read one file.
   *
   * Text files come back as `text`; anything the backend refuses to decode
   * comes back as `dataBase64` with a sniffed media type. Over `maxBytes` the
   * result is marked `truncated` rather than refused, because the panel is a
   * preview.
   *
   * @param {object} params read parameters.
   * @param {string} params.path file to read.
   * @param {number} [params.maxBytes] preview budget.
   * @returns {Promise<Record<string, unknown>>} the file preview.
   */
  async readFile(params) {
    const fs = this.#requireFs()
    this.#assertPathAllowed(params.path)
    const target = await fs.resolve(params.path)
    const info = await fs.stat(target)
    if (info === undefined) throw fail(ERROR_CODES.NOT_FOUND, `"${params.path}" does not exist`, { details: { path: params.path } })
    if (info.type !== 'file') {
      throw fail(ERROR_CODES.INVALID_PARAMS, `"${params.path}" is not a regular file`, { details: { path: params.path } })
    }
    this.#assertPathAllowed(fs.processPath(target))
    const size = Number(info.size ?? 0)
    const budget = params.maxBytes
    const truncated = budget !== undefined && size > budget
    const text = await safeCallAsync(() => fs.readText(target))
    if (typeof text === 'string') {
      const clipped = truncated ? Buffer.from(text, 'utf8').subarray(0, budget).toString('utf8') : text
      return { path: params.path, size, truncated, binary: false, text: clipped }
    }
    const bytes = await fs.readBytes(target, undefined, truncated ? budget : Math.max(size, 1))
    return {
      path: params.path,
      size,
      truncated,
      binary: true,
      dataBase64: Buffer.from(bytes).toString('base64'),
      mime: sniffMime(params.path),
    }
  }

  /**
   * @returns {any} the composed filesystem service.
   */
  #requireFs() {
    const fs = this.service('fs')
    if (!fs?.resolve || !fs?.listDir) {
      throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'the file browser requires the filesystem plugin')
    }
    return fs
  }

  /**
   * @param {string} path candidate path.
   */
  #assertPathAllowed(path) {
    if (!this.allowsCwd(path)) {
      throw fail(ERROR_CODES.FORBIDDEN, `"${path}" is outside allowedCwdPrefixes`, { details: { path } })
    }
  }

  // ── plugin management (PLUGIN-EXT §8 `pluginManagement`) ───────────────────

  /**
   * List the deployment's Loader entries.
   *
   * @returns {Promise<Record<string, unknown>>} `{ items }`.
   */
  async listPlugins() {
    const inventory = this.service('pluginInventory')
    if (!inventory?.list) {
      throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'the plugin inventory requires the plugin-inventory plugin')
    }
    const snapshot = await inventory.list()
    const items = []
    for (const entry of snapshot?.entries ?? []) {
      const id = String(entry?.entryId ?? '')
      const moduleName = String(entry?.moduleName ?? '')
      const facts = this.#pluginFacts(moduleName)
      items.push({
        id,
        name: facts.name,
        version: facts.version,
        ...(facts.description === undefined ? {} : { description: facts.description }),
        enabled: entry?.enabled === true,
        state: fiberState(entry?.fiberPhase, entry?.enabled === true),
        scope: 'global',
        configurable: facts.configurable,
      })
    }
    for (const preset of snapshot?.agentPresets ?? []) {
      for (const row of preset?.rows ?? []) {
        const id = String(row?.entryId ?? '')
        const moduleName = String(row?.moduleName ?? '')
        const facts = this.#pluginFacts(moduleName)
        items.push({
          id,
          name: facts.name,
          version: facts.version,
          enabled: row?.enabled === true,
          state: fiberState(row?.fiberPhase, row?.enabled === true),
          scope: 'session',
          preset: preset?.id,
          configurable: false,
        })
      }
    }
    return { items }
  }

  /**
   * Read one plugin's configuration schema and current values.
   *
   * @param {string} id Loader entry id.
   * @returns {Promise<Record<string, unknown>>} `{ schema, values }`.
   */
  async pluginConfig(id) {
    const entry = this.#requireLoaderEntry(id)
    const moduleName = String(entry?.options?.name ?? '')
    const schema = safeCall(() => this.#loaderModule(moduleName)?.Config?.toJSON?.())
    return {
      schema: schema ?? {},
      values: toPlainJson(entry?.options?.config) ?? {},
    }
  }

  /**
   * Merge a patch into one plugin's configuration.
   *
   * @param {string} id Loader entry id.
   * @param {Record<string, any>} patch partial configuration.
   * @returns {Promise<Record<string, unknown>>} `{ values }`.
   */
  async setPluginConfig(id, patch) {
    const entry = this.#requireLoaderEntry(id)
    const next = { ...(toPlainJson(entry?.options?.config) ?? {}), ...patch }
    await entry.update({ config: next })
    const updated = this.#loaderEntry(id) ?? entry
    return { values: toPlainJson(updated?.options?.config) ?? next }
  }

  /**
   * Enable or disable one Loader entry.
   *
   * @param {string} id Loader entry id.
   * @param {boolean} enabled desired state.
   * @returns {Promise<Record<string, unknown>>} `{ item }`.
   */
  async setPluginEnabled(id, enabled) {
    const entry = this.#requireLoaderEntry(id)
    await entry.update({ disabled: !enabled })
    const updated = this.#loaderEntry(id) ?? entry
    const moduleName = String(updated?.options?.name ?? '')
    const facts = this.#pluginFacts(moduleName)
    return {
      item: {
        id,
        name: facts.name,
        version: facts.version,
        enabled: updated?.disabled !== true,
        state: fiberState(fiberPhaseOf(updated), updated?.disabled !== true),
        scope: 'global',
        configurable: facts.configurable,
      },
    }
  }

  /**
   * @param {string} id Loader entry id.
   * @returns {any} the Loader entry.
   */
  #loaderEntry(id) {
    const loader = this.service('loader')
    return safeCall(() => loader?.resolve?.(id))
  }

  /**
   * Import one Loader module specifier so its exported `Config` schema can be
   * read. The Loader caches imports, so this is a map lookup after first use.
   *
   * @param {string} moduleName module specifier from the Loader entry.
   * @returns {any} the imported module, or undefined.
   */
  #loaderModule(moduleName) {
    if (moduleName === '') return undefined
    const loader = this.service('loader')
    return safeCall(() => loader?.import?.(moduleName))
  }

  /**
   * Describe one Loader module by its own manifest.
   *
   * A bare package specifier resolves through Node's search paths, exactly as
   * the Loader itself resolves it; a path specifier walks up to the nearest
   * `package.json`. Either way the name and version shown here are the ones
   * the package declares, not a guess from the entry id.
   *
   * @param {string} moduleName module specifier from the Loader entry.
   * @returns {{name: string, version: string, description?: string, configurable: boolean}} display facts.
   */
  #pluginFacts(moduleName) {
    const configurable = safeCall(() => this.#loaderModule(moduleName)?.Config !== undefined) === true
    const manifest = readPackageManifest(moduleName, this.ctx?.baseUrl ?? import.meta.url)
    const bare = bareModuleName(moduleName)
    return {
      name: manifest?.name ?? bare ?? moduleName,
      version: typeof manifest?.version === 'string' ? manifest.version : '',
      ...(typeof manifest?.description === 'string' && manifest.description !== ''
        ? { description: manifest.description }
        : {}),
      configurable,
    }
  }

  /**
   * @param {string} id Loader entry id.
   * @returns {any} the Loader entry, or a protocol error.
   */
  #requireLoaderEntry(id) {
    const loader = this.service('loader')
    if (!loader?.resolve) {
      throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'plugin management requires the Cordis loader')
    }
    if (!this.config.allowRemoteControl) {
      throw fail(ERROR_CODES.DISABLED, 'remote control is disabled by plugin configuration')
    }
    const entry = safeCall(() => loader.resolve(id))
    if (entry === undefined) throw fail(ERROR_CODES.NOT_FOUND, `unknown plugin entry "${id}"`, { details: { id } })
    return entry
  }
}

/**
 * @param {any} snapshot a `JobSnapshot`.
 * @returns {Record<string, unknown>} the wire form.
 */
export function wireJob(snapshot) {
  return {
    id: snapshot?.id,
    kind: snapshot?.kind,
    label: snapshot?.label,
    status: snapshot?.status,
    detail: snapshot?.detail,
    sessionId: snapshot?.ownerSession,
    startedAt: snapshot?.startedAt,
    finishedAt: snapshot?.finishedAt,
    reported: snapshot?.reported === true,
  }
}

/**
 * @template T
 * @param {() => T} fn value producer that may throw.
 * @returns {T | undefined} the value, or undefined when it threw.
 */
function safeCall(fn) {
  try {
    return fn()
  } catch {
    return undefined
  }
}

/**
 * @template T
 * @param {() => Promise<T>} fn value producer that may reject.
 * @returns {Promise<T | undefined>} the value, or undefined when it rejected.
 */
async function safeCallAsync(fn) {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

/**
 * Trim one durable session event down to the shape the live `session/event`
 * firehose carries, so a server splices history and live frames with one
 * parser. The log's own `seq` and `time` are preserved exactly.
 *
 * @param {any} event a `SessionEvent` from the log.
 * @returns {Record<string, unknown>} the wire event.
 */
export function wireSessionEvent(event) {
  return {
    type: event?.type,
    seq: Number(event?.seq),
    time: Number(event?.time),
    data: event?.data,
    ...(event?.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
    ...(event?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs }),
    ...(event?.ignorable === true ? { ignorable: true } : {}),
  }
}

/**
 * Attach the current rating to an assistant-message event.
 *
 * @param {Record<string, any>} wire the wire event.
 * @param {any} source the durable event it came from.
 * @param {Map<string, Record<string, any>>} feedback current feedback by message id.
 * @returns {Record<string, any>} the event, with `feedback` when one exists.
 */
function withFeedback(wire, source, feedback) {
  if (wire.type !== 'assistant/message' || feedback.size === 0) return wire
  const messageId = source?.data?.message?.id
  if (messageId === undefined || messageId === null) return wire
  const item = feedback.get(String(messageId))
  if (item === undefined) return wire
  return {
    ...wire,
    feedback: {
      rating: item.rating === 'positive' ? 'like' : 'dislike',
      updatedAt: Number(item.updatedAt ?? 0),
    },
  }
}

/**
 * Add the model's declared intent to every tool call in one message-aligned
 * history record, so a server rendering the aligned view shows the same
 * `Pwsh · <intent>` row the local UI does.
 *
 * @param {any} record a `SessionHistoryRecord`.
 * @returns {any} the record, with tool-call descriptions filled in.
 */
export function decorateHistoryRecord(record) {
  const message = record?.event?.data?.message
  const content = message?.content
  if (!Array.isArray(content)) return record
  let changed = false
  const next = content.map((block) => {
    if (block?.type !== 'tool-call') return block
    const description = toolIntentFromArguments(block?.arguments)
    if (description === undefined) return block
    changed = true
    return { ...block, description }
  })
  if (!changed) return record
  return { ...record, event: { ...record.event, data: { ...record.event.data, message: { ...message, content: next } } } }
}

/**
 * @param {any} workspace a `WorkspaceView`.
 * @returns {Record<string, unknown> | null} the wire form, shaped like `workspace.list` items.
 */
export function wireWorkspace(workspace) {
  if (!workspace) return null
  return {
    id: workspace.workspaceId,
    path: workspace.path,
    title: workspace.title,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    sessionIds: workspace.sessionIds ?? [],
  }
}

/**
 * Decode canonical base64, refusing anything the protocol should have caught.
 *
 * @param {string} text base64 payload.
 * @returns {Uint8Array} the decoded bytes.
 */
function decodeBase64(text) {
  if (typeof text !== 'string' || text === '') {
    throw fail(ERROR_CODES.INVALID_PARAMS, '"dataBase64" must be a non-empty base64 string', {
      details: { field: 'dataBase64' },
    })
  }
  const buffer = Buffer.from(text, 'base64')
  if (buffer.byteLength === 0) {
    throw fail(ERROR_CODES.INVALID_PARAMS, '"dataBase64" is not valid base64', { details: { field: 'dataBase64' } })
  }
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

/**
 * @param {Uint8Array[]} chunks byte chunks in order.
 * @returns {Uint8Array} one contiguous buffer.
 */
function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * Compare two filesystem paths the way Windows and POSIX users expect.
 *
 * @param {unknown} left first path.
 * @param {unknown} right second path.
 * @returns {boolean} whether they name the same location.
 */
function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const normalize = (value) => value.replace(/\\/g, '/').replace(/\/+$/, '')
  const a = normalize(left)
  const b = normalize(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Extension → media type for the file browser's binary previews. */
const MIME_BY_EXTENSION = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  json: 'application/json',
  wasm: 'application/wasm',
})

/**
 * @param {string} path file path.
 * @returns {string} a media type derived from the extension.
 */
function sniffMime(path) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(path))
  return MIME_BY_EXTENSION[String(match?.[1] ?? '').toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Map one Loader fiber phase onto the protocol's plugin state vocabulary.
 *
 * @param {string | null | undefined} phase the inventory's `fiberPhase`.
 * @param {boolean} enabled effective enablement.
 * @returns {string} one of `active | pending | failed | unloading | disabled`.
 */
function fiberState(phase, enabled) {
  if (phase === 'active') return 'active'
  if (phase === 'failed') return 'failed'
  if (phase === 'unloading') return 'unloading'
  if (phase === null || phase === undefined) return enabled ? 'pending' : 'disabled'
  return 'pending'
}

/**
 * @param {any} entry a Cordis Loader entry.
 * @returns {string | null} the entry's root-fiber phase.
 */
function fiberPhaseOf(entry) {
  const state = entry?.fiber?.state
  if (typeof state === 'number') return FIBER_PHASES[state] ?? null
  if (typeof state === 'string') return state
  return null
}

/** Cordis fiber state enum → the inventory's phase names. */
const FIBER_PHASES = Object.freeze(['pending', 'loading', 'active', 'failed', 'unloading'])

/**
 * @param {unknown} value any configuration value.
 * @returns {unknown} a JSON-safe clone, or undefined when it cannot be cloned.
 */
function toPlainJson(value) {
  if (value === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return undefined
  }
}

/**
 * @param {string} specifier a Loader module specifier.
 * @returns {string | undefined} the bare package name, when the specifier is one.
 */
function bareModuleName(specifier) {
  if (typeof specifier !== 'string' || specifier === '') return undefined
  if (specifier.startsWith('.') || specifier.includes('://') || isAbsolute(specifier)) return undefined
  const [first = '', second = ''] = specifier.split('/')
  if (first === '' || first === 'cordis:') return undefined
  return first.startsWith('@') ? `${first}/${second}` : first
}

/**
 * Read the package manifest that owns one Loader module specifier.
 *
 * Bare specifiers resolve through Node's own search paths anchored where the
 * plugin was loaded from — the profile's `node_modules`, which is exactly where
 * the Loader resolved them. Path specifiers walk up to the nearest manifest.
 *
 * @param {string} moduleName module specifier from the Loader entry.
 * @param {string} anchor absolute URL of a file inside the loading deployment.
 * @returns {Record<string, any> | undefined} the parsed manifest.
 */
function readPackageManifest(moduleName, anchor) {
  if (typeof moduleName !== 'string' || moduleName === '') return undefined
  const bare = bareModuleName(moduleName)
  try {
    if (bare !== undefined) {
      const searchPaths = createRequire(anchor).resolve.paths(bare)
      if (searchPaths === null) return undefined
      for (const searchPath of searchPaths) {
        const manifest = join(searchPath, bare, 'package.json')
        if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, 'utf8'))
      }
      return undefined
    }
    if (moduleName.startsWith('cordis:')) return undefined
    const base = isAbsolute(moduleName) ? moduleName : fileURLToPath(new URL(moduleName, anchor))
    let current = dirname(base)
    const root = parse(current).root
    while (true) {
      const manifest = join(current, 'package.json')
      if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, 'utf8'))
      if (current === root) return undefined
      current = dirname(current)
    }
  } catch {
    return undefined
  }
}
