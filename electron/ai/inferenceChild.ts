import type { ModelSpec } from './capabilityCatalog';

/**
 * 推理子进程（运行于 Electron `utilityProcess`）。
 *
 * 为什么单独一个进程：原生推理库是 C++，失败方式是**进程级崩溃**——M0 实测
 * BiRefNet-lite 在 DirectML 上"加载成功"却一执行就抛 DmlFusedNode 原生错误。
 * 这种错误发生在主进程等于一张坏照片干掉整个窗口。
 *
 * 本文件只回数据、**不写盘**（附录 A.1）：写暂存、命名、清理都是 aiService 的事。
 * 模型形状一律从清单取，这里不出现任何具体尺寸或张量名。
 */

/** D12：CPU 路径必须显式限线程。实测不限线程时 ORT 吃满 32 核、单进程 6.3GB，把开发机压到无响应。 */
export const DEFAULT_INTRA_OP_THREADS = 2;
export const DEFAULT_INTER_OP_THREADS = 1;
/**
 * 会话创建超时的**下限**（探针里 ort-web 的 WebGPU 就是 180s 不返回，必须有上限）。
 *
 * 为什么不写死一个数：实测 200MB 级模型加载就要 9s，而**光读元数据 CPU 侧就17.1s**
 * —— 固定 30s 会把「模型大一点」误报成「加载超时」，用户看到的是超时而不是真实原因。
 * 所以真正的超时按体积算（见 `loadTimeoutMsFor`），这里只保留小模型的兜底。
 */
export const DEFAULT_LOAD_TIMEOUT_MS = 30_000;

/**
 * 按模型体积算加载超时。
 *
 * 实测锚点：4.4 MB 级模型秒级加载；200MB 级模型在 CPU 侧读元数据就17.1s。
 * 斜率取 **1 s/MB + 30s 固定开销**：200MB → 约 230s，覆盖 17.1s 还有大量余量；
 * 而 4.4MB → 34s，仍是「感觉不到等待」的量级。
 *
 * ⚠️ 别把斜率调大。曾按 60 s/MB估过，结果 20MB 就顶到上限、整条曲线全被压平——
 * **分级要有区分度，否则不如写死**。上限 8 分钟是真兜底：超过这个数就不是
 * 「模型大」，而是卡死了，等下去没有意义。
 */
export function loadTimeoutMsFor(sizeBytes: number | undefined): number {
  if (!sizeBytes || !Number.isFinite(sizeBytes) || sizeBytes <= 0) return DEFAULT_LOAD_TIMEOUT_MS;
  const MB = 1024 * 1024;
  const dynamic = Math.ceil(sizeBytes / MB) * 1_000;
  return Math.min(480_000, Math.max(DEFAULT_LOAD_TIMEOUT_MS, dynamic + DEFAULT_LOAD_TIMEOUT_MS));
}

export type BackendPreference = 'dml' | 'cpu';

export interface SessionFlags {
  executionProviders: string[];
  intraOpNumThreads: number;
  interOpNumThreads: number;
  logSeverityLevel: 3;
}

/**
 * 建会话的参数。**任何后端都必须带显式线程数**，不允许依赖默认值——
 * 这是探针把开发机压死那次的直接教训。
 */
export function buildSessionOptions(
  backend: BackendPreference = 'dml',
  threads: { intraOpNumThreads?: number; interOpNumThreads?: number } = {}
): SessionFlags {
  return {
    executionProviders: backend === 'dml' ? ['dml', 'cpu'] : ['cpu'],
    intraOpNumThreads: threads.intraOpNumThreads ?? DEFAULT_INTRA_OP_THREADS,
    interOpNumThreads: threads.interOpNumThreads ?? DEFAULT_INTER_OP_THREADS,
    logSeverityLevel: 3
  };
}

export interface LoadRequest {
  modelPath: string;
  model: ModelSpec;
  backend?: BackendPreference;
}

export interface InferRequest {
  modelId: string;
  /** 与 model.inputDims 同长度的 NCHW 形状 */
  dims: number[];
  data: Float32Array;
}

