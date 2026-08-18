import { parentPort } from 'worker_threads';
import { readdir, stat, lstat } from 'fs/promises';
import { basename, extname, join } from 'path';
import { createHash } from 'crypto';
import { isImageFile } from '../../shared/imageExt';
import type { FolderNode, ImageFile, ScanBatch, ScanStats } from '../../shared/types';

/**
 * scanWorker：worker_threads 扫描线程（D4 性能策略①）。
 * DFS 递归遍历目录 → 扩展名过滤 → 后序累加 direct/total → 每 ~200 图片推送一批。
 * 只读文件系统，不触碰 XMP（性能）。
 *
 * 纯逻辑通过 walkDirectory() 导出，便于单测（tests/scan.test.ts mock fs/promises）；
 * 作为 worker 运行时（parentPort 非空）才注册消息监听。
 */

export interface ScanOptions {
  rootPath: string;
  batchSize?: number;
  onBatch: (batch: ScanBatch) => void;
  shouldCancel?: () => boolean;
}

/** 每批推送的图片数阈值 */
const DEFAULT_BATCH_SIZE = 200;
/** 目录节点积压阈值（避免大量小目录迟迟不推送给 UI） */
const FOLDER_BATCH_FLUSH = 100;

/**
 * 递归遍历 rootPath，增量推送目录树节点与图片批次。
 * @returns 最终统计（done=false 表示被取消）
 */
export async function walkDirectory(options: ScanOptions): Promise<ScanStats> {
  let rootAbs = options.rootPath.replace(/[\\/]+$/, '');
  // 盘符根（如 C:\ → "C:"）必须保留分隔符：裸 "C:" 是 drive-relative 路径，
  // fs 会把它解析为进程 cwd 所在的 C 盘目录（而非盘符根），导致扫到错误位置。
  if (/^[a-zA-Z]:$/.test(rootAbs)) {
    rootAbs += '\\';
  }
  const batchSize = options.batchSize && options.batchSize > 0 ? options.batchSize : DEFAULT_BATCH_SIZE;
  const shouldCancel = options.shouldCancel ?? (() => false);

  const stats: ScanStats = { scannedFiles: 0, imageCount: 0, totalFiles: 0, done: false };
  let pendingImages: ImageFile[] = [];
  let pendingFolders: FolderNode[] = [];
  let batchIndex = 0;
  let cancelled = false;

  const flush = (done: boolean): void => {
    if (done || pendingImages.length >= batchSize || pendingFolders.length >= FOLDER_BATCH_FLUSH) {
      if (pendingImages.length === 0 && pendingFolders.length === 0 && !done) return;
      options.onBatch({
        batchIndex: batchIndex++,
        folders: pendingFolders,
        images: pendingImages,
        stats: { ...stats, done }
      });
      pendingImages = [];
      pendingFolders = [];
    }
  };

  /** 绝对路径 → 相对根目录路径（'/' 分隔；根目录直接子项无前缀） */
  const relPathOf = (abs: string): string => {
    const rel = abs.slice(rootAbs.length).replace(/\\/g, '/');
    return rel.replace(/^\/+/, '');
  };

  const walk = async (dirAbs: string, dirRel: string): Promise<FolderNode | null> => {
    if (cancelled || shouldCancel()) {
      cancelled = true;
      return null;
    }
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      // 无权限/不存在等：跳过该目录，不中断扫描
      return null;
    }

    const subDirs: { abs: string; rel: string }[] = [];
    let directCount = 0;

    for (const entry of entries) {
      if (cancelled || shouldCancel()) {
        cancelled = true;
        return null;
      }
      if (entry.isDirectory()) {
        // 跳过符号链接/junction：Windows 系统盘存在自循环 junction
        // （如 AppData\Local\Application Data → AppData\Local 自身），
        // 跟随会导致 DFS 无限递归、扫描卡死。
        try {
          const lst = await lstat(join(dirAbs, entry.name));
          if (lst.isSymbolicLink()) continue;
        } catch {
          continue;
        }
        subDirs.push({
          abs: join(dirAbs, entry.name),
          rel: dirRel ? `${dirRel}/${entry.name}` : entry.name
        });
      } else if (entry.isFile()) {
        stats.scannedFiles += 1;
        if (isImageFile(entry.name)) {
          const absPath = join(dirAbs, entry.name);
          const image: ImageFile = {
            id: createHash('sha1').update(absPath).digest('hex').slice(0, 16),
            absPath,
            relPath: dirRel ? `${dirRel}/${entry.name}` : entry.name,
            name: entry.name,
            ext: extname(entry.name).toLowerCase(),
            size: 0,
            mtimeMs: 0,
            dirRelPath: dirRel,
            tags: []
          };
          try {
            const st = await stat(absPath);
            image.size = st.size;
            image.mtimeMs = st.mtimeMs;
          } catch {
            // stat 失败保留 0（缩略图缓存 key 仍可用）
          }
          pendingImages.push(image);
          stats.imageCount += 1;
          directCount += 1;
          flush(false);
        }
      }
    }

    let totalCount = directCount;
    const children: FolderNode[] = [];
    for (const sub of subDirs) {
      const child = await walk(sub.abs, sub.rel);
      if (child && child.totalCount > 0) {
        children.push(child);
        totalCount += child.totalCount;
      }
    }

    // D1：递归含图片数 > 0 才作为可见目录节点下发
    if (totalCount === 0) return null;

    children.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    const node: FolderNode = {
      relPath: dirRel,
      name: basename(dirAbs),
      directCount,
      totalCount,
      hidden: false,
      childrenLoaded: true,
      children
    };
    // D1：根目录自身不下发（relPath=''，根节点由 UI 从 rootPath 构造）
    if (dirRel !== '') {
      pendingFolders.push(node);
      flush(false);
    }
    return node;
  };

  await walk(rootAbs, '');
  if (!cancelled) {
    stats.totalFiles = stats.scannedFiles;
    stats.done = true;
    flush(true);
  }
  return stats;
}

// ---- worker 消息协议（仅在 worker 线程上下文生效） ----
let cancelled = false;

if (parentPort) {
  parentPort.on('message', (msg: { type?: string; rootPath?: string }) => {
    if (msg?.type === 'start' && msg.rootPath) {
      void walkDirectory({
        rootPath: msg.rootPath,
        onBatch: (batch) => parentPort?.postMessage({ type: 'batch', batch }),
        shouldCancel: () => cancelled
      })
        .then((stats) => {
          if (cancelled) {
            parentPort?.postMessage({ type: 'cancelled' });
          } else {
            parentPort?.postMessage({ type: 'done', stats });
          }
        })
        .catch((err: unknown) => {
          parentPort?.postMessage({
            type: 'error',
            error: { code: 'SCAN_ERROR', message: err instanceof Error ? err.message : String(err) }
          });
        });
    } else if (msg?.type === 'cancel') {
      cancelled = true;
    }
  });
}
