import { stat, writeFile, access, readFile, rename, rm, mkdir } from 'fs/promises';
import { isAbsolute, join, normalize, sep, basename, dirname, extname, relative } from 'path';

import { capabilities, type CapabilitySpec, type ModelSpec } from './capabilityCatalog';
import { computeCacheKey, computeMaskCacheKey } from './cacheKey';
import { modelDir, previewDir, previewFile, settingsFile, maskFile, maskFileName, MASK_FILE_EXT } from './paths';
import { PIPELINE_VERSION, preprocessImage } from './preprocess';
import { classifyGpuError } from './gpuErrorText';
import type { AiCutoutParamsPayload } from '../../shared/types';
import {
  DEFAULT_CUTOUT_PARAMS,
  composeCutoutPng,
  cropMaskPlane,
  getPostprocessor,
  maskFromBytes,
  maskToBytes,
  resolveBgColorId,
  toCacheParams,
  type CutoutParams,
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
  /**
   * 抠图后处理参数（第一版只有底色）。
   *
   * 以前 `execute()` 里把 `DEFAULT_CUTOUT_PARAMS` 写死，"改个参数"在渲染层根本没有入口。
   * 方案 §2 的分界线要求参数只作用于轻的那一层，前提是它得先从请求里进来（附录 A
   * 「参数流转」），所以**不许**在主进程另配一份默认值当事实源。未提供时取默认值，与旧行为等价。
   */
  cutout?: AiCutoutParamsPayload;
}

export interface RunResult {
  taskId: string;
  tempPath: string;
  /** 派生文件要落在它旁边，标签也从它继承 */
  sourceAbsPath: string;
  cacheHit: boolean;
  didApplySigmoid: boolean;
  maskWidth: number;
  maskHeight: number;
  capabilityId: string;
  modelId: string;
  actionTag: string;
}

export interface SaveResult {
  savedPath: string;
  targetName: string;
  /** true 表示首选举了名，实际写成 .cutout.N.png */
  renamed: boolean;
  /**
   * true 表示覆盖的是**我们自己上一轮导出的**那张（判据：同名文件身上带着本次的行为标签）。
   * §6 裁定 1：派生文件本来就是"当前结果"，改完底色再保存不该堆出 .cutout.2 / .cutout.3。
   */
  overwrote: boolean;
  tagsWritten: string[];
}

export interface CleanupReport {
  deleted: number;
  /** 索引里指向暂存外的条目数：拒绝删除，只清索引 */
  refused: number;
  freedBytes: number;
  expiredBytes: number;
}

export interface PreviewIndexEntry {
  /** 相对暂存目录的文件名（成品 `<五元组键>.png`，掩码 `masks/<掩码键>.mask.bin`） */
  fileName: string;
  sizeBytes: number;
  sourceAbsPath: string;
  capabilityId: string;
  modelId: string;
  createdAt: number;
  lastAccessedAt: number;
  /**
   * 暂存条目的种类：成品图 / 掩码。两级缓存共用**同一份**索引，
   * 于是保留期与容量上限那套 LRU 天然覆盖掩码，不需要第二套清理（§6 裁定 3）。
   * 缺省视为 'result'——旧索引文件里没有这个字段，不能因为升级就把成品当掩码处理。
   */
  kind?: PreviewEntryKind;
}

interface PreviewIndex {
  version: 1;
  entries: Record<string, PreviewIndexEntry>;
}

export type PreviewEntryKind = 'result' | 'mask';

/** 掩码文件按后缀认（`<掩码键>.mask.bin` 带两个点，不能用 extname 判类型）。 */
function isMaskFileName(fileName: string): boolean {
  return fileName.endsWith(MASK_FILE_EXT);
}

function kindOfFileName(fileName: string): PreviewEntryKind {
  return isMaskFileName(fileName) ? 'mask' : 'result';
}

/**
 * 索引的键空间。成品与掩码的键都是 40 位 sha1，各自独立算出来撞不上，但也没人保证——
 * 所以掩码加 `mask/` 前缀，两类互不覆盖。
 * 成品键保持**裸键**（剥单个扩展名，与升级前一致）：老索引里留下的成品条目仍能被删得掉，
 * 不会变成"占着盘查不到"的幽灵。
 */
function indexKeyOf(fileName: string): string {
  if (isMaskFileName(fileName)) return `mask/${basename(fileName, MASK_FILE_EXT)}`;
  return basename(fileName, extname(fileName));
}

/** 索引里的 fileName 一律是**相对暂存目录**的路径：掩码在 masks/ 子目录里。 */
function previewRelName(absPath: string): string {
  return relative(previewDir(), absPath);
}

