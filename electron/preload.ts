import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { PhotoTagApi, ScanBatch, ScanStats, ThumbnailResult, UpdateStatus } from '../shared/types';

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
  // 多根目录（R10）
  listRoots: () => ipcRenderer.invoke('roots:list'),
  addRoot: (path: string, alias?: string) => ipcRenderer.invoke('roots:add', path, alias),
  removeRoot: (rootId: string) => ipcRenderer.invoke('roots:remove', rootId),
  renameRoot: (rootId: string, alias: string) => ipcRenderer.invoke('roots:rename', rootId, alias),
  // 扫描（带 rootId）
  scanStart: (rootId: string, rootPath: string, scanId: string) => ipcRenderer.invoke('scan:start', rootId, rootPath, scanId),
  scanCancel: () => ipcRenderer.invoke('scan:cancel'),
  onScanProgress: (cb: (batch: ScanBatch) => void) => subscribe<ScanBatch>('scan:progress', cb),
  onScanDone: (cb: (payload: { rootId: string; rootPath: string; scanId: string; stats: ScanStats }) => void) =>
    subscribe<{ rootId: string; rootPath: string; scanId: string; stats: ScanStats }>('scan:done', cb),
  onScanError: (cb: (error: { code: string; message: string; rootId: string; scanId: string }) => void) =>
    subscribe<{ code: string; message: string; rootId: string; scanId: string }>('scan:error', cb),
  // 文件夹隐藏（按根）
  hideFolder: (rootId: string, relPath: string) => ipcRenderer.invoke('folder:hide', rootId, relPath),
  unhideFolder: (rootId: string, relPath: string) => ipcRenderer.invoke('folder:unhide', rootId, relPath),
  listHiddenFolders: (rootId: string) => ipcRenderer.invoke('folder:list-hidden', rootId),
  // 在资源管理器中打开目录
  openFolderInExplorer: (absPath: string) => ipcRenderer.invoke('folder:open-in-explorer', absPath),
  // 在资源管理器中定位文件
  revealFileInExplorer: (absPath: string) => ipcRenderer.invoke('file:reveal-in-explorer', absPath),
  // 复制文件到剪贴板
  copyFileToClipboard: (absPath: string) => ipcRenderer.invoke('clipboard:copy-file', absPath),
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
  getImageInfo: (absPath: string) => ipcRenderer.invoke('image:info', absPath),
  // 自动更新
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => subscribe<UpdateStatus>('update:status', cb)
};

contextBridge.exposeInMainWorld('api', api);
