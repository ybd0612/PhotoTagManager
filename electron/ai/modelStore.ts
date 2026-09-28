import { createHash } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { statfs, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'fs/promises';
import { once } from 'events';
import { join } from 'path';

import { indexFile, modelDir, modelsDir } from './paths';
import {
  classifyFetchError,
  classifyHttpStatus,
  describeDownloadFailure,
  sourceTargets,
  type DownloadFailure,
  type SourceId
} from './modelSources';

/**
 * 模型权重的下载 / 断点续传 / 校验 / 本地索引 / 删除回收（规格 §5.1、附录 A.4）。
 *
 * 五条硬规矩都来自实测：
 * - 每个模型只存仓库坐标，实际地址按「ModelScope → hf-mirror」顺序展开，逐个试到成功为止；
 *   两个源的失败类别要分开记，"源上没有"和"这台机器出不去"绝不能共用一句话。
 * - 用哪个 fetch 由调用方注入（主进程给的是 Electron 的 net.fetch，配合系统/自定义代理设置）；
 * - 先写 `*.part`，完成后校验 sha256，再改名就位——**绝不允许直接写最终文件名**；
 * - 校验不通过就删文件并报"内容损坏"，静默用坏文件会在推理阶段崩得莫名其妙；
 * - 进度只报已收 / 总量。实测速率 0.39~2.8 MB/s 波动大，任何按固定速率外推的
 *   "预计还需 X 秒"都是假信息，所以进度对象里压根不提供这类字段。
 */

export interface ModelDownloadSpec {
  id: string;
  /** HuggingFace 风格的「命名空间/仓库名」，两个源共用 */
  repoId: string;
  /** 仓库内文件路径 */
  filePath: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

/** 单个源的失败，带上类别，供上层决定"下一句该说什么" */
class TransferError extends Error {
  constructor(message: string, readonly failure: DownloadFailure) {
    super(message);
    this.name = 'TransferError';
  }
}

export type ModelStatus = 'absent' | 'downloading' | 'present';

export interface DownloadProgress {
  modelId: string;
  receivedBytes: number;
  totalBytes: number;
}

export interface ModelStoreOptions {
  onProgress?: (p: DownloadProgress) => void;
  /** 注入点：单测用它构造"磁盘不足"场景 */
  freeBytesProbe?: (dir: string) => Promise<number>;
  fetchImpl?: typeof fetch;
}

export interface DownloadResult {
  path: string;
  sha256: string;
  sizeBytes: number;
  /** true 表示本地已就位、未再联网 */
  cacheHit: boolean;
}

interface ModelIndexEntry {
  sha256: string;
  sizeBytes: number;
  path: string;
  installedAt: string;
}

interface ModelIndex {
  version: 1;
  models: Record<string, ModelIndexEntry>;
}

/**
 * 下载前要求的可用空间 = 模型体积 × 2。
 * × 2 是「一份模型 + 一份派生图峰值」的保守占位（§5.1 明写安全余量未实测），
 * 实测出真实峰值后再收紧；在此之前界面不得显示"预计还需 X"。
 */
const REQUIRED_FREE_FACTOR = 2;

export class ModelStore {
  private readonly inFlight = new Set<string>();
  private readonly onProgress?: (p: DownloadProgress) => void;
  private readonly freeBytesProbe: (dir: string) => Promise<number>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ModelStoreOptions = {}) {
    this.onProgress = opts.onProgress;
    this.freeBytesProbe =
      opts.freeBytesProbe ??
      (async (dir: string) => {
        const { bsize, bavail } = await statfs(dir);
        return Number(bsize) * Number(bavail);
      });
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** 同步置位在任何一个 await 之前，调用方拿到 Promise 后立刻 status() 必然 seeing downloading。 */
  async status(modelId: string): Promise<ModelStatus> {
    if (this.inFlight.has(modelId)) return 'downloading';
    try {
      const files = await readdir(modelDir(modelId));
      return files.some((f) => !f.endsWith('.part')) ? 'present' : 'absent';
    } catch {
      return 'absent';
    }
  }

  async download(spec: ModelDownloadSpec, signal?: AbortSignal): Promise<DownloadResult> {
    this.inFlight.add(spec.id);
    const dir = modelDir(spec.id, { create: true });
    const target = join(dir, spec.fileName);
    const part = `${target}.part`;

    try {
      const already = await this.readExisting(target, spec);
      if (already) return { ...already, cacheHit: true };

      const freeBytes = await this.freeBytesProbe(modelsDir()).catch(() => {
        throw new Error('无法读取磁盘可用空间，已取消下载');
      });
      const required = spec.sizeBytes * REQUIRED_FREE_FACTOR;
      if (freeBytes < required) {
        throw new Error(
          `磁盘可用空间不足：需要约 ${Math.ceil(required / 1048576)} MB，` +
            `当前只剩约 ${Math.floor(freeBytes / 1048576)} MB`
        );
      }

      const existingPart = await sizeOf(part);
      if (existingPart > spec.sizeBytes) await rm(part, { force: true }); // 比目标还大 = 脏数据，重来

      const ref = { repoId: spec.repoId, filePath: spec.filePath };
      const failures: Array<{ source: SourceId; failure: DownloadFailure }> = [];
      for (const src of sourceTargets(ref)) {
        try {
          await this.transfer(spec, src.url, part, target, signal);
        } catch (err) {
          if (err instanceof TransferError && err.failure === 'cancelled') throw new Error('下载已取消');
          const failure = err instanceof TransferError ? err.failure : classifyFetchError(err);
          failures.push({ source: src.source, failure });
          continue;
        }
        const actualSha = await sha256OfFile(target);
        if (actualSha !== spec.sha256) {
          // 坏文件绝不留着：下一次推理崩在半路比现在多试一个源难查得多
          await rm(target, { force: true });
          failures.push({ source: src.source, failure: 'corrupt' });
          continue;
        }
        const sizeBytes = (await stat(target)).size;
        await this.recordIndex(spec, target, sizeBytes);
        this.emitProgress(spec.id, sizeBytes, sizeBytes);
        return { path: target, sha256: actualSha, sizeBytes, cacheHit: false };
      }
      throw new Error(describeDownloadFailure(ref, failures));
    } finally {
      this.inFlight.delete(spec.id);
    }
  }

  /** 删除同时清临时文件与索引条目（§5.1：不留孤儿）。 */
  async remove(modelId: string): Promise<void> {
    const dir = modelDir(modelId);
    await rm(dir, { recursive: true, force: true });
    const index = await this.readIndex();
    if (index.models[modelId]) {
      delete index.models[modelId];
      await this.writeIndex(index);
    }
  }

  async installedModels(): Promise<Record<string, ModelIndexEntry>> {
    return (await this.readIndex()).models;
  }

  // ── 内部实现 ────────────────────────────────────────────────────────────

  private async transfer(
    spec: ModelDownloadSpec,
    url: string,
    part: string,
    target: string,
    signal?: AbortSignal
  ): Promise<void> {
    const startBytes = await sizeOf(part);
    const headers: Record<string, string> = startBytes > 0 ? { Range: `bytes=${startBytes}-` } : {};
    const res = await this.fetchImpl(url, { headers, signal }).catch((err: unknown) => {
      if (isAbort(err)) throw new TransferError('下载已取消', 'cancelled');
      // 抛到这里说明是连接层异常（超时/DNS/拒绝/代理不可达），换源才有意义
      throw new TransferError(`下载请求失败：${describeError(err)}`, classifyFetchError(err));
    });
    const httpFailure = classifyHttpStatus(res.status);
    if (httpFailure) {
      throw new TransferError(`下载失败：HTTP ${res.status}`, httpFailure);
    }
    if (!res.body) throw new TransferError('下载失败：响应没有内容', 'unreachable');

    // 要求续传但服务器当没看见 → 只能整份重来，否则拼起来是坏文件
    const resumeApplied = startBytes > 0 && res.status === 206;
    const offset = resumeApplied ? startBytes : 0;
    if (!resumeApplied && startBytes > 0) await rm(part, { force: true });

    const declared = Number(res.headers.get('content-length'));
    const totalBytes = Number.isFinite(declared) && declared > 0 ? offset + declared : spec.sizeBytes;

    const ws = createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' });
    const reader = res.body.getReader();
    let received = offset;
    try {
      for (;;) {
        if (signal?.aborted) throw new Error('下载已取消');
        const { done, value } = await reader.read().catch((err: unknown) => {
          if (isAbort(err)) throw new TransferError('下载已取消', 'cancelled');
          throw new TransferError(`下载中断：${describeError(err)}`, 'unreachable');
        });
        if (done) break;
        if (!value) continue;
        received += value.byteLength;
        if (!ws.write(value)) await once(ws, 'drain');
        this.emitProgress(spec.id, received, totalBytes);
      }
      ws.end();
      await once(ws, 'finish');
      await once(ws, 'close');
    } catch (err) {
      ws.destroy();
      await once(ws, 'close').catch(() => undefined);
      void reader.cancel().catch(() => undefined);
      throw err;
    }
    if (received !== totalBytes) {
      // 服务器提前收尾：保留 .part 供下次续传，但本次必须报失败，不能当成功
      throw new TransferError(`下载不完整：已收 ${received} / ${totalBytes} 字节，可重试继续`, 'unreachable');
    }

    await rename(part, target);
  }

  private async readExisting(target: string, spec: ModelDownloadSpec) {
    const size = await sizeOf(target);
    if (size !== spec.sizeBytes) return null;
    return { path: target, sha256: spec.sha256, sizeBytes: size };
  }

  private async readIndex(): Promise<ModelIndex> {
    try {
      const parsed = JSON.parse(await readFile(indexFile(), 'utf8')) as ModelIndex;
      return { version: 1, models: parsed.models ?? {} };
    } catch {
      return { version: 1, models: {} };
    }
  }

  private async writeIndex(index: ModelIndex): Promise<void> {
    await mkdir(modelsDir(), { recursive: true });
    const tmp = `${indexFile()}.tmp`;
    await writeFile(tmp, JSON.stringify(index, null, 2));
    await rename(tmp, indexFile());
  }

  private async recordIndex(spec: ModelDownloadSpec, path: string, sizeBytes: number): Promise<void> {
    const index = await this.readIndex();
    index.models[spec.id] = { sha256: spec.sha256, sizeBytes, path, installedAt: new Date().toISOString() };
    await this.writeIndex(index);
  }

  private emitProgress(modelId: string, receivedBytes: number, totalBytes: number): void {
    this.onProgress?.({ modelId, receivedBytes, totalBytes });
  }
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(path);
    rs.on('error', reject);
    rs.on('data', (chunk: string | Buffer) => hash.update(chunk));
    rs.on('end', resolve);
  });
  return hash.digest('hex');
}

function isAbort(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    (('name' in err && (err as { name: unknown }).name === 'AbortError') ||
      ('code' in err && (err as { code: unknown }).code === 'ABORT_ERR'))
  );
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
