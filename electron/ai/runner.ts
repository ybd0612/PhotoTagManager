import { loadTimeoutMsFor, type BackendPreference, type ChildReply, type ChildRequest, type InferFeedsReply, type InferFeedsRequest, type InferReply } from './inferenceChild';
import type { ModelSpec } from './capabilityCatalog';

/**
 * 主进程侧的子进程管家（D9 / D12 的落点）。
 *
 * 职责只有三件：把请求送进子进程、在硬超时内拿到答复、子进程死了就重启并让
 * **当次任务**以可读错误失败——绝不把崩溃带进主进程，也绝不让调用方无限等。
 * 具体的张量形状与输出选择都在清单里，这里不出现任何模型专有常量。
 */

export interface ChildHandle {
  postMessage(message: ChildRequest): void;
  kill(): void;
}

export type ChildEvent =
  | { type: 'message'; payload: ChildReply }
  | { type: 'exit'; code: number | null };

export type ChildListener = (event: ChildEvent) => void;

/** 由 Electron 的 utilityProcess 或测试假件实现。 */
export interface SpawnedChild extends ChildHandle {
  onMessage(listener: ChildListener): void;
}

export type SpawnChild = (entry: string) => SpawnedChild;

export interface InferenceRunner {
  readonly loadedModelId: string | null;
  readonly restartCount: number;
  load(req: { modelPath: string; model: ModelSpec; backend?: BackendPreference }): Promise<number>;
  infer(req: { modelId: string; dims: number[]; data: Float32Array }): Promise<InferReply>;
  unload(): Promise<void>;
  loadNamed?(sessionKey: string, req: { modelPath: string; model: ModelSpec; backend?: BackendPreference }): Promise<number>;
  inferFeeds?(req: InferFeedsRequest): Promise<InferFeedsReply>;
  unloadNamed?(sessionKey: string): Promise<void>;
  dispose(): Promise<void>;
}

export class ChildNotRespondingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChildNotRespondingError';
  }
}

/**
 * 把 Electron 的 utilityProcess 适配成 ChildRunner 需要的 SpawnedChild。
 *
 * 由调用方把 `utilityProcess` 传进来（而不是在这里 import 'electron'），
 * 这样 runner 模块在 node 环境也能安全 import、生命周期可以用假件测。
 */
export interface UtilityProcessLike {
  fork(modulePath: string): {
    postMessage(message: unknown): void;
    kill(): void;
    on(event: 'message', listener: (message: ChildReply) => void): void;
    on(event: 'exit', listener: (code: number | null) => void): void;
  };
}

export function makeUtilityProcessSpawner(utilityProcess: UtilityProcessLike): SpawnChild {
  return (entry: string): SpawnedChild => {
    const child = utilityProcess.fork(entry);
    return {
      postMessage: (message) => child.postMessage(message),
      kill: () => {
        child.kill();
      },
      onMessage: (listener) => {
        // 别在这里读 message.data：父进程的 'message' 直接把消息本体交出来，
        // 套 { data } 信封的是子进程那侧的 process.parentPort。读错层会让 reply.id
        // 变成 undefined、在途请求永不结算，真机上表现为每次加载都等到超时。
        child.on('message', (message) => listener({ type: 'message', payload: message }));
        child.on('exit', (code) => listener({ type: 'exit', code }));
      }
    };
  };
}

export interface ChildRunnerOptions {
  spawn: SpawnChild;
  entry: string;
  /**
 * 会话创建超时。**不给默认值**——各调用点按模型体积算（`loadTimeoutMsFor`）。
 * 固定 30s 装不下 214MB 级模型，会把「模型大一点」误报成「加载超时」。
 */
loadTimeoutMs?: number;
  /**
   * 单次推理/卸载的超时上限。
   * 默认 180s：K7那条「单次操作超 1 分钟即算慢到不可用」是**产品侧的体验线**，
   * 不是崩溃保护线。这里要拦的是「子进程卡死」，不是「模型慢」——
   * 让慢模型走到被判超时、报一句「已中止」，比让它跑完更能说明问题。
   */
  requestTimeoutMs?: number;
  onRestart?: (info: { code: number | null; restartCount: number }) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  label: string;
}

export class ChildRunner implements InferenceRunner {
  private child: SpawnedChild | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private loadedId: string | null = null;
  private restarting = false;
  private restarts = 0;
  /**
   * 子进程代际。真机探针实测到的竞态：超时回收 child#1 后立刻拉起 child#2，
   * child#1 迟到的 exit 事件若不加区分地处理，会把 child#2 的在途请求打死，
   * 并把仍然存活、占着显存的 child#2 从台账上抹掉（等于泄漏一个 DirectML 会话）。
   */
  private generation = 0;

  private readonly spawn: SpawnChild;
  private readonly entry: string;
  private readonly configuredLoadTimeoutMs?: number;
  private readonly requestTimeoutMs: number;
  private readonly onRestart?: ChildRunnerOptions['onRestart'];