/** 默认保留 30 天（§4.7 建议值，设置页可改）。 */
const DEFAULT_RETENTION_DAYS = 30;
/** 默认暂存总量上限 1 GiB。实测一张 690x920 成品约 1.1MB，1000 张约 1.1GB。 */
const DEFAULT_PREVIEW_MAX_BYTES = 1024 * 1024 * 1024;

export interface RunHandle {
  taskId: string;
  promise: Promise<RunResult>;
}

/** 主进程 → 渲染层的一次性事件（IPC 层原样转成 ai:progress / ai:done / ai:error） */
export type AiEvent =
  | { type: 'progress'; payload: AiProgress }
  | { type: 'done'; payload: RunResult }
  | { type: 'error'; payload: { taskId: string; code: string; message: string } };

/** 元数据通道（生产实现绑定 XmpService，测试注入假件）。 */
export interface MetadataGateway {
  readTags(absPath: string): Promise<string[]>;
  writeTags(absPath: string, add: string[]): Promise<void>;
  /** 把原图的 EXIF 等基础元数据复制进派生文件；不提供时跳过该步 */
  copyBase?(fromPath: string, toPath: string): Promise<void>;
}

export interface PreviewRetention {
  /** 保留期，默认 30 天 */
  retentionDays?: number;
  /** 暂存总量上限（字节），默认 1 GiB */
  maxBytes?: number;
  now?: () => number;
}

export interface AiServiceDeps {
  runner: InferenceRunner;
  store: ModelGateway;
  meta?: MetadataGateway;
  previewRetention?: PreviewRetention;
  /** 移出暂存用的原语，默认 fs.rename；测试用它注入"保存失败" */
  moveFile?: (fromPath: string, toPath: string) => Promise<void>;
  onProgress?: (p: AiProgress) => void;
  onDone?: (r: RunResult) => void;
  onError?: (e: { taskId: string; code: string; message: string }) => void;
  /** 便于测试注入 */
  catalog?: CapabilitySpec[];
  /**
   * 连续空闲多久自动释放驻留模型（§5.2 末条）。默认 `IDLE_UNLOAD_MS`；
   * 注入更短的值只是为了让单测跑得起，不代表线上可以调成 0。
   */
  idleUnloadMs?: number;
}

/**
 * 空闲自动卸载的时长。取 5 分钟是"人还在挑图"与"走开了"的分界：
 * 比一次完整眼验长不了多少，又足够长到不会在连续处理中把会话抽走。
 * 代价上限就是重新加载那一下（实测 0.96~3.14 秒），而加载对用户本来就是静默的（D14）。
 */
const IDLE_UNLOAD_MS = 5 * 60 * 1000;

