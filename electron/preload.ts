import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { PhotoTagApi, ScanBatch, ScanStats, ThumbnailResult } from '../shared/types';

/**
 * 事件订阅辅助：返回取消订阅函数（渲染侧 useScan / useThumbnails 依赖）。
 */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => {
    cb(payload);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

/**
 * 白名单 API：只暴露 PhotoTagApi 定义的方法，不暴露 ipcRenderer 原始对象（安全模型）。
 */
const api: PhotoTagApi = {
  // 目录选择
  pickDirectory: () => ipcRenderer.invoke('dialog:pick-directory'),
  // 扫描
  scanStart: (rootPath: string) => ipcRenderer.invoke('scan:start', rootPath),
  scanCancel: () => ipcRenderer.invoke('scan:cancel'),
  onScanProgress: (cb: (batch: ScanBatch) => void) => subscribe<ScanBatch>('scan:progress', cb),
  onScanDone: (cb: (payload: { rootPath: string; stats: ScanStats }) => void) =>
    subscribe<{ rootPath: string; stats: ScanStats }>('scan:done', cb),
  onScanError: (cb: (error: { code: string; message: string }) => void) =>
    subscribe<{ code: string; message: string }>('scan:error', cb),
  // 文件夹隐藏
  hideFolder: (relPath: string) => ipcRenderer.invoke('folder:hide', relPath),
  unhideFolder: (relPath: string) => ipcRenderer.invoke('folder:unhide', relPath),
  listHiddenFolders: () => ipcRenderer.invoke('folder:list-hidden'),
  // 标签
  readImageTags: (absPath: string) => ipcRenderer.invoke('tags:read-image', absPath),
  readBulkTags: (absPaths: string[]) => ipcRenderer.invoke('tags:read-bulk', absPaths),
  writeImageTags: (req) => ipcRenderer.invoke('tags:write-image', req),
  writeBatchTags: (reqs) => ipcRenderer.invoke('tags:write-batch', reqs),
  onBatchProgress: (cb: (p: { done: number; total: number }) => void) =>
    subscribe<{ done: number; total: number }>('tags:batch-progress', cb),
  renameTag: (from: string, to: string) => ipcRenderer.invoke('tags:rename', from, to),
  // 缩略图
  getThumbnail: (absPath: string) => ipcRenderer.invoke('thumb:get', absPath),
  onThumbReady: (cb: (thumb: ThumbnailResult) => void) => subscribe<ThumbnailResult>('thumb:ready', cb),
  // 图片信息（P1）
  getImageInfo: (absPath: string) => ipcRenderer.invoke('image:info', absPath)
};

contextBridge.exposeInMainWorld('api', api);
