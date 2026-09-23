import { stat, writeFile, access } from 'fs/promises';
import { join } from 'path';

import { capabilities, type CapabilitySpec, type ModelSpec } from './capabilityCatalog';
import { computeCacheKey } from './cacheKey';
import { modelDir, previewFile } from './paths';
import { PIPELINE_VERSION, preprocessImage } from './preprocess';
import {
  DEFAULT_CUTOUT_PARAMS,
  composeCutoutPng,
  cropMaskPlane,
  getPostprocessor,
  toCacheParams,
  type MaskPlane
} from './postprocess';
import type { InferenceRunner } from './runner';
import type { ModelDownloadSpec } from './modelStore';

export type { InferenceRunner } from './runner';

/**
 * 主进程侧的编排（附录 A.1）：ensureReady → 查缓存 → 推理 → 写暂存。
 *
 * 三条不可让步的规矩：
 * - **一次点击走完 下载→加载→推理**，中间不要求第二次操作（D14）；唯一的询问
 *   是首次下载前的那一句代价告知（AG2），未确认就一个字节都不写、一个请求都不发；
 * - **缓存命中不得调 runner**（D18 ②），命中判据是五元组键；
 * - **同一时刻只允许一个推理**（§5.2），后来的排队，不做并发调度。
 *
 * 结果一律写 `userData/ai-preview/`，**绝不写照片目录**——扫描器只按扩展名过滤，
 * 放错位置半成品会被扫进用户网格（§5.0 红线 1）。
 */

export interface ModelGateway {
  status(modelId: string): Promise<'absent' | 'downloading' | 'present'>;
  download(spec: ModelDownloadSpec, signal?: AbortSignal): Promise<{ path: string }>;
  remove(modelId: string): Promise<void>;
}

export type AiPhase = 'download' | 'load' | 'infer' | 'encode';

export interface AiProgress {
  taskId: string;
  phase: AiPhase;
  percent?: number;
}

export interface RunRequest {
  absPath: string;
  capabilityId: string;
  modelId?: string;
  /** 首次下载的代价告知已由界面确认过（AG2）。已下载时不需要该标志。 */
  downloadApproved?: boolean;
  backend?: 'dml' | 'cpu';
}

export interface RunResult {
  taskId: string;
  tempPath: string;
  cacheHit: boolean;
  didApplySigmoid: boolean;
  maskWidth: number;
  maskHeight: number;
  capabilityId: string;
  modelId: string;
  actionTag: string;
}

export interface RunHandle {
  taskId: string;
  promise: Promise<RunResult>;
}

export interface AiServiceDeps {
  runner: InferenceRunner;
  store: ModelGateway;
  onProgress?: (p: AiProgress) => void;
  onDone?: (r: RunResult) => void;
  onError?: (e: { taskId: string; code: string; message: string }) => void;
  /** 便于测试注入 */
  catalog?: CapabilitySpec[];
}

/** 带错误码的失败：界面按 message 显示，日志按 code 定位（Q16 的起点）。 */
export class AiTaskError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = code;
  }
}

/**
 * 从清单解析出可执行的模型。未实测跑通的一律拒绝执行——
 * M0 的教训是 BiRefNet「加载成功」但一执行就崩，"文件在仓库里"和"能用"没有关系。
 */
export function resolveModel(
  catalog: CapabilitySpec[],
  capabilityId: string,
  modelId?: string
): ModelSpec {
  const cap = catalog.find((c) => c.id === capabilityId);
  if (!cap) throw new AiTaskError('CAPABILITY_UNAVAILABLE', `清单里没有 ID 为 ${capabilityId} 的行为`);
  const wanted = modelId ?? cap.defaultModelId;
  const model = cap.models.find((m) => m.id === wanted);
  if (!model) throw new AiTaskError('MODEL_UNAVAILABLE', `行为 ${capabilityId} 下没有模型 ${wanted}`);
  if (!model.verified) {
    throw new AiTaskError('MODEL_NOT_VERIFIED', `模型 ${model.id} 未在本引擎实测跑通，暂不可用`);
  }
  return model;
}

function roundMb(bytes: number): string {
  return (bytes / 1048576).toFixed(1);
}

export class AiService {
  private readonly deps: AiServiceDeps;
  private readonly catalog: CapabilitySpec[];
  private queueTail: Promise<void> = Promise.resolve();
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancelled = new Set<string>();
  private seq = 0;

