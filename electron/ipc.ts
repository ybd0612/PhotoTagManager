import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import type { IpcResult, TagWriteRequest } from '../shared/types';
import type { ScanService } from './services/scanService';
import type { XmpService } from './services/xmpService';
import type { ThumbnailService } from './services/thumbnailService';
import type { FolderStore } from './services/folderStore';
import type { RootStore } from './services/rootStore';

export interface IpcDeps {
  scan: ScanService;
  xmp: XmpService;
  thumb: ThumbnailService;
  folders: FolderStore;
  roots: RootStore;
  getWindow: () => BrowserWindow | null;
}

/**
 * 集中注册全部 IPC Handler（§1.3 / §3.3）。
 * 所有 Handler 一律返回统一响应信封 IpcResult，禁止裸抛异常（§7）。
 */
export function registerIpc(deps: IpcDeps): void {
  const ok = <T>(data: T): IpcResult<T> => ({ ok: true, data });
  const fail = (code: string, message: string): IpcResult<never> => ({
    ok: false,
    error: { code, message }
  });

  const handle = <A extends unknown[], T>(
    channel: string,
    fn: (...args: A) => Promise<T> | T
  ): void => {
    ipcMain.handle(channel, async (_event, ...args: A): Promise<IpcResult<T>> => {
      try {
        return ok(await fn(...args));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail('IPC_ERROR', message);
      }
    });
  };

  // 目录选择（R01）
  handle('dialog:pick-directory', async (): Promise<string | null> => {
    const win = deps.getWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      title: '选择图片根目录',
      properties: ['openDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // 多根目录（R10）：增删改查
  handle('roots:list', (): Promise<unknown> => deps.roots.list());
  handle('roots:add', (path: string, alias?: string): Promise<unknown> => deps.roots.add(path, alias));
  handle('roots:remove', (rootId: string): Promise<unknown> => deps.roots.remove(rootId));
  handle('roots:rename', (rootId: string, alias: string): Promise<unknown> => deps.roots.rename(rootId, alias));

  // 扫描（R01/R02，带 rootId）
  handle('scan:start', (rootId: string, rootPath: string): { rootId: string; rootPath: string } => {
    if (!rootId) throw new Error('rootId 不能为空');
    if (!rootPath) throw new Error('rootPath 不能为空');
    const win = deps.getWindow();
    if (win && !win.isDestroyed()) {
      deps.scan.startScan(rootId, rootPath, win.webContents);
    }
    return { rootId, rootPath };
  });

  handle('scan:cancel', (): void => {
    deps.scan.cancel();
  });

  // 文件夹隐藏（R05/R06，按根隔离）
  handle('folder:hide', (rootId: string, relPath: string): Promise<void> => deps.folders.hide(rootId, relPath));
  handle('folder:unhide', (rootId: string, relPath: string): Promise<void> => deps.folders.unhide(rootId, relPath));
  handle('folder:list-hidden', (rootId: string): Promise<unknown> => deps.folders.list(rootId));

  // 标签（R07）
  handle('tags:read-image', (absPath: string): Promise<unknown> => deps.xmp.read(absPath));
  handle('tags:read-bulk', (absPaths: string[]): Promise<unknown> => deps.xmp.readBulk(absPaths ?? []));
  handle('tags:write-image', (req: TagWriteRequest): Promise<unknown> => deps.xmp.write(req));

  handle('tags:write-batch', (reqs: TagWriteRequest[]): Promise<unknown> => {
    const win = deps.getWindow();
    return deps.xmp.writeBatch(reqs ?? [], (p) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('tags:batch-progress', p);
      }
    });
  });

  // P1：标签重命名/合并
  handle('tags:rename', (from: string, to: string): Promise<number> =>
    deps.xmp.renameTag(from, to, deps.scan.getAllImagePaths())
  );

  // 缩略图（R09）
  handle('thumb:get', async (absPath: string) => {
    const result = await deps.thumb.get(absPath);
    if (result) {
      const win = deps.getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('thumb:ready', result);
      }
    }
    return result;
  });

  // 图片信息（P1）
  handle('image:info', (absPath: string): Promise<unknown> => deps.xmp.getImageInfo(absPath));

  // 调试用
  handle('app:get-user-data', (): string => app.getPath('userData'));
}
