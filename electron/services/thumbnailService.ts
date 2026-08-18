import { nativeImage } from 'electron';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import type { ThumbnailResult } from '../../shared/types';
import type { XmpService } from './xmpService';

/**
 * 缩略图服务（D4 性能策略②③）：
 * ① 磁盘缓存命中直接返回（key = sha1(absPath:mtimeMs:size)）
 * ② nativeImage 解码生成（JPG/PNG/WebP/GIF/BMP）
 * ③ 回退 exiftool 抽取内嵌缩略图（RAW/HEIC/TIFF）
 * ④ 失败返回占位图（不写缓存）
 * 生成走独立串行队列，避免与 XMP 读写并发争抢 exiftool。
 */

const THUMB_SIZE = 320;

const PLACEHOLDER_SVG = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="100%" height="100%" fill="#e2e8f0"/><text x="50%" y="50%" fill="#94a3b8" font-size="18" text-anchor="middle" dominant-baseline="middle">无预览</text></svg>`
)}`;

export class ThumbnailService {
  private readonly cacheDir: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly xmp: XmpService,
    userDataPath: string
  ) {
    this.cacheDir = join(userDataPath, 'thumbnails');
  }

  /** 请求缩略图：缓存命中立即返回；否则入生成队列 */
  async get(absPath: string): Promise<ThumbnailResult | null> {
    let stat;
    try {
      stat = await fs.stat(absPath);
    } catch {
      return null; // 文件不存在
    }

    const key = createHash('sha1')
      .update(`${absPath}:${stat.mtimeMs}:${stat.size}`)
      .digest('hex');
    const cacheFile = join(this.cacheDir, `${key}.jpg`);

    const cached = await this.readCache(cacheFile, absPath);
    if (cached) return cached;

    return this.enqueue(async () => {
      const again = await this.readCache(cacheFile, absPath);
      if (again) return again;
      const result = await this.generate(absPath, cacheFile);
      if (result && result.source !== 'placeholder') {
        await this.writeCache(cacheFile, result);
      }
      return result;
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async readCache(cacheFile: string, absPath: string): Promise<ThumbnailResult | null> {
    try {
      const buf = await fs.readFile(cacheFile);
      const img = nativeImage.createFromBuffer(buf);
      if (img.isEmpty()) return null;
      const size = img.getSize();
      return {
        absPath,
        dataUrl: img.toDataURL(),
        width: size.width,
        height: size.height,
        source: 'cache'
      };
    } catch {
      return null;
    }
  }

  private async writeCache(cacheFile: string, result: ThumbnailResult): Promise<void> {
    try {
      const dataUrl = result.dataUrl;
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      await fs.mkdir(this.cacheDir, { recursive: true });
      await fs.writeFile(cacheFile, Buffer.from(base64, 'base64'));
    } catch {
      // 缓存写入失败不影响使用（下次重新生成）
    }
  }

  /** 生成流程：nativeImage → exiftool 回退 → 占位图 */
  private async generate(absPath: string, cacheFile: string): Promise<ThumbnailResult | null> {
    // ① nativeImage 解码（JPG/PNG/WebP 等）
    const native = nativeImage.createFromPath(absPath);
    if (!native.isEmpty()) {
      const resized = native.getSize().width > THUMB_SIZE || native.getSize().height > THUMB_SIZE
        ? native.resize({ width: THUMB_SIZE })
        : native;
      const jpeg = resized.toJPEG(80);
      const img = nativeImage.createFromBuffer(jpeg);
      const size = img.getSize();
      return {
        absPath,
        dataUrl: img.toDataURL(),
        width: size.width,
        height: size.height,
        source: 'native'
      };
    }

    // ② exiftool 抽取内嵌预览（RAW/HEIC/TIFF）
    try {
      const buffer = await this.xmp.extractPreviewBuffer(absPath);
      if (buffer && buffer.length > 0) {
        const fromBuf = nativeImage.createFromBuffer(buffer);
        if (!fromBuf.isEmpty()) {
          const resized = fromBuf.getSize().width > THUMB_SIZE || fromBuf.getSize().height > THUMB_SIZE
            ? fromBuf.resize({ width: THUMB_SIZE })
            : fromBuf;
          const jpeg = resized.toJPEG(80);
          const img = nativeImage.createFromBuffer(jpeg);
          const size = img.getSize();
          return {
            absPath,
            dataUrl: img.toDataURL(),
            width: size.width,
            height: size.height,
            source: 'exiftool'
          };
        }
      }
    } catch {
      // 继续回退占位图
    }

    // ③ 占位图（不写缓存）
    return {
      absPath,
      dataUrl: PLACEHOLDER_SVG,
      width: THUMB_SIZE,
      height: THUMB_SIZE,
      source: 'placeholder'
    };
  }
}