  constructor(deps: AiServiceDeps) {
    this.deps = deps;
    this.catalog = deps.catalog ?? capabilities;
  }

  run(req: RunRequest): Promise<RunResult> {
    return this.startRun(req).promise;
  }

  /** 立刻拿到 taskId（供 IPC 回给渲染层），完成与失败走事件。 */
  startRun(req: RunRequest): RunHandle {
    const taskId = `ai-${++this.seq}`;
    const controller = new AbortController();
    this.controllers.set(taskId, controller);

    // 事件必须在 promise settle 之前同步触发，否则调用方拿到拒绝时事件还没落地。
    const run = async (): Promise<RunResult> => {
      try {
        const result = await this.execute(taskId, req, controller.signal);
        this.deps.onDone?.(result);
        return result;
      } catch (err) {
        const mapped = this.cancelled.has(taskId)
          ? new AiTaskError('CANCELLED', '任务已取消')
          : toTaskError(err);
        this.deps.onError?.({ taskId, code: mapped.code, message: mapped.message });
        throw mapped;
      } finally {
        this.controllers.delete(taskId);
      }
    };

    // 串行队列：接在队尾，前一个结束（无论成败）后才轮到它。
    const promise = this.queueTail.then(run);
    this.queueTail = promise.then(
      () => undefined,
      () => undefined
    );
    // 调用方可以不 await（IPC 事件驱动），这里吞掉避免未处理拒绝。
    promise.then(
      () => undefined,
      () => undefined
    );
    return { taskId, promise };
  }

  cancel(taskId: string): boolean {
    if (!this.controllers.has(taskId)) return false;
    this.cancelled.add(taskId);
    this.controllers.get(taskId)?.abort();
    return true;
  }

  async dispose(): Promise<void> {
    for (const id of Array.from(this.controllers.keys())) this.cancel(id);
    await this.deps.runner.dispose();
  }

