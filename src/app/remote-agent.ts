/**
 * router 侧的「远程会话」适配器。
 *
 * executor 原本直接操作进程内的 DSH Agent（`id` / `inbox` / `whenIdle` / `cancel` / `session.snapshotEvents`）。
 * 把执行搬到远程 worker 后，这些成员必须仍然可用——本类用鸭子类型提供同样的表面，
 * 内部全部转成协议调用，于是 executor 不需要知道自己面对的是本地 Agent 还是远程 worker。
 */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * 统一事件形状：RemoteAgent 内部只存原始 DSH session 事件 `{type, seq, time, data}`。
 *
 * 入参有三种历史形态，必须在这一处收敛，否则下游（executor 的 relay、retry-health）
 * 会同时面对三种嵌套深度：
 *  - 线上信封 `{seq, ts, type, data: 原始事件}`（applyEvents，来自 worker 的 event.batch）
 *  - 旧的包装 `{event: ...}`（早期日志格式）
 *  - 已经是原始事件（history 回调、worker 的 events.pull）
 */
function normalizeEvent(value: unknown): unknown {
  const record = asRecord(value)
  if (record === undefined) return value
  if ('event' in record) return normalizeEvent(record.event)
  const inner = asRecord(record.data)
  // 信封的 data 本身是一个完整事件（有自己的 type + seq）；原始事件的 data 是业务 payload。
  if (
    typeof record.type === 'string' &&
    typeof record.seq === 'number' &&
    typeof inner?.type === 'string' &&
    typeof inner.seq === 'number'
  ) {
    return inner
  }
  return value
}

const MESSAGE_PREFIX = 'dsh-superagent:';

type RemoteStatus = 'idle' | 'running';

interface RemoteAgentOptions {
  workerId: string;
  sessionId: string;
  /** 协议调用入口；用接口而非具体类，便于测试注入。 */
  call: <T>(method: string, params: unknown) => Promise<T>;
  /** 读取已落盘的历史事件（首次构造时用来补齐状态）。 */
  history?: () => Promise<readonly unknown[]>;
  log?: (message: string) => void;
  /** The router-side effect of a tool call it cannot run itself: `orchestrator_report`. */
  onReport?: (args: unknown, callId: string) => void;
}

/** executor 只需要这些成员；显式声明出来，避免把一个完整的 DSH Agent 当作契约。 */
export interface ExecutorAgent {
  readonly id: string;
  readonly status: string;
  readonly inbox: { remove(messageId: string): void };
  readonly session: { snapshotEvents(): readonly unknown[] };
  cancel(reason: { kind: string }, options?: { keepInbox?: boolean }): void;
  whenIdle(): Promise<void>;
}

export class RemoteAgent implements ExecutorAgent {
  /** 标记位：执行器据此跳过只对本地会话成立的逻辑（后台作业、inbox 内部结构等）。 */
  readonly remote = true;
  readonly id: string;
  readonly workerId: string;

  readonly inbox = {
    remove: (messageId: string): void => {
      // executor 传进来的是 `promptedId(requestId)`，反向解析回 requestId 才能走协议。
      const requestId = messageId.startsWith(MESSAGE_PREFIX) ? messageId.slice(MESSAGE_PREFIX.length) : messageId;
      void this.#removeInput(requestId);
    },
  };

  readonly session = {
    snapshotEvents: (): readonly unknown[] => this.#events,
  };

  readonly #call: RemoteAgentOptions['call'];
  readonly #log: (message: string) => void;
  #status: RemoteStatus = 'idle';
  #events: unknown[] = [];
  /** 已入列事件的 seq 水位：history 与实时事件交错到达时用来去重。 */
  readonly #seen = new Set<number>();
  #waiters: Array<() => void> = [];
  #disposed = false;
  #hydrated = false;
  /** The report calls already applied, keyed by their call id: an event replay must not report twice. */
  readonly #reported = new Set<string>();
  /** Whether this turn produced a report; a completed turn without one is the gap the fallback fills. */
  #reportedThisTurn = false;
  /** Completed turns in a row that ended without reporting, which turns the fallback from a nudge into a block. */
  #silentTurns = 0;
  /** When this Session last produced an event; the router's watchdog reads it to find one that stopped progressing. */
  #lastEventAt = Date.now();
  /** Applies a remote `orchestrator_report` call on the router side. */
  readonly #onReport?: (args: unknown, callId: string) => void;
  /** The status last handed to DSH's `agent/status` listeners, so the bridge emits only transitions. */
  lastPublished: string | undefined;

  constructor(options: RemoteAgentOptions) {
    this.id = options.sessionId;
    this.workerId = options.workerId;
    this.#call = options.call;
    this.#log = options.log ?? (() => undefined);
    this.#onReport = options.onReport;
    if (options.history) {
      void options
        .history()
        .then(events => {
          this.#hydrated = true;
          // 历史与实时事件可能交错到达：统一按 seq 去重，谁先到都不影响状态机。
          for (const event of events) this.#push(event);
        })
        .catch(error => {
          this.#log(`远程会话 ${this.id} 历史事件加载失败: ${String(error)}`);
        });
    } else {
      this.#hydrated = true;
    }
  }