/** settings.json 里的 AI 段（§5.0）。M1 只有默认模型覆盖与暂存保留配置。 */
export interface AiSettings {
  aiDefaults?: Record<string, string>;
  previewRetention?: { retentionDays?: number; maxBytes?: number };
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
  if (!cap) throw new AiTaskError('CAPABILITY_UNAVAILABLE', `找不到这个处理功能，请重新打开预览再试`);
  const wanted = modelId ?? cap.defaultModelId;
  const model = cap.models.find((m) => m.id === wanted);
  if (!model) throw new AiTaskError('MODEL_UNAVAILABLE', `这个功能当前没有可用的模型`);
  if (!model.verified) {
    throw new AiTaskError('MODEL_NOT_VERIFIED', `这个模型还没在本机显卡上验证通过，暂时不能选`);
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
  /** taskId → 最近一次成功结果，`ai:save(taskId)` 靠它找回暂存文件与原图 */
  private readonly finished = new Map<string, RunResult>();
  private readonly listeners = new Set<(event: AiEvent) => void>();
  private seq = 0;
  /**
   * 当前驻留会话是按哪个后端建的。用户显式切 CPU / 切回 GPU 时必须重建会话，
   * 否则界面写着走 CPU、实际还在 GPU 会话上跑（§8-16 / D12 禁止无声降级）。
   */
  private loadedBackend: 'dml' | 'cpu' | null = null;
  /**
   * 空闲自动卸载的定时器。每次提交任务与每次任务结束都重新武装，
   * 所以它量的是"距离最后一次 AI 活动多久"，不是"启动多久"。
   */
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

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
    // 排队与在跑期间不该抽走在用的会话：先把空闲计时推后
    this.rearmIdleUnload();

    // 事件必须在 promise settle 之前同步触发，否则调用方拿到拒绝时事件还没落地。
    const run = async (): Promise<RunResult> => {
      try {
        const result = await this.execute(taskId, req, controller.signal);
        this.publish({ type: 'done', payload: result });
        return result;
      } catch (err) {
        const mapped = this.cancelled.has(taskId)
          ? new AiTaskError('CANCELLED', '任务已取消')
          : toTaskError(err);
        this.publish({ type: 'error', payload: { taskId, code: mapped.code, message: mapped.message } });
        throw mapped;
      } finally {
        this.controllers.delete(taskId);
        // 顺序要紧：先摘掉在途标记，再武装定时器，让到点时"有没有任务在跑"判得准
        this.rearmIdleUnload();
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

  /** 重新武装空闲卸载计时（§5.2：连续空闲一段时间自动释放显存） */
  private rearmIdleUnload(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const ms = this.deps.idleUnloadMs ?? IDLE_UNLOAD_MS;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.unloadIfIdle();
    }, ms);
    // 一个待触发的定时器不该成为"进程不肯退出"的理由
    this.idleTimer.unref?.();
  }

  private unloadIfIdle(): void {
    // 还有任务在跑或排队：从它结束再起算，不抽走在用的会话
    if (this.controllers.size > 0) {
      this.rearmIdleUnload();
      return;
    }
    // 本来就没驻留（没跑过、或已被手动卸载）：不去敲一个空会话
    if (this.deps.runner.loadedModelId === null) return;
    this.loadedBackend = null;
    // 释放失败不弹提示：下次点主按钮时 loadedModelId 对不上，execute 会自己走重建路径
    void this.deps.runner.unload().catch(() => undefined);
  }

  /** 用户选定的默认模型（下拉里「设为默认」）；没有覆盖时回清单自带的默认值。 */
  async defaultModelFor(capabilityId: string): Promise<string> {
    const settings = await this.readSettings();
    const override = settings.aiDefaults?.[capabilityId];
    if (override && this.catalog.find((c) => c.id === capabilityId)?.models.some((m) => m.id === override && m.verified)) {
      return override;
    }
    return this.catalog.find((c) => c.id === capabilityId)?.defaultModelId ?? '';
  }

  /** 只允许设成该行为下已实测跑通的模型，否则报错而不是默默生效。 */
  async setDefaultModel(capabilityId: string, modelId: string): Promise<void> {
    const cap = this.catalog.find((c) => c.id === capabilityId);
    if (!cap) throw new AiTaskError('CAPABILITY_UNAVAILABLE', `找不到这个处理功能，请重新打开预览再试`);
    const model = cap.models.find((m) => m.id === modelId);
    if (!model) throw new AiTaskError('MODEL_UNAVAILABLE', `这个功能当前没有可用的模型`);
    if (!model.verified) {
      throw new AiTaskError('MODEL_NOT_VERIFIED', `这个模型还没在本机验证通过，不能设为默认`);
    }
    const settings = await this.readSettings();
    settings.aiDefaults = { ...settings.aiDefaults, [capabilityId]: modelId };
    await this.writeSettings(settings);
  }

  private async readSettings(): Promise<AiSettings> {
    try {
      return JSON.parse(await readFile(settingsFile(), 'utf8')) as AiSettings;
    } catch {
      return {};
    }
  }

  private async writeSettings(settings: AiSettings): Promise<void> {
    const tmp = `${settingsFile()}.tmp`;
    await writeFile(tmp, JSON.stringify(settings, null, 2));
    await rename(tmp, settingsFile());
  }

  /** IPC 用：过滤后的可渲染清单——只含实测跑通的模型（§4.3）。 */
  usableCatalog(): CapabilitySpec[] {
    return this.catalog
      .filter((cap) => cap.models.some((m) => m.verified))
      .map((cap) => ({ ...cap, models: cap.models.filter((m) => m.verified) }));
  }

  /** IPC 用：按 modelId 找下载规格（跨行为查找，模型管理下拉只给 id）。 */
  findModelSpec(modelId: string): { capabilityId: string; spec: ModelDownloadSpec } | null {
    for (const cap of this.catalog) {
      const model = cap.models.find((m) => m.id === modelId);
      if (!model) continue;
      return { capabilityId: cap.id, spec: toDownloadSpec(model) };
    }
    return null;
  }

  async dispose(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    for (const id of Array.from(this.controllers.keys())) this.cancel(id);
    await this.deps.runner.dispose();
  }

  /**
   * 把暂存结果移入原图旁，成为 `原名.cutout.png`（冲突递增 `.cutout.2.png`）。
   *
   * 顺序上有讲究：**先移动成功再写元数据**。移动失败（Windows 上文件被占用是日常事件）
   * 时暂存结果必须原样保留，用户看过并认可的东西不能因为一次写入失败就消失（§6 / A5）。
   */
  async save(taskId: string): Promise<SaveResult> {
    const run = this.finished.get(taskId);
    if (!run) throw new AiTaskError('TASK_NOT_FOUND', '该任务的结果已保存或已失效，请重新处理一次');
    const cap = this.catalog.find((c) => c.id === run.capabilityId);
    if (!cap) throw new AiTaskError('CAPABILITY_UNAVAILABLE', `找不到这个处理功能，无法保存结果`);
    if (!(await exists(run.sourceAbsPath))) {
      throw new AiTaskError('SOURCE_MISSING', `找不到原图（可能已被移动或删除）：${run.sourceAbsPath}`);
    }
    if (!(await exists(run.tempPath))) {
      this.finished.delete(taskId);
      throw new AiTaskError('PREVIEW_MISSING', '预览结果已被清理，请重新处理一次');
    }

    const dir = dirname(run.sourceAbsPath);
    const stem = basename(run.sourceAbsPath, extname(run.sourceAbsPath));
    const firstChoice = join(dir, `${stem}.${cap.outputSuffix}${cap.outputExt}`);
    // §6 裁定 1：派生文件是"当前结果"，改完底色再保存要覆盖同一张。认不出来源时一律递增——
    // 宁可多一个文件，也不可覆盖我们不认识的东西（用户手工放的同名文件、或旧版本导出的）
    const overwrote = (await exists(firstChoice)) && (await this.isOurDerivedFile(firstChoice, cap.actionTag));
    const wanted = overwrote ? firstChoice : await pickTargetName(dir, stem, cap.outputSuffix, cap.outputExt);

    try {
      await (this.deps.moveFile ?? rename)(run.tempPath, wanted);
    } catch (err) {
      // 移动没成功 ⇒ 暂存结果必须还在，用户看过并认可的东西不能因一次写入失败就消失
      throw new AiTaskError(
        'SAVE_FAILED',
        `保存到照片目录失败：${errorMessage(err)}。结果仍保留在预览暂存中，可直接重试`
      );
    }

    await this.removePreviewEntry(run.tempPath);
    this.finished.delete(taskId);

    let tagsWritten: string[] = [];
    if (this.deps.meta) {
      try {
        // 顺序不能反：exiftool 的 -all:all 会把 XMP-ptm:Tags 也从源图刷过去，
        // 先写标签再复制 → 行为标签被源图的旧标签覆盖掉（端到端实测到过）。
        await this.deps.meta.copyBase?.(run.sourceAbsPath, wanted);
        const inherited = await this.deps.meta.readTags(run.sourceAbsPath);
        tagsWritten = [...new Set([...inherited, cap.actionTag])];
        await this.deps.meta.writeTags(wanted, tagsWritten);
      } catch (err) {
        // 文件已经落在目录里，不能谎称保存失败；明确报元数据这一步出了问题
        throw new AiTaskError(
          'METADATA_WRITE_FAILED',
          `派生文件已保存为 ${basename(wanted)}，但写入标签/元数据失败：${errorMessage(err)}`
        );
      }
    }

    return {
      savedPath: wanted,
      targetName: basename(wanted),
      renamed: !overwrote && wanted !== firstChoice,
      overwrote,
      tagsWritten
    };
  }

  /**
   * 同名派生文件是不是我们自己导出的？判据是它身上带着本次的行为标签——
   * 上一次保存时 `writeTags` 就是把这对标签写进去的。
   *
   * 没有元数据通道、或读标签失败一律答"不是"：认不出来源就去递增，别覆盖。
   * 这条宁可多留一个文件，也不可静默替用户删掉一张我们不认识的照片。
   */
  private async isOurDerivedFile(absPath: string, actionTag: string): Promise<boolean> {
    if (!this.deps.meta) return false;
    try {
      return (await this.deps.meta.readTags(absPath)).includes(actionTag);
    } catch {
      return false;
    }
  }

  /**
   * 预览暂存的清理：**保留期与容量上限双条件**，任一触发即按最久未访问淘汰（§5.3）。
   * 只按时间清理等于假设用户用量恒定，不够。
   *
   * 删除前必须校验路径前缀在 `ai-preview/` 内（§5.0 红线 3）：索引被篡改或写坏时，
   * 少了这道校验就等于拿着一份 JSON 去删用户照片。只按索引删，目录里未被索引的
   * 文件一律不动——我们不知道它是什么，就不该删它。
   */
  async cleanup(overrides: { retentionDays?: number; maxBytes?: number } = {}): Promise<CleanupReport> {
    const index = await this.readPreviewIndex();
    const retention = this.deps.previewRetention ?? {};
    const now = (retention.now ?? Date.now)();
    const retentionDays = overrides.retentionDays ?? retention.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const maxBytes = overrides.maxBytes ?? retention.maxBytes ?? DEFAULT_PREVIEW_MAX_BYTES;
    const report: CleanupReport = { deleted: 0, refused: 0, freedBytes: 0, expiredBytes: 0 };

    // 整轮只写一次索引：边删边写会被后面的整体覆盖把已删条目又写回去。
    const nextEntries: Record<string, PreviewIndexEntry> = {};
    const kept: { key: string; path: string; sizeBytes: number; lastAccessedAt: number }[] = [];

    for (const [key, entry] of Object.entries(index.entries)) {
      const resolved = resolveInsidePreview(entry.fileName);
      if (!resolved) {
        report.refused += 1;
        continue; // 不删文件，也不保留这条索引
      }
      let sizeBytes: number;
      try {
        sizeBytes = (await stat(resolved)).size;
      } catch {
        continue; // 文件早就不在了，索引跟着清掉
      }
      kept.push({ key, path: resolved, sizeBytes, lastAccessedAt: entry.lastAccessedAt });
    }

    const expireBefore = now - retentionDays * 86_400_000;
    const survivors: typeof kept = [];
    let total = 0;
    for (const item of kept) {
      if (item.lastAccessedAt < expireBefore) {
        await removeFile(item.path);
        report.deleted += 1;
        report.freedBytes += item.sizeBytes;
        report.expiredBytes += item.sizeBytes;
        continue;
      }
      survivors.push(item);
      total += item.sizeBytes;
    }

    // 超上限：从最久未访问的开始淘汰，直到落到阈值以下
    survivors.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    while (total > maxBytes && survivors.length > 0) {
      const item = survivors.shift()!;
      await removeFile(item.path);
      report.deleted += 1;
      report.freedBytes += item.sizeBytes;
      total -= item.sizeBytes;
    }

    for (const item of survivors) {
      nextEntries[item.key] = { ...index.entries[item.key], sizeBytes: item.sizeBytes };
    }
    await this.writePreviewIndex({ version: 1, entries: nextEntries });
    return report;
  }

  /** 设置页只读统计用（模型占用、可用磁盘、整卡显存在 T13 另给）。 */
  async previewStats(): Promise<{ entries: number; totalBytes: number }> {
    const index = await this.readPreviewIndex();
    let totalBytes = 0;
    let entries = 0;
    for (const entry of Object.values(index.entries)) {
      const resolved = resolveInsidePreview(entry.fileName);
      if (!resolved) continue;
      try {
        totalBytes += (await stat(resolved)).size;
        entries += 1;
      } catch {
        // 文件不在了，统计里跳过；索引由 cleanup 负责清
      }
    }
    return { entries, totalBytes };
  }

  /** 记录一次可保存的结果（`ai:save(taskId)` 靠它找回暂存文件与原图）。 */
  private async settleRun(result: RunResult): Promise<RunResult> {
    this.finished.set(result.taskId, result);
    return result;
  }

  /** 登记成品条目，索引与掩码共用同一份。 */
  private async recordPreviewEntry(result: RunResult): Promise<void> {
    await this.upsertPreviewEntry(result.tempPath, {
      sourceAbsPath: result.sourceAbsPath,
      capabilityId: result.capabilityId,
      modelId: result.modelId
    });
  }

  /**
   * 把一个暂存文件登记进**同一份**索引（成品与掩码共用），于是保留期与容量上限那套
   * LRU 天然覆盖掩码，不需要第二套清理机制（§6 裁定 3）。
   */
  private async upsertPreviewEntry(
    absPath: string,
    meta: Pick<PreviewIndexEntry, 'sourceAbsPath' | 'capabilityId' | 'modelId'>
  ): Promise<void> {
    const index = await this.readPreviewIndex();
    const now = (this.deps.previewRetention?.now ?? Date.now)();
    let sizeBytes = 0;
    try {
      sizeBytes = (await stat(absPath)).size;
    } catch {
      return;
    }
    const fileName = previewRelName(absPath);
    const key = indexKeyOf(fileName);
    index.entries[key] = {
      fileName,
      sizeBytes,
      ...meta,
      createdAt: index.entries[key]?.createdAt ?? now,
      lastAccessedAt: now,
      kind: kindOfFileName(fileName)
    };
    await this.writePreviewIndex(index);
  }

  private async removePreviewEntry(tempPath: string): Promise<void> {
    const index = await this.readPreviewIndex();
    const key = indexKeyOf(previewRelName(tempPath));
    if (!index.entries[key]) return;
    delete index.entries[key];
    await this.writePreviewIndex(index);
  }

  /** 缓存命中也要刷时间，否则 LRU 记的是"第一次生成"而不是"最近在用"。 */
  private async touchPreviewEntry(tempPath: string): Promise<void> {
    const index = await this.readPreviewIndex();
    const key = indexKeyOf(previewRelName(tempPath));
    if (!index.entries[key]) return;
    index.entries[key].lastAccessedAt = (this.deps.previewRetention?.now ?? Date.now)();
    await this.writePreviewIndex(index);
  }

  private async readPreviewIndex(): Promise<PreviewIndex> {
    try {
      const parsed = JSON.parse(await readFile(previewFile(PREVIEW_INDEX_NAME), 'utf8')) as PreviewIndex;
      return { version: 1, entries: parsed.entries ?? {} };
    } catch {
      return { version: 1, entries: {} };
    }
  }

  private async writePreviewIndex(index: PreviewIndex): Promise<void> {
    const tmp = previewFile(`${PREVIEW_INDEX_NAME}.tmp`);
    await writeFile(tmp, JSON.stringify(index, null, 2));
    await rename(tmp, previewFile(PREVIEW_INDEX_NAME));
  }

  private async execute(taskId: string, req: RunRequest, signal: AbortSignal): Promise<RunResult> {
    this.throwIfCancelled(taskId);
    const cap = this.catalog.find((c) => c.id === req.capabilityId);
    if (!cap) throw new AiTaskError('CAPABILITY_UNAVAILABLE', `找不到这个处理功能，请重新打开预览再试`);
    const model = resolveModel(
      this.catalog,
      req.capabilityId,
      req.modelId ?? (await this.defaultModelFor(req.capabilityId))
    );
    // 后处理函数必须已注册，否则宁可在跑之前失败
    getPostprocessor(cap.postprocessId);

    let sourceStat;
    try {
      sourceStat = await stat(req.absPath);
    } catch {
      throw new AiTaskError('SOURCE_MISSING', `找不到原图（可能已被移动或删除）：${req.absPath}`);
    }
    if (!sourceStat.isFile()) throw new AiTaskError('SOURCE_MISSING', `这个目标不是一张图片：${req.absPath}`);

    // 参数从请求里带进来（附录 A「参数流转」）：写死在这里就等于面板改了也没人读。
    const cutout = resolveCutoutParams(req.cutout);
    const params = toCacheParams(cutout);
    const source = { absPath: req.absPath, mtimeMs: sourceStat.mtimeMs, size: sourceStat.size };
    const key = computeCacheKey({
      source,
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
        sourceAbsPath: req.absPath,
        cacheHit: true,
        didApplySigmoid: false,
        maskWidth: model.inputDims[3] ?? 0,
        maskHeight: model.inputDims[2] ?? 0,
        capabilityId: cap.id,
        modelId: model.id,
        actionTag: cap.actionTag
      };
      await this.touchPreviewEntry(tempPath);
      return this.settleRun(cached);
    }

    // ── 分界线：这张图的掩码算过没有（方案 §2）────────────────────────────
    // 掩码键**不含**后处理参数（附录 A），所以换底色会走到这里就停住，不必回头重跑 GPU。
    const maskKey = computeMaskCacheKey({
      source,
      modelSha256: model.sha256,
      inputDims: model.inputDims,
      pipelineVersion: PIPELINE_VERSION
    });
    const maskPath = maskFile(maskFileName(maskKey));
    const cachedMask = await readMaskPlane(maskPath);
    let mask: MaskPlane;
    if (cachedMask) {
      mask = cachedMask;
      await this.touchPreviewEntry(maskPath);
    } else {
      mask = await this.inferMaskPlane(taskId, req, model, signal);
      // 写失败不致命：这一次照样能出图，只是下次还要重跑推理；
      // 抛错反而是把已经花掉的 GPU 时间扔掉。
      await writeMaskPlane(maskPath, mask).catch(() => undefined);
      if (await exists(maskPath)) {
        await this.upsertPreviewEntry(maskPath, {
          sourceAbsPath: req.absPath,
          capabilityId: cap.id,
          modelId: model.id
        });
      }
    }
    this.throwIfCancelled(taskId);

    // ── 合成（底色在这一步铺，方案附录 A）→ 写暂存 ─────────────────────────
    this.emit(taskId, 'encode', 0);
    const composed = await composeCutoutPng(req.absPath, mask, cutout);
    try {
      await writeFile(tempPath, composed.png);
    } catch (err) {
      // §6：写盘失败要把半成品清掉，别在暂存里留下半个文件
      await removeQuietly(tempPath);
      throw new AiTaskError('WRITE_PREVIEW_FAILED', `写入预览暂存失败：${errorMessage(err)}`);
    }
    this.throwIfCancelled(taskId);

    const fresh: RunResult = {
      taskId,
      tempPath,
      sourceAbsPath: req.absPath,
      cacheHit: false,
      didApplySigmoid: composed.didApplySigmoid,
      maskWidth: composed.maskWidth,
      maskHeight: composed.maskHeight,
      capabilityId: cap.id,
      modelId: model.id,
      actionTag: cap.actionTag
    };
    await this.recordPreviewEntry(fresh);
    return this.settleRun(fresh);
  }

  /**
   * 分界线**以上**那一段（方案 §2 的"重"侧）：确保模型就绪 → 预处理 → 推理 → 裁掉补边。
   *
   * 只在掩码缓存没命中时才走到这里。一次点击走完 下载→加载→推理 是 D14 的口径，
   * 唯一的询问是首次下载前那一句代价告知（AG2）。
   */
  private async inferMaskPlane(
    taskId: string,
    req: RunRequest,
    model: ModelSpec,
    signal: AbortSignal
  ): Promise<MaskPlane> {
    // ── 确保模型就绪（下载是这一步的内部细节，不是用户步骤）─────────────
    const status = await this.deps.store.status(model.id);
    if (status === 'downloading') {
      throw new AiTaskError('MODEL_BUSY', `这个模型还在下载中，下载完成后再试`);
    }
    if (status === 'absent') {
      if (!req.downloadApproved) {
        throw new AiTaskError(
          'DOWNLOAD_NEEDS_CONSENT',
          `首次使用需要下载模型文件（约 ${roundMb(model.sizeBytes)} MB），请在弹窗中确认`
        );
      }
      this.emit(taskId, 'download', 0);
      await this.deps.store.download(toDownloadSpec(model), signal);
      this.emit(taskId, 'download', 100);
    }
    this.throwIfCancelled(taskId);

    const modelPath = join(modelDir(model.id), model.fileName);
    if (!(await exists(modelPath))) {
      throw new AiTaskError('MODEL_MISSING_ON_DISK', `模型文件不见了，请在模型下拉里删除后重新下载（${modelPath}）`);
    }

    // 后端变化也要重建会话：与"模型是否仍驻留"是 AND 关系，所以子进程崩溃或
    // 被外部卸载（loadedModelId 变 null）后，同后端同样会走重建路径。
    const backend: 'dml' | 'cpu' = req.backend ?? 'dml';
    if (this.deps.runner.loadedModelId !== model.id || this.loadedBackend !== backend) {
      this.emit(taskId, 'load', 0);
      try {
        await this.deps.runner.load({ modelPath, model, backend });
      } catch (err) {
        // 加载失败绝大多数出在显卡上：显存不够，或 DML 建会话就崩（实测 BiRefNet 的 DmlFusedNode）。
        // 认不出来就保留专用码 + 原文，别硬编成"显卡问题"误导人
        const msg = errorMessage(err);
        const gpu = classifyGpuError(msg);
        throw new AiTaskError(gpu?.code ?? 'MODEL_LOAD_FAILED', gpu?.message ?? msg);
      }
      this.loadedBackend = backend;
    }
    this.throwIfCancelled(taskId);

    // ── 预处理 + 推理 ────────────────────────────────────────────────────
    this.emit(taskId, 'infer', 0);
    let input: Awaited<ReturnType<typeof preprocessImage>>;
    try {
      input = await preprocessImage(req.absPath, model);
    } catch (err) {
      // RAW / HEIC / 多帧 GIF / 损坏文件：给专用码，界面能说明原因而不是"未知错误"
      throw new AiTaskError('DECODE_FAILED', errorMessage(err));
    }
    let reply;
    try {
      reply = await this.deps.runner.infer({ modelId: model.id, dims: input.dims, data: input.tensor });
    } catch (err) {
      // 推理期同样可能撞显存（大图 + 大模型）。分类只换文案与码，行为不变：
      // 绝不因为"显存不够"就自动改用 CPU 跑——D12 明令禁止无声降级，要用户自己勾
      const msg = errorMessage(err);
      const gpu = classifyGpuError(msg);
      throw new AiTaskError(gpu?.code ?? 'INFERENCE_FAILED', gpu?.message ?? msg);
    }
    this.throwIfCancelled(taskId);

    // 掩码裁掉补边：这一步之后的产物就是本方案缓存的那一层
    const full = toMaskPlane(reply.data, reply.dims);
    return cropMaskPlane(full, {
      x: input.padX,
      y: input.padY,
      width: input.contentWidth,
      height: input.contentHeight
    });
  }

  private throwIfCancelled(taskId: string): void {
    if (this.cancelled.has(taskId)) throw new AiTaskError('CANCELLED', '任务已取消');
  }

  private emit(taskId: string, phase: AiPhase, percent: number): void {
    this.publish({ type: 'progress', payload: { taskId, phase, percent } });
  }

  /**
   * IPC 层用它把 ai:progress / ai:done / ai:error 转发给窗口。
   * 订阅而不是构造时注入，是因为窗口会被重建（最小化到托盘后关窗再开）。
   */
  subscribe(listener: (event: AiEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(event: AiEvent): void {
    if (event.type === 'progress') this.deps.onProgress?.(event.payload);
    if (event.type === 'done') this.deps.onDone?.(event.payload);
    if (event.type === 'error') this.deps.onError?.(event.payload);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 一个订阅者抛错不影响其他订阅者与本次任务
      }
    }
  }
}

function toDownloadSpec(model: ModelSpec): ModelDownloadSpec {
  return {
    id: model.id,
    repoId: model.repoId,
    filePath: model.filePath,
    fileName: model.fileName,
    sizeBytes: model.sizeBytes,
    sha256: model.sha256
  };
}

/** 推理结果 → 掩码平面。形状一律从会话给的 dims 读，不写死。 */
function toMaskPlane(data: Float32Array, dims: number[]): MaskPlane {
  if (dims.length < 2) throw new AiTaskError('UNEXPECTED_OUTPUT', `模型返回的数据格式不对，已中止（形状 ${dims.join('x')}）`);
  const height = dims[dims.length - 2];
  const width = dims[dims.length - 1];
  if (width * height > data.length) {
    throw new AiTaskError('UNEXPECTED_OUTPUT', `模型返回的数据不完整，已中止（需要 ${width}×${height}，实际 ${data.length}）`);
  }
  return { data: data.subarray(0, width * height), width, height };
}

/**
 * 请求带来的抠图参数 → 完整 `CutoutParams`。
 *
 * 底色只认渲染层传来的预设 id：RGBA 数值本身留在 `BG_COLOR_PRESETS`，界面不抄第二份，
 * 于是"证件照蓝底到底是哪个蓝"只有一处定义。认不出来的 id 当透明处理，
 * 宁可不铺底色，也不要替用户猜一个颜色写进他的成品里。
 */
export function resolveCutoutParams(raw: AiCutoutParamsPayload | undefined): CutoutParams {
  if (!raw?.bgcolor) return { ...DEFAULT_CUTOUT_PARAMS };
  return { ...DEFAULT_CUTOUT_PARAMS, bgcolor: resolveBgColorId(raw.bgcolor) };
}

/** 掩码缓存落盘（`ai-preview/masks/<掩码键>.mask.bin`）；目录随首次写入创建。 */
async function writeMaskPlane(path: string, mask: MaskPlane): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, maskToBytes(mask));
}

