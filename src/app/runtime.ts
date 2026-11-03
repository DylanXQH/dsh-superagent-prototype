/** Application composition root and lifecycle manager for dsh-superagent. */
import { recordEpisode } from './episodes.ts'
import { distillAndRemember } from './distill.ts'
import { triageMessage } from './memory-triage.ts'
import { recall, recallCard } from './memory-store.ts'
import { createMemory } from './memory-bridge.ts'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { builtinTaskKinds, Engine, key, reasonText, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, triggerMessage, workerSessionId } from '../executor/dsh.ts'
import { ticketCard } from './cards.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import { parseMemoryCommand, runMemoryCommand } from './memory-commands.ts'
import { parseStatusCommand, runStatusCommand } from './status-commands.ts'
import { parseDeliveryCommand, runDeliveryCommand, type DeliveryCommand } from './delivery-commands.ts'
import { sendFeishuChat, startDailyBrief, startWatchdog } from './notify.ts'
import { registerHttp, type HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime extends Service implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  /** Task kinds this deployment routes by: the registry both the executor and the report tool resolve through. */
  readonly taskKinds = builtinTaskKinds()
  readonly executor: DshExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  constructor(ctx: Context, readonly machine: Machine, restart: () => void) {
    super(ctx, 'orchestrator')
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      // The memory rules live in their own package now; installing the service here, before any session can recall,
      // keeps one instance for the process and lets the package own the ranking and provenance code.
      createMemory(ctx, store, machine.stateDir)
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      })
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId,
        lifetime: this.lifetime,
        closing: () => this.closing(), environment,
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent) })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine, taskKinds: this.taskKinds,
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate),
        memoryCard: text => recallCard(recall(store, text, { limit: 6 }), 1200) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused() })
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor,
        outbox, prepareTicket: (ticket, outcome) => {
          const prepared = executor.prepare(ticket, outcome)
          const repository = this.repositoryOf(prepared)
          return repository ? { ...prepared, repository } : prepared
        }, emit: event => {
          // Notify the main Session only about domain events it did not initiate itself.
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // Notify the ticket's conversations whenever it ends via a pull request.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          // P0 memory: record the episode of every ended ticket from facts already stored; it changes no behaviour by itself.
          if (ended) {
            const episode = recordEpisode(store, ended)
            // Learning is part of ending a ticket: the follow-ups a person typed are the only evidence we accept as intent.
            if (episode) distillAndRemember(store, episode)
          }
          // P1 memory: a person's message may state a durable preference; record it as a fact. This never edits prompts.
          if (event.type === 'trigger.received' && !this.quiet) {
            const trigger = store.triggers.get(event.data.triggerId)
            if (trigger?.human) {
              const learnt = triageMessage(store, trigger.text, { ticketId: event.data.ticketId, actor: trigger.actor.id })
              if (learnt.saved.length > 0) ctx.logger.info('memory: recorded %d standing instruction(s) from %s', learnt.saved.length, trigger.id)
            }
          }
          if (ended && setup.configured()) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
          }
        } })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => runtime.receive(trigger) }
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources, taskKinds: this.taskKinds,
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(), sendNotice: message => {
          // Every finished ticket is reported on Feishu, whatever channel it came in on; the intake channel only
          // gets the router's own reply path, and mail gets none because a person asked for intake-only there.
          const chatId = this.store.settings().notify.chatId
          if (message.channel.source !== 'feishu' && chatId) {
            void sendFeishuChat(this.commands, chatId, message.text).catch((error: unknown) => console.error('[dsh-superagent] feishu notice failed: %s', String(error)))
          }
          if (message.channel.source !== 'mail') outbox.send(message)
        },
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.ready = this.initialize()
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { release() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  /**
   * The repository a new ticket's work belongs to, read off its title and the message that started it: a task that names a
   * configured repository other than the primary one is prepared and delivered there. Unset keeps the primary repository,
   * and a deployment serving a single repository never overrides anything.
   */
  private repositoryOf(ticket: Ticket): string | undefined {
    const deployment = this.setup.configured() ? this.setup.deployment : undefined
    if (!deployment || deployment.repositories.length <= 1) return undefined
    const trigger = this.store.triggers.get(ticket.origin.triggerId)
    // A GitHub trigger names its repository directly, so a Source event never needs the text scan below.
    const declared = trigger?.meta.repository
    if (typeof declared === 'string') {
      const hit = deployment.repositories.find(item => item.toLowerCase() === declared.toLowerCase())
      if (hit && hit !== deployment.repository) return hit
    }
    for (const text of [ticket.title, trigger?.text ?? '']) {
      for (const match of text.matchAll(/(?<![\w.-])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?![\w.-])/g)) {
        const candidate = `${match[1]}/${match[2]}`
        const hit = deployment.repositories.find(item => item.toLowerCase() === candidate.toLowerCase())
        if (hit && hit !== deployment.repository) return hit
      }
    }
    return undefined
  }
  checkSetup(): void { this.setup.check() }
  receive(trigger: Trigger): ReceiveResult {
    // Delivery decisions ("merge", "show me") need the GitHub CLI, so they answer off the receive path.
    const decision = this.deliveryCommand(trigger)
    if (decision) {
      void this.answerDelivery(trigger, decision)
      this.passes.request()
      return 'stored'
    }
    // Memory and status commands answer from the Store alone: no ticket, no worker, and the reply goes out through the
    // same outbox as every other message, so ordering and retries still apply.
    const reply = this.memoryReply(trigger) ?? this.statusReply(trigger)
    if (reply === undefined) return this.passes.receive(trigger)
    const channel = trigger.channel
    if (channel) this.outbox.send({ id: key('answer', trigger.id), channel, text: reply, kind: 'reply' })
    this.passes.request()
    return 'stored'
  }
  /** Reply text when this trigger is a memory command from an authorised person; `undefined` means "not a command". */
  /** Returns the delivery decision a person just made, if the message is one and the sender is allowed to make it. */
  private deliveryCommand(trigger: Trigger): DeliveryCommand | undefined {
    if (!trigger.human) return undefined
    if (!allowedSender(this.store.settings(), trigger.actor)) return undefined
    return parseDeliveryCommand(trigger.text)
  }
  /** Answers a delivery decision out of band: the CLI call must not block the Engine's pass loop. */
  private async answerDelivery(trigger: Trigger, command: DeliveryCommand): Promise<void> {
    const channel = trigger.channel
    if (!channel) return
    const text = await runDeliveryCommand({ store: this.store, commands: this.commands }, command)
      .catch((error: unknown) => `处理失败：${error instanceof Error ? error.message : String(error)}`)
    this.outbox.send({ id: key('answer', trigger.id), channel, text, kind: 'reply' })
  }
  private statusReply(trigger: Trigger): string | undefined {
    if (!trigger.human) return undefined
    if (!allowedSender(this.store.settings(), trigger.actor)) return undefined
    const command = parseStatusCommand(trigger.text)
    return command ? runStatusCommand(this.store, command) : undefined
  }
  private memoryReply(trigger: Trigger): string | undefined {
    if (!trigger.human) return undefined
    if (!allowedSender(this.store.settings(), trigger.actor)) return undefined
    const command = parseMemoryCommand(trigger.text)
    return command ? runMemoryCommand(this.store, command) : undefined
  }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    this.sessions.install()
    this.executor.install()
    await this.sessions.ensure(this.masterId, this.machine.stateDir, 'dsh-superagent orchestrator', 'orchestrator')
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    this.#scheduled.push(startDailyBrief({
      commands: this.commands,
      store: this.store,
      stateDir: this.machine.stateDir,
      config: () => this.store.settings().notify,
      lifetime: this.stopped,
      log: message => console.error('[dsh-superagent] %s', message),
    }))
    // The watchdog closes the gap remote placement opens: a worker that stops producing events used to leave its
    // ticket at `working` forever, with nothing on this side noticing.
    this.#scheduled.push(startWatchdog({
      commands: this.commands,
      config: () => this.store.settings().notify,
      scan: () => this.sessions.stalledSessions(Date.now(), 30 * 60_000),
      block: (sessionId, minutes) => this.sessions.blockStalled(sessionId, minutes),
      lifetime: this.stopped,
      log: message => console.error('[dsh-superagent] %s', message),
    }))
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks,
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog() }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  readonly #scheduled: Array<() => void> = []
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; const passes = this.passes.stop(); for (const stop of this.#scheduled.splice(0)) stop(); this.stopped.abort()
    try {
      this.assessor.stop()
      const ids = [this.masterId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id))]
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      await this.executor.shutdown()
      this.executor.dispose()
      this.sessions.dispose()
      for (const dispose of this.disposers.reverse()) dispose()
      await this.ctx.sessionPersistence.flush()
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      this.setup.restore()
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
