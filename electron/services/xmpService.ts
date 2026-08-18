import { ExifTool } from 'exiftool-vendored';
import { promises as fs } from 'fs';
import { join } from 'path';
import type { ImageInfo, TagInfo, TagWriteRequest } from '../../shared/types';

/**
 * XMP 标签服务（D3）：exiftool-vendored 封装。
 * - 串行队列：所有读写任务排队执行，天然限流（exiftool 单实例）
 * - 标签存储于**自定义 XMP 命名空间 XMP-ptm:Tags**（JSON 数组），
 *   Windows 属性面板不识别该命名空间 → "标记"属性不显示（普通图片与 GIF 一致）
 * - 写入时同时清空标准 dc:subject（Windows 标记来源），实现渐进迁移；
 *   读取时兼容旧 dc:subject 数据（迁移前打的标签仍可见）
 * - 单个任务超时 30s，失败进入错误映射表，不阻塞队列
 */

/** 自定义命名空间配置文件内容（exiftool 需 -config 注册 ptm 命名空间） */
const PTM_CONFIG_CONTENT = `# PhotoTagManager custom XMP namespace (ptm)
# Tags are stored in XMP-ptm:Tags; Windows Explorer does not recognize this
# namespace, so the "Tags" property stays empty for both regular images and GIF.
%Image::ExifTool::UserDefined = (
    'Image::ExifTool::XMP::Main' => {
        ptm => {
            SubDirectory => { TagTable => 'Image::ExifTool::UserDefined::ptm' },
        },
    },
);

%Image::ExifTool::UserDefined::ptm = (
    GROUPS => { 0 => 'XMP', 1 => 'XMP-ptm', 2 => 'Image' },
    NAMESPACE => { 'ptm' => 'https://phototagmanager.local/ptm/1.0/' },
    WRITABLE => 'string',
    Tags => { Writable => 'string' },
);

1;
`;

export class XmpService {
  private exif: ExifTool | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly configHome: string;
  private readonly configPath: string;

  constructor(userDataPath: string) {
    // exiftool 启动时自动加载 $EXIFTOOL_HOME/.ExifTool_config，
    // 用环境变量注册自定义命名空间，避免 -config 参数在 exiftool-vendored
    // 常驻模式（-stay_open）下挂起或位置错乱导致写入失效。
    this.configHome = join(userDataPath, 'exiftool-config');
    this.configPath = join(this.configHome, '.ExifTool_config');
  }

  /** 串行入队 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** 确保自定义命名空间配置文件存在（不存在则写入 userData） */
  private async ensureConfig(): Promise<void> {
    try {
      await fs.access(this.configPath);
    } catch {
      await fs.mkdir(this.configHome, { recursive: true });
      await fs.writeFile(this.configPath, PTM_CONFIG_CONTENT, 'utf-8');
    }
  }

  private async getExif(): Promise<ExifTool> {
    if (!this.exif) {
      await this.ensureConfig();
      this.exif = new ExifTool({
        spawnTimeoutMillis: 30000,
        taskTimeoutMillis: 30000,
        // 通过 EXIFTOOL_HOME 自动加载 .ExifTool_config（注册 ptm 命名空间）
        exiftoolEnv: { EXIFTOOL_HOME: this.configHome }
      });
    }
    return this.exif;
  }

  /** dc:subject 可能是 string | string[] | undefined → 归一化为去重数组 */
  private normalizeSubjects(raw: unknown): string[] {
    const arr = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
    return [...new Set(arr.map((s) => String(s).trim()).filter((s) => s.length > 0))];
  }

  /**
   * 读取标签：XMP-ptm:Tags（JSON 数组）优先；
   * 回退旧 dc:subject（迁移前写入的标签仍可见，渐进迁移）。
   */
  private parseTags(tags: Record<string, unknown>): string[] {
    const raw = tags.Tags;
    if (typeof raw === 'string' && raw.trim().length > 0) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          return [...new Set(parsed.map((s) => String(s).trim()).filter((s) => s.length > 0))];
        }
      } catch {
        // 非 JSON（异常数据）走字符串归一化兜底
      }
      return this.normalizeSubjects(raw);
    }
    return this.normalizeSubjects(tags.Subject);
  }

  /** 错误映射：尽量给出稳定的错误码 */
  private mapError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not writable|read-only|readonly/i.test(msg)) return 'READONLY_FILE';
    if (/no such file|not found/i.test(msg)) return 'FILE_NOT_FOUND';
    if (/unsupported|not supported|unable to/i.test(msg)) return 'UNSUPPORTED_FORMAT';
    return 'EXIF_TOOL_ERROR';
  }

  /** 读取单张图片标签（XMP-ptm:Tags 解析 + xmp:Label） */
  async read(absPath: string): Promise<TagInfo> {
    return this.enqueue(async () => {
      try {
        const exif = await this.getExif();
        const tags = (await exif.read(absPath)) as Record<string, unknown>;
        const subjects = this.parseTags(tags);
        const label = typeof tags.Label === 'string' && tags.Label.length > 0 ? tags.Label : undefined;
        return { absPath, subjects, label, ok: true };
      } catch (err) {
        return { absPath, subjects: [], ok: false, error: this.mapError(err) };
      }
    });
  }

  /** 写回标签：读当前 → 差量应用 → 写 XMP-ptm:Tags + 清空 dc:subject（Windows 标记），保留 Label */
  async write(req: TagWriteRequest): Promise<TagInfo> {
    return this.enqueue(async () => {
      try {
        const exif = await this.getExif();
        const current = (await exif.read(req.absPath)) as Record<string, unknown>;
        const currentSubjects = this.parseTags(current);
        const currentLabel = typeof current.Label === 'string' ? current.Label : undefined;

        const add = req.add ?? [];
        const remove = req.remove ?? [];
        const nextSubjects = [
          ...new Set([...currentSubjects.filter((s) => !remove.includes(s)), ...add])
        ];
        const nextLabel = req.setLabel !== undefined ? req.setLabel : currentLabel;

        const writeArgs: Record<string, unknown> = {
          Tags: JSON.stringify(nextSubjects),
          Subject: '' // 清空标准 dc:subject（Windows 属性面板"标记"来源），渐进迁移
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
        const exif = await this.getExif();
        const tags = (await exif.read(absPath)) as Record<string, unknown>;
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
          sizeBytes: tags.FileSize ? parseInt(String(tags.FileSize), 10) : undefined,
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
      const exif = await this.getExif();
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