/** 读掩码缓存。文件不在、读坏了、形状对不上一律返回 null——按"没有缓存"重跑推理。 */
async function readMaskPlane(path: string): Promise<MaskPlane | null> {
  try {
    return maskFromBytes(await readFile(path));
  } catch {
    return null;
  }
}

/**
 * 暂存索引就放在 `ai-preview/` 目录内：这样"清理只允许作用于暂存目录"这条
 * 红线（§5.0 红线 3）天然成立，索引和它描述的文件不可能分家。
 */
const PREVIEW_INDEX_NAME = 'index.json';

/**
 * 把索引里的 fileName 解析成一个确定落在暂存目录内的绝对路径。
 * 越界（绝对路径指向别处、或 ../.. 爬出去）返回 null，调用方必须拒绝删除。
 * 注：暂存目录内若存在指向外部的符号链接，`rm` 只断开链接本身，不会顺带删掉目标。
 */
function resolveInsidePreview(fileName: string): string | null {
  const root = normalize(previewDir()) + sep;
  const candidate = normalize(isAbsolute(fileName) ? fileName : join(previewDir(), fileName));
  return candidate.startsWith(root) && candidate !== normalize(previewDir()) ? candidate : null;
}

/** `原名.cutout.png` 已存在时不覆盖，改用 `原名.cutout.2.png`（§4.4 同名冲突）。 */
async function pickTargetName(dir: string, stem: string, suffix: string, ext: string): Promise<string> {
  const first = join(dir, `${stem}.${suffix}${ext}`);
  if (!(await exists(first))) return first;
  for (let n = 2; n < 1000; n++) {
    const candidate = join(dir, `${stem}.${suffix}.${n}${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new AiTaskError('SAVE_NAME_EXHAUSTED', `同名抠图文件太多，序号已用完，请先清理 ${stem}.${suffix} 开头的文件`);
}

async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true });
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
