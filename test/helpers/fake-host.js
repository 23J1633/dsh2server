/**
 * Test doubles: a minimal Cordis-shaped context and a fake harness host.
 *
 * The end-to-end tests run the **real** `Bridge` against the **real** reference
 * relay, replacing only the harness services underneath it. That keeps the
 * protocol, transports, dispatcher, and host adapter under test while making the
 * assertions deterministic.
 *
 * @module dsh2server/test/helpers/fake-host
 */

/**
 * A tiny event/capability context with the shape the plugin uses.
 */
export class FakeContext {
  /** @param {Record<string, unknown>} [services] service instances by name. */
  constructor(services = {}) {
    this.services = services
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map()
    /** @type {Array<() => unknown>} */
    this.effects = []
    /** @type {string[]} */
    this.logs = []
    const self = this
    this.logger = (name) => ({
      error: (...args) => self.logs.push(`error ${args.join(' ')}`),
      warn: (...args) => self.logs.push(`warn ${args.join(' ')}`),
      info: (...args) => self.logs.push(`info ${args.join(' ')}`),
      debug: (...args) => self.logs.push(`debug ${args.join(' ')}`),
    })
  }

  /**
   * @param {string} name service name.
   * @returns {unknown} the service, or undefined.
   */
  get(name) {
    return this.services[name]
  }

  /**
   * @param {string} event event name.
   * @param {Function} handler listener.
   * @returns {void}
   */
  on(event, handler) {
    const set = this.listeners.get(event) ?? new Set()
    set.add(handler)
    this.listeners.set(event, set)
  }

  /**
   * @param {string} event event name.
   * @param {...unknown} args listener arguments.
   * @returns {unknown[]} listener return values.
   */
  emit(event, ...args) {
    const results = []
    for (const handler of [...(this.listeners.get(event) ?? [])]) {
      results.push(handler(...args))
    }
    return results
  }

  /**
   * Run the effect body immediately and remember its disposer.
   *
   * @param {() => unknown} body effect body.
   * @returns {void}
   */
  effect(body) {
    this.effects.push(/** @type {() => unknown} */ (body()))
  }

  /** Run every registered disposer. */
  async dispose() {
    for (const disposer of this.effects.splice(0).reverse()) {
      if (typeof disposer === 'function') await disposer()
    }
  }
}

/**
 * A live agent double.
 */
export class FakeAgent {
  /**
   * @param {string} id agent/session identity.
   * @param {FakeSession} session owning session.
   */
  constructor(id, session) {
    this.id = id
    this.session = session
    this.status = 'idle'
    this.options = { provider: 'fake', model: 'fake-model' }
    this.inbox = { nextTurn: [], nextStep: [], clear() {} }
    /** @type {Array<Record<string, unknown>>} */
    this.calls = []
  }

  /** @param {unknown} message prompt message. */
  followup(message) {
    this.calls.push({ method: 'followup', message })
  }

  /** @param {unknown} message steering message. */
  steer(message) {
    this.calls.push({ method: 'steer', message })
  }

  /** @param {unknown} message injected context. */
  inject(message) {
    this.calls.push({ method: 'inject', message })
  }

  /**
   * @param {Record<string, unknown>} cause cancellation cause.
   * @param {Record<string, unknown>} [options] cancellation options.
   */
  cancel(cause, options) {
    this.calls.push({ method: 'cancel', cause, options })
    this.status = 'idle'
  }

  /** @returns {Promise<void>} resolves immediately. */
  async whenIdle() {}
}

/**
 * A live session double.
 */
export class FakeSession {
  /**
   * @param {object} options session options.
   * @param {string} options.id session identity.
   * @param {string} [options.cwd] working directory.
   */
  constructor(options) {
    this.id = options.id
    this.header = {
      version: 3,
      id: options.id,
      createdAt: Date.now(),
      cwd: options.cwd ?? 'C:/work/project',
      isSeeded: false,
    }
    this.seq = 1
    /** @type {Array<Record<string, unknown>>} */
    this.events = []
    /** @type {Array<Record<string, unknown>>} the durable event log, as a real session keeps it. */
    this.logEvents = []
    this.agent = new FakeAgent(options.id, this)
  }

