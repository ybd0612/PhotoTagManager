import { Worker } from 'worker_threads';
import { join } from 'path';
import type { WebContents } from 'electron';
import type { ImageFile, ScanStats } from '../../shared/types';

/**
 * 扫描编排服务：创建/复用 Worker、转发批推送、处理取消、保存最终图片快照。
 * Worker 构建产物位于 out/main/scanWorker.js（electron.vite.config.ts 额外入口）。
 */
export class ScanService {
  private worker: Worker | null = null;
  private readonly imagesById = new Map<string, ImageFile>();

  /** 启动扫描：终止旧 Worker → 新建 → 转发批/完成/错误事件到渲染进程 */
  startScan(rootPath: string, wc: WebContents): void {
    this.cancel();
    this.imagesById.clear();

    const worker = new Worker(join(__dirname, 'scanWorker.js'));
    this.worker = worker;

    worker.on('message', (msg: { type?: string; batch?: unknown; stats?: ScanStats; error?: { code: string; message: string }; rootPath?: string }) => {
      if (wc.isDestroyed()) return;
      if (msg?.type === 'batch' && msg.batch) {
        const batch = msg.batch as { images: ImageFile[] };
        for (const image of batch.images ?? []) {
          this.imagesById.set(image.id, image);
        }
        wc.send('scan:progress', msg.batch);
      } else if (msg?.type === 'done') {
        const stats = msg.stats as ScanStats;
        wc.send('scan:done', { rootPath, stats });
      } else if (msg?.type === 'error' && msg.error) {
        wc.send('scan:error', msg.error);
      }
    });

    worker.on('error', (err: Error) => {
      if (!wc.isDestroyed()) {
        wc.send('scan:error', { code: 'SCAN_WORKER_ERROR', message: err.message });
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
  }

  /** 当前扫描已发现图片的绝对路径列表（P1 标签重命名/合并用） */
  getAllImagePaths(): string[] {
    return [...this.imagesById.values()].map((image) => image.absPath);
  }

  /** 应用退出时释放 Worker */
  dispose(): void {
    this.cancel();
  }
}
