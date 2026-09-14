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
import { ERROR_CODES, fail } from './protocol.js'
import { truncate } from './util.js'

/** Service names probed at startup, in the order they appear in capabilities. */
const PROBED_SERVICES = [
  'agents',
  'sessions',
  'sessionController',
  'sessionPersistence',
  'sessionProjections',
  'workspaceRegistry',
  'jobs',
  'goals',
  'commands',
  'approval',
  'userQuestions',
]

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
  }

  /**
   * Resolve one service, tolerating a context that throws on unknown keys.
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
    this.cache.set(name, value)
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
      return { records: page?.records ?? [], hasMore: page?.hasMore === true }
    }
    const session = this.liveSession(params.sessionId)
    if (!session) {
      throw fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'history for a detached session requires the session controller plugin')
    }
    return { records: this.#liveHistory(session, params), hasMore: false }
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
