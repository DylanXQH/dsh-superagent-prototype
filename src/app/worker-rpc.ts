/**
 * router 侧的 worker 接入点（协议 v1 · P2 会话面）。
 *
 * 职责边界：
 *  - 起 WebSocket 服务端，接受 worker 主动外连（拓扑反转，见 protocol/remote-protocol-v1.md §3.1）
 *  - `worker.initialize` 握手：版本协商、enrollment 校验、签发短期 sessionToken
 *  - `worker.heartbeat`：续租、在线状态与并发水位
 *  - `worker.event.batch`：事件落盘到 per-session Journal（router 侧校验 seq 单调且不跳号），
 *    回 `ackedSeq` 让 worker 裁剪本地缓冲
 *
 * 本类**不碰 executor**：P4 才把 executor 从「进程内 Agent」换成「远程 session」。
 * P2 单独验证「连接 + 握手 + 事件不丢不乱序」，避免被 executor 改造拖住。
 */
import { randomBytes } from 'node:crypto';
import { remember } from './memory-store.ts';
import type { Store } from './store.ts';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import {
  NonceCache,
  NotificationMethods,
  PROTOCOL_VERSION,
  RpcError,
  RpcErrorCode,
  RouterMethods,
  RpcServer,
  SessionJournal,
  TokenSigner,
  WorkerMethods,
  eventLevel,
  negotiateVersion,
  type EventBatchParams,
  type EventBatchResult,
  type EventPullParams,
  type EventPullResult,
  type HeartbeatParams,
  type HeartbeatResult,
  type InitializeParams,
  type InitializeResult,
  type RpcMeta,
  type RpcServerConnection,
  type RequestContext,
  type WithMeta,
} from '@dsh-superagent/rpc';

/** 短期 sessionToken 有效期；worker 靠心跳续租，过期后必须重新 initialize。 */
const LEASE_TTL_MS = 90_000;
/** router 允许 worker 同时在途的事件批次数（背压窗口）。 */
const MAX_IN_FLIGHT = 8;
/** 单批事件条数上限，与 worker 侧 batchSize 对齐。 */
const EVENT_BATCH_MAX = 256;

export interface WorkerRecord {
  workerId: string;
  instanceId: string;
  name: string;
  version: string;
  platform: string;
  models: string[];
  maxConcurrentSessions: number;
  connectionId: string;
  remoteAddress: string | undefined;
  connectedAt: number;
  lastSeenAt: number;
  activeSessions: number;
  /**
   * 路由器视角的占用量。
   *
   * `activeSessions` 只随 worker 的 30 秒心跳更新，而调度发生在两次心跳之间：
   * 若只看心跳值，连续下发的几个会话会全部落到同一台机器上，把它压垮。
   */
  assignedSessions: number;
  /** router 下发给该 worker 的短期 token。P3 会换成 HMAC 签名并在每个请求上校验。 */
  sessionToken: string;
  /**
   * worker 自报的开放能力标签（`env.os` / `tool.xcode` / `zone` 等），router 调度时用。
   * 缺省为空：老版本 worker 不报，调度器按「任意空闲 worker」回退。
   */
  tags?: Record<string, string | number | boolean>;
}

