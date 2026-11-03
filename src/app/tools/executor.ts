/** Executor Session tools for reading ticket context, acknowledging requests, managing threads, handing back out-of-scope triggers, and reporting status. */
import { z } from 'zod'
import { builtinStrategies, builtinTaskKinds, key, liveTicket, normalizeArtifact, type EngineForExecutor, type StrategyFact, type TaskKindRegistry,
  type Ticket } from '../../core/index.ts'
import { IM_WORDS } from '../../infra/text.ts'
import { claimPull, readPull } from '../../sources/github-pull.ts'
import type { SourceContext } from '../../sources/host.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import type { Store } from '../store.ts'
import { reportRelay, threadFollowedNotice } from '../notices.ts'
import type { Sessions } from '../sessions.ts'
import { AcknowledgementSchema, readTool, tool, type Tool } from './tool.ts'

export interface ExecutorToolsHost {
  readonly engine: Pick<EngineForExecutor, 'report' | 'reply' | 'markUnrelated' | 'handback' | 'followForContext' | 'noteTrace'>
  readonly store: Pick<Store, 'tickets' | 'replyStatus' | 'atomic' | 'settings'>
  readonly sessions: Pick<Sessions, 'relay' | 'notify'>
  /** Queues the ticket's ready outcome to its own channel; absent in hosts that cannot deliver channel messages. */
  readonly sendNotice?: (message: import('../../core/index.ts').OutboundMessage) => void
  readonly resources: ResourceHost
  /** GitHub Source context whose pull-request rules govern claiming a reported PR. */
  readonly github: SourceContext
  /** Task kinds this deployment routes and verifies with; absent means the built-in kinds. */
  readonly taskKinds?: TaskKindRegistry
  sendReplies(): Promise<void>
}
/** The built-in task kinds, used when the host hosts none. */
const DEFAULT_TASK_KINDS = builtinTaskKinds()
/** What a report may name as a completed artifact: a reference to content that stays on the worker. */
const ArtifactRefSchema = z.object({
  kind: z.enum(['screenshot', 'build', 'log', 'file', 'diff', 'report']),
  uri: z.string().trim().min(1).describe('worker://<worker>/<path>: the content stays on the worker and is pulled on demand.'),
  sha256: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  mime: z.string().optional(),
  preview: z.string().optional(),
}).strict()

