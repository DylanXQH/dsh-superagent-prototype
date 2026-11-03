/** Loopback-only management HTTP routes with same-origin enforcement for the web panel. */
import { recall, remember, retract } from './memory-store.ts'
import { episodeStats, listEpisodes, readEpisode } from './episodes.ts'
import { renderMemoryPage } from './memory-page.ts'
import { baselineFindings, canaryFindings } from './baseline.ts'
import { appendAudit } from './audit.ts'
import { KV } from '../kv.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { key } from '../core/ids.ts'
import { THREAD_FILTERS, TICKET_FILTERS, type Api, type ApiResponse, type RouteParams } from './api.ts'
import { sourceSkills } from './context.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { PromptConflict, SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInParts, defaultPrompts, savePrompts, type Prompts }
  from './prompts.ts'
import { policyVersion } from '../policy.ts'
import { PromptConfigSchema } from './prompts.ts'
import { describeBlocking, scanPromptChange, scanText } from './scan.ts'
import { SettingsConflict, type Settings } from './settings.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import { UserError, type EngineForPeople, type Ticket } from '../core/index.ts'
import type { Deployment, Machine } from '../deployment.ts'
import type { DshExecutor } from '../executor/dsh.ts'
import type { Health } from '../sources/host.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Sessions } from './sessions.ts'
import { activeWorkerRpcHub } from './worker-rpc.ts'
import { eventLevel } from '@dsh-superagent/rpc'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'
import type { LinkTarget, ViewHost } from './views/records.ts'
import type { Variable } from './execution-environment.ts'
import { policyHistory } from './settings-history.ts'
import { overview } from './views/overview.ts'
import { settingsView } from './views/settings.ts'
import { sourcesStatus, type SetupState } from './views/sources.ts'
import { decisionList, search, threadDetail, threadList } from './views/threads.ts'
import { executorLoad, ticketDetail, ticketList } from './views/tickets.ts'

export interface HttpHost {
  readonly store: Store
  /** Feishu message links resolved since startup, used by search to match AppLink URLs. */
  readonly sourceLinks: Pick<TextCache, 'entries'>
  readonly sources: SourceRegistry
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'preview' | 'save' | 'defaultChanged'>
  readonly sessions: Pick<Sessions, 'status' | 'notify' | 'delivery' | 'ensure' | 'prompt'>
  readonly settings: Pick<Settings, 'view' | 'save' | 'pause' | 'sync' | 'refreshLabels'>
  readonly engine: EngineForPeople
  readonly executor: Pick<DshExecutor, 'activeCount'>
  readonly health: Record<string, Health>
  readonly machine: Machine
  readonly masterId: string
  /** Resolves once startup finishes or setup determines what is still missing. */
  readonly ready: Promise<void>
  /** Resolved deployment; throws if read while waiting for setup (`!configured()`). */
  readonly deployment: Deployment
  readonly setupProblem?: SetupProblem | undefined
  readonly feishuProblem?: SetupProblem | undefined
  configured(): boolean
  links(): LinkTarget
  ticketEnvironment(ticket: Ticket): Variable[]
  checkSetup(): void
  requestPass(): void
  models(): Promise<ModelCatalog>
}
/**
 * Represents a client-facing 400 or 404 error raised during management route parsing or lookup.
 * Route handlers throw it when request bodies are malformed or target records are missing, and registerHttp serializes its status and message in the HTTP response.
 */
class RouteError extends Error { constructor(readonly status: 400 | 404, message: string) { super(message) } }
async function readBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > maxBytes) throw new RouteError(400, `Request exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new RouteError(400, 'The request body is not JSON') }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value))
}
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  return req.headers['x-orchestrator-request'] === '1' && (req.headers.origin === undefined || req.headers.origin === `http://${host}`)
}
/** Maps errors to HTTP status codes and structured payloads that the panel localizes in the interface language. */
function failure(error: unknown): [number, Record<string, unknown>] {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
    return [400, { error: `Invalid settings: ${issues.map(issue => issue.path).join(', ')}`, issues }]
  }
  if (error instanceof SetupError) return [400, { error: error.message, setup: error.problem }]
  if (error instanceof RouteError) return [error.status, { error: error.message }]
  if (error instanceof UserError) return [error.missing ? 404 : 400, { error: error.message, code: error.code, values: error.values }]
  if (error instanceof SettingsConflict || error instanceof PromptConflict) return [409, { error: error.message }]
  return [500, { error: error instanceof Error ? error.message : String(error) }]
}

