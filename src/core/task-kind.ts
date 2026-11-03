/**
 * Task kinds: one task type's three seams — how its workspace is prepared, how a ready result is delivered, and how a
 * worker's ready report is verified. The router picks a kind when it accepts a ticket; the executor's launch path, the
 * delivery path and the shared worker prompt do not change, so a new kind needs one implementation here plus one
 * routing rule (settings `executor.taskKinds`, or the kind's own `match` phrases).
 */
import type { ArtifactRef, ReportProgress, ReportState, Ticket } from './model.ts'

/** Everything a kind needs to decide: the ticket and the words the router routed on. */
export interface TaskKindContext {
  readonly ticket: Ticket
  /** The title and the origin message text, joined. */
  readonly text: string
}

/** One worker report as a kind sees it: the partial-delivery lists plus what a code report may name. */
export interface TaskKindReport extends ReportProgress {
  state: ReportState
  summary: string
  /** The pull request a code report named, when it named one. */
  pull?: { number: number; url?: string }
}

/** The text of the notice a person gets when the ticket is ready. */
export interface TaskKindDelivery { text: string }

/** A ready report is accepted, or rejected with what the worker must fix before reporting ready. */
export type TaskKindVerdict = { ok: true } | { ok: false; reason: string }

/** One task type. Adding a task type means adding one of these and one routing rule, not changing the executor. */
export interface TaskKind {
  readonly id: string
  /** How its workspace is prepared: a repository clone, an empty workspace directory, or the router host itself. */
  readonly workspace: 'repository' | 'workspace' | 'maintenance'
  /** Worker capabilities (tags) this kind wants; advisory, the router's placement policy decides. */
  readonly capabilities?: readonly string[]
  /** Case-insensitive regular expression sources over the request that route to this kind; the default kind has none. */
  readonly match?: readonly string[]
  /** Extra assignment text for the worker. The shared prompt keeps its structure; kind rules live here. */
  note?(context: TaskKindContext): string
  /** Text of the ready notice; undefined keeps a finished ticket in the panel only. */
  deliver(context: TaskKindContext, report: TaskKindReport): TaskKindDelivery | undefined
  /** Whether a ready report may be accepted as complete. A rejection is shown to the worker instead of the report. */
  verify(context: TaskKindContext, report: TaskKindReport): TaskKindVerdict
}

/** A configured routing rule: a kind and the phrases that select it, in order. */
export interface TaskKindRule { readonly id: string; readonly match: readonly string[] }

