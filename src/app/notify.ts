/** Proactive Feishu messages the router sends on its own schedule: the daily brief, and the watchdog's stall reports. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ticketStage } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import type { Store } from './store.ts'

/** Sends a Markdown message to a chat the router knows, outside any conversation the Outbox can reply to. */
export async function sendFeishuChat(commands: Commands, chatId: string, text: string): Promise<void> {
  // Plain text on purpose: the Markdown rendering of a multi-line brief dropped its tail in testing.
  await commands.lark(['im', '+messages-send', '--chat-id', chatId, '--text', text])
}

/** The settings the scheduled notices read. */
export interface NotifyConfig {
  /** The Feishu chat that receives them; empty turns the scheduled notices off. */
  chatId: string
  dailyBrief: boolean
  /** Local time of the daily brief, `HH:MM` in `Asia/Shanghai`. */
  dailyBriefAt: string
  watchdog: boolean
}

/** What has already gone out, kept on disk so a restart does not repeat the same day's brief. */
interface NotifyState { lastBrief?: string }

const statePath = (stateDir: string): string => join(stateDir, 'notify-state.json')

function readState(stateDir: string): NotifyState {
  try {
    return JSON.parse(readFileSync(statePath(stateDir), 'utf8')) as NotifyState
  } catch {
    return {}
  }
}

function writeState(stateDir: string, state: NotifyState): void {
  try {
    writeFileSync(statePath(stateDir), JSON.stringify(state), 'utf8')
  } catch {
    // A brief that cannot record itself is repeated tomorrow, which is better than crashing the router.
  }
}

/** `HH:MM` in the router's own time zone, which is the reader's. */
function localClock(now: Date): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now)
  const pick = (type: string): string => parts.find(part => part.type === type)?.value ?? ''
  return { date: `${pick('year')}-${pick('month')}-${pick('day')}`, time: `${pick('hour')}:${pick('minute')}` }
}

/** The brief a person reads over coffee: what is running, and what is waiting on them. */
export function dailyBriefText(store: Store, now: Date): string {
  const open = store.tickets.open()
  const waiting: string[] = []
  const running: string[] = []
  for (const ticket of open) {
    const stage = ticketStage(ticket).stage
    if (stage === 'person') waiting.push(`· ${ticket.title}`)
    else if (stage === 'working') running.push(`· ${ticket.title}`)
  }
  const lines = [`📋 早报 ${localClock(now).date}`, '']
  if (open.length === 0) {
    lines.push('现在没有在跑的任务。')
  } else {
    lines.push(`共 ${open.length} 个任务。`)
    if (running.length > 0) lines.push('', `进行中 ${running.length} 个：`, ...running.slice(0, 12), ...(running.length > 12 ? [`（另有 ${running.length - 12} 个没列出，发「我的任务怎么样了」看全部）`] : []))
    if (waiting.length > 0) lines.push('', `等你处理 ${waiting.length} 个：`, ...waiting.slice(0, 12), ...(waiting.length > 12 ? [`（另有 ${waiting.length - 12} 个没列出，发「我的任务怎么样了」看全部）`] : []))
    if (running.length === 0 && waiting.length === 0) lines.push('', '其余票据都在等待或已结束。')
  }
  lines.push('', '—— 以上是今天的全部内容 ——')
  return lines.join('\n')
}

/**
 * Sends the daily brief once a day at `dailyBriefAt`, checked every minute.
 * @returns a disposer that stops the timer.
 */
export function startDailyBrief(options: {
  commands: Commands
  store: Store
  stateDir: string
  config: () => NotifyConfig
  lifetime: AbortSignal
  log?: (message: string) => void
}): () => void {
  const tick = (): void => {
    const config = options.config()
    if (!options.lifetime.aborted && config.dailyBrief && config.chatId) {
      const now = new Date()
      const clock = localClock(now)
      const state = readState(options.stateDir)
      if (clock.time === config.dailyBriefAt && state.lastBrief !== clock.date) {
        writeState(options.stateDir, { ...state, lastBrief: clock.date })
        void sendFeishuChat(options.commands, config.chatId, dailyBriefText(options.store, now))
          .catch((error: unknown) => options.log?.(`daily brief failed: ${String(error)}`))
      }
    }
    if (!options.lifetime.aborted) timer = setTimeout(tick, 60_000)
  }
  let timer = setTimeout(tick, 60_000)
  return () => clearTimeout(timer)
}

/** What the watchdog found: one remote Session that has gone quiet. */
export interface QuietSession { sessionId: string; ticketId: string; title: string; idleMs: number }

/**
 * Watches remote Sessions and tells a person when one stops making progress, blocking the ticket past the longer limit.
 * @returns a disposer that stops the timer.
 */
export function startWatchdog(options: {
  commands: Commands
  config: () => NotifyConfig
  scan: () => QuietSession[]
  block: (sessionId: string, minutes: number) => void
  lifetime: AbortSignal
  log?: (message: string) => void
  everyMs?: number
  reportAfterMs?: number
  blockAfterMs?: number
}): () => void {
  const everyMs = options.everyMs ?? 5 * 60_000
  const reportAfterMs = options.reportAfterMs ?? 30 * 60_000
  const blockAfterMs = options.blockAfterMs ?? 60 * 60_000
  const reported = new Set<string>()
  const tell = (markdown: string): void => {
    const chatId = options.config().chatId
    if (chatId) void sendFeishuChat(options.commands, chatId, markdown).catch((error: unknown) => options.log?.(`watchdog notice failed: ${String(error)}`))
  }
  const tick = (): void => {
    if (!options.lifetime.aborted && options.config().watchdog) {
      for (const item of options.scan()) {
        const minutes = Math.round(item.idleMs / 60_000)
        if (item.idleMs >= blockAfterMs) {
          reported.delete(item.sessionId)
          options.block(item.sessionId, minutes)
          tell(`🚨 任务卡住了，已标记阻塞\n· ${item.title}\n· 已 ${minutes} 分钟没有任何进展\n\n你可以让我重跑，或在面板上看它的会话记录。`)
        } else if (item.idleMs >= reportAfterMs && !reported.has(item.sessionId)) {
          reported.add(item.sessionId)
          tell(`⚠️ 任务可能卡住了\n· ${item.title}\n· 已 ${minutes} 分钟没有任何进展\n\n到 ${Math.round(blockAfterMs / 60_000)} 分钟我会自动标记为阻塞。`)
        }
      }
    }
    if (!options.lifetime.aborted) timer = setTimeout(tick, everyMs)
  }
  let timer = setTimeout(tick, everyMs)
  return () => clearTimeout(timer)
}