  /**
   * @param {number} [fromSeq] inclusive first sequence number.
   * @param {number} [toSeqExclusive] exclusive last sequence number.
   * @returns {readonly Record<string, unknown>[]} the requested log slice.
   */
  snapshotEvents(fromSeq = 0, toSeqExclusive = Number.MAX_SAFE_INTEGER) {
    return this.logEvents.filter((event) => Number(event.seq) >= fromSeq && Number(event.seq) < toSeqExclusive)
  }

  /**
   * Append one event to the durable log.
   *
   * @param {Record<string, unknown>} event a `SessionEvent`.
   * @returns {Record<string, unknown>} the appended event.
   */
  appendLogEvent(event) {
    this.logEvents.push(event)
    return event
  }

  /** @returns {Array<Record<string, unknown>>} derived transcript. */
  deriveMessages() {
    return this.events.map((event) => ({ role: 'user', content: [{ type: 'text', text: String(event.text ?? '') }] }))
  }
}

/**
 * A harness host double covering the services the bridge probes.
 */
export class FakeHost {
  /**
   * @param {object} [options] host options.
   * @param {Array<{id: string, cwd?: string, running?: boolean}>} [options.sessions] initial sessions.
   */
  constructor(options = {}) {
    /** @type {Map<string, FakeSession>} */
    this.sessions = new Map()
    for (const spec of options.sessions ?? [{ id: 'session-a', cwd: 'C:/work/project', running: true }]) {
      const session = new FakeSession({ id: spec.id, cwd: spec.cwd })
      session.agent.status = spec.running ? 'running' : 'idle'
      this.sessions.set(spec.id, session)
    }
    /** @type {Array<Record<string, unknown>>} */
    this.prompts = []
    /** @type {Array<Record<string, unknown>>} */
    this.cancels = []
    /** @type {Array<Record<string, unknown>>} */
    this.commandRuns = []
    /** @type {Array<Record<string, unknown>>} */
    this.goalCalls = []
    this.jobSnapshots = [
      { id: 'bash-1', kind: 'bash', label: 'pnpm test', status: 'running', ownerSession: 'session-a', startedAt: Date.now(), reported: false },
    ]
    this.goal = undefined
    this.approvalPolicy = undefined
    /** @type {Array<Record<string, any>>} message feedback rows. */
    this.feedback = []
    /** @type {string} the deployment's current permission preset name. */
    this.permission = 'workspace-write'
    /** @type {Array<Record<string, any>>} path-free Agent-preset roster. */
    this.agentPresetRows = [
      { id: 'standard', name: 'Standard', description: 'Full coding agent', trust: 'system', isDefault: true },
      { id: 'minimal', name: 'Minimal', description: 'Single-tool agent', trust: 'system', isDefault: false },
    ]
    /** @type {Array<Record<string, string>>} accepted preset selections. */
    this.agentPresetSelections = []
    /** @type {Map<string, Uint8Array>} stored attachment bytes by harness reference id. */
    this.attachmentBytes = new Map()
    /** @type {Array<Record<string, any>>} registered workspaces. */
    this.workspaces = [
      {
        workspaceId: 'ws-1',
        path: 'C:/work/project',
        title: 'Project',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        sessionIds: ['session-a'],
      },
    ]
    /** @type {Array<Record<string, any>>} every config/enablement write the bridge made. */
    this.pluginWrites = []
    /** @type {Map<string, Record<string, any>>} files the fake filesystem serves. */
    this.files = new Map([
      ['C:/work/project', { type: 'directory' }],
      ['C:/work/project/notes.txt', { type: 'file', size: 11, text: 'hello world' }],
      ['C:/work/project/blob.bin', { type: 'file', size: 4096, bytes: new Uint8Array([0, 1, 2, 3]) }],
      ['C:/work/project/src', { type: 'directory' }],
      ['C:/work/project/src/index.ts', { type: 'file', size: 3, text: 'ok\n' }],
    ])
    /** @type {Map<string, Set<Function>>} */
    this.jobListeners = new Set()
    /** @type {Set<Function>} */
    this.projectionListeners = new Set()
    this.services = this.#buildServices()
  }