  constructor(opts: ChildRunnerOptions) {
    this.spawn = opts.spawn;
    this.entry = opts.entry;
    this.configuredLoadTimeoutMs = opts.loadTimeoutMs;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 180_000;
    this.onRestart = opts.onRestart;
  }

  get loadedModelId(): string | null {
    return this.loadedId;
  }

  get restartCount(): number {
    return this.restarts;
  }

  /**
   * 加载超时按模型体积算。调用方显式给了 `loadTimeoutMs`（探针在用）就以它为准。
   * 固定 30s 装不下大模型——实测 214MB 的 BiRefNet 光读元数据 CPU 侧就要 17.1s。
   */
  private loadTimeoutFor(model: ModelSpec | undefined): number {
    return this.configuredLoadTimeoutMs ?? loadTimeoutMsFor(model?.sizeBytes);
  }

  async load(req: {
    modelPath: string;
    model: ModelSpec;
    backend?: BackendPreference;
  }): Promise<number> {
    const startedAt = Date.now();
    const reply = await this.send('load', req, this.loadTimeoutFor(req.model), `加载模型 ${req.model.id}`);
    this.loadedId = req.model.id;
    return (reply as { loadMs?: number } | null)?.loadMs ?? Date.now() - startedAt;
  }

  async infer(req: { modelId: string; dims: number[]; data: Float32Array }): Promise<InferReply> {
    return (await this.send('infer', req, this.requestTimeoutMs, `推理 ${req.modelId}`)) as InferReply;
  }

  async loadNamed(sessionKey: string, req: { modelPath: string; model: ModelSpec; backend?: BackendPreference }): Promise<number> {
    const reply = await this.send('load-named', { sessionKey, request: req }, this.loadTimeoutFor(req.model), `加载模型会话 ${sessionKey}`);
    return (reply as { loadMs?: number } | null)?.loadMs ?? 0;
  }

  async inferFeeds(req: InferFeedsRequest): Promise<InferFeedsReply> {
    return (await this.send('infer-feeds', req, this.requestTimeoutMs, `多输入推理 ${req.sessionKey}`)) as InferFeedsReply;
  }

  async unloadNamed(sessionKey: string): Promise<void> {
    await this.send('unload', { sessionKey }, this.requestTimeoutMs, `卸载模型会话 ${sessionKey}`);
  }

  async unload(): Promise<void> {
    await this.send('unload', undefined, this.requestTimeoutMs, '卸载模型');
    this.loadedId = null;
  }

  async dispose(): Promise<void> {
    const child = this.child;
    this.generation += 1;
    this.child = null;
    this.loadedId = null;
    this.failAll(new Error('推理服务已关闭'));
    if (child) child.kill();
  }

  /** 子进程由 Electron 的 utilityProcess 或测试假件提供，两者都实现 SpawnedChild。 */
  private ensureChild(): SpawnedChild {
    if (this.child) return this.child;
    const gen = ++this.generation;
    const child = this.spawn(this.entry);
    child.onMessage((event) => {
      // 旧代际子进程迟到事件一律丢弃：它自己的退出与新进程无关
      if (gen !== this.generation) return;
      if (event.type === 'message') {
        this.settle(event.payload);
        return;
      }
      this.handleExit(event.code);
    });
    this.child = child;
    return child;
  }

  private handleExit(code: number | null): void {
    this.generation += 1;
    this.child = null;
    this.loadedId = null;
    // 原生层报错是进程级的：把当次任务变成可读错误，下一次请求自然拉起新进程。
    this.failAll(
      new Error(
        `推理子进程已退出（code=${code ?? 'unknown'}）。当次任务未完成，可直接重试；` +
          `若反复失败，多半是该模型在本引擎上不支持（详见能力清单的实测标记）。`
      )
    );
    this.noteRestart(code);
  }

  /** 一次"进程被换掉"记一笔，无论是自己退出还是被我们回收。 */
  private noteRestart(code: number | null): void {
    if (this.restarting) return;
    this.restarts += 1;
    this.restarting = true;
    queueMicrotask(() => {
      this.restarting = false;
    });
    this.onRestart?.({ code, restartCount: this.restarts });
  }

  private send(type: ChildRequest['type'], payload: unknown, timeoutMs: number, label: string): Promise<unknown> {
    const child = this.ensureChild();
    const id = ++this.seq;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 超时说明子进程卡死：回收它，让下一次请求换一个新进程。
        this.pending.delete(id);
        reject(new ChildNotRespondingError(`${label} 超时（${Math.round(timeoutMs / 1000)} 秒），已中止`));
        this.generation += 1;
        this.child = null;
        this.loadedId = null;
        this.failAll(new Error(`${label} 超时，推理子进程已被回收`));
        child.kill();
        this.noteRestart(null);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, label });
      child.postMessage({ id, type, payload } as ChildRequest);
    });
  }

  private settle(reply: ChildReply): void {
    const entry = this.pending.get(reply.id);
    if (!entry) return;
    this.pending.delete(reply.id);
    clearTimeout(entry.timer);
    if (reply.ok) entry.resolve(reply.data);
    else entry.reject(new Error(reply.message));
  }

  private failAll(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending = new Map();
  }
}
