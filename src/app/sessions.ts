/** Lifecycle, prompt/tool/skill decoration, message delivery, and budget retry tracking for orchestrator and worker DSH sessions. */
import { recall, recallCard } from './memory-store.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { dirname } from 'node:path'
import { z } from 'zod'
import { builtinStrategies, key, liveTicket, NoWorkerCapacityError, type StrategyFact, type Ticket } from '../core/index.ts'
import { mandateInstructions, ticketOfSession } from '../executor/dsh.ts'
import type { HealthEntry } from '../infra/health.ts'
import { AgentDelivery, messageId } from './delivery.ts'
import { RemoteAgent, type ExecutorAgent } from './remote-agent.ts'
import { activeWorkerRpcHub } from './worker-rpc.ts'
import type { Effects } from './effects.ts'
import type { Variable } from './execution-environment.ts'
import { RetryHealth } from './retry-health.ts'
import { initializeRoleModel } from './role-models.ts'
import { bundledSkills } from './skill-files.ts'
import { SKILL_PREFIX, type PromptVersion, type Prompts } from './prompts.ts'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'
import type { RegisterTool, Tool } from './tools/tool.ts'

/** Host dependencies used by `Sessions`. */
export interface SessionsHost {
  /** DSH Cordis context: sessions, agents, persistence, and their events. */
  readonly context: Context
  readonly store: Pick<Store, 'tickets' | 'settings' | 'get' | 'set' | 'keys'>
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'compose' | 'skills'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'idle' | 'pending'>
  /** The `models` health entry, which reports managed sessions waiting on a model-budget retry. */
  readonly health: HealthEntry
  readonly masterId: string
  readonly lifetime: AbortSignal
  closing(): boolean
  /** Execution environment variables for `ticket`, rendered into its worker's system prompt. */
  environment(ticket: Ticket): Variable[]
  /** Tools to register on the main Session (`ticket === undefined`) or on `ticket`'s worker Session. */
  tools(agent: Agent, ticket?: Ticket): Tool[]
}

/**
 * What Sessions registered for an agent it decorated: the releases of its prompt section, tools and skill scope, the scope
 * its skills are registered in, and the skills of one prompt revision; for a worker's subagent, only its tool limits.
 */
interface SessionBinding { disposers: (() => void)[]; scope?: Context; skills?: { revision: number; dispose: () => void }; subagent?: true }

/** The agent presets Executor Sessions and the main Session are created with, which the bundle's patch defines. */
export const WORKER_PRESET = 'dsh-superagent-worker', ROUTER_PRESET = 'dsh-superagent-router'
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** DSH's agent preset registry selected `agentPreset` for a Session. */
    'agent-preset/selected'(sessionId: string, agentPreset: string): void
  }
}
/**
 * The DSH tools an Executor Session works with: files, search, the shell and its jobs, the web, skills, its todo list and
 * subagents. It gets no other tool the profile has, whenever it was registered: none that asks or shows a person something,
 * changes the profile, schedules work or starts goals outside the worker slots, the pause and a person's hold, starts or
 * messages other Sessions, or edits documents.
 */
const WORK_TOOLS = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'pwsh', 'job_output', 'job_list', 'job_kill', 'web_search',
  'web_fetch', 'skill', 'todo_write', 'subagent', 'list_subagent_models', 'send_message', 'list_agents', 'interrupt_agent']
/** What the main Session is told when it would wait: what it waits for comes to it, and a waiting step holds back the next. */
const NO_WAIT = 'Reports, follow_up notices, new candidates and a background job\'s end with its output arrive by themselves as messages; '
  + 'end the turn instead of waiting for them.'
/** What a main Session under `standard` is told when its command would wait the shell's default. */
const DEFAULT_WAIT = 'This shell waits up to 60 seconds by default: pass timeoutMs of at most 30000, or run_in_background, '
  + 'as a waiting step holds back new candidates.'
/** `sleep` at a command position: the start, after ; & | ( { ! ` or a newline, or after a keyword or a command that runs it. */
/** How long `session.ensure` may take: it clones the ticket's repository on the worker. */
const PREPARE_RPC_TIMEOUT_MS = 300_000