export function executorTools(host: ExecutorToolsHost, ticket: Ticket): Tool[] {
  const ticketId = ticket.id
  return [
    readTool('Read one page of a resource of this ticket that the resource parameter lists. Follow next_offset, and next_resource where a page names one.',
      true, (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, ticketId, signal)),
    tool({
      name: 'orchestrator_ack',
      description: 'Acknowledge one original human request before substantial work, as the replies section says; it posts as a reply to that message.',
      schema: z.object({
        trigger_id: z.string(),
        text: AcknowledgementSchema.describe(`At most ${IM_WORDS} words; Markdown is supported.`),
      }).strict(),
      execute: async args => {
        const reply = host.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: args.trigger_id, text: args.text })
        if (reply.status !== 'sent') await host.sendReplies()
        return { trigger_id: args.trigger_id, acknowledgement: host.store.replyStatus(reply.id)!, reused: reply.reused }
      },
    }),
    tool({
      name: 'orchestrator_thread_unrelated',
      description: 'Stop following an attached thread that is not about this ticket, as the work section says; its own threads cannot be dropped.',
      schema: z.object({
        thread: z.string().min(1).describe('The thread key, which trigger/<id> of one of its messages shows as thread, such as feishu:<chat>:<root> or github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('One sentence on why the thread is not about this ticket.'),
      }).strict(),
      execute: async args => { host.engine.markUnrelated(ticketId, args.thread, args.reason); return { removed: true, thread: args.thread } },
    }),
    tool({
      name: 'orchestrator_thread_follow',
      description: 'Follow a related thread, such as an Issue or another PR, for context only.',
      schema: z.object({
        thread: z.string().describe('Thread key, such as github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('How it relates, in one sentence.'),
      }).strict(),
      execute: async args => host.store.atomic(() => {
        const at = args.thread.indexOf(':')
        if (at < 1 || at === args.thread.length - 1) throw new Error('A thread key is <source>:<id>, such as github:<number>')
        const followed = host.engine.followForContext(ticketId, { source: args.thread.slice(0, at), id: args.thread.slice(at + 1) })
        if (followed) host.sessions.notify(...threadFollowedNotice(ticketId, args.thread, args.reason))
        return { followed, thread: args.thread }
      }),
    }),
    tool({
      name: 'orchestrator_trigger_handback',
      description: 'Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket\'s to decide, such as a bot\'s, which is assessed without it.',
      schema: z.object({
        trigger_id: z.string().min(1),
        reason: z.string().trim().min(1).max(300).describe('One sentence on what it asks for beyond this ticket.'),
      }).strict(),
      execute: async args => ({ trigger_id: args.trigger_id, queued: host.engine.handback(ticketId, args.trigger_id, args.reason) }),
    }),
    tool({
      name: 'orchestrator_report',
      description: 'Report progress, ready, blocked, failed or dropped, as the work and handoff sections say. '
        + 'With progress, say what is finished, what remains and what failed, so a later attempt can continue instead of redoing work.',
      schema: z.object({
        state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped']),
        summary: z.string().min(1),
        human_action: z.string().trim().min(1).max(1000).nullish().describe('One concrete question for a person, also with state=progress; omit to keep the pending one, null to clear it.'),
        question_for_trigger_id: z.string().optional().describe('With human_action: the human message that raised the question, which is asked where that person wrote.'),
        pr_number: z.number().int().positive().nullish().describe(`The ticket's PR: its source PR, or one by ${host.github.deployment.github.login} from a branch named after this ticket (DSH_SUPERAGENT_NAME).`),
        reply_to_trigger_id: z.string().optional().describe('The explicit human question this report answers; never for ordinary progress.'),
        completed: z.array(z.object({ item: z.string().trim().min(1), artifact: ArtifactRefSchema.optional() }).strict()).max(50).optional()
          .describe('Items finished; an optional artifact reference stays on the worker and can be pulled later, never inline its content.'),
        remaining: z.array(z.string().trim().min(1)).max(50).optional()
          .describe('Items still to do; empty means nothing is left. A ticket may live across attempts, so this is how partial work is handed on.'),
        failed: z.array(z.object({ item: z.string().trim().min(1), reason: z.string().trim().min(1), retryable: z.boolean() }).strict()).max(50).optional()
          .describe('Items that failed, with the reason and whether another attempt may succeed.'),
      }).strict(),
      execute: async (args, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
        const pull = args.pr_number != null ? await readPull(host.github, args.pr_number, signal) : undefined
        // A PR the ticket's branch naming rules cannot prove is still the ticket's, so a strict claim failure is logged
        // and the report proceeds: refusing it here would make the worker unable to report at all, and the delivery
        // notice below still carries the PR number a person asked for.
        const refused = pull ? claimPull(host.github, ticketId, pull) : undefined
        if (refused) console.error('[dsh-superagent] 票据 %s 的 PR #%s 未绑定（仍按报告继续）: %s', ticketId, pull?.number, refused)
        // Only a reference is stored: content a worker inlined in a completed item is dropped, so the router never holds it.
        const completed = args.completed?.map(entry => ({ item: entry.item,
          ...(entry.artifact === undefined ? {} : normalizeArtifact(entry.artifact) ? { artifact: normalizeArtifact(entry.artifact)! } : {}) }))
        const pullView = pull ? { number: pull.number, url: (pull as { html_url?: string }).html_url } : undefined
        const kind = (host.taskKinds ?? DEFAULT_TASK_KINDS).resolve(current)
        const view = { state: args.state, summary: args.summary, ...(completed?.length ? { completed } : {}),
          ...(args.remaining ? { remaining: args.remaining } : {}), ...(args.failed?.length ? { failed: args.failed } : {}), ...(pullView ? { pull: pullView } : {}) }
        // 公理 7：是否接受一份 ready 报告也是可替换的决策层；默认 verify 策略委托 kind.verify，配置可换成更严格或更宽的策略。
        let reviewVerdict: { strategy: string; facts: StrategyFact[] } | undefined
        if (args.state === 'ready') {
          const review = builtinStrategies().review(host.store.settings().policy.strategies.review)
          const verdict = review.review({ kind, report: view, ticket: current })
          if (!verdict.ok) throw new Error(verdict.reason ?? 'The report was not accepted.')
          reviewVerdict = { strategy: review.id, facts: verdict.facts }
        }
        // Record the report and queue the relay atomically so an invalid report leaves no partial state, and a recorded report always reaches the main Session.
        const outcome = host.store.atomic(() => {
          const report = { state: args.state, summary: args.summary, ...(args.human_action !== undefined ? { question: args.human_action } : {}),
            ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
            ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}),
            ...(completed?.length ? { completed } : {}),
            ...(args.remaining ? { remaining: args.remaining } : {}),
            ...(args.failed?.length ? { failed: args.failed } : {}) }
          const updated = host.engine.report(ticketId, report)
          const relay = reportRelay(updated, report)
          if (relay) host.sessions.relay(relay.id, relay.text)
          // The task kind writes the delivery text: a repository change names its PR, a file task names its files.
          const delivery = report.state === 'ready' ? kind.deliver({ ticket: updated, text: '' }, view) : undefined
          const channel = updated.channels.at(-1)
          if (delivery && channel) host.sendNotice?.({ id: key('delivery', updated.id), channel, kind: 'notice', ticketId: updated.id, text: delivery.text })
          const notification = relay ? 'orchestrator' : 'internal_only'
          return { reported: true, notification, ...(updated.attention ? { attention: updated.attention } : {}) }
        })
        // 公理 5：review 层的依据链，写在与 triage/planning/assignment 同一条票据 trace 上。
        if (reviewVerdict) {
          host.engine.noteTrace(ticketId, { layer: 'review', strategy: reviewVerdict.strategy, at: new Date().toISOString(),
            outcome: 'accepted', facts: reviewVerdict.facts })
        }
        return outcome
      },
    }),
  ]
}
