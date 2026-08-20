import { Worker } from 'worker_threads';
import { randomUUID } from 'crypto';
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
  private currentScanId: string | null = null;
  private readonly imagesByRoot = new Map<string, Map<string, ImageFile>>();

  /** 启动扫描：终止旧 Worker → 新建 → 转发批/完成/错误事件到渲染进程 */
  startScan(rootId: string, rootPath: string, wc: WebContents, requestedScanId?: string): string {
    this.cancel();
    const scanId = requestedScanId ?? randomUUID();
    this.imagesByRoot.set(rootId, new Map());
    this.currentRootId = rootId;
    this.currentScanId = scanId;

    const worker = new Worker(join(__dirname, 'scanWorker.js'));
    this.worker = worker;
    const isCurrent = (): boolean => this.worker === worker && this.currentScanId === scanId;
    const finish = (): void => {
      if (!isCurrent()) return;
      this.worker = null;
      this.currentRootId = null;
      this.currentScanId = null;
    };

    worker.on('message', (msg: { type?: string; batch?: ScanBatch; stats?: ScanStats; error?: { code: string; message: string } }) => {
      if (!isCurrent() || wc.isDestroyed()) return;
      if (msg?.type === 'batch' && msg.batch) {
        const batch: ScanBatch = { ...msg.batch, rootId, scanId };
        const rootImages = this.imagesByRoot.get(rootId) ?? new Map();
        for (const image of batch.images ?? []) rootImages.set(image.id, image);
        this.imagesByRoot.set(rootId, rootImages);
        wc.send('scan:progress', batch);
      } else if (msg?.type === 'done') {
        const stats = msg.stats as ScanStats;
        wc.send('scan:done', { rootId, rootPath, scanId, stats });
        finish();
      } else if (msg?.type === 'error' && msg.error) {
        wc.send('scan:error', { ...msg.error, rootId, scanId });
        finish();
      }
    });

    worker.on('error', (err: Error) => {
      if (!isCurrent()) return;
      if (!wc.isDestroyed()) wc.send('scan:error', { code: 'SCAN_WORKER_ERROR', message: err.message, rootId, scanId });
      finish();
    });

    worker.on('exit', (code) => {
      if (!isCurrent()) return;
      if (code !== 0 && !wc.isDestroyed()) {
        wc.send('scan:error', { code: 'SCAN_WORKER_EXIT', message: `扫描线程异常退出（${code}）`, rootId, scanId });
      }
      finish();
    });

    worker.postMessage({ type: 'start', rootPath, scanId });
    return scanId;
  }

  /** 取消当前扫描（终止 Worker） */
  cancel(): void {
    const worker = this.worker;
    this.worker = null;
    this.currentRootId = null;
    this.currentScanId = null;
    if (worker) worker.terminate().catch(() => undefined);
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
