/** Deterministic answers to "how is my work doing", so checking status never costs a ticket or a worker. */
import { ticketStage, type Ticket } from '../core/index.ts'
import type { Store } from './store.ts'

/** What a status question asks for; `only` narrows the answer to one group. */
export type StatusCommand = { kind: 'tickets'; only?: 'person' | 'working' }

/** Strips Feishu mention markup and collapses whitespace before matching. */
function normalize(text: string): string {
  return text.replace(/<at[^>]*>.*?<\/at>/g, ' ').replace(/@\S+/g, ' ').replace(/\s+/g, ' ').trim()
}

const WHOLE = [
  /^(?:我的)?(?:任务|工单|工作)(?:都)?(?:怎么样|咋样|如何|什么情况|进展|进度|状态)(?:了|呢)?[？?。!！]*$/i,
  /^(?:现在|目前|手头)?(?:有|还有)?(?:哪些|什么|几个)?(?:任务|工单)(?:在跑|在做|在进行|在忙|没完|待确认)?(?:呢|吗)?[？?。!！]*$/i,
  /^(?:看看|查下|查一下|列一下|列下)(?:我的)?(?:任务|工单)[？?。!！]*$/i,
  /^(?:我的)?(?:任务|工单)(?:列表|清单)[？?。!！]*$/i,
]

/** Reads a whole message that asks about work in progress; a sentence that also instructs something is not a status question. */
export function parseStatusCommand(text: string): StatusCommand | undefined {
  const body = normalize(text)
  if (!body) return undefined
  if (!WHOLE.some(pattern => pattern.test(body))) return undefined
  return { kind: 'tickets', ...(/在跑|在做|进行中|running/i.test(body) ? { only: 'working' as const } : {}) }
}

const LABEL: Record<string, string> = { working: '进行中', person: '等你', idle: '待命', ended: '已结束' }
const ACTION: Record<string, string> = { review: '待你审阅', answer: '等你回答', blocked: '卡住了', failed: '失败了', delivery: '消息投递失败' }
const MAX_PER_GROUP = 4
const MAX_TITLE = 26

/** Renders one line for a ticket: its title, its stage, and the pull request a person can open. */
function line(ticket: Ticket, stage: ReturnType<typeof ticketStage>): string {
  const title = (ticket.title || ticket.intent || ticket.id).replace(/\s+/g, ' ').trim()
  const short = title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE)}…` : title
  const pull = ticket.follows?.map(follow => /^github:(\d+)$/.exec(follow.thread)?.[1]).find(Boolean)
  const suffix = stage.stage === 'person' ? `（${ACTION[stage.action ?? ''] ?? '等你'}${pull ? ` PR #${pull}` : ''}）` : ''
  return `· ${short}${suffix}`
}

/**
 * Answers a status question from the Store alone: open tickets grouped by what they wait on, then the latest ended ones.
 * A person asking what happened gets an answer even when nothing is running.
 */
export function runStatusCommand(store: Pick<Store, 'tickets'>, _command: StatusCommand): string {
  const open = store.tickets.open()
  const person: string[] = []
  const working: string[] = []
  const idle: string[] = []
  for (const ticket of open) {
    const stage = ticketStage(ticket)
    if (stage.stage === 'person') person.push(line(ticket, stage))
    else if (stage.stage === 'working') working.push(line(ticket, stage))
    else idle.push(line(ticket, stage))
  }
  const block = (name: string, rows: string[]): string[] => rows.length === 0 ? []
    : [`${name} ${rows.length} 张：`, ...rows.slice(0, MAX_PER_GROUP), ...(rows.length > MAX_PER_GROUP ? [`· 还有 ${rows.length - MAX_PER_GROUP} 张`] : [])]
  const parts = [...block('等你处理', person), ...block('进行中', working), ...block('待命', idle)]
  if (parts.length === 0) {
    const ended = store.tickets.list().filter(ticket => ticket.ended).slice(0, 2)
    return ended.length === 0 ? '现在没有任务，也没有做过什么。' : ['现在没有进行中的任务。最近结束：', ...ended.map(ticket => `· ${(ticket.title || ticket.intent).slice(0, MAX_TITLE)}（${ticket.ended?.outcome ?? ''}）`)].join('\n')
  }
  return parts.join('\n')
}
