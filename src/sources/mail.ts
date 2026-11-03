/** 163-mail Source: polls the inbox for new mail, turns each into a Trigger, and replies through the same mail CLI. */
import type { Context } from '@deepseek-ai/cordis'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { key, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { pause } from './poll.ts'
import { z } from 'zod'

const run = promisify(execFile)
export const SOURCE = 'mail'
/** The CLI that speaks SMTP/IMAP for the agent mailbox; its `--json` mode keeps stdout machine-readable. */
const DEFAULT_SCRIPT = '/opt/mail163/mail163.py'
const DEFAULT_SECRET = '/opt/mail163/mail163.env'

const MailConfigSchema = z.object({
  pollSeconds: z.number().int().min(60).max(3600).default(120),
  folder: z.string().default('INBOX'),
  maxPerPoll: z.number().int().min(1).max(20).default(5),
  script: z.string().default(DEFAULT_SCRIPT),
  credentialFile: z.string().default(DEFAULT_SECRET),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
}).strict()
export type MailConfig = z.infer<typeof MailConfigSchema>

/** One inbox row as `list --json` reports it. */
interface MailItem { uid: string; date: string; from: string; from_addr: string; subject: string }
/** One message as `read --json` reports it. */
interface MailBody { uid: string; from: string; to: string; subject: string; date: string; body: string; attachments: string[] }

/** The configuration of the running poll, so the reply adapter can reach the same CLI without a Source context. */
let active: MailConfig = MailConfigSchema.parse({})

/** Runs the mail CLI and parses its JSON stdout; stderr carries human-readable logging and is ignored. */
async function cli<T>(config: MailConfig, args: string[], timeoutMs = 90_000): Promise<T> {
  const { stdout } = await run('python3', [config.script, '--secret-file', config.credentialFile, ...args],
    { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
  const text = String(stdout).trim()
  if (!text) throw new Error(`mail163 ${args[0]} produced no JSON output`)
  return JSON.parse(text) as T
}

/** Lists unseen messages, newest first, bounded by `maxPerPoll`. */
/** Lists unseen messages, newest first. The first poll asks for a large page so the baseline covers the whole backlog. */
async function listUnseen(config: MailConfig, limit = config.maxPerPoll): Promise<{ total: number; items: MailItem[] }> {
  return cli<{ folder: string; total: number; items: MailItem[] }>(config,
    ['list', '--folder', config.folder, '--unseen', '--limit', String(limit), '--json'])
}

/** Reads one message's full body without marking it seen. */
async function readBody(config: MailConfig, uid: string): Promise<MailBody> {
  return cli<MailBody>(config, ['read', '--uid', uid, '--folder', config.folder, '--json'])
}

/** Sends a reply; the CLI enforces the account whitelist and the From address. */
async function sendMail(config: MailConfig, to: string, subject: string, body: string): Promise<void> {
  await run('python3', [config.script, '--secret-file', config.credentialFile, 'send',
    '--to', to, '--subject', subject, '--body', body, '--delay', '0'], { timeout: 120_000, windowsHide: true })
}

/** Parses the CLI's `YYYY-MM-DD HH:MM` display time, which is already in this machine's zone. */
function atOf(item: MailItem): string {
  const parsed = Date.parse(item.date.replace(' ', 'T'))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString()
}

/**
 * Builds the Trigger for one message. The thread is the mailbox message itself (a reply thread is not modelled: the CLI has
 * no stable parent lookup), so subsequent replies to the agent open their own ticket rather than continuing one.
 */
export function mailTrigger(item: MailItem, body: MailBody, folder: string): Trigger {
  const subject = item.subject || '(无主题)'
  const text = [`主题：${subject}`, `发件人：${item.from}`, '', body.body].join('\n')
  return { id: key('mail', item.uid), source: SOURCE,
    threads: [{ source: SOURCE, id: item.uid }],
    actor: { source: SOURCE, id: item.from_addr || item.from },
    human: true,
    // Mail arrives at the agent's own mailbox, so it is a direct message to the agent rather than a mention in a shared room.
    addressed: 'direct',
    at: atOf(item),
    text: text.slice(0, 40_000),
    channel: { source: SOURCE, thread: `mail:${item.uid}`, address: { to: item.from_addr || item.from, subject: `Re: ${subject}` } },
    ...body.attachments.length > 0 ? { meta: { uid: item.uid, subject, folder, attachments: body.attachments } }
      : { meta: { uid: item.uid, subject, folder } } }
}

export const mailKind: SourceKind<MailConfig> = {
  kind: SOURCE,
  title: { zh: '163 邮箱', en: '163 Mail' },
  description: { zh: '智能体的 163 邮箱；收件箱里的新邮件变成工单，处理结果用邮件回复来信人。', en: 'The agent\'s 163 mailbox; new inbox mail becomes a ticket and its reply goes back by mail.' },
  schema: MailConfigSchema,
  fields: [
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600,
      label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' },
      hint: { zh: '默认 120 秒。163 邮箱对频繁登录有风控，不要设得过小。', en: '120 s by default; 163 rate-limits frequent logins, so keep it generous.' } },
    { key: 'folder', type: 'text', label: { zh: '监听的文件夹', en: 'Folder' },
      hint: { zh: '默认 INBOX。只监听未读邮件，处理过的邮件第二次不会被重复接收。', en: 'INBOX by default. Only unseen mail is polled, and a message is ingested once.' } },
    { key: 'maxPerPoll', type: 'number', advanced: true, min: 1, max: 20,
      label: { zh: '每轮最多处理几封', en: 'Messages per poll' },
      hint: { zh: '默认 5。剩下的留到下一轮，避免一次性开出太多工单。', en: '5 by default. The rest wait for the next round so one poll does not open too many tickets.' } },
    { key: 'script', type: 'text', advanced: true, label: { zh: '邮件 CLI 路径', en: 'Mail CLI path' },
      hint: { zh: '同时用于收信和回信；它需要 `list/read/send` 与 `--json` 支持。', en: 'Used for both polling and replying; it must support list/read/send with --json.' } },
    { key: 'credentialFile', type: 'text', advanced: true, label: { zh: '凭证文件', en: 'Credential file' },
      hint: { zh: '包含 163 授权码与白名单，权限必须是 600。', en: 'Holds the 163 auth code and whitelist; its mode must be 600.' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20,
      label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' },
      hint: { zh: '单次网络波动会在下一轮自动重试。', en: 'A single network hiccup is retried on the next poll.' } },
  ],
  // Every person who can mail the mailbox is received; the Policy's admission table decides whether a message becomes work.
  // 只由本 Source 汇报的健康项；sourceContext 按这里声明的名字校验 report。
  health: ['mail'],
  // 收件箱里的每封邮件都接收，是否成为工作由 Policy 的准入表决定；这里不观察任何回复线程。
  scope: () => ({ listened: true, observed: false }),
  channel: {
    send: async (_host, message) => {
      const to = message.channel.address.to
      if (!to) throw new Error('Missing mail reply address')
      await sendMail(active, to, message.channel.address.subject ?? 'Re:', message.text)
      return 'sent'
    },
    link: address => ({ url: '', label: { zh: `邮件 ${address.to ?? ''}`.trim(), en: `Mail ${address.to ?? ''}`.trim() } }),
  },
}

export const name = 'dsh-superagent-mail'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(mailKind), 'mail: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, mailKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('mail', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

/** Reports an error only after `failures` consecutive failed polls, so a single network hiccup stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves accounts; until then nothing is polled.
  if (!ctx.configured()) { ctx.report('mail', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<MailConfig>(SOURCE)
    try {
      if (config) {
        active = config
        await pollRound(ctx, config, signal)
        ctx.report("mail", health("ready", "mailIdle", { seconds: String(Math.max(60, config.pollSeconds)) }))
        failures = 0
      } else ctx.report('mail', health('paused', 'sourceOff'))
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 3, error)
      if (!signal.aborted && failed) ctx.report('mail', failed)
    }
    await pause(Math.max(60, ctx.config<MailConfig>(SOURCE)?.pollSeconds ?? 120) * 1000, signal)
  }
}

/** Reads the unseen mail, ingests each message not seen before, and records the ingested UIDs. */
async function pollRound(ctx: SourceContext, config: MailConfig, signal: AbortSignal): Promise<void> {
  // The first poll only records what already sits in the inbox: turning a mailbox backlog into tickets on install would
  // flood the board with work nobody asked for today.
  if (!ctx.state.get(KV.mail.initialized)) {
    const backlog = await listUnseen(config, 500)
    for (const item of backlog.items) ctx.state.set(KV.mail.seen(item.uid), new Date().toISOString())
    ctx.state.set(KV.mail.initialized, true)
    ctx.report('mail', health('ready', 'mailIdle', { seconds: String(Math.max(60, config.pollSeconds)) }))
    return
  }
  const { items } = await listUnseen(config)
  if (signal.aborted || items.length === 0) return
  for (const item of items) {
    if (signal.aborted) return
    if (ctx.state.get(KV.mail.seen(item.uid))) continue
    const body = await readBody(config, item.uid)
    if (signal.aborted) return
    await ctx.receive(mailTrigger(item, body, config.folder))
    ctx.state.set(KV.mail.seen(item.uid), new Date().toISOString())
  }
}