export interface WorkerRpcHubOptions {
  /** 公网部署时的 TLS 材料；提供后监听 HTTPS，worker 用 wss:// 连接。 */
  tls?: { key: string | Buffer; cert: string | Buffer };
  /**
   * 每批事件落盘后的回调（seq 已去重、顺序已保证）。
   * router 侧的执行器靠它把 worker 的事件接回自己的状态机，等价于进程内的 `session/event`。
   */
  onSessionEvents?: (info: { workerId: string; sessionId: string; events: readonly unknown[] }) => void;
  /**
   * 一台 worker 断开时，它当时托管的会话。
   * 远程化后会话状态只存在于 worker 上，掉线若不在这里收尾，票据会永远停在 working。
   */
  onWorkerLost?: (info: { workerId: string; sessions: readonly string[] }) => void;
  /**
   * 有 worker 可用（注册成功，或心跳表明它还有空位）时回调。
   * 公理 2 的「等机器」状态靠它复活：没有这条信号，waiting-resource 的票据只能等人手动重试。
   */
  onWorkerAvailable?: (info: { workerId: string }) => void;
  context: Context;
  /** router 侧状态目录；worker 事件与注册表都落在其下。 */
  stateDir: string;
  /** 监听地址。跨机部署需显式设为 Tailscale 地址或 0.0.0.0（并前置 TLS）。 */
  host?: string;
  port?: number;
  path?: string;
  /** 允许的 enrollment token 集合。P3 换成「生成-绑定-轮换-吊销」的完整体系。 */
  enrollmentTokens: readonly string[];
  /** 签发短期 sessionToken 的 HMAC 密钥（至少 32 字节）。 */
  sessionSecret: Buffer | string;
  /**
   * 记忆库：握手时把 worker 上报的能力落成 `env` 事实（带 owner 与 TTL），派单时再召回给该 worker。
   * 省略则完全不做环境记忆，连接行为不变。
   */
  store?: Pick<Store, 'memories'>;
  log?: (message: string) => void;
}

let activeHub: WorkerRpcHub | undefined;

/** 把当前进程的 hub 暴露给 HTTP 层：P2 的调试端点与 P4 的 executor 共用同一个实例。 */
export function setActiveWorkerRpcHub(hub: WorkerRpcHub | undefined): void {
  activeHub = hub;
}

export function activeWorkerRpcHub(): WorkerRpcHub | undefined {
  return activeHub;
}

export class WorkerRpcHub {
  readonly #options: WorkerRpcHubOptions;
  readonly #workers = new Map<string, WorkerRecord>();
  readonly #journals = new Map<string, SessionJournal>();
  readonly #journalRoot: string;
  readonly #signer: TokenSigner;
  readonly #nonces = new NonceCache();
  #server: RpcServer | undefined;
  /** 仍在 ensure 过程中的占位（会话还没真正出现在 worker 的活动会话里）。 */
  readonly #inFlight = new Map<string, number>();
  /** 每台 worker 当前托管的会话；掉线时用来把它们的票据收尾。 */
  readonly #assigned = new Map<string, Set<string>>();

  constructor(options: WorkerRpcHubOptions) {
    this.#options = options;
    this.#journalRoot = join(options.stateDir, 'worker-events');
    this.#signer = new TokenSigner(options.sessionSecret, LEASE_TTL_MS);
  }

