import { Worker } from 'worker_threads';
import { join } from 'path';
import type { WebContents } from 'electron';
import type { ImageFile, ScanBatch, ScanStats } from '../../shared/types';

/**
 * 扫描编排服务：创建/复用 Worker、转发批推送、处理取消、按根保存最终图片快照。
 * Worker 构建产物位于 out/main/scanWorker.js（electron.vite.config.ts 额外入口）。
 * 多根支持：imagesByRoot 按 rootId 分桶累积；事件均携带 rootId。
 */
export class ScanService {
  private worker: Worker | null = null;
  private currentRootId: string | null = null;
  private readonly imagesByRoot = new Map<string, Map<string, ImageFile>>();

  /** 启动扫描：终止旧 Worker → 新建 → 转发批/完成/错误事件到渲染进程 */
  startScan(rootId: string, rootPath: string, wc: WebContents): void {
    this.cancel();
    this.imagesByRoot.set(rootId, new Map());
    this.currentRootId = rootId;

    const worker = new Worker(join(__dirname, 'scanWorker.js'));
    this.worker = worker;

    worker.on('message', (msg: { type?: string; batch?: ScanBatch; stats?: ScanStats; error?: { code: string; message: string }; rootPath?: string }) => {
      if (wc.isDestroyed()) return;
      if (msg?.type === 'batch' && msg.batch) {
        const batch: ScanBatch = { ...msg.batch, rootId };
        const rootImages = this.imagesByRoot.get(rootId) ?? new Map();
        for (const image of batch.images ?? []) {
          rootImages.set(image.id, image);
        }
        this.imagesByRoot.set(rootId, rootImages);
        wc.send('scan:progress', batch);
      } else if (msg?.type === 'done') {
        const stats = msg.stats as ScanStats;
        wc.send('scan:done', { rootId, rootPath, stats });
      } else if (msg?.type === 'error' && msg.error) {
        wc.send('scan:error', { ...msg.error, rootId });
      }
    });

    worker.on('error', (err: Error) => {
      if (!wc.isDestroyed()) {
        wc.send('scan:error', { code: 'SCAN_WORKER_ERROR', message: err.message, rootId });
      }
    });

    worker.postMessage({ type: 'start', rootPath });
  }

  /** 取消当前扫描（终止 Worker） */
  cancel(): void {
    if (this.worker) {
      this.worker.terminate().catch(() => undefined);
      this.worker = null;
    }
    this.currentRootId = null;
  }

  /** 当前扫描所属根（渲染层判断进度归属用） */
  getCurrentRootId(): string | null {
    return this.currentRootId;
  }

  /** 已扫描某根？ */
  hasRoot(rootId: string): boolean {
    return this.imagesByRoot.has(rootId);
  }

  /** 全部根已发现图片的绝对路径列表（P1 标签重命名/合并用） */
  getAllImagePaths(): string[] {
    const all: string[] = [];
    for (const rootImages of this.imagesByRoot.values()) {
      for (const image of rootImages.values()) {
        all.push(image.absPath);
      }
    }
    return all;
  }

  /** 应用退出时释放 Worker */
  dispose(): void {
    this.cancel();
  }
}