  private async execute(taskId: string, req: RunRequest, signal: AbortSignal): Promise<RunResult> {
    this.throwIfCancelled(taskId);
    const cap = this.catalog.find((c) => c.id === req.capabilityId);
    if (!cap) throw new AiTaskError('CAPABILITY_UNAVAILABLE', `清单里没有 ID 为 ${req.capabilityId} 的行为`);
    const model = resolveModel(this.catalog, req.capabilityId, req.modelId);
    // 后处理函数必须已注册，否则宁可在跑之前失败
    getPostprocessor(cap.postprocessId);

    let sourceStat;
    try {
      sourceStat = await stat(req.absPath);
    } catch {
      throw new AiTaskError('SOURCE_MISSING', `找不到原图：${req.absPath}`);
    }
    if (!sourceStat.isFile()) throw new AiTaskError('SOURCE_MISSING', `目标不是文件：${req.absPath}`);

    const params = toCacheParams(DEFAULT_CUTOUT_PARAMS);
    const key = computeCacheKey({
      source: { absPath: req.absPath, mtimeMs: sourceStat.mtimeMs, size: sourceStat.size },
      modelSha256: model.sha256,
      inputDims: model.inputDims,
      postprocessParams: params,
      pipelineVersion: PIPELINE_VERSION
    });
    const tempPath = previewFile(`${key}${cap.outputExt}`);

    if (await exists(tempPath)) {
      // 命中缓存：不调 runner，直接给预览（§5.2 秒出预览的依据）
      this.throwIfCancelled(taskId);
      const cached: RunResult = {
        taskId,
        tempPath,
        cacheHit: true,
        didApplySigmoid: false,
        maskWidth: model.inputDims[3] ?? 0,
        maskHeight: model.inputDims[2] ?? 0,
        capabilityId: cap.id,
        modelId: model.id,
        actionTag: cap.actionTag
      };
      return cached;
    }

    // ── 确保模型就绪（下载是这一步的内部细节，不是用户步骤）─────────────
    const status = await this.deps.store.status(model.id);
    if (status === 'downloading') {
      throw new AiTaskError('MODEL_BUSY', `模型 ${model.id} 正在下载中，请稍候`);
    }
    if (status === 'absent') {
      if (!req.downloadApproved) {
        throw new AiTaskError(
          'DOWNLOAD_NEEDS_CONSENT',
          `首次使用需下载 ${roundMb(model.sizeBytes)} MB，确认后开始`
        );
      }
      this.emit(taskId, 'download', 0);
      await this.deps.store.download(toDownloadSpec(model), signal);
      this.emit(taskId, 'download', 100);
    }
    this.throwIfCancelled(taskId);

    const modelPath = join(modelDir(model.id), model.fileName);
    if (!(await exists(modelPath))) {
      throw new AiTaskError('MODEL_MISSING_ON_DISK', `清单说模型已就位，但磁盘上找不到 ${modelPath}`);
    }

    if (this.deps.runner.loadedModelId !== model.id) {
      this.emit(taskId, 'load', 0);
      await this.deps.runner.load({ modelPath, model, backend: req.backend });
    }
    this.throwIfCancelled(taskId);

    // ── 预处理 + 推理 ────────────────────────────────────────────────────
    this.emit(taskId, 'infer', 0);
    const input = await preprocessImage(req.absPath, model);
    let reply;
    try {
      reply = await this.deps.runner.infer({ modelId: model.id, dims: input.dims, data: input.tensor });
    } catch (err) {
      throw new AiTaskError('INFERENCE_FAILED', errorMessage(err));
    }
    this.throwIfCancelled(taskId);

    // ── 掩码裁掉补边 → 映回原图 → 合成 → 写暂存 ─────────────────────────
    this.emit(taskId, 'encode', 0);
    const full = toMaskPlane(reply.data, reply.dims);
    const mask = cropMaskPlane(full, {
      x: input.padX,
      y: input.padY,
      width: input.contentWidth,
      height: input.contentHeight
    });
    const composed = await composeCutoutPng(req.absPath, mask, DEFAULT_CUTOUT_PARAMS);
    try {
      await writeFile(tempPath, composed.png);
    } catch (err) {
      // §6：写盘失败要把半成品清掉，别在暂存里留下半个文件
      await removeQuietly(tempPath);
      throw new AiTaskError('WRITE_PREVIEW_FAILED', `写入预览暂存失败：${errorMessage(err)}`);
    }
    this.throwIfCancelled(taskId);

    return {
      taskId,
      tempPath,
      cacheHit: false,
      didApplySigmoid: composed.didApplySigmoid,
      maskWidth: composed.maskWidth,
      maskHeight: composed.maskHeight,
      capabilityId: cap.id,
      modelId: model.id,
      actionTag: cap.actionTag
    };
  }

  private throwIfCancelled(taskId: string): void {
    if (this.cancelled.has(taskId)) throw new AiTaskError('CANCELLED', '任务已取消');
  }

  private emit(taskId: string, phase: AiPhase, percent: number): void {
    this.deps.onProgress?.({ taskId, phase, percent });
  }
}

function toDownloadSpec(model: ModelSpec): ModelDownloadSpec {
  return {
    id: model.id,
    downloadUrl: model.downloadUrl,
    fileName: model.fileName,
    sizeBytes: model.sizeBytes,
    sha256: model.sha256
  };
}

/** 推理结果 → 掩码平面。形状一律从会话给的 dims 读，不写死。 */
function toMaskPlane(data: Float32Array, dims: number[]): MaskPlane {
  if (dims.length < 2) throw new AiTaskError('UNEXPECTED_OUTPUT', `输出形状不是平面：${dims.join('x')}`);
  const height = dims[dims.length - 2];
  const width = dims[dims.length - 1];
  if (width * height > data.length) {
    throw new AiTaskError('UNEXPECTED_OUTPUT', `输出长度 ${data.length} 不足 ${width}x${height}`);
  }
  return { data: data.subarray(0, width * height), width, height };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function removeQuietly(path: string): Promise<void> {
  try {
    const { rm } = await import('fs/promises');
    await rm(path, { force: true });
  } catch {
    // 清理失败不改变本次任务的结论
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toTaskError(err: unknown): AiTaskError {
  if (err instanceof AiTaskError) return err;
  if (isAbortLike(err)) return new AiTaskError('CANCELLED', '任务已取消');
  return new AiTaskError('INTERNAL_ERROR', errorMessage(err));
}

function isAbortLike(err: unknown): boolean {
  return (
    !!err && typeof err === 'object' && 'name' in err && (err as { name: unknown }).name === 'AbortError'
  );
}
