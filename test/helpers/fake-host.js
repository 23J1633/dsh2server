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
    this.agent = new FakeAgent(options.id, this)
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
        self.sessions.set(id, new FakeSession({ id, cwd: request.cwd }))
        return { sessionId: id }
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
    const workspaceRegistry = {
      list: () => [
        {
          id: 'ws-1',
          path: 'C:/work/project',
          title: 'Project',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
          sessionIds: [...self.sessions.keys()],
        },
      ],
    }
    const sessionProjections = {
      snapshot: () => ({ asOfSeq: 3, values: { todos: [{ id: 't1', text: 'ship it', status: 'pending' }] } }),
      onChanged: (listener) => {
        self.projectionListeners.add(listener)
        return () => self.projectionListeners.delete(listener)
      },
    }
    return { sessions, agents, sessionController, jobs, goals, commands, approval, workspaceRegistry, sessionProjections }
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
