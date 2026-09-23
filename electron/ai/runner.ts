import type { BackendPreference, ChildReply, ChildRequest, InferReply } from './inferenceChild';
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
    on(event: 'message', listener: (message: { data: unknown }) => void): void;
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
        child.on('message', (message) => listener({ type: 'message', payload: message.data as never }));
        child.on('exit', (code) => listener({ type: 'exit', code }));
      }
    };
  };
}

export interface ChildRunnerOptions {
  spawn: SpawnChild;
  entry: string;
  /** 会话创建硬上限。探针里 ort-web 的 WebGPU 180s 不返回，必须有上限。 */
  loadTimeoutMs?: number;
  /** 单次推理/卸载的超时上限。 */
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

  private readonly spawn: SpawnChild;
  private readonly entry: string;
  private readonly loadTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly onRestart?: ChildRunnerOptions['onRestart'];

  constructor(opts: ChildRunnerOptions) {
    this.spawn = opts.spawn;
    this.entry = opts.entry;
    this.loadTimeoutMs = opts.loadTimeoutMs ?? 30_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.onRestart = opts.onRestart;
  }

  get loadedModelId(): string | null {
    return this.loadedId;
  }

  get restartCount(): number {
    return this.restarts;
  }

  async load(req: {
    modelPath: string;
    model: ModelSpec;
    backend?: BackendPreference;
  }): Promise<number> {
    const startedAt = Date.now();
    const reply = await this.send('load', req, this.loadTimeoutMs, `加载模型 ${req.model.id}`);
    this.loadedId = req.model.id;
    return (reply as { loadMs?: number } | null)?.loadMs ?? Date.now() - startedAt;
  }

  async infer(req: { modelId: string; dims: number[]; data: Float32Array }): Promise<InferReply> {
    return (await this.send('infer', req, this.requestTimeoutMs, `推理 ${req.modelId}`)) as InferReply;
  }

  async unload(): Promise<void> {
    await this.send('unload', undefined, this.requestTimeoutMs, '卸载模型');
    this.loadedId = null;
  }

  async dispose(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.loadedId = null;
    this.failAll(new Error('推理服务已关闭'));
    if (child) child.kill();
  }

  /** 子进程由 Electron 的 utilityProcess 或测试假件提供，两者都实现 SpawnedChild。 */
  private ensureChild(): SpawnedChild {
    if (this.child) return this.child;
    const child = this.spawn(this.entry);
    child.onMessage((event) => {
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
    this.child = null;
    this.loadedId = null;
    // 原生层报错是进程级的：把当次任务变成可读错误，下一次请求自然拉起新进程。
    this.failAll(
      new Error(
        `推理子进程已退出（code=${code ?? 'unknown'}）。当次任务未完成，可直接重试；` +
          `若反复失败，多半是该模型在本引擎上不支持（详见能力清单的实测标记）。`
      )
    );
    if (!this.restarting) {
      this.restarts += 1;
      this.restarting = true;
      queueMicrotask(() => {
        this.restarting = false;
      });
      this.onRestart?.({ code, restartCount: this.restarts });
    }
  }

  private send(type: ChildRequest['type'], payload: unknown, timeoutMs: number, label: string): Promise<unknown> {
    const child = this.ensureChild();
    const id = ++this.seq;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 超时说明子进程卡死：回收它，让下一次请求换一个新进程。
        this.pending.delete(id);
        reject(new ChildNotRespondingError(`${label} 超时（${Math.round(timeoutMs / 1000)} 秒），已中止`));
        this.child = null;
        this.loadedId = null;
        this.failAll(new Error(`${label} 超时，推理子进程已被回收`));
        child.kill();
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