const titleOf = (ticket: Ticket): string => (ticket.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
const summaryOf = (ticket: Ticket): string => (ticket.mandate?.scope ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
/** Any artifact references a report carries, normalized by `partial()` before this sees them. */
const artifactsOf = (report: TaskKindReport): ArtifactRef[] =>
  (report.completed ?? []).flatMap(entry => (entry.artifact === undefined ? [] : [entry.artifact as ArtifactRef]))
const CLOSING = '回复「合并」或「看下」继续；不回复就先停在这里。'

/**
 * Changing code in a repository: clone it, open a PR, and the PR is the delivery. The default kind, so it carries no
 * `match` phrases and catches every request that names no other task type.
 */
export const codeChange: TaskKind = {
  id: 'code-change', workspace: 'repository',
  deliver(context, report) {
    const where = report.pull ? `PR #${report.pull.number}${report.pull.url ? ` ${report.pull.url}` : ''}` : '没有改动需要合并'
    return { text: `✅ 任务完成：${titleOf(context.ticket)}${summaryOf(context.ticket) ? `\n${summaryOf(context.ticket)}` : ''}\n${where}\n${CLOSING}` }
  },
  verify(_context, report) {
    if (report.state === 'ready' && report.remaining?.length) return { ok: false,
      reason: 'A ready report must not list remaining items: keep state=progress while work remains, or remove items that are no longer needed.' }
    return { ok: true }
  },
}

/**
 * Producing files in a workspace that is not a repository: no clone, no branch, no PR. The files are the result; each
 * one is listed in completed[] with an artifact reference, and the notice names them.
 */
export const fileChange: TaskKind = {
  id: 'file-change', workspace: 'workspace',
  match: ['(写|创建|生成|保存|导出|输出|整理|汇总)[^。\\n]{0,30}(文件|文档|报告|清单|表格|md|markdown|txt)',
    '\\b(write|create|generate|save|export|produce|assemble)\\b[^\\n]{0,30}\\b(file|document|report|note|markdown|txt)\\b'],
  note() {
    return 'This is a file task, not a repository change: there is no clone, no branch and no pull request. '
      + 'Write the files in this workspace directory, and report each output in completed[].artifact as '
      + '{kind:"file", uri:"worker://<this worker>/<path>", size, sha256}. '
      + 'Report ready only once the files are written; verify their contents before reporting.'
  },
  deliver(context, report) {
    const names = artifactsOf(report).map(artifact => artifact.uri).slice(0, 3).join('、')
    return { text: `✅ 任务完成：${titleOf(context.ticket)}${summaryOf(context.ticket) ? `\n${summaryOf(context.ticket)}` : ''}`
      + `\n产物：${names || '见工作区'}${artifactsOf(report).length > 3 ? ` 等 ${artifactsOf(report).length} 项` : ''}\n${CLOSING}` }
  },
  verify(_context, report) {
    if (report.state !== 'ready') return { ok: true }
    if (!artifactsOf(report).length) return { ok: false,
      reason: 'A file task reports the files it wrote: list each output in completed[].artifact as {kind, uri} where uri is worker://<this worker>/<path>.' }
    return { ok: true }
  },
}

/** Answering with findings: no repository, no PR; the report summary carries the result. */
export const analysis: TaskKind = {
  id: 'analysis', workspace: 'workspace',
  match: ['分析|总结|调研|梳理|比较|评估|解读', '\\b(analy[sz]e|summari[sz]e|research|investigate|compare|evaluate|interpret)\\b'],
  note() {
    return 'This is an analysis task, not a repository change: there is no clone, no branch and no pull request. '
      + 'Put the findings in the report summary; attach any report file you produced as a completed[].artifact reference. '
      + 'Report ready only when the analysis is complete.'
  },
  deliver(context, report) {
    return { text: `✅ 任务完成：${titleOf(context.ticket)}${summaryOf(context.ticket) ? `\n${summaryOf(context.ticket)}` : ''}\n${CLOSING}` }
  },
  verify(_context, report) {
    if (report.state !== 'ready') return { ok: true }
    if (report.summary.trim().length < 40) return { ok: false,
      reason: 'An analysis report is its findings: state them in summary (at least 40 characters) before reporting ready.' }
    return { ok: true }
  },
}

/** A request that names a repository is development work: documentation PRs and README edits stay repository tickets. */
const REPOSITORY_ASK = /github\.com|仓库|\brepo(sitory)?\b|pull request|\bPR\b|分支|代码|\bcode\b|commit|readme/i
/** A request that says not to open a PR declares itself non-repository work: "不要开 PR" must not beat "生成一份报告". */
const NOT_REPOSITORY = /(不要|不需要|无需|不用|别)\s*(开|创建|提|发)?\s*(PR|pr|pull request)|no\s+(pull request|\bPR\b)/i

const matchOne = (source: string, text: string): boolean => {
  try { return new RegExp(source, 'i').test(text) } catch { return false }
}

/**
 * The task kinds the router ships with, plus registration and selection. Selection order: configured rules in order,
 * then a request that names a repository stays `code-change`, then each kind's own `match` phrases, then the default.
 */
export class TaskKindRegistry {
  readonly #kinds = new Map<string, TaskKind>()
  constructor(kinds: readonly TaskKind[] = [fileChange, analysis, codeChange], private readonly defaultId = 'code-change') {
    for (const kind of kinds) this.register(kind)
  }
  /** Adds a kind, replacing one of the same id so a deployment can override a built-in. */
  register(kind: TaskKind): void { this.#kinds.set(kind.id, kind) }
  get(id: string): TaskKind | undefined { return this.#kinds.get(id) }
  list(): TaskKind[] { return [...this.#kinds.values()] }
  /** Selects the kind for a new ticket from its configured rules, a repository hint, the kinds' match phrases, and the default. */
  select(input: { title?: string; text: string; rules?: readonly TaskKindRule[]; defaultId?: string }): TaskKind {
    const text = `${input.title ?? ''}\n${input.text}`
    for (const rule of input.rules ?? []) {
      const kind = this.get(rule.id)
      if (kind && rule.match.some(source => matchOne(source, text))) return kind
    }
    const fallback = (): TaskKind => this.get(input.defaultId ?? this.defaultId) ?? this.get('code-change') ?? codeChange
    if (!NOT_REPOSITORY.test(text) && REPOSITORY_ASK.test(text) && this.get('code-change')) return this.get('code-change')!
    for (const kind of this.#kinds.values()) {
      if (kind.id === 'code-change' || !kind.match?.length) continue
      if (kind.match.some(source => matchOne(source, text))) return kind
    }
    return fallback()
  }
  /** The kind a ticket already runs under, from its stored Execution, or the default for a ticket without one. */
  resolve(ticket: Ticket): TaskKind {
    return (ticket.execution?.taskKind ? this.get(ticket.execution.taskKind) : undefined) ?? this.get('code-change') ?? codeChange
  }
}

/** The registry a deployment gets when it configures none: the built-in kinds and the code-change default. */
export const builtinTaskKinds = (): TaskKindRegistry => new TaskKindRegistry()