function machineView({ stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }: Machine) {
  return { stateDir, promptMaxChars: promptMaxChars.get(), admissionContextMaxPages: admissionContextMaxPages.get(),
    admissionContextTimeoutMs: admissionContextTimeoutMs.get() }
}
function setupView(runtime: HttpHost) {
  const resolved = runtime.configured() ? runtime.deployment : undefined
  return {
    machine: machineView(runtime.machine), problem: runtime.setupProblem ?? null, feishuProblem: runtime.feishuProblem ?? null,
    accounts: resolved ? { repository: resolved.repository, agent: resolved.github.login, feishu: resolved.feishu ? { appId: resolved.feishu.appId, brand: resolved.feishu.brand, botId: resolved.feishu.botId, name: resolved.feishu.name } : null } : null,
  }
}
/** Build the `/orchestrator/api/state` response consumed by the management panel and `scripts/dsh-superagent status` (`docs/006-deployment.md`). */
export function stateView(runtime: HttpHost) {
  const settings = runtime.store.settings()
  return { setup: setupView(runtime), load: { ...executorLoad(runtime.store, runtime.executor.activeCount()),
    maxWorkers: settings.executor.maxWorkers },
    masterId: runtime.masterId, paused: settings.paused, health: runtime.health }
}
const views = (runtime: HttpHost): ViewHost => ({ store: runtime.store, sources: runtime.sources, links: runtime.links() })
const setupState = (runtime: HttpHost): SetupState => ({ deployment: runtime.configured() ? runtime.deployment : undefined,
  problem: runtime.setupProblem, feishuProblem: runtime.feishuProblem })
export type StateView = ReturnType<typeof stateView>
/** Builds a ticket's detail view; `environment` is empty while waiting for setup because it requires the resolved deployment. */
function ticketPage(runtime: HttpHost, id: string) {
  const detail = ticketDetail(views(runtime), id), ticket = runtime.store.tickets.get(id)
  if (!detail || !ticket) throw new RouteError(404, 'Ticket not found')
  return { ...detail, environment: runtime.configured() ? runtime.ticketEnvironment(ticket) : [] }
}
export type TicketPageView = ReturnType<typeof ticketPage>
function promptsView(runtime: HttpHost, revision: number | undefined, offset: number) {
  const current = runtime.prompts.current()
  const shown = revision === undefined || revision === current.revision ? current : runtime.prompts.version(revision)
  // Each built-in part with the key of its text, which an override records as its base, and for the overrides shown whose
  // built-in text changed since, the text they were edited from when known.
  const parts = Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) }))
  return { masterId: runtime.masterId, current: shown, defaults: defaultPrompts(), sections: TEAM_SECTIONS, skillName: SKILL_NAME.source,
    builtin: Object.keys(sourceSkills), skillPrefix: SKILL_PREFIX, parts, defaultChanged: runtime.prompts.defaultChanged(shown.config),
    ...runtime.sessions.status(), ...runtime.prompts.history(offset) }
}
export type PromptsView = ReturnType<typeof promptsView>

interface Input<K extends keyof Api> {
  params: RouteParams<K>; query: Record<string, string>; body: (maxBytes?: number) => Promise<unknown>
}
type Routes = { [K in keyof Api]: (input: Input<K>) => ApiResponse<K> | Promise<ApiResponse<K>> }
const offset = z.coerce.number().int().nonnegative().catch(0)
const limit = (fallback: number, max: number) => z.coerce.number().int().positive().catch(fallback).transform(value => Math.min(max, value))
const TicketsQuery = z.object({ state: z.enum(TICKET_FILTERS).catch('open'), offset, limit: limit(20, 1000) })
const ThreadsQuery = z.object({ filter: z.enum(THREAD_FILTERS).catch('subscribed'), offset, limit: limit(20, 1000) })
const ThreadQuery = z.object({ limit: limit(50, 100), before: z.string().optional(), around: z.string().optional() })
const DecisionsQuery = z.object({ kind: z.string().default(''), window: z.literal('24h').optional().catch(undefined), offset,
  limit: limit(30, 200) })
const count = z.coerce.number().int().nonnegative()
const PromptsQuery = z.object({ revision: count.optional(), offset: count.default(0) })
const SourceBlock = z.templateLiteral(['source:', z.string().regex(/^[a-z][a-z0-9-]*$/)])
const SettingsBlockSchema = z.union([z.enum(['policy', 'eval', 'executor', 'notify']), SourceBlock])
const SaveRequest = z.object({ value: z.unknown(), revision: z.number().int().nonnegative() })