export interface InferReply {
  data: Float32Array;
  dims: number[];
  outputName: string;
  inferMs: number;
}

export interface InferFeedsRequest {
  sessionKey: string;
  feeds: Record<string, { type: 'float32' | 'int64'; dims: number[]; data: Float32Array | BigInt64Array }>;
  outputs?: string[];
}
export interface InferFeedsReply { outputs: Record<string, { type: string; dims: number[]; data: Float32Array | BigInt64Array }>; inferMs: number }
interface NamedSession { session: import('onnxruntime-node').InferenceSession; modelId: string; outputNames: string[] }

export interface ChildDeps {
  /** 注入 ort 模块，单测用假实现验协议，集成测试用真的 */
  ort: typeof import('onnxruntime-node');
}

/** 子进程内的会话管理器：一次只驻留一个模型（§5.2）。 */
export class ChildInference {
  private session: import('onnxruntime-node').InferenceSession | null = null;
  private loadedModelId: string | null = null;
  private loadedSpec: ModelSpec | null = null;
  private outputNames: string[] = [];
  private readonly namedSessions = new Map<string, NamedSession>();

  constructor(private readonly deps: ChildDeps) {}

  async load(req: LoadRequest): Promise<{ modelId: string; loadMs: number; outputNames: string[] }> {
    const startedAt = Date.now();
    await this.disposeSession();
    const options = buildSessionOptions(req.backend ?? 'dml');
    const session = await this.deps.ort.InferenceSession.create(req.modelPath, options);
    this.session = session;
    this.loadedModelId = req.model.id;
    this.loadedSpec = req.model;
    this.outputNames = Array.from(session.outputNames ?? []);
    return { modelId: req.model.id, loadMs: Date.now() - startedAt, outputNames: this.outputNames };
  }

  async loadNamed(sessionKey: string, req: LoadRequest): Promise<number> {
    const startedAt = Date.now();
    await this.unloadNamed(sessionKey);
    const session = await this.deps.ort.InferenceSession.create(req.modelPath, buildSessionOptions(req.backend ?? 'dml'));
    this.namedSessions.set(sessionKey, { session, modelId: req.model.id, outputNames: Array.from(session.outputNames ?? []) });
    return Date.now() - startedAt;
  }

  async inferFeeds(req: InferFeedsRequest): Promise<InferFeedsReply> {
    const loaded = this.namedSessions.get(req.sessionKey);
    if (!loaded) throw new Error(`模型会话尚未加载：${req.sessionKey}`);
    const feeds: Record<string, import('onnxruntime-node').Tensor> = {};
    for (const [name, feed] of Object.entries(req.feeds)) feeds[name] = new this.deps.ort.Tensor(feed.type, feed.data as never, feed.dims);
    const startedAt = Date.now();
    const values = req.outputs ? await loaded.session.run(feeds, req.outputs) : await loaded.session.run(feeds);
    const outputs: InferFeedsReply['outputs'] = {};
    for (const name of req.outputs ?? loaded.outputNames) {
      const out = values[name];
      if (!out) throw new Error(`会话没有给出名为 ${name} 的输出`);
      outputs[name] = { type: out.type, dims: Array.from(out.dims), data: (out.data as Float32Array | BigInt64Array).slice() };
    }
    return { outputs, inferMs: Date.now() - startedAt };
  }

  async unloadNamed(sessionKey: string): Promise<void> {
    const loaded = this.namedSessions.get(sessionKey);
    this.namedSessions.delete(sessionKey);
    await loaded?.session.release().catch(() => undefined);
  }