const SLEEP = /(?:^|[;&|({!`\n]|\b(?:do|then|else|elif|if|while|until|time|exec|nohup|command|env)\s)\s*(?:\S*\/)?sleep\b/
/**
 * The main Session's guard: it refuses a bash command that runs sleep or asks to hold the step longer than 30 seconds, and a
 * job wait longer than 5 seconds. Under `standard`, as a main Session created before the router preset runs, the shell holds
 * a command 60 seconds and a job wait lasts 30 seconds by default, so a command needs a timeout or the background, and a
 * job wait its timeout; the router preset ends both after 5 seconds.
 */
function noWait({ name, arguments: input }: { name: string; arguments: unknown }, routed: () => boolean): string | undefined {
  const args = (input ?? {}) as { command?: unknown; timeoutMs?: unknown; run_in_background?: unknown; wait?: unknown; timeout_ms?: unknown }
  if (name === 'bash') {
    const sleeps = typeof args.command === 'string' && SLEEP.test(args.command)
    if (sleeps || typeof args.timeoutMs === 'number' && args.timeoutMs > 30_000) return NO_WAIT
    if (args.timeoutMs === undefined && args.run_in_background !== true && !routed()) return DEFAULT_WAIT
  }
  if (name === 'job_output' && args.wait === true && (typeof args.timeout_ms === 'number' ? args.timeout_ms > 5_000 : !routed())) return NO_WAIT
  return undefined
}

/**
 * Creates and decorates orchestrator and worker DSH `Agent` sessions with role models, system prompt sections from `Prompts`, runtime skills, and restricted tool sets.
 * `Runtime`, `DshExecutor`, `MasterAssessor`, `Settings`, and management routes/tools use it to ensure sessions, deliver deduplicated messages via `AgentDelivery`, and process ordered `relay` and `notice` effects.
 * Feeds session events into `RetryHealth` to report model budget waits on the `models` `HealthEntry`, and durably records which prompt revisions each session has worked under in `Store` (`KV.sessions.prompts`) to authorize prompt version reads.
 */
export class Sessions {
  private readonly agentDelivery: AgentDelivery
  /** Decorated agents mapped to their registered disposers and skill scope until the agent is disposed or `Sessions.dispose()` runs. */
  private readonly bindings = new Map<Agent, SessionBinding>()
  private readonly retryHealth = new RetryHealth()
  /** Sessions executing on a remote worker, keyed by session id; their DSH Agent lives in the worker process. */
  private readonly remote = new Map<string, RemoteAgent>()
  /**
   * Which assignment strategy placed a session, and the facts it used; the executor copies this into the ticket's basis
   * chain once the assignment starts (axiom 7 + axiom 5).
   */
  private readonly placements = new Map<string, { strategy: string; facts: StrategyFact[] }>()
  private readonly ctx: Context
  /** Registers ordered `relay` and `notice` effect handlers that deliver to the main Session. */
  constructor(private readonly host: SessionsHost) {
    this.ctx = host.context
    this.agentDelivery = new AgentDelivery(host.context)
    // Deliver relays and notices to the main Session in the order they were queued.
    host.effects.handle('relay', ({ text }, requestId) => this.prompt(host.masterId, requestId, text, 'steer'), { ordered: true })
    host.effects.handle('notice', ({ value, summary }, name) => this.inject(name, value, summary), { ordered: true })
  }
  /** Subscribes to host agent and session events so newly created sessions are decorated and model-budget retries are reflected in health. Call once at startup. */
  install(): void {
    const ctx = this.ctx
    ctx.on('agent/disposed', ({ agent }) => {
      this.release(agent)
      this.retryHealth.clear(agent.id); this.updateModelHealth()
    })
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id)
      const binding = agent && agent.session === session ? this.bindings.get(agent) : undefined
      if (!agent || !binding || binding.subagent) return
      this.retryHealth.observe(agent.id, event)
      this.updateModelHealth()
    })
    ctx.on('agent/created', async ({ agent }) => { await this.decorate(agent); return undefined })
    // Opening a Session in DSH's Web UI before its first turn may select the default preset for it: select ours again. After
    // its first turn DSH refuses any selection, which leaves it as it is.
    ctx.inject(['agentPresets'], child => {
      child.on('agent-preset/selected', (sessionId, preset) => {
        const ticketId = ticketOfSession(sessionId), agent = ctx.agents.get(sessionId as SessionId)
        const ours = sessionId === this.host.masterId ? ROUTER_PRESET : ticketId && this.host.store.tickets.get(ticketId) ? WORKER_PRESET : undefined
        if (!ours || preset === ours || !agent) return
        const presets = child.get('agentPresets') as { select(agent: Agent, preset: string): Promise<string> }
        presets.select(agent, ours).catch(() => {})
      })
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle' && !this.host.closing()) { this.retryHealth.clear(agent.id); this.updateModelHealth() }
    })
  }
  /** Resolves or creates session `id` in workspace `cwd`, initializes its role model, decorates it with prompts/skills/tools, sets `danger-full-access` permissions, and renames it to `title`. */
  async ensure(id: string, cwd: string, title: string, role: 'orchestrator' | 'worker', env?: Record<string, string>, forceLocal = false,
    prepareOverride?: string): Promise<ExecutorAgent> {
    // A host-maintenance Session must run in this process: it edits the router's own files, which a remote worker cannot reach.
    if (role === 'worker' && !forceLocal && this.host.store.settings().executor.placement === 'remote') return this.ensureRemote(id, cwd, title, env, prepareOverride)
    const ctx = this.ctx
    let result = await ctx.sessionController.resolveAgent(id as SessionId)
    if ('error' in result && result.error.code === 'session/not-found') {
      const workspace = await ctx.workspaceRegistry.create(cwd)
      // A Session keeps the preset it was created with, one of the bundle's own (cordis.patch.yml).
      await ctx.sessionController.create({ sessionId: id as SessionId, workspaceId: workspace.id,
        agentPreset: role === 'worker' ? WORKER_PRESET : ROUTER_PRESET })
      result = await ctx.sessionController.resolveAgent(id as SessionId)
    }
    if ('error' in result) throw result.error
    const settings = this.host.store.settings()
    await initializeRoleModel(ctx, result.agent, role === 'orchestrator' ? settings.eval.model : settings.executor.model)
    await this.decorate(result.agent)
    ctx.permissionPresets.set(result.agent.session, 'danger-full-access')
    await ctx.sessionController.rename({ sessionId: id as SessionId, title })
    // A local placement is a placement too: record it so a ticket's basis chain says why it did not go to a worker.
    this.placements.set(id, { strategy: 'local', facts: [{ name: 'placement', value: 'local' }] })
    return result.agent
  }
  /**
   * Creates (or reuses) the adapter for a Session that runs on a registered remote worker.
   * The worker owns the DSH Agent; this side keeps only a mirror that executor can drive.
   */
  /** `prepareOverride` is the task kind's say on the worker's prepare command: undefined sends the configured one, '' sends none. */
  private async ensureRemote(id: string, cwd: string, title: string, env?: Record<string, string>, prepareOverride?: string): Promise<RemoteAgent> {
    const existing = this.remote.get(id)
    if (existing) return existing
    const hub = activeWorkerRpcHub()
    if (!hub) throw new Error('executor.placement is "remote" but the worker RPC hub is not running')
    const settings = this.host.store.settings()
    // 公理 7：选哪台机器是一个可替换的决策层。默认 least-loaded 与旧行为一致；配置 tag-match 则先按能力标签过滤。
    const selection = settings.policy.strategies
    const strategy = builtinStrategies().assignment(selection.assignment)
    const candidates = hub.workers.map(worker => ({
      id: worker.workerId,
      tags: worker.tags ?? {},
      load: Math.max(worker.activeSessions, worker.assignedSessions),
      capacity: worker.maxConcurrentSessions,
    }))
    const choice = strategy.choose({ candidates, requiredTags: selection.requiredTags })
    const worker = choice.id === undefined ? undefined : hub.workers.find(candidate => candidate.workerId === choice.id)
    if (!worker) {
      const states = hub.workers.map(w => `${w.workerId}:${Math.max(w.activeSessions, w.assignedSessions)}/${w.maxConcurrentSessions}`)
      throw new NoWorkerCapacityError(states.join(','), states)
    }
    const agent = new RemoteAgent({
      workerId: worker.workerId,
      sessionId: id,
      call: (method, params) => hub.callWorker(worker.workerId, method, params),
      history: () => hub.eventsOf(id),
      onDispose: () => hub.release(worker.workerId),
      log: message => { this.ctx.logger.info('[dsh-superagent] %s', message) },
      // The worker registers an inert `orchestrator_report`; the call lands here and runs on the router.
      onReport: (args, callId) => this.reportRemote(id, args, callId),
    })
    // The worker has no PromptVersion of ours: the skill bodies travel with the request, so a remote worker
    // runs the same operational skills as an in-process one.
    const version = this.host.prompts.current()
    const specs = this.host.prompts.skills(version.config).map(([name, content]) => ({
      name: `${SKILL_PREFIX}${name}`,
      description: content.replace(/\s+/g, ' ').slice(0, 120) || 'Custom dsh-superagent operational skill.',
      content,
    }))
    // 这台机器的环境事实 + 对所有机器都成立的事实：worker 用它避开已知的坑（例如本机不能直连 GitHub）。
    const memory = [this.environmentCard(worker.name), this.knowledgeCard(title)].filter(part => part.length > 0).join('\n\n')
    // 先占位：ensure 要跑几十秒的 clone，期间并发的派发必须看得到这次占用。
    hub.reserve(worker.workerId)
    // Preparing a workspace clones a repository, so it outlives the default control-plane timeout.
    await hub.callWorker(worker.workerId, 'session.ensure', {
      sessionId: id, cwd, title, name: title, promptText: '', skills: specs, model: settings.executor.model ?? null,
      ...(prepareOverride === undefined ? (settings.executor.prepare ? { prepare: settings.executor.prepare } : {}) : (prepareOverride ? { prepare: prepareOverride } : {})),
      // The worker has no Source of its own: the ticket's execution environment describes the router's source.
      ...(env && Object.keys(env).length > 0 ? { env } : {}),
      ...(memory ? { memory } : {}),
      // The worker has no PromptVersion of ours: send the composed worker prompt so remote sessions follow the same rules.
      policy: this.host.prompts.compose(version.config, 'worker'),
      // 公理 4：router 派出的会话归 router 所有，worker 本地只读围观，不允许在旁边插话。
      owner: 'router',
    }, PREPARE_RPC_TIMEOUT_MS).catch(error => {
      hub.release(worker.workerId)
      hub.settle(worker.workerId)
      throw error
    })
    hub.settle(worker.workerId)
    this.placements.set(id, { strategy: strategy.id, facts: choice.facts })
    this.remote.set(id, agent)
    this.ctx.logger.info('[dsh-superagent] session %s runs on remote worker %s', id, worker.workerId)
    return agent
  }
  /**
   * Renders the environment facts that apply to `workerId`: its own probes plus entries that hold for every worker.
   * The card is bounded so a chatty worker cannot crowd the task out of the prompt.
   */
  private environmentCard(workerId: string): string {
    const entries = this.host.store.memories.list({ scope: 'env', owner: workerId, limit: 40 })
    return recallCard(entries, 1000)
  }

  /**
   * What we already know about this kind of task, for the worker to read before it starts.
   *
   * The query is the ticket title — the closest thing to a stated intent that exists before the worker runs. Env facts
   * are excluded on purpose: they describe *a machine*, and only the machine that will run the task should see them.
   */
  private knowledgeCard(query: string): string {
    const trimmed = query.trim()
    if (trimmed.length === 0) return ''
    const entries = recall(this.host.store, trimmed, { limit: 8 }).filter(entry => entry.scope !== 'env')
    return recallCard(entries, 900)
  }
  /** Which strategy placed a session and what it knew when it did; the executor records it once the assignment starts. */
  placement(sessionId: string): { strategy: string; facts: StrategyFact[] } | undefined { return this.placements.get(sessionId) }
  /** Feeds events pushed by the worker hub into the matching remote adapter. */
  deliverRemoteEvents(sessionId: string, events: readonly unknown[]): void {
    this.remote.get(sessionId)?.applyEvents(events)
  }
  /**
   * Runs an `orchestrator_report` the worker's Session made: the tool exists on the worker only so the call shows up
   * in the event stream, and the ticket-side effect belongs here, where the ticket, the store and the notices live.
   */
  /**
   * Remote Sessions that have stopped producing events for longer than `quietMs`.
   * The watchdog reports them to a person and, past the longer limit, blocks the ticket itself.
   */
  stalledSessions(now: number, quietMs: number): Array<{ sessionId: string; ticketId: string; title: string; idleMs: number }> {
    const stalled: Array<{ sessionId: string; ticketId: string; title: string; idleMs: number }> = []
    for (const [sessionId, agent] of this.remote) {
      const idleMs = now - agent.lastEventAt
      if (idleMs < quietMs) continue
      const ticketId = ticketOfSession(sessionId)
      const ticket = ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
      if (!ticket || ticket.ended) continue
      stalled.push({ sessionId, ticketId: ticket.id, title: ticket.title, idleMs })
    }
    return stalled
  }

  /** Ends the sessions a disconnected worker was holding; their tickets cannot finish on their own. */
  blockWorkerLost(sessionId: string): void {
    this.reportRemote(sessionId, { state: 'blocked', summary: '执行这台任务的 worker 断开了连接，任务随之中断。你可以让我重跑，或先检查那台机器。' }, `worker-lost:${sessionId}`)
  }

  /** Blocks a stalled ticket through the same report path a worker's own `blocked` report takes. */
  blockStalled(sessionId: string, minutes: number): void {
    this.reportRemote(sessionId, { state: 'blocked', summary: `超过 ${minutes} 分钟没有任何进展，看门狗已标记阻塞；请检查 worker 状态或重新安排这项任务。` }, `watchdog:${sessionId}:${minutes}`)
  }

  private reportRemote(sessionId: string, raw: unknown, callId: string): void {
    const ticketId = ticketOfSession(sessionId)
    const ticket = ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
    if (!ticket) {
      console.error('[dsh-superagent] 远程会话 %s 的 %s 找不到票据，已忽略', sessionId, callId)
      return
    }
    const report = this.host.tools({ id: sessionId } as unknown as Agent, ticket).find(entry => entry.name === 'orchestrator_report')
    if (!report) return
    void Promise.resolve(report.schema.safeParseAsync(raw)).then(
      parsed => {
        if (!parsed.success) {
          console.error('[dsh-superagent] 远程会话 %s 的报告参数无效: %s', sessionId, JSON.stringify(parsed.error.issues.slice(0, 3)))
          return
        }
        void report.execute(parsed.data as never, this.host.lifetime).catch((error: unknown) => {
          console.error('[dsh-superagent] 远程会话 %s 的报告执行失败: %s', sessionId, String(error))
        })
      },
      (error: unknown) => console.error('[dsh-superagent] 远程会话报告解析失败: %s', String(error)),
    )
  }
  /**
   * Bridges a remote Session's status transition onto DSH's `agent/status`, which the executor listens to:
   * without it a remote worker would never look idle and its ticket would never be assessed.
   */
  publishRemoteStatus(sessionId: string): void {
    const agent = this.remote.get(sessionId)
    if (!agent || agent.lastPublished === agent.status) return
    agent.lastPublished = agent.status
    this.ctx.logger.info('[dsh-superagent] remote session %s status %s', sessionId, agent.status)
    this.ctx.emit('agent/status', { agent: agent as unknown as Agent, status: agent.status as 'idle' | 'running' })
  }
  /** Returns whether `sessionId` already holds the message delivered under `requestId`, or `false` if the session does not exist. */
  async holds(sessionId: string, requestId: string): Promise<boolean> {
    const remote = this.remote.get(sessionId)
    if (remote) return remote.holds(requestId)
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    return !('error' in result) && await this.agentDelivery.holds(result.agent, key(requestId))
  }
  /** Deliver a message once per request id: to the next turn, the current one, or `inject`ed with its label without waking the agent. */
  async prompt(sessionId: string, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, authorize?: () => void,
    accepted?: () => void): Promise<void> {
    const remote = this.remote.get(sessionId)
    if (remote) {
      authorize?.()
      remote.markDelivered(requestId)
      await remote.prompt(requestId, text, mode)
      accepted?.()
      return
    }
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    if ('error' in result) throw result.error
    await this.agentDelivery.send(result.agent, key(requestId), text, mode, this.host.lifetime, authorize, accepted)
  }
  /** The id of the message `prompt` delivers under `requestId`, which DSH's inbox events name it by. */
  promptedId(requestId: string): MessageId { return messageId(key(requestId)) }
  /** Enqueues a steering relay to the main Session; relays are durable and retried by `Effects` until delivered, at most once per `requestId`. */
  relay(requestId: string, text: string): void { this.host.effects.enqueue('relay', requestId, { text }) }
  /** Enqueues a durable background notice for injection into the main Session; a new notice with the same `name` replaces a still-waiting notice of that `name`. */
  notify(name: string, value: Record<string, unknown>, summary: string): void { this.host.effects.enqueue('notice', name, { value, summary }) }
  /** Waits for currently runnable `notice` effects to settle and returns `'injected'` if notice `name` has reached the main Session or `'pending'` if it is still queued. */
  async delivery(name: string): Promise<'injected' | 'pending'> {
    await this.host.effects.idle('notice')
    return this.host.effects.pending('notice', name) ? 'pending' : 'injected'
  }
  /** Injects a notice into the main Session without waking it; no-op if the main Session does not exist yet. */
  private async inject(name: string, value: Record<string, unknown>, summary: string): Promise<void> {
    const resolved = await this.ctx.sessionController.resolveAgent(this.host.masterId as SessionId)
    if ('error' in resolved) return
    // Deduplicate by notice name and payload hash so retries are idempotent while updated payloads still deliver.
    const text = JSON.stringify(value)
    await this.agentDelivery.send(resolved.agent, `notice:${name}:${key(text)}`, text, { inject: summary }, this.host.lifetime)
  }
  /** Returns the current prompt revision, the active prompt revision of each loaded Session, and whether the main Session still has a pending `'prompts'` notice. */
  status() {
    const { store, prompts, effects } = this.host
    const sessions = store.keys(KV.sessions.prompts).flatMap(name => {
      const sessionId = name.slice(KV.sessions.prompts.prefix.length), revision = store.get(name)?.at(-1)
      return this.ctx.agents.get(sessionId as SessionId) && revision !== undefined ? [{ sessionId, revision }] : []
    })
    return { revision: prompts.current().revision, sessions, notificationPending: effects.pending('notice', 'prompts') }
  }
  /** Returns the prompt version a Session runs under (the one bound on its latest model request, or the current version). */
  promptVersion(sessionId: string): PromptVersion {
    const revision = this.host.store.get(KV.sessions.prompts(sessionId))?.at(-1)
    return revision === undefined ? this.host.prompts.current() : this.host.prompts.version(revision)
  }
  /** Whether a Session is authorized to read `revision` (its active revision or any revision it previously ran under). */
  mayRead(sessionId: string, revision: number): boolean {
    return revision === this.promptVersion(sessionId).revision || (this.host.store.get(KV.sessions.prompts(sessionId)) ?? []).includes(revision)
  }
  /** Returns a tool registrar for `agent` that renders tool output as JSON text and attaches `output.image` as an image when present. */
  private registerTool(agent: Agent, binding: SessionBinding): RegisterTool {
    return (name, description, schema, execute) => {
      binding.disposers.push(agent.ctx.tools.register({ name, description, parameters: z.toJSONSchema(schema),
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => {
          const text = { type: 'text' as const, text: JSON.stringify(value) }
          const image = value && typeof value === 'object' && 'image' in value ? (value as { image: never }).image : undefined
          return image ? [text, { type: 'image' as const, attachment: image }] : [text]
        } },
        execute: (args, execution) => execute(schema.parse(args), execution.signal) }))
    }
  }
  /** Returns `sessionId`'s active model-budget retry state (`{ model_retry }`) for status listings, or `{}` when not waiting on one. */
  modelRetry(sessionId: string | undefined) {
    const retry = sessionId ? this.retryHealth.get(sessionId) : undefined
    return retry ? { model_retry: retry } : {}
  }
  private updateModelHealth(): void {
    const retries = this.retryHealth.list()
    this.host.health.set(retries.length
      ? { state: 'error', detail: retries.slice(0, 5).map(item => `${item.sessionId}: ${item.provider} is over its model budget; retried ${item.attempts} times, waiting since ${item.since}; the model and retry policy are unchanged`).join('; ') + (retries.length > 5 ? `; ${retries.length - 5} more Sessions` : ''), at: retries.at(-1)!.lastAt }
      : { state: 'ready', detail: 'No managed Session is waiting on a model budget retry' })
  }
  private ticketOf(agent: Agent): Ticket | undefined {
    const ticketId = ticketOfSession(agent.id)
    return ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
  }
  private async decorate(agent: Agent): Promise<void> {
    if (this.bindings.has(agent)) return
    const host = this.host
    const master = agent.id === host.masterId
    const ticket = master ? undefined : this.ticketOf(agent)
    if (!master && !ticket) { this.limitSubagent(agent); return }
    const binding: SessionBinding = { disposers: [] }
    this.bindings.set(agent, binding)
    this.retryHealth.restore(agent.id, agent.session.snapshotEvents())
    if (agent.status === 'idle') this.retryHealth.clear(agent.id)
    this.updateModelHealth()
    // Disable variable interpolation so literal ${{ ... }} expressions in team prompts are preserved.
    binding.disposers.push(agent.ctx.systemPrompt.section({ name: 'dsh-superagent-policy', order: 9999, interpolate: false, text: context => {
      const version = this.promptFor(agent, context.signal !== undefined)
      const current = ticket && host.store.tickets.get(ticket.id)
      const composed = host.prompts.compose(version.config, master ? 'orchestrator' : 'worker', current ? host.environment(current) : undefined)
      return `[dsh-superagent prompt revision ${version.revision}]\n${composed}\n${current ? mandateInstructions(current.mandate) : ''}`
    }, ...(master ? { complete: true } : {}) }))
    // A recreated skill scope (e.g. after the skills service restarts) starts empty, so reset `binding.skills` before rebinding.
    const skillScope = agent.ctx.inject(['skills'], scope => {
      binding.scope = scope
      binding.skills = undefined
      this.bindSkills(binding, host.prompts.current())
    })
    binding.disposers.push(() => { skillScope.dispose().catch((error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release a skill scope: %s', String(error)) }) })
    await skillScope
    // Bail out if the agent was disposed while awaiting the skill scope.
    if (this.bindings.get(agent) !== binding) return
    const register = this.registerTool(agent, binding)
    for (const tool of host.tools(agent, ticket)) register(tool.name, tool.description, tool.schema, tool.execute)
    if (master) {
      binding.disposers.push(agent.ctx.tools.restrict({ allow: ['skill', 'bash', 'read', 'read_image', 'job_output', 'job_list', 'job_kill'] }),
        agent.ctx.tools.guard(execution => noWait(execution, () => this.routed(agent))))
    } else {
      // An Executor Session keeps the profile's work tools it has, which DSH requires to be known; its own tools are not masked.
      binding.disposers.push(...this.workOnly(agent, ticket!.id))
    }
  }
  /**
   * Whether a Session runs the router preset: as DSH's preset registry last selected it, read through the session projection
   * on a DSH whose registry has no `presetForSession`, else as it was created; `standard`, the safer caps, when unreadable.
   */
  private routed(agent: Agent): boolean {
    try {
      const presets = this.ctx.get('agentPresets') as { presetForSession?: (session: Agent['session']) => string | null } | undefined
      const projections = this.ctx.get('sessionProjections') as { stateOf?: (session: Agent['session'], key: string) => unknown } | undefined
      const selected = typeof presets?.presetForSession === 'function' ? presets.presetForSession(agent.session)
        : projections?.stateOf?.(agent.session, 'agentPreset')
      return (selected ?? agent.session.header.agentPreset) === ROUTER_PRESET
    } catch { return false }
  }
  /**
   * An Executor Session's tools: only the profile's work tools, which DSH requires to be known, and none once its ticket
   * ended. A failed or blocked worker keeps its tools, so a person may continue it in its Session; only automated input waits
   * (see the executor). Read inherited tools through the parent scope, which includes the preset's tools. The global view
   * misses preset tools; the agent's own view also includes local tools such as subagent, which restrict refuses to name.
   */
  private workOnly(agent: Agent, ticketId: string): (() => void)[] {
    const store = this.host.store
    const parent = scopeParentOf(agent)
    const allow = WORK_TOOLS.filter(name => agent.ctx.tools.get(name, parent))
    return [agent.ctx.tools.restrict({ allow }), agent.ctx.tools.guard(() => {
      const current = store.tickets.get(ticketId)
      return !current || !liveTicket(current) ? 'Ticket ended; new work needs a new authorized ticket' : undefined
    })]
  }
  /**
   * A subagent of an Executor Session, or of one of its subagents, which runs under DSH's `standard` preset with the worker's
   * permissions, gets the same work tools as the worker, and none once the worker's ticket ended. Any other agent is left as
   * it is.
   */
  private limitSubagent(agent: Agent): void {
    let parent = agent.session.header.parentSession
    // Up the subagents' parents to the worker, which are loaded while their subagents run.
    for (let depth = 0; parent !== undefined && ticketOfSession(parent) === undefined && depth < 8; depth++) {
      parent = this.ctx.agents.get(parent)?.session.header.parentSession
    }
    const ticketId = parent === undefined ? undefined : ticketOfSession(parent)
    if (ticketId === undefined || !this.host.store.tickets.get(ticketId)) return
    this.bindings.set(agent, { disposers: this.workOnly(agent, ticketId), subagent: true })
  }
  /** Register the skills of a prompt version in the agent's skill scope, in place of an earlier version's. */
  private bindSkills(binding: SessionBinding, version: PromptVersion): void {
    const { scope, skills: previous } = binding
    if (!scope || previous?.revision === version.revision) return
    previous?.dispose()
    const disposers: (() => void)[] = []
    for (const [name, content] of this.host.prompts.skills(version.config)) {
      const bundled = name === 'feishu' || name === 'github' ? bundledSkills[name] : undefined
      const body = version.config.skills[name] ?? ''
      const description = bundled?.description ?? (body.replace(/\s+/g, ' ').slice(0, 120) || 'Custom dsh-superagent operational skill.')
      disposers.push(scope.skills.register({ name: `${SKILL_PREFIX}${name}`, description, content, source: 'runtime',
        ...(bundled ? { resourceBase: { kind: 'directory' as const, path: dirname(bundled.path) } } : {}) }))
    }
    binding.skills = { revision: version.revision, dispose: () => { disposers.forEach(dispose => dispose()) } }
  }
  /** Return the current prompt version, updating the agent's skills and recording the revision in Store when bound to a model request. */
  private promptFor(agent: Agent, bind: boolean): PromptVersion {
    const version = this.host.prompts.current()
    if (!bind) return version
    const binding = this.bindings.get(agent)
    if (binding) this.bindSkills(binding, version)
    const { store } = this.host
    const revisions = store.get(KV.sessions.prompts(agent.id)) ?? []
    const bound = [...revisions.filter(revision => revision !== version.revision), version.revision]
    if (revisions.at(-1) !== version.revision) store.set(KV.sessions.prompts(agent.id), bound)
    return version
  }
  /** Releases registrations for `agent` in reverse order (LIFO); disposing its skill scope releases its skills as well. */
  private release(agent: Agent): void {
    const binding = this.bindings.get(agent)
    if (!binding) return
    this.bindings.delete(agent)
    binding.skills?.dispose()
    for (const dispose of binding.disposers.splice(0).reverse()) {
      try { dispose() } catch (error) { this.ctx.logger.warn('dsh-superagent could not release what it registered for a Session: %s', String(error)) }
    }
  }
  /** Releases prompt sections, skills, and tools registered by `Sessions` across all decorated agents. */
  dispose(): void { for (const agent of [...this.bindings.keys()]) this.release(agent) }
}
