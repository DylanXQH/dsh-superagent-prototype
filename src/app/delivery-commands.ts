/** Answers "merge it" and "show me" in the delivery thread, so the notice's promise is a real capability. */
import { z } from 'zod'
import { ticketStage, type Ticket } from '../core/index.ts'
import type { Store } from './store.ts'

/** How a person replies to a delivery notice; `number` names the pull request when more than one is waiting. */
export type DeliveryCommand = { kind: 'merge'; number?: number } | { kind: 'inspect'; number?: number }

/** Strips Feishu mention markup and collapses whitespace before matching. */
function normalize(text: string): string {
  return text.replace(/<at[^>]*>.*?<\/at>/g, ' ').replace(/@\S+/g, ' ').replace(/\s+/g, ' ').trim()
}

const MERGE = /^(?:好的?[，,]\s*)?(?:合并|合了|合掉|merge)\s*(?:吧|掉|它|这个|这单|pr|it)?\s*(?:#|pr\s*#?)?(\d{1,6})?[？?。!！]*$/i
const INSPECT = /^(?:看下|看一下|看看|详情|diff)(?:这个|一下|这单|pr|详情)?\s*(?:#|pr\s*#?)?(\d{1,6})?[？?。!！]*$/i

/**
 * Reads a whole message that answers a delivery notice. A sentence that also asks for something new is a new request,
 * not a decision on the old one, so only bare decisions match.
 */
export function parseDeliveryCommand(text: string): DeliveryCommand | undefined {
  const body = normalize(text)
  if (!body) return undefined
  const merge = MERGE.exec(body)
  if (merge) return { kind: 'merge', ...(merge[1] ? { number: Number(merge[1]) } : {}) }
  const inspect = INSPECT.exec(body)
  if (inspect) return { kind: 'inspect', ...(inspect[1] ? { number: Number(inspect[1]) } : {}) }
  return undefined
}

const Pull = z.object({
  number: z.number().int().positive(), title: z.string(), state: z.string(), merged: z.boolean(),
  mergeable: z.boolean().nullable().optional(), additions: z.number(), deletions: z.number(), changed_files: z.number(),
  user: z.object({ login: z.string() }), html_url: z.string(),
})
const Merged = z.object({ merged: z.boolean(), message: z.string() })

/** The harness a delivery command runs against: the Store's tickets plus the agent's GitHub CLI. */
export interface DeliveryHost {
  store: Pick<Store, 'tickets'>
  commands: { api<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T> }
}

/** Every open ticket waiting on a person that has a pull request attached, oldest first. */
/** A pull request URL quoted in the worker's own final report, for tickets the Source never bound to a PR thread. */
const PULL_IN_SUMMARY = /https?:\/\/github\.com\/[^\s)]+\/pull\/(\d+)/

function waiting(store: Pick<Store, 'tickets'>): { ticket: Ticket; number: string }[] {
  return store.tickets.open()
    .filter(ticket => ticketStage(ticket).stage === 'person')
    .map(ticket => ({
      ticket,
      number: (ticket.follows ?? []).map(follow => /^github:(\d+)$/.exec(follow.thread)?.[1]).find(Boolean)
        ?? PULL_IN_SUMMARY.exec(ticket.summary ?? '')?.[1],
    }))
    .filter((row): row is { ticket: Ticket; number: string } => Boolean(row.number))
}

/**
 * Runs a delivery decision against the waiting pull request.
 * Merging is the person's explicit instruction here, so it is performed directly; everything reported back is the CLI's own answer.
 */
export async function runDeliveryCommand(host: DeliveryHost, command: DeliveryCommand): Promise<string> {
  const rows = waiting(host.store)
  if (rows.length === 0) {
    const pending = host.store.tickets.open().filter(ticket => ticketStage(ticket).stage === 'person')
    if (pending.length === 0) return '现在没有等你决定的交付。'
    return [`有 ${pending.length} 张在等你，但都没记到 PR 号（票据没绑定到 GitHub PR）：`, ...pending.slice(-5).map(ticket => `· ${(ticket.title || ticket.intent).slice(0, 28)}`)].join('\n')
  }
  if (!command.number && rows.length > 1) {
    return ['有好几张等你决定，回复「合并 #号」指定：', ...rows.slice(-5).map(row => `· #${row.number} ${(row.ticket.title || row.ticket.intent).slice(0, 24)}`)].join('\n')
  }
  const target = command.number ? rows.find(row => row.number === String(command.number)) : rows[0]
  if (!target) return `没找到还要你决定的 PR #${command.number}。`
  const path = `pulls/${target.number}`
  try {
    if (command.kind === 'merge') {
      const result = await host.commands.api(Merged, `${path}/merge`, '-X', 'PUT', '-f', 'merge_method=squash')
      return result.merged
        ? `✅ 已合并 PR #${target.number}（${target.ticket.title || target.ticket.intent}）`
        : `合并没成功：${result.message}`
    }
    const pull = await host.commands.api(Pull, path)
    const status = pull.merged ? '已合并' : pull.state !== 'open' ? `已${pull.state}` : pull.mergeable === false ? '有冲突，合不了' : '可合并'
    return [
      `PR #${pull.number} ${pull.title}`,
      `+${pull.additions}/-${pull.deletions}，${pull.changed_files} 个文件，作者 ${pull.user.login}`,
      `状态：${status}`,
      pull.html_url,
    ].join('\n')
  } catch (error) {
    return `处理失败：${error instanceof Error ? error.message : String(error)}`
  }
}