  get workers(): readonly WorkerRecord[] {
    // 对外只暴露可观测字段：sessionToken 是 90 秒短期凭证，绝不进 HTTP 响应或日志。
    return [...this.#workers.values()].map(({ sessionToken: _omit, ...rest }) => rest as WorkerRecord);
  }

  /**
   * 挑一台还有余量的 worker：有效负载取「心跳上报」与「路由器已派发」的较大者。
   * 没有可用节点时返回 undefined，由调用方决定是排队还是拒绝。
   */
  pickWorker(): WorkerRecord | undefined {
    return [...this.#workers.values()]
      .filter(worker => this.#load(worker) < worker.maxConcurrentSessions)
      .sort((left, right) => this.#load(left) - this.#load(right))[0];
  }

  /** 派发前占位，避免并发派发都选中同一台机器。 */
  reserve(workerId: string): void {
    const worker = this.#workers.get(workerId);
    if (!worker) return;
    worker.assignedSessions += 1;
    this.#inFlight.set(workerId, (this.#inFlight.get(workerId) ?? 0) + 1);
  }

  /** ensure 已返回：会话开始在 worker 上运行，占位转交给心跳里的 activeSessions。 */
  settle(workerId: string): void {
    const current = this.#inFlight.get(workerId) ?? 0;
    if (current <= 1) this.#inFlight.delete(workerId);
    else this.#inFlight.set(workerId, current - 1);
  }

  /** 会话结束后归还配额（幂等：计数不会降到 0 以下）。 */
  release(workerId: string): void {
    const worker = this.#workers.get(workerId);
    if (worker) worker.assignedSessions = Math.max(0, worker.assignedSessions - 1);
  }

  #load(worker: WorkerRecord): number {
    return Math.max(worker.activeSessions, worker.assignedSessions);
  }

  /**
   * 读取某会话已落盘的 L1 事件（RemoteAgent 用它实现 snapshotEvents / history）。
   *
   * 返回的是原始 DSH session 事件（信封里的 `data`），与 worker 本地实时事件的
   * 形状一致——RemoteAgent 只认识一种事件形状，嵌套解包只在这一处发生。
   */
  async eventsOf(sessionId: string, limit = 200): Promise<readonly unknown[]> {
    const journal = await this.#journal(sessionId);
    const events = await journal.replay(0, limit);
    return events.map(entry => (entry as { data?: unknown }).data ?? entry);
  }

  /**
   * 按需回拉某会话在 worker 本地的事件日志（含 L3 全文）。
   *
   * router 侧只落盘 L1，L2 只进内存，L3 从不外发；需要还原「当时到底发生了什么」
   * 时（UI 排障、ticket 归档）走这条通道，避免为偶然观测付出常驻存储与带宽。
   */
  async pullEvents(sessionId: string, params: Omit<EventPullParams, 'sessionId'> = {}): Promise<EventPullResult> {
    const workerId = this.#ownerOf(sessionId);
    if (workerId === undefined) {
      throw new RpcError(RpcErrorCode.SessionOrphaned, `no worker holds session ${sessionId}`, { retryable: false });
    }
    return this.callWorker<EventPullResult>(workerId, RouterMethods.EventsPull, { sessionId, ...params });
  }

  /** 从 #assigned 反查会话所在 worker（callWorker / ensure 时登记）。 */
  #ownerOf(sessionId: string): string | undefined {
    for (const [workerId, sessions] of this.#assigned) {
      if (sessions.has(sessionId)) return workerId;
    }
    return undefined;
  }

  get listeningPort(): number {
    return this.#server?.listeningPort ?? 0;
  }

  async start(): Promise<void> {
    if (this.#server) return;
    await mkdir(this.#journalRoot, { recursive: true });
    const server = new RpcServer({
      host: this.#options.host ?? '127.0.0.1',
      port: this.#options.port ?? 3091,
      path: this.#options.path ?? '/rpc',
      ...(this.#options.tls ? { tls: this.#options.tls } : {}),
      // P3 才上 Origin 白名单；当前靠 enrollment token + 只监听内网地址。
      verifyOrigin: () => true,
      onConnection: connection => { this.#attach(connection); },
      onClose: connection => { this.#forget(connection); },
      debug: message => { this.#log(message); },
    });
    this.#server = server;
    const address = await server.start();
    this.#log(`worker rpc listening on ${address.host}:${address.port}${this.#options.path ?? '/rpc'}`);
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#workers.clear();
    this.#journals.clear();
    await server?.stop();
  }

  /** 某 session 已落盘的最大 seq，供 P4 的 executor 判断进度。 */
  journalFor(sessionId: string): Promise<SessionJournal> {
    return this.#journal(sessionId);
  }

  /**
   * 向指定 worker 下发一次 RPC 调用。
   * P4 的 `RemoteSessions` 会用它替代进程内 `Agent` 调用；P2 先用它做端到端验收。
   */
  async callWorker<T>(workerId: string, method: string, params: unknown, timeoutMs?: number): Promise<T> {
    const connection = this.#connectionFor(workerId);
    const sessionId = (params as { sessionId?: unknown } | undefined)?.sessionId;
    if (typeof sessionId === 'string') {
      const held = this.#assigned.get(workerId) ?? new Set<string>();
      held.add(sessionId);
      this.#assigned.set(workerId, held);
    }
    // 双向请求都带 _meta：worker 侧将来校验 router 发起的方向时不需要改协议。
    const withMeta = {
      ...(params as Record<string, unknown>),
      _meta: { ts: Date.now(), nonce: randomBytes(12).toString('base64url') },
    };
    // timeoutMs 用于 session.ensure 这类含 git clone 的长操作（默认 15s 远远不够）。
    return (await connection.channel.call(method, withMeta, timeoutMs)) as T;
  }

  #connectionFor(workerId: string): RpcServerConnection {
    const record = this.#workers.get(workerId);
    if (!record) {
      throw new RpcError(RpcErrorCode.WorkerNotRegistered, `unknown worker ${workerId}`, { retryable: false });
    }
    const connection = this.#server?.connections.find(candidate => candidate.id === record.connectionId);
    if (!connection) {
      throw new RpcError(RpcErrorCode.SessionOrphaned, `worker ${workerId} is offline`, { retryable: true });
    }
    return connection;
  }

  #log(message: string): void {
    this.#options.log?.(message);
  }

  #attach(connection: RpcServerConnection): void {
    connection.channel.register(WorkerMethods.Initialize, params => this.#initialize(connection, params as InitializeParams));
    // 除 initialize 外的方法都必须携带有效 sessionToken + 新鲜 nonce。
    this.#guarded(connection, WorkerMethods.Heartbeat, params => this.#heartbeat(connection, params as HeartbeatParams));
    this.#guarded(connection, WorkerMethods.EventBatch, params => this.#eventBatch(connection, params as EventBatchParams));
    this.#guarded(connection, WorkerMethods.SessionReport, async () => ({ ok: true }));
    connection.channel.register(NotificationMethods.WorkerReady, async params => {
      this.#log(`worker ${connection.workerId ?? connection.id} ready: ${JSON.stringify(params)}`);
    });
  }

  #guarded(
    connection: RpcServerConnection,
    method: string,
    handler: (params: unknown) => Promise<unknown>,
  ): void {
    connection.channel.register(method, async (params, context) => {
      this.#authorize(connection, params, context);
      return handler(params);
    });
  }

  /** P3 鉴权：token 合法 + 属于本连接 + nonce 未重放 + 时间戳在窗口内。 */
  #authorize(connection: RpcServerConnection, params: unknown, context: RequestContext): void {
    const meta = (params as WithMeta | undefined)?._meta;
    if (!meta || typeof meta.token !== 'string') {
      throw new RpcError(RpcErrorCode.Unauthorized, 'missing session token in _meta', { retryable: false });
    }
    const claims = this.#signer.verify(meta.token);
    if (!claims || claims.workerId !== connection.workerId) {
      throw new RpcError(RpcErrorCode.Unauthorized, 'invalid or expired session token', { retryable: false });
    }
    if (!this.#nonces.accept(meta.nonce, meta.ts)) {
      throw new RpcError(RpcErrorCode.Unauthorized, 'replayed or stale request', { retryable: false });
    }
  }

  #forget(connection: RpcServerConnection): void {
    const workerId = connection.workerId;
    if (!workerId) return;
    const record = this.#workers.get(workerId);
    // 同一 worker 可能已有新连接（重连），只清理属于本连接的那条记录。
    if (record?.connectionId !== connection.id) return;
    this.#workers.delete(workerId);
    this.#inFlight.delete(workerId);
    const lost = [...(this.#assigned.get(workerId) ?? [])];
    this.#assigned.delete(workerId);
    this.#log(`worker ${workerId} disconnected`);
    if (lost.length > 0) this.#options.onWorkerLost?.({ workerId, sessions: lost });
  }

  #requireWorker(connection: RpcServerConnection): WorkerRecord {
    const workerId = connection.workerId;
    const worker = workerId ? this.#workers.get(workerId) : undefined;
    if (!worker) {
      throw new RpcError(RpcErrorCode.WorkerNotRegistered, 'worker must call worker.initialize first', { retryable: false });
    }
    return worker;
  }

  async #initialize(connection: RpcServerConnection, params: InitializeParams): Promise<InitializeResult> {
    const negotiated = negotiateVersion(params.protocolVersion, [params.protocolVersion], [PROTOCOL_VERSION]);
    if (!negotiated) {
      throw new RpcError(
        RpcErrorCode.UnsupportedProtocolVersion,
        `unsupported protocol version ${params.protocolVersion}`,
        { supported: [PROTOCOL_VERSION], retryable: false },
      );
    }
    const token = params.auth?.enrollmentToken;
    if (typeof token !== 'string' || !this.#options.enrollmentTokens.includes(token)) {
      throw new RpcError(RpcErrorCode.Unauthorized, 'enrollment token rejected', { retryable: false });
    }
    const instanceId = params.auth.instanceId;
    if (typeof instanceId !== 'string' || instanceId.length === 0) {
      throw new RpcError(RpcErrorCode.Unauthorized, 'auth.instanceId is required', { retryable: false });
    }
    const workerId = `${params.workerInfo.name}#${instanceId.slice(0, 8)}`;
    // P3：token 带签名与过期时间，不再是不透明的随机串；worker 每个请求都要回传它。
    const issued = this.#signer.issue(workerId, instanceId);
    const sessionToken = issued.token;
    const previous = this.#workers.get(workerId);
    const record: WorkerRecord = {
      workerId,
      instanceId,
      name: params.workerInfo.name,
      version: params.workerInfo.version,
      platform: params.workerInfo.platform,
      models: [...params.capabilities.models],
      maxConcurrentSessions: params.capabilities.maxConcurrentSessions,
      connectionId: connection.id,
      remoteAddress: connection.remoteAddress,
      connectedAt: previous?.connectedAt ?? Date.now(),
      lastSeenAt: Date.now(),
      activeSessions: previous?.activeSessions ?? 0,
      assignedSessions: previous?.assignedSessions ?? 0,
      sessionToken,
      ...(params.capabilities.tags && Object.keys(params.capabilities.tags).length > 0
        ? { tags: params.capabilities.tags }
        : {}),
    };
    this.#workers.set(workerId, record);
    connection.workerId = workerId;
    // 环境事实：worker 每次握手都重新探测，所以这里只落「本次探测的结论」，靠 TTL 自然过期而不是靠人工维护。
    this.#rememberEnvironment(record, params);
    this.#log(`worker ${workerId} initialized (protocol ${negotiated.version}/${negotiated.negotiated}, remote ${record.remoteAddress ?? '?'})`);
    this.#options.onWorkerAvailable?.({ workerId });
    if (params.resume?.sessions.length) {
      this.#log(`worker ${workerId} resumed ${params.resume.sessions.length} session(s) at seq ${params.resume.sessions.map(s => `${s.sessionId}@${s.lastAckedSeq}`).join(', ')}`);
    }
    return {
      protocolVersion: negotiated.version,
      negotiated: negotiated.negotiated,
      capabilities: {
        methods: Object.values(WorkerMethods),
        maxInFlight: MAX_IN_FLIGHT,
        eventBatchMax: EVENT_BATCH_MAX,
      },
      routerInfo: { name: 'dsh-superagent', version: '0.2.0' },
      sessionToken,
      leaseTtlMs: LEASE_TTL_MS,
      workerId,
    };
  }

  /**
   * Records the facts a worker reported about its own machine as `env` memories owned by that worker.
   * Values are re-probed on every handshake, so a stale fact is replaced rather than believed; the 7-day TTL covers workers
   * that stop connecting altogether. Unchanged values are not rewritten, which keeps the history readable.
   */
  #rememberEnvironment(record: WorkerRecord, params: InitializeParams): void {
    const store = this.#options.store;
    if (!store) return;
    const facts: [string, string][] = [
      ['platform', params.workerInfo.platform],
      ['models', [...params.capabilities.models].join(', ') || 'unknown'],
      ['max-concurrent-sessions', String(params.capabilities.maxConcurrentSessions)],
      ['worker-version', params.workerInfo.version],
    ]
    for (const [name, value] of facts) {
      const key = `probe-${name}`;
      // Owner is the worker's configured name, not the per-process instance id: a restart must not fork the machine's facts.
      const existing = store.memories.list({ scope: 'env', owner: record.name, limit: 200 }).find(entry => entry.key === key)
      if (existing?.value === value) continue;
      remember(store, { scope: 'env', owner: record.name, kind: 'fact', key, value, confidence: 0.7, source: 'observed-trusted',
        evidence: [`handshake:${record.workerId}`], ttlDays: 7 });
    }
  }

  async #heartbeat(connection: RpcServerConnection, params: HeartbeatParams): Promise<HeartbeatResult> {
    const worker = this.#requireWorker(connection);
    worker.lastSeenAt = Date.now();
    const freed = worker.activeSessions > params.activeSessions;
    worker.activeSessions = params.activeSessions;
    // 以心跳的真实活动数为准：worker 回收了空闲会话，路由器的配额也必须跟着回落，
    // 否则一台只会「越跑越满」的机器永远接不到新任务。只额外保留仍在 ensure 的占位。
    worker.assignedSessions = Math.max(params.activeSessions, this.#inFlight.get(worker.workerId) ?? 0);
    // 每次心跳都续签：token TTL 90s，心跳 30s，续签窗口足够。
    const rotated = this.#signer.issue(worker.workerId, worker.instanceId);
    // 心跳是「容量可能变了」的唯一周期性信号：会话回收（freed）或仍有空位时，让执行器试着放下等待机器的票据。
    if (freed || worker.assignedSessions < worker.maxConcurrentSessions) this.#options.onWorkerAvailable?.({ workerId: worker.workerId });
    return { leaseRemainingMs: LEASE_TTL_MS, paused: false, sessionToken: rotated.token };
  }

  async #eventBatch(connection: RpcServerConnection, params: EventBatchParams): Promise<EventBatchResult> {
    const worker = this.#requireWorker(connection);
    const journal = await this.#journal(params.sessionId);
    // 公理 3：router 只把 L1 当权威状态落盘；L2 只进内存（onSessionEvents 派发给
    // RemoteAgent/UI），L3 根本不会出现在这一批里（worker 侧已裁掉）。
    // 因此 router 侧 seq 允许跳跃，ackedSeq 语义是「最远已落盘的 L1 seq」。
    const stored = params.events.filter(event => eventLevel(event) === 'L1');
    const deliverable = params.events.filter(event => eventLevel(event) !== 'L3');
    // 分级契约的常驻守卫：worker 侧本不该把 L3 发出来（那是在为偶然观测付带宽）。
    // 真发出来了说明 worker 的分级被改坏或版本不一致——留一行日志，别用静默丢弃掩盖。
    const leaked = params.events.filter(event => eventLevel(event) === 'L3');
    if (leaked.length > 0) {
      const sample = leaked.slice(0, 3).map(event => event.type).join(',');
      this.#log(`事件分级契约违规：worker ${worker.workerId} 上报了 ${leaked.length} 条 L3 事件（session=${params.sessionId}，如 ${sample}），已丢弃不落盘`);
    }
    try {
      await journal.append(stored);
    } catch (error) {
      // 跳号 / 非法事件：让 worker 重新对齐，而不是静默吞掉（否则 seq 会永久空洞）。
      this.#log(`worker ${worker.workerId} event.batch rejected for ${params.sessionId}: ${String(error)}`);
      throw new RpcError(RpcErrorCode.InternalFailure, String(error), { retryable: true, retryAfterMs: 200 });
    }
    worker.lastSeenAt = Date.now();
    // 只在真的有新事件时派发：重复批次（ack 丢失后的重传）不会再触发执行器。
    if (deliverable.length > 0) {
      try {
        this.#options.onSessionEvents?.({
          workerId: worker.workerId,
          sessionId: params.sessionId,
          events: deliverable,
        });
      } catch (error) {
        this.#log(`onSessionEvents 回调异常: ${String(error)}`);
      }
    }
    return { ackedSeq: journal.lastSeq };
  }

  async #journal(sessionId: string): Promise<SessionJournal> {
    const cached = this.#journals.get(sessionId);
    if (cached) return cached;
    // router 侧只落盘 L1，seq 必然有空洞；worker 侧仍严格连续（空洞=真的丢事件）。
    const journal = new SessionJournal(this.#journalRoot, sessionId, { allowGaps: true });
    await journal.load();
    this.#journals.set(sessionId, journal);
    return journal;
  }
}