  /** When this Session last produced an event. */
  get lastEventAt(): number { return this.#lastEventAt }
  get status(): string {
    return this.#status;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** hub 收到新事件后调用；worker 侧已按 L1/L2 裁剪，这里再按 seq 兜一层幂等。 */
  applyEvents(envelopes: readonly unknown[]): void {
    for (const envelope of envelopes) this.#push(envelope);
  }

  /** 归一 + 去重 + 入列 + 应用；返回是否真的接受了这条事件。 */
  #push(value: unknown): boolean {
    const event = normalizeEvent(value);
    const seq = asRecord(event)?.seq;
    if (typeof seq === 'number') {
      if (this.#seen.has(seq)) return false;
      this.#seen.add(seq);
    }
    this.#events.push(event);
    this.#apply(event);
    // 只保留最近 2000 条：executor 只关心最近的 assistant 消息与状态跃迁。
    if (this.#events.length > 2000) {
      this.#events = this.#events.slice(-2000);
      this.#seen.clear();
      for (const kept of this.#events) {
        const keptSeq = asRecord(kept)?.seq;
        if (typeof keptSeq === 'number') this.#seen.add(keptSeq);
      }
    }
    return true;
  }

  async prompt(requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }): Promise<void> {
    await this.#call('session.prompt', { sessionId: this.id, requestId, text, mode });
  }

  async holds(requestId: string): Promise<boolean> {
    const result = await this.#call<{ holds: boolean }>('session.status', { sessionId: this.id });
    void result;
    // 幂等由 worker 侧 AgentDelivery.holds 保证；router 认为「已投递过」即视为持有。
    return this.#delivered.has(requestId);
  }

  cancel(reason: { kind: string }, _options?: { keepInbox?: boolean }): void {
    this.#log(`远程会话 ${this.id} 中断（${reason.kind}）`);
    void this.#call('session.interrupt', { sessionId: this.id, keepInbox: true }).catch(error => {
      this.#log(`远程会话 ${this.id} 中断失败: ${String(error)}`);
    });
  }

  whenIdle(): Promise<void> {
    if (this.#disposed || this.#status === 'idle') return Promise.resolve();
    return new Promise<void>(resolve => {
      this.#waiters.push(resolve);
    });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      await this.#call('session.dispose', { sessionId: this.id });
    } catch (error) {
      this.#log(`远程会话 ${this.id} 释放失败: ${String(error)}`);
    }
    this.#wake();
  }

  async #removeInput(requestId: string): Promise<void> {
    try {
      await this.#call('session.removeInput', { sessionId: this.id, requestId });
    } catch (error) {
      this.#log(`远程会话 ${this.id} 撤回输入失败: ${String(error)}`);
    }
  }

  #apply(event: unknown): void {
    this.#lastEventAt = Date.now();
    const record = event as { type?: string; status?: string };
    // A worker Session that ends a turn `completed` without ever reporting leaves the ticket at `working` with no
    // summary and nobody told, which is exactly what a person reports as "it said it was on it and nothing happened".
    // The first such turn nudges `progress`, the second blocks the ticket so the router stops claiming it is running.
    if (record.type === 'turn/end') {
      const reason = (event as { data?: { reason?: { kind?: string } } }).data?.reason?.kind;
      // 一轮结束 = 会话空闲；这一句必须在分支内执行，否则 whenIdle() 永远不返回。
      this.#setStatus('idle');
      if (reason === 'completed' && !this.#reportedThisTurn) {
        this.#silentTurns += 1;
        const summary = '这一轮已经结束，但没有通过 orchestrator_report 汇报结论。';
        this.#onReport?.(this.#silentTurns >= 2
          ? { state: 'blocked', summary: `${summary}连续 ${this.#silentTurns} 轮如此，已标记为阻塞，请安排人看一下这个会话。` }
          : { state: 'progress', summary: `${summary}如果还有下一步就继续；再有一轮不汇报会判为卡住。` },
          `autoreport:${this.id}:${String(Date.now())}`);
      }
      if (reason === 'completed') this.#reportedThisTurn = false;
      return;
    }
    // `orchestrator_report` runs on the router, not on the worker: the worker registers an inert tool so the call
    // shows up in the event stream, and this is where it takes effect there.
    if (record.type === 'tool/call') {
      // 原始事件形状：payload 直接挂在 event.data 上（信封的 data.data 嵌套已在 normalizeEvent 消除）。
      const call = (event as { data?: { name?: string; arguments?: string; callId?: string } }).data;
      if (call?.name === 'orchestrator_report' && typeof call.arguments === 'string') {
        const callId = call.callId ?? `${this.id}:report`;
        if (!this.#reported.has(callId)) {
          this.#reported.add(callId);
          this.#reportedThisTurn = true;
          this.#silentTurns = 0;
          try { this.#onReport?.(JSON.parse(call.arguments) as unknown, callId); }
          catch (error) { this.#log(`远程会话 ${this.id} 的 orchestrator_report 参数无法解析: ${String(error)}`); }
        }
      }
      return;
    }
    if (record.type === 'turn/start' || record.type === 'turn/step/start' || record.type === 'step/start') {
      this.#setStatus('running');
      return;
    }
    if (record.type === 'session/idle') {
      this.#setStatus('idle');
      return;
    }
    if (record.type === 'agent/status' && typeof record.status === 'string') {
      this.#setStatus(record.status === 'idle' ? 'idle' : 'running');
    }
  }

  #setStatus(next: RemoteStatus): void {
    if (this.#status === next) return;
    this.#status = next;
    if (next === 'idle') this.#wake();
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const wake of waiters) wake();
  }

  /** 已投递过的 requestId（router 侧幂等记录）。 */
  readonly #delivered = new Set<string>();

  /** 记录一次投递，供 `holds` 使用（重复投递由 worker 侧再兜一层）。 */
  markDelivered(requestId: string): void {
    this.#delivered.add(requestId);
  }

  get hydrated(): boolean {
    return this.#hydrated;
  }
}