function routes(runtime: HttpHost): Routes {
  const { store } = runtime
  const RememberRequest = z.object({ scope: z.enum(['user', 'project', 'env']), kind: z.enum(['preference', 'convention', 'fact', 'procedure']),
  key: z.string().min(1).max(120), value: z.string().min(1).max(2000), confidence: z.number().min(0).max(1).optional(),
  source: z.enum(['user-said', 'observed-trusted', 'observed-untrusted', 'inferred']).optional(), evidence: z.array(z.string().max(200)).max(20).optional(),
  ttlDays: z.number().int().min(1).max(3650).optional() }).strict()
const ticket = (id: string) => { if (!store.tickets.get(id)) throw new RouteError(404, 'Ticket not found'); return id }
  const promptBody = (input: { body: (maxBytes?: number) => Promise<unknown> }) => input.body(4 * runtime.machine.promptMaxChars.get() + 4096)
  return {
    'GET state': () => stateView(runtime),
    'GET rpc/workers': () => {
      const hub = activeWorkerRpcHub()
      if (!hub) throw new RouteError(503, 'The worker RPC hub is not running')
      return { workers: hub.workers, listeningPort: hub.listeningPort }
    },
    // 按需回拉：router 只落盘 L1，L2 只在内存，L3 从不外发；需要还原「当时到底
    // 发生了什么」时才向会话所在 worker 拉取（公理 3 的补偿通道，不做周期拉取）。
    'GET rpc/sessions/:id/events': async input => {
      const hub = activeWorkerRpcHub()
      if (!hub) throw new RouteError(503, 'The worker RPC hub is not running')
      const query = z.object({
        fromSeq: count.optional(),
        toSeq: count.optional(),
        limit: count.optional(),
        types: z.string().optional(),
      }).parse(input.query)
      const result = await hub.pullEvents(input.params.id, {
        ...(query.fromSeq === undefined ? {} : { fromSeq: query.fromSeq }),
        ...(query.toSeq === undefined ? {} : { toSeq: query.toSeq }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.types === undefined || query.types.length === 0
          ? {}
          : { types: query.types.split(',').map(part => part.trim()).filter(Boolean) }),
      })
      return {
        sessionId: result.sessionId,
        hasMore: result.hasMore,
        lastSeq: result.lastSeq,
        events: result.events.map(event => ({
          seq: event.seq,
          ts: event.ts,
          type: event.type,
          level: eventLevel(event),
          event: event.data,
        })),
      }
    },
    'POST rpc/call': async input => {
      const hub = activeWorkerRpcHub()
      if (!hub) throw new RouteError(503, 'The worker RPC hub is not running')
      const request = z.object({ workerId: z.string(), method: z.string(), params: z.unknown().default({}) }).parse(await input.body())
      return { ok: true, result: await hub.callWorker(request.workerId, request.method, request.params) }
    },
    // Temporary probe (removed once the executor drives remote Sessions end to end).
    'POST rpc/session': async input => {
      const request = z.object({ sessionId: z.string(), cwd: z.string(), title: z.string(), text: z.string(),
        env: z.record(z.string(), z.string()).optional() }).parse(await input.body())
      const agent = await runtime.sessions.ensure(request.sessionId, request.cwd, request.title, 'worker', request.env)
      await runtime.sessions.prompt(request.sessionId, `probe-${Date.now()}`, request.text, 'queue')
      return { ok: true, id: agent.id, status: agent.status }
    },
    // Temporary probe: 注入一条真实 Trigger，验证 Source→Eval→Ticket→Executor→远端 worker 的完整链路。
    // 验完即删（真实票据只能由 Source 产生）。
    'POST rpc/trigger': async input => {
      const request = z.object({ text: z.string(), threadId: z.string().default('999'), actor: z.string().default('DylanXQH'),
        addressed: z.enum(['mention', 'direct']).optional() }).parse(await input.body())
      const result = runtime.engine.receive({
        id: key('probe-trigger', String(Date.now())),
        source: 'github',
        threads: [{ source: 'github', id: request.threadId }],
        actor: { source: 'github', id: request.actor },
        human: true,
        ...(request.addressed ? { addressed: request.addressed } : {}),
        at: new Date().toISOString(),
        text: request.text,
        meta: { number: Number(request.threadId), isPr: false, kind: 'issue' },
      })
      runtime.requestPass()
      return { ok: true, result }
    },
    'GET overview': () => overview(views(runtime), runtime.health, policyVersion(store.settings()),
      executorLoad(store, runtime.executor.activeCount()), runtime.setupProblem ?? runtime.feishuProblem),
    'GET search': ({ query }) => search(views(runtime), query.q ?? '', runtime.sourceLinks),
    'GET sources': () => sourcesStatus(views(runtime), runtime.health, setupState(runtime)),
    'GET settings': () => settingsView(store, runtime.sources, runtime.health, setupState(runtime), runtime.machine.stateDir),
    'POST sources/:id/labels': ({ params }) => runtime.settings.refreshLabels(params.id),
    'GET threads': ({ query }) => {
      const { filter, offset, limit } = ThreadsQuery.parse(query)
      return threadList(views(runtime), filter, offset, limit)
    },
    'GET threads/:key': ({ params, query }) => {
      const { limit, before, around } = ThreadQuery.parse(query)
      const detail = threadDetail(views(runtime), params.key, before, limit, around)
      if (!detail) throw new RouteError(404, 'Thread not found')
      return detail
    },
    'POST threads/:key/unsubscribe': async ({ params }) => {
      const removed = runtime.engine.unsubscribe(params.key)
      return { removed, thread: params.key, context_delivery: await runtime.sessions.delivery(`subscription:${params.key}`) }
    },
    'POST triggers/:id/requeue': ({ params }) => {
      const queued = runtime.engine.reevaluate(params.id)
      runtime.requestPass()
      return { queued }
    },
    'GET decisions': ({ query }) => {
      const { kind, window, offset, limit } = DecisionsQuery.parse(query)
      const since = window ? new Date(Date.now() - 86_400_000).toISOString() : ''
      return decisionList(views(runtime), kind.split(',').filter(Boolean), offset, limit, since)
    },
    'POST decisions/:id/dismiss': ({ params }) => { runtime.engine.dismiss(params.id); return { dismissed: true } },
    'GET tickets': ({ query }) => {
      const { state, offset, limit } = TicketsQuery.parse(query)
      return ticketList(views(runtime), state, offset, limit)
    },
    'GET tickets/:id': ({ params }) => ticketPage(runtime, params.id),
    'POST memory/scan': async input => {
      const request = z.object({ text: z.string(), where: z.string().optional() }).parse(await input.body())
      return { findings: scanText(request.text, request.where ?? 'text') }
    },
    'GET memory': ({ query }) => {
      const limit = Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 500)
      const q = String(query.q ?? '')
      const scope = query.scope === 'user' || query.scope === 'project' || query.scope === 'env' ? query.scope as 'user' | 'project' | 'env' : undefined
      const items = q ? recall(store, q, { ...(scope ? { scope } : {}), limit }) : store.memories.list({ ...(scope ? { scope } : {}), limit })
      return { items, total: store.memories.history(1000).length }
    },
    'GET memory/history': ({ query }) => ({ items: store.memories.history(Math.min(Number(query.limit ?? 200) || 200, 1000)) }),
    'POST memory': async ({ body }) => {
      const input = RememberRequest.parse(await body())
      const { memory, superseded } = remember(store, input)
      return { saved: true, memory, ...(superseded ? { superseded: superseded.id } : {}) }
    },
    'POST memory/:id/retract': ({ params }) => ({ retracted: true, memory: retract(store, params.id) }),
    'GET episodes': ({ query }) => {
      const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200)
      return { items: listEpisodes(store, limit), total: (store.get(KV.episodes.index) ?? []).length }
    },
    'GET episodes/stats': () => episodeStats(store),
    'GET episodes/:id': ({ params }) => {
      const episode = readEpisode(store, params.id)
      if (!episode) throw new RouteError(404, 'Episode not found')
      return episode
    },
    'POST tickets/:id/retry': ({ params }) => { const id = ticket(params.id); runtime.engine.retryTicket(id); return { retried: true } },
    'POST tickets/:id/stop': ({ params }) => { const id = ticket(params.id); runtime.engine.stopTicket(id); return { stopped: true } },
    'POST executor/pause': async ({ body }) => runtime.settings.pause(z.object({ paused: z.boolean() }).parse(await body()).paused, 'panel'),
    'PUT settings/:block': async ({ params, body }) => {
      const block = SettingsBlockSchema.parse(params.block)
      const known = !block.startsWith('source:') || runtime.sources.instances().some(instance => `source:${instance.id}` === block)
      if (!known) throw new RouteError(404, 'Source not found')
      const request = SaveRequest.parse(await body())
      return runtime.settings.save(block, request.value, request.revision, 'panel')
    },
    'GET policy/history': () => policyHistory(store, runtime.sources, policyVersion(store.settings())),
    'POST policy-sync/:id': async ({ params }) => ({ policy: await runtime.settings.sync(params.id) }),
    'POST setup/check': () => { runtime.checkSetup(); return { restarting: true } },
    'GET models': () => runtime.models(),
    'GET prompts': ({ query }) => { const { revision, offset } = PromptsQuery.parse(query); return promptsView(runtime, revision, offset) },
    'PUT prompts': async input => {
      const request = z.object({ config: z.unknown(), baseRevision: z.number().int().nonnegative() }).parse(await promptBody(input))
      const next = PromptConfigSchema.parse(request.config)
      // Program memory is the one artefact a model can rewrite about its own behaviour. The A/B gate scores success and
      // is blind to a change that keeps success flat while opening a side channel, so text-level findings that a person
      // must sign off on are refused here — before they ever reach a worker prompt.
      const findings = scanPromptChange(runtime.prompts.current().config, next)
      if (findings.some(finding => finding.severity === 'block')) throw new RouteError(422, describeBlocking(findings))
      const baseline = baselineFindings(next)
      if (baseline.length > 0) throw new RouteError(422, `基线检查未通过：${baseline.map(finding => finding.reason).join('；')}`)
      const saved = await savePrompts(runtime, request.config, request.baseRevision, 'panel', version => {
        // The audit write must never fail a change a person already approved; the store still holds the revision.
        void appendAudit(runtime.machine.stateDir, {
          kind: 'prompts', revision: version.revision, previousRevision: version.previousRevision, source: 'panel',
          summary: `保存提示词版本 r${version.revision}`, findings: { block: 0, warn: findings.filter(item => item.severity === 'warn').length },
        }).catch(() => undefined)
      })
      return saved
    },
    'GET prompts/baseline': () => { const findings = baselineFindings(runtime.prompts.current().config); return { ok: findings.length === 0, findings } },
    'POST prompts/canary': () => canaryFindings(runtime.prompts.current().config),
    'POST prompts/rollback': async input => {
      const request = z.object({ revision: z.number().int().positive() }).parse(await input.body(64 * 1024))
      const target = runtime.prompts.version(request.revision)
      const current = runtime.prompts.current()
      const baseline = baselineFindings(target.config)
      if (baseline.length > 0) throw new RouteError(422, `该版本未通过基线检查：${baseline.map(finding => finding.reason).join('；')}`)
      const saved = await savePrompts(runtime, target.config, current.revision, 'rollback', version => {
        void appendAudit(runtime.machine.stateDir, {
          kind: 'rollback', revision: version.revision, previousRevision: version.previousRevision, source: 'rollback',
          summary: `回滚到 r${request.revision}（保存为 r${version.revision}）`, detail: { from: request.revision, base: current.revision },
        }).catch(() => undefined)
      })
      return saved
    },
    'POST prompts/preview': async input => runtime.prompts.preview(await promptBody(input)),
  }
}
function decoded(segment: string): string {
  try { return decodeURIComponent(segment) } catch { throw new RouteError(400, 'A path segment has a malformed escape') }
}
function match(table: Routes, method: string, segments: string[]) {
  for (const [route, run] of Object.entries(table)) {
    const [verb, path] = route.split(' ') as [string, string]
    const pattern = path.split('/')
    const fits = pattern.length === segments.length && pattern.every((part, index) => part.startsWith(':') || part === segments[index])
    if (verb !== method || !fits) continue
    const params: Record<string, string> = {}
    pattern.forEach((part, index) => { if (part.startsWith(':')) params[part.slice(1)] = decoded(segments[index]!) })
    return { run: run as (input: Input<keyof Api>) => unknown, params }
  }
  return undefined
}
export function registerHttp(ctx: Context, runtime: HttpHost): () => void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Orchestrator management requires a loopback Web server')
  const table = routes(runtime)
  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: '/orchestrator', handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith('/orchestrator/api/')) { res.writeHead(404); res.end(); return }
      if (!sameOrigin(req, ctx.webServer.port)) { json(res, 403, { error: 'Same-origin management request required' }); return }
      try {
        await runtime.ready
        // HTML pages live under the API prefix so they share the token check, the same-origin guard, and the error path.
        if (url.pathname === '/orchestrator/api/memory-page' && (req.method ?? 'GET') === 'GET') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end(renderMemoryPage(runtime.store))
          return
        }
        const route = match(table, req.method ?? 'GET', url.pathname.slice('/orchestrator/api/'.length).split('/'))
        if (!route) throw new RouteError(404, 'Unknown operation')
        const query = Object.fromEntries(url.searchParams)
        json(res, 200, await route.run({ params: route.params as never, query, body: maxBytes => readBody(req, maxBytes) }))
      } catch (error) { json(res, ...failure(error)) }
    } })]
  return () => { for (const dispose of disposers) dispose() }
}