  /** @returns {Record<string, unknown>} the service table handed to the fake context. */
  #buildServices() {
    const self = this
    const sessions = {
      list: () => [...self.sessions.values()],
      get: (id) => self.sessions.get(id),
      fork: (source) => {
        const parent = self.sessions.get(String(source))
        const child = new FakeSession({ id: `${parent?.id}-fork`, cwd: parent?.header?.cwd })
        self.sessions.set(child.id, child)
        return child
      },
    }
    const agents = {
      get: (id) => self.sessions.get(id)?.agent,
      list: () => [...self.sessions.values()].map((session) => session.agent),
      roots: () => [...self.sessions.values()].map((session) => session.agent),
      resume: async ({ resumeSessionId }) => ({ agent: self.sessions.get(resumeSessionId)?.agent, dispose: async () => {} }),
      create: async ({ sessionId, meta }) => {
        const session = new FakeSession({ id: sessionId, cwd: meta?.cwd })
        self.sessions.set(sessionId, session)
        return { agent: session.agent, dispose: async () => {} }
      },
    }
    const sessionController = {
      list: async () => ({
        items: [...self.sessions.values()].map((session) => ({
          sessionId: session.id,
          updatedAt: session.header.createdAt,
          running: session.agent.status === 'running',
          blank: false,
          cwd: session.header.cwd,
        })),
      }),
      resolveAgent: async (sessionId) => {
        const session = self.sessions.get(String(sessionId))
        return session ? { agent: session.agent } : { error: { code: 'session/not-found', message: 'not found' } }
      },
      create: async (request) => {
        const id = request.sessionId ?? `session-${self.sessions.size + 1}`
        const session = new FakeSession({ id, cwd: request.cwd })
        session.header.agentPreset = request.agentPreset ?? 'standard'
        self.sessions.set(id, session)
        return { sessionId: id, agentPreset: session.header.agentPreset }
      },
      prompt: async (request) => {
        const session = self.sessions.get(String(request.sessionId))
        if (!session) throw new Error('not found')
        self.prompts.push(request)
        const message = { id: request.requestId, role: 'user', content: request.content }
        if (request.mode === 'steer') session.agent.steer(message)
        else session.agent.followup(message)
        return { accepted: true }
      },
      cancel: (request) => {
        self.cancels.push(request)
        self.sessions.get(String(request.sessionId))?.agent.cancel({ kind: 'user' }, { keepInbox: true })
        return { accepted: true }
      },
      rename: async (request) => ({ title: request.title, seq: 7 }),
      fork: async (request) => ({ sessionId: `${request.sessionId}-fork` }),
      search: async (query) => ({ items: [{ sessionId: 'session-a', snippet: `match: ${query.query}` }], hasMore: false }),
      page: async () => ({ records: [{ type: 'event', event: { type: 'user/message', seq: 1, time: 1, data: {} } }], hasMore: false }),
      selectModel: async (request) => ({ selected: { provider: request.provider, model: request.model } }),
      modelCatalog: async () => ({ default: { provider: 'fake', model: 'fake-model' }, routableProviders: ['fake'], groups: [], failures: [] }),
      updateQueue: () => ({ accepted: true }),
    }
    const jobs = {
      list: (caller) => self.jobSnapshots.filter((job) => !job.ownerSession || !caller || job.ownerSession === caller.id),
      kill: (id) => {
        const job = self.jobSnapshots.find((entry) => entry.id === id)
        if (job) job.status = 'killed'
        return 'requested'
      },
      read: (id) => ({ text: `output of ${id}`, snapshot: self.jobSnapshots.find((entry) => entry.id === id) }),
      onJobsChanged: (listener) => {
        self.jobListeners.add(listener)
        return () => self.jobListeners.delete(listener)
      },
    }
    const goals = {
      get: () => self.goal,
      pause: () => {
        self.goalCalls.push({ action: 'pause' })
        self.goal = { ...self.goal, phase: 'paused' }
        return self.goal
      },
      resume: () => {
        self.goalCalls.push({ action: 'resume' })
        self.goal = { ...self.goal, phase: 'active' }
        return self.goal
      },
      complete: () => {
        self.goalCalls.push({ action: 'complete' })
        self.goal = { ...self.goal, phase: 'complete' }
        return self.goal
      },
      clear: () => {
        self.goalCalls.push({ action: 'clear' })
        const current = self.goal
        self.goal = undefined
        return current
      },
      disarm: () => self.goal,
    }
    const commands = {
      list: () => [{ name: 'compact', description: 'Compact the conversation' }],
      execute: async (_agent, line) => {
        self.commandRuns.push({ line })
        return { commandId: 'cmd-1', result: { kind: 'ok' } }
      },
    }
    const approval = {
      setPolicy: (_agent, policy) => {
        self.approvalPolicy = policy
      },
      overrideOf: () => self.approvalPolicy,
    }
    // The registry publishes `id`; the controller publishes `workspaceId`. The
    // host adapter has to read both, so the fake keeps each layer's own spelling.
    const workspaceRegistry = {
      archivedSessionIds: [],
      list: () =>
        self.workspaces.map((workspace) => ({
          id: workspace.workspaceId,
          path: workspace.path,
          title: workspace.title,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
          sessionIds: workspace.sessionIds,
        })),
      archiveSession: async (sessionId) => {
        if (!self.sessions.get(sessionId)) {
          throw new Error(`session "${sessionId}" not found`)
        }
        if (!workspaceRegistry.archivedSessionIds.includes(sessionId)) workspaceRegistry.archivedSessionIds.push(sessionId)
      },
    }
    const sessionProjections = {
      snapshot: () => ({ asOfSeq: 3, values: { todos: [{ id: 't1', text: 'ship it', status: 'pending' }] } }),
      onChanged: (listener) => {
        self.projectionListeners.add(listener)
        return () => self.projectionListeners.delete(listener)
      },
    }
    const messageFeedback = {
      list: async ({ sessionId }) => ({
        ok: true,
        value: {
          items: self.feedback
            .filter((row) => row.sessionId === sessionId)
            .map((row) => ({ messageId: row.messageId, rating: row.rating, version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt })),
        },
      }),
      put: async ({ sessionId, messageId, rating }) => {
        const now = Date.now()
        const existing = self.feedback.find((row) => row.sessionId === sessionId && row.messageId === messageId)
        if (existing === undefined) {
          const row = { sessionId, messageId, rating, version: `v${self.feedback.length + 1}`, createdAt: now, updatedAt: now }
          self.feedback.push(row)
          return { ok: true, value: row }
        }
        existing.rating = rating
        existing.updatedAt = now
        existing.version = `${existing.version}+`
        return { ok: true, value: existing }
      },
      delete: async ({ sessionId, messageId }) => {
        self.feedback = self.feedback.filter((row) => !(row.sessionId === sessionId && row.messageId === messageId))
        return { ok: true, value: { absent: true } }
      },
    }
    const permissionPresets = {
      names: ['read-only', 'workspace-write', 'danger-full-access'],
      current: () => self.permission,
      resolve: (name) => {
        if (!['read-only', 'workspace-write', 'danger-full-access'].includes(name)) throw new Error(`no preset ${name}`)
        return { sandbox: name, approval: 'ask' }
      },
      // The real service folds the same three knob events and resolves the
      // preset from the resulting state; a cold session reads through here.
      selectFor: (state) => ({
        options: ['read-only', 'workspace-write', 'danger-full-access'].map((name) => ({ value: name, name })),
        currentValue: state?.preset ?? state?.sandbox ?? 'workspace-write',
      }),
      set: (_session, name) => {
        self.permission = name
      },
    }
    const agentPresets = {
      defaultId: 'standard',
      authorable: true,
      remoteExportList: async () => ({
        presets: self.agentPresetRows.map((row) => ({ ...row })),
        authorable: true,
        modeSelectionEnabled: true,
      }),
      readDocument: async (agentPreset) => {
        const preset = self.agentPresetRows.find((row) => row.id === agentPreset)
        if (!preset) {
          const error = new Error(`preset "${agentPreset}" not found`)
          error.code = 'agent-preset/not-found'
          throw error
        }
        return { agentPreset, trust: preset.trust, name: preset.name, description: preset.description, content: `- $id: ${agentPreset}\n` }
      },
      select: async (agent, agentPreset) => {
        if (!self.agentPresetRows.some((row) => row.id === agentPreset)) {
          const error = new Error(`preset "${agentPreset}" not found`)
          error.code = 'agent-preset/not-found'
          throw error
        }
        agent.session.header.agentPreset = agentPreset
        self.agentPresetSelections.push({ sessionId: agent.id, agentPreset })
        return agentPreset
      },
      remoteExportCopy: async (from, agentPreset, name) => {
        const source = self.agentPresetRows.find((row) => row.id === from)
        if (!source) throw new Error(`preset "${from}" not found`)
        self.agentPresetRows.push({ ...source, id: agentPreset, name: name ?? agentPreset, trust: 'user', isDefault: false })
      },
      remoteExportDelete: async (agentPreset) => {
        const preset = self.agentPresetRows.find((row) => row.id === agentPreset)
        if (preset?.trust !== 'user') {
          const error = new Error(`preset "${agentPreset}" is read-only`)
          error.code = 'agent-preset/read-only'
          throw error
        }
        self.agentPresetRows = self.agentPresetRows.filter((row) => row.id !== agentPreset)
      },
    }
    const attachments = {
      saveImage: async ({ data, mediaType, name }) => {
        const ref = { attachmentId: 'img-1', mediaType, bytes: data.byteLength, width: 2, height: 2, name }
        self.attachmentBytes.set(ref.attachmentId, data)
        return ref
      },
      admitEncodedFile: async ({ data, name }) => {
        const bytes = Buffer.from(data, 'base64')
        const ref = { attachmentId: 'file-1', name: name ?? 'file', bytes: bytes.byteLength }
        self.attachmentBytes.set(ref.attachmentId, new Uint8Array(bytes))
        return ref
      },
      readImage: async (ref) => ({ ref, data: self.attachmentBytes.get(ref.attachmentId) ?? new Uint8Array() }),
      readFileStream: async function* (ref) {
        yield self.attachmentBytes.get(ref.attachmentId) ?? new Uint8Array()
      },
    }
    const fileUploads = {
      upload: async (_agent, request) => ({
        receiptId: `rcpt-${self.attachmentBytes.size}`,
        file: { attachmentId: 'file-1', name: request.name ?? 'file', bytes: Buffer.from(request.data, 'base64').byteLength },
      }),
    }
    const fs = {
      resolve: async (path) => ({ targetKey: path, displayPath: path }),
      processPath: (target) => target.displayPath,
      stat: async (target) => {
        const entry = self.files.get(target.displayPath)
        return entry === undefined ? undefined : { version: 'v1', type: entry.type, size: entry.size }
      },
      readText: async (target) => {
        const entry = self.files.get(target.displayPath)
        if (entry?.text === undefined) throw new Error('not text')
        return entry.text
      },
      readBytes: async (target) => self.files.get(target.displayPath)?.bytes ?? new Uint8Array(),
      readByteRange: async (target, range) => (self.files.get(target.displayPath)?.bytes ?? new Uint8Array()).slice(range.offset, range.offset + range.length),
      listDir: async (target) => {
        const prefix = `${target.displayPath}/`
        const seen = new Map()
        for (const [path, entry] of self.files) {
          if (!path.startsWith(prefix) || path === target.displayPath) continue
          const name = path.slice(prefix.length).split('/')[0]
          if (seen.has(name)) continue
          seen.set(name, {
            name,
            type: path.slice(prefix.length).includes('/') ? 'directory' : entry.type,
            target: { targetKey: `${prefix}${name}`, displayPath: `${prefix}${name}` },
            size: entry.size,
          })
        }
        return [...seen.values()]
      },
    }
    const workspaceController = {
      archiveSession: async ({ sessionId }) => {
        await workspaceRegistry.archiveSession(sessionId)
        return { archivedSessionIds: [...workspaceRegistry.archivedSessionIds] }
      },
      create: async ({ path }) => {
        const existing = self.workspaces.find((entry) => entry.path === path)
        if (existing !== undefined) return { workspace: existing, created: false }
        const workspace = {
          workspaceId: `ws-${self.workspaces.length + 1}`,
          path,
          title: path,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          sessionIds: [],
        }
        self.workspaces.push(workspace)
        return { workspace, created: true }
      },
      rename: async ({ workspaceId, title }) => {
        const workspace = self.workspaces.find((entry) => entry.workspaceId === workspaceId)
        if (workspace === undefined) throw new Error(`workspace "${workspaceId}" not found`)
        workspace.title = title
        return { workspace }
      },
      delete: async ({ workspaceId }) => {
        self.workspaces = self.workspaces.filter((entry) => entry.workspaceId !== workspaceId)
        return { deleted: true }
      },
      follow: async function* () {
        // The follow stream is only observed, never driven, in these tests.
      },
    }
    const pluginInventory = {
      list: async () => ({
        entries: [
          { entryId: 'p-one', moduleName: 'pkg-one', enabled: true, fiberPhase: 'active' },
          { entryId: 'p-two', moduleName: 'pkg-two', enabled: false, fiberPhase: null },
        ],
        agentPresets: [{ id: 'standard', trust: 'system', isDefault: true, rows: [{ entryId: 'p-tool', moduleName: 'pkg-tool', enabled: true, fiberPhase: 'active' }] }],
      }),
    }
    // Entries are stable objects so `update()` behaves like the real Loader's:
    // the change is applied in place and every later read sees it.
    const loaderEntries = new Map([
      ['p-one', { id: 'p-one', name: 'pkg-one', disabled: false, config: { answer: 42 }, fiber: { state: 2 } }],
      ['p-two', { id: 'p-two', name: 'pkg-two', disabled: true, config: {}, fiber: { state: 0 } }],
      ['p-tool', { id: 'p-tool', name: 'pkg-tool', disabled: false, config: {}, fiber: { state: 2 } }],
    ])
    const loader = {
      resolve: (id) => {
        const entry = loaderEntries.get(id)
        if (entry === undefined) return undefined
        return {
          options: {
            id: entry.id,
            name: entry.name,
            get config() {
              return entry.config
            },
          },
          get disabled() {
            return entry.disabled
          },
          fiber: entry.fiber,
          update: async (patch) => {
            self.pluginWrites.push({ id, patch })
            if (patch.config !== undefined) entry.config = patch.config
            if (patch.disabled !== undefined) entry.disabled = patch.disabled
          },
        }
      },
      import: async (name) => {
        if (name !== 'pkg-one') return {}
        return {
          Config: {
            toJSON: () => ({
              uid: 1,
              refs: {
                0: { type: 'string', meta: {} },
                2: { type: 'const', meta: {}, value: 'a' },
                3: { type: 'const', meta: {}, value: 'b' },
                4: { type: 'union', meta: { default: 'a', description: 'pick one' }, list: [2, 3] },
                5: { type: 'number', meta: { default: 42 } },
                1: { type: 'object', meta: { default: {} }, dict: { answer: 5, mode: 4 } },
              },
            }),
          },
        }
      },
    }
    // Cold reads go through the persistence handle, exactly as the real
    // backend does: `read(offset, length)` slices the stored log, and an
    // omitted length means "to the end".
    const sessionPersistence = {
      open: async (id) => {
        const session = self.sessions.get(String(id))
        if (session === undefined) {
          const error = new Error(`no stored session "${id}"`)
          error.name = 'SessionPersistenceNotFoundError'
          throw error
        }
        return {
          id,
          read: async (offset = 0, length) => ({
            events: session.logEvents.slice(offset, length === undefined ? undefined : offset + length),
          }),
          close: async () => {},
        }
      },
    }
    return {
      sessions,
      agents,
      sessionController,
      sessionPersistence,
      jobs,
      goals,
      commands,
      approval,
      workspaceRegistry,
      sessionProjections,
      messageFeedback,
      permissionPresets,
      agentPresets,
      attachments,
      fileUploads,
      fs,
      workspaceController,
      pluginInventory,
      loader,
    }
  }

  /**
   * @param {object} [overrides] service overrides; `undefined` removes a service.
   * @returns {FakeContext} a context exposing this host.
   */
  context(overrides = {}) {
    const services = { ...this.services, ...overrides }
    for (const [name, value] of Object.entries(overrides)) {
      if (value === undefined) delete services[name]
    }
    return new FakeContext(services)
  }

  /**
   * Append one durable session event and publish it on the cordis firehose.
   *
   * @param {FakeContext} ctx context carrying the bridge's listeners.
   * @param {string} sessionId session identity.
   * @param {Record<string, unknown>} [data] event payload.
   */
  emitSessionEvent(ctx, sessionId, data = {}) {
    const session = this.sessions.get(sessionId)
    const event = {
      type: data.type ?? 'tool/result',
      seq: session.seq++,
      time: Date.now(),
      data: data.data ?? { ok: true },
      surfaceOp: 'append',
    }
    session.events.push({ ...event, text: data.text })
    ctx.emit('session/event', session, event)
    return event
  }
}

/**
 * Wait until `predicate` is true or the budget elapses.
 *
 * The predicate may be synchronous or asynchronous; an async predicate is
 * awaited, so a polling check can itself call the bridge without leaving
 * unhandled rejections behind when the deadline passes.
 *
 * @param {() => boolean | Promise<boolean>} predicate condition to await.
 * @param {number} [timeoutMs] maximum wait.
 * @param {string} [label] description used in the failure message.
 * @returns {Promise<void>} resolves when the condition holds.
 */
export async function waitFor(predicate, timeoutMs = 5000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let satisfied = false
    try {
      satisfied = await predicate()
    } catch {
      satisfied = false
    }
    if (satisfied) return
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
