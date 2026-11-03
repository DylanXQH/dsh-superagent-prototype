/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Runtime } from './app/runtime.ts'
import { setActiveWorkerRpcHub, WorkerRpcHub } from './app/worker-rpc.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile limits update in place without a restart; account changes restart dsh-superagent. DSH's settings service stops
  // serving this entry while dsh-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) })
  }
  const runtime = new Runtime(ctx, machine, restart)
  ctx.effect(() => async () => { await runtime.stop() })
  // Worker RPC endpoint: remote workers dial in and run Sessions on this router's behalf.
  // 必须在 `runtime.ready` 之前起：runtime 初始化时就会重放待处理的 launch effect，
  // 而 placement=remote 的派发要调用 hub；hub 晚一步就会有工单以
  // 「the worker RPC hub is not running」直接失败（实测重启后必现）。
  const hub = new WorkerRpcHub({
    context: ctx,
    stateDir: machine.stateDir,
    host: process.env.DSH_SUPERAGENT_RPC_HOST ?? '127.0.0.1',
    port: Number(process.env.DSH_SUPERAGENT_RPC_PORT ?? 3091),
    enrollmentTokens: await readEnrollmentTokens(machine.stateDir),
    sessionSecret: await readOrCreateSessionSecret(machine.stateDir),
    store: runtime.store,
    tls: await readTlsMaterial(),
    // 禁忌 5：ctx.logger 的内容不进 router.log（systemd 只收 stdout/stderr），
    // 诊断类输出必须走 console.error 才能落到 ~/.dsh/logs/router.log。
    log: message => { console.error(`[dsh-superagent worker-rpc] ${message}`) },
    onSessionEvents: info => {
      runtime.sessions.deliverRemoteEvents(info.sessionId, info.events)
      runtime.sessions.publishRemoteStatus(info.sessionId)
    },
    // 公理 2：机器只是「一次尝试」，不是任务的拥有者。worker 掉线 → 结束本次 attempt 并在有空位的 worker 上重派；
    // 只有连续 MAX_ATTEMPTS 次都丢掉才判失败（执行器内部判定）。因此这里不再直接把票据置为 blocked。
    onWorkerLost: info => { runtime.executor.handleWorkerLost(info.sessions) },
    // 有 worker 注册，或心跳显示还有空位：把因为「没有机器」而等待的票据重新排上（等机器 ≠ 失败）。
    onWorkerAvailable: () => { runtime.executor.retryWaitingResource() },
  })
  await hub.start()
  setActiveWorkerRpcHub(hub)
  ctx.effect(() => async () => { await hub.stop() })
  ctx.logger.info('dsh-superagent worker RPC listening on %s:%d', process.env.DSH_SUPERAGENT_RPC_HOST ?? '127.0.0.1', Number(process.env.DSH_SUPERAGENT_RPC_PORT ?? 3091))
  await runtime.ready
  ctx.logger.info(runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'
export { recall, recallCard, recallTerms, remember, retract, markUsed, isCurrent } from './app/memory-store.ts'

/** Reads the enrollment tokens a worker may present, from `<stateDir>/worker-enrollment.json` (bare array or `{tokens: []}`). */
async function readEnrollmentTokens(stateDir: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(stateDir, 'worker-enrollment.json'), 'utf8'))
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string')
    const tokens = parsed && typeof parsed === 'object' ? (parsed as { tokens?: unknown }).tokens : undefined
    return Array.isArray(tokens) ? tokens.filter((item): item is string => typeof item === 'string') : []
  } catch { return [] }
}

/** Reads, or creates once, the HMAC secret that signs short-lived worker session tokens. */
async function readOrCreateSessionSecret(stateDir: string): Promise<string> {
  const file = join(stateDir, 'session-secret')
  try { return (await readFile(file, 'utf8')).trim() } catch { /* created below */ }
  await mkdir(stateDir, { recursive: true })
  const secret = randomBytes(48).toString('base64url')
  await writeFile(file, secret, { mode: 0o600 })
  return secret
}

/** Reads the TLS material for the worker RPC endpoint, when both paths are configured. */
async function readTlsMaterial(): Promise<{ key: string; cert: string } | undefined> {
  const cert = process.env.DSH_SUPERAGENT_RPC_TLS_CERT, key = process.env.DSH_SUPERAGENT_RPC_TLS_KEY
  if (!cert || !key) return undefined
  return { cert: await readFile(cert, 'utf8'), key: await readFile(key, 'utf8') }
}