  async infer(req: InferRequest): Promise<InferReply> {
    const session = this.session;
    const spec = this.loadedSpec;
    if (!session || !spec) throw new Error(`模型尚未加载，无法推理：${req.modelId}`);
    if (this.loadedModelId !== req.modelId) {
      throw new Error(`当前驻留的模型是 ${this.loadedModelId}，请求的是 ${req.modelId}`);
    }
    const startedAt = Date.now();
    const tensor = new this.deps.ort.Tensor('float32', req.data, req.dims);
    const results = await session.run({ [spec.inputName]: tensor });
    const outputName = this.outputNames[spec.outputNameIndex];
    if (!outputName) {
      throw new Error(
        `清单要求取第 ${spec.outputNameIndex} 个输出，但会话只有 ${this.outputNames.length} 个输出`
      );
    }
    const output = results[outputName];
    if (!output) throw new Error(`会话没有给出名为 ${outputName} 的输出`);
    const dims = Array.from(output.dims as ArrayLike<number>);
    const total = dims.reduce((acc, n) => acc * n, 1);
    const src = output.data as Float32Array;
    return {
      data: src.slice(0, total),
      dims,
      outputName,
      inferMs: Date.now() - startedAt
    };
  }

  get currentModelId(): string | null {
    return this.loadedModelId;
  }

  async unload(): Promise<void> {
    await this.disposeSession();
  }

  async dispose(): Promise<void> {
    await this.disposeSession();
    await Promise.all(Array.from(this.namedSessions.keys(), (key) => this.unloadNamed(key)));
  }

  private async disposeSession(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.loadedSpec = null;
    this.loadedModelId = null;
    if (!session) return;
    try {
      await session.release();
    } catch {
      // release 失败不影响退出，进程本身要被回收
    }
  }
}

export type ChildRequest =
  | { id: number; type: 'load'; payload: LoadRequest }
  | { id: number; type: 'infer'; payload: InferRequest }
  | { id: number; type: 'load-named'; payload: { sessionKey: string; request: LoadRequest } }
  | { id: number; type: 'infer-feeds'; payload: InferFeedsRequest }
  | { id: number; type: 'unload'; payload?: { sessionKey?: string } };

export type ChildReply =
  | { id: number; ok: true; data: unknown }
  | { id: number; ok: false; message: string };

/** 协议层单独可测：错误一律变成可读 reply，让主进程有机会捕获而不是跟着崩。 */
export function createMessageHandler(child: ChildInference) {
  return async (request: ChildRequest): Promise<ChildReply> => {
    try {
      if (request.type === 'load') {
        return { id: request.id, ok: true, data: await child.load(request.payload) };
      }
      if (request.type === 'infer') {
        return { id: request.id, ok: true, data: await child.infer(request.payload) };
      }
      if (request.type === 'load-named') {
        return { id: request.id, ok: true, data: { loadMs: await child.loadNamed(request.payload.sessionKey, request.payload.request) } };
      }
      if (request.type === 'infer-feeds') {
        return { id: request.id, ok: true, data: await child.inferFeeds(request.payload) };
      }
      if (request.type === 'unload') {
        if (request.payload?.sessionKey) await child.unloadNamed(request.payload.sessionKey);
        else await child.unload();
        return { id: request.id, ok: true, data: null };
      }
      throw new Error(`未知的子进程请求类型：${String((request as { type?: string }).type)}`);
    } catch (err) {
      return { id: request.id, ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  };
}

/** Electron utilityProcess 子进程里的通信端口（Node 的 process.parentPort）。 */
interface UtilityParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

/**
 * 子进程入口的接线。放在函数里且只在 utilityProcess 内自动执行，
 * 这样 node 环境的单测可以安全 import 本模块、只验纯逻辑与协议。
 */
export async function startUtilityChildProcess(): Promise<void> {
  const parentPort = (process as unknown as { parentPort?: UtilityParentPort }).parentPort;
  if (!parentPort) {
    throw new Error('inferenceChild 必须在 Electron utilityProcess 中启动：拿不到 process.parentPort');
  }
  const ort = await import('onnxruntime-node');
  const child = new ChildInference({ ort });
  const handle = createMessageHandler(child);
  parentPort.on('message', async (event) => {
    const reply = await handle(event.data as ChildRequest);
    parentPort.postMessage(reply);
  });
}

if (process.type === 'utility') {
  void startUtilityChildProcess();
}
