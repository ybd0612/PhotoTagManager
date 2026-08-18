import { ExifTool } from 'exiftool-vendored';
import type { ImageInfo, TagInfo, TagWriteRequest } from '../../shared/types';

/**
 * XMP 标签服务（D3）：exiftool-vendored 封装。
 * - 串行队列：所有读写任务排队执行，天然限流（exiftool 单实例）
 * - 写标签只更新 dc:subject / xmp:Label，保留 XMP 其他字段（无损）
 * - 单个任务超时 30s，失败进入错误映射表，不阻塞队列
 */
export class XmpService {
  private exif: ExifTool | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  /** 串行入队 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private getExif(): ExifTool {
    if (!this.exif) {
      this.exif = new ExifTool({ spawnTimeoutMillis: 30000, taskTimeoutMillis: 30000 });
    }
    return this.exif;
  }

  /** dc:subject 可能是 string | string[] | undefined → 归一化为去重数组 */
  private normalizeSubjects(raw: unknown): string[] {
    const arr = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
    return [...new Set(arr.map((s) => String(s).trim()).filter((s) => s.length > 0))];
  }

  /** 错误映射：尽量给出稳定的错误码 */
  private mapError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not writable|read-only|readonly/i.test(msg)) return 'READONLY_FILE';
    if (/no such file|not found/i.test(msg)) return 'FILE_NOT_FOUND';
    if (/unsupported|not supported|unable to/i.test(msg)) return 'UNSUPPORTED_FORMAT';
    return 'EXIF_TOOL_ERROR';
  }

  /** 读取单张图片 XMP 标签（dc:subject 合并去重 + xmp:Label） */
  async read(absPath: string): Promise<TagInfo> {
    return this.enqueue(async () => {
      try {
        const tags = await this.getExif().read(absPath);
        const subjects = this.normalizeSubjects(tags.Subject);
        const label = typeof tags.Label === 'string' && tags.Label.length > 0 ? tags.Label : undefined;
        return { absPath, subjects, label, ok: true };
      } catch (err) {
        return { absPath, subjects: [], ok: false, error: this.mapError(err) };
      }
    });
  }

  /** 写回标签：读当前 → 差量应用 → 写 dc:subject / xmp:Label，保留其他字段 */
  async write(req: TagWriteRequest): Promise<TagInfo> {
    return this.enqueue(async () => {
      try {
        const exif = this.getExif();
        const current = await exif.read(req.absPath);
        const currentSubjects = this.normalizeSubjects(current.Subject);
        const currentLabel = typeof current.Label === 'string' ? current.Label : undefined;

        const add = req.add ?? [];
        const remove = req.remove ?? [];
        const nextSubjects = [
          ...new Set([...currentSubjects.filter((s) => !remove.includes(s)), ...add])
        ];
        const nextLabel = req.setLabel !== undefined ? req.setLabel : currentLabel;

        const writeArgs: Record<string, unknown> = {
          Subject: nextSubjects.length > 0 ? nextSubjects : ''
        };
        if (nextLabel !== undefined) {
          writeArgs.Label = nextLabel;
        }

        await exif.write(req.absPath, writeArgs, ['-overwrite_original']);
        return {
          absPath: req.absPath,
          subjects: nextSubjects,
          label: nextLabel || undefined,
          ok: true
        };
      } catch (err) {
        return { absPath: req.absPath, subjects: [], ok: false, error: this.mapError(err) };
      }
    });
  }

  /** 批量读取（逐张排队） */
  async readBulk(absPaths: string[]): Promise<TagInfo[]> {
    const results: TagInfo[] = [];
    for (const absPath of absPaths) {
      results.push(await this.read(absPath));
    }
    return results;
  }

  /** 批量写入：队列逐个处理 + 进度回调（tags:batch-progress） */
  async writeBatch(
    reqs: TagWriteRequest[],
    onProgress?: (p: { done: number; total: number }) => void
  ): Promise<{ okCount: number; failCount: number }> {
    let okCount = 0;
    let failCount = 0;
    for (let i = 0; i < reqs.length; i += 1) {
      const result = await this.write(reqs[i]);
      if (result.ok) okCount += 1;
      else failCount += 1;
      onProgress?.({ done: i + 1, total: reqs.length });
    }
    return { okCount, failCount };
  }

  /** P1：标签重命名/合并（对全量图片读改写；from 命中即替换为 to，合并去重） */
  async renameTag(from: string, to: string, absPaths: string[]): Promise<number> {
    if (!from || !to || from === to) return 0;
    let renamed = 0;
    for (const absPath of absPaths) {
      const info = await this.read(absPath);
      if (!info.ok || !info.subjects.includes(from)) continue;
      const nextSubjects = [...new Set(info.subjects.map((s) => (s === from ? to : s)))];
      const result = await this.write({ absPath, add: nextSubjects, remove: info.subjects });
      if (result.ok) renamed += 1;
    }
    return renamed;
  }

  /** 读取图片基本信息（P1：分辨率/拍摄时间/文件大小/相机型号） */
  async getImageInfo(absPath: string): Promise<ImageInfo> {
    return this.enqueue(async () => {
      try {
        const tags = await this.getExif().read(absPath);
        const num = (v: unknown): number | undefined => {
          if (typeof v === 'number') return v;
          if (typeof v === 'string') {
            const parsed = parseInt(v, 10);
            return Number.isNaN(parsed) ? undefined : parsed;
          }
          return undefined;
        };
        return {
          absPath,
          width: num(tags.ImageWidth) ?? num(tags.ExifImageWidth),
          height: num(tags.ImageHeight) ?? num(tags.ExifImageHeight),
          sizeBytes: tags.FileSize ? parseInt(tags.FileSize, 10) : undefined,
          dateTimeOriginal: typeof tags.DateTimeOriginal === 'string' ? tags.DateTimeOriginal : undefined,
          make: typeof tags.Make === 'string' ? tags.Make : undefined,
          model: typeof tags.Model === 'string' ? tags.Model : undefined,
          ok: true
        };
      } catch (err) {
        return { absPath, ok: false, error: this.mapError(err) };
      }
    });
  }

  /**
   * 抽取内嵌预览图/缩略图二进制（RAW/HEIC/TIFF 缩略图回退用，D4 性能策略③）。
   * 按 PreviewImage → JpgFromRaw → ThumbnailImage 顺序尝试；返回 Buffer 或 null。
   */
  async extractPreviewBuffer(absPath: string): Promise<Buffer | null> {
    return this.enqueue(async () => {
      const exif = this.getExif();
      const candidates = ['PreviewImage', 'JpgFromRaw', 'ThumbnailImage'];
      for (const key of candidates) {
        try {
          const buf = await exif.extractBinaryTagToBuffer(key, absPath);
          if (buf && buf.length > 0) return buf;
        } catch {
          // 该标签不存在（如 JPEG 无 JpgFromRaw），尝试下一个
        }
      }
      return null;
    });
  }

  /** 应用退出时结束 exiftool 子进程 */
  async dispose(): Promise<void> {
    await this.enqueue(async () => {
      if (this.exif) {
        await this.exif.end();
        this.exif = null;
      }
    });
  }
}
