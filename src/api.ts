import type { IpcResult, PhotoTagApi } from '../shared/types';

export type { PhotoTagApi } from '../shared/types';

declare global {
  interface Window {
    api: PhotoTagApi;
  }
}

/**
 * 获取 window.api（preload 注入）。运行时调用，便于测试 mock。
 */
export function getApi(): PhotoTagApi {
  return window.api;
}

/**
 * 解包统一响应信封：ok:false 时抛出 Error（message 为错误信息）。
 */
export async function call<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) {
    throw new Error(result.error.message || result.error.code);
  }
  return result.data;
}

/**
 * 本地大图 URL：经主进程自定义协议 ptm-file 读取（渲染进程无 Node 权限）。
 */
export function toFileUrl(absPath: string): string {
  return `ptm-file://local/${encodeURIComponent(absPath)}`;
}

/** 字节数格式化（预览信息展示用） */
export function formatBytes(bytes: number | undefined): string {
  if (bytes == null || Number.isNaN(bytes)) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
