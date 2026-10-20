import { app, clipboard, dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import { promises as fsp } from 'fs';
import { dirname, join } from 'path';
import type {
  IpcResult,
  SortDir,
  SortKey,
  TagWriteRequest,
  ThumbSize,
  TrashResult,
  UiPrefs,
  UpdateStatus
} from '../shared/types';
import { DEFAULT_UI_PREFS } from '../shared/types';
import { isInsideRoot } from '../shared/pathGuard';
import type { ScanService } from './services/scanService';
import type { XmpService } from './services/xmpService';
import type { ThumbnailService } from './services/thumbnailService';
import type { FolderStore } from './services/folderStore';
import type { RootStore } from './services/rootStore';
import type { UpdaterService } from './services/updaterService';
import { sanitizeProxyRules } from '../shared/proxyRule';
export interface IpcDeps {
  scan: ScanService;
  xmp: XmpService;
  thumb: ThumbnailService;
  folders: FolderStore;
  roots: RootStore;
  updater: UpdaterService;
  getWindow: () => BrowserWindow | null;
  /** 保存代理设置后立刻作用到会话。可选：IPC 契约测试不注入就跳过 */
  applyProxy?(rules: string): Promise<void>;
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
  handle('roots:remove', async (rootId: string): Promise<unknown> => {
    const result = await deps.roots.remove(rootId);
    // 删根即清隐藏记录，避免残留（bugfix）
    await deps.folders.removeByRoot(rootId);
    return result;
  });
  handle('roots:rename', (rootId: string, alias: string): Promise<unknown> => deps.roots.rename(rootId, alias));
  handle('roots:reorder', async (orderedIds: string[]): Promise<void> => {
    if (!Array.isArray(orderedIds)) throw new Error('orderedIds 必须是数组');
    await deps.roots.reorder(orderedIds.filter((id): id is string => typeof id === 'string'));
  });

  // 扫描（R01/R02，带 rootId）
  handle('scan:start', (rootId: string, rootPath: string, scanId: string): { rootId: string; rootPath: string; scanId: string } => {
    if (!rootId) throw new Error('rootId 不能为空');
    if (!rootPath) throw new Error('rootPath 不能为空');
    if (!scanId) throw new Error('scanId 不能为空');
    const win = deps.getWindow();
    if (win && !win.isDestroyed()) {
      deps.scan.startScan(rootId, rootPath, win.webContents, scanId);
      return { rootId, rootPath, scanId };
    }
    throw new Error('主窗口不可用');
  });

  handle('scan:cancel', (): void => {
    deps.scan.cancel();
  });

  // 文件夹隐藏（R05/R06，按根隔离）
  handle('folder:hide', (rootId: string, relPath: string): Promise<void> => deps.folders.hide(rootId, relPath));
  handle('folder:unhide', (rootId: string, relPath: string): Promise<void> => deps.folders.unhide(rootId, relPath));
  handle('folder:list-hidden', (rootId: string): Promise<unknown> => deps.folders.list(rootId));

  // 在资源管理器中打开目录（R11）
  handle('folder:open-in-explorer', async (absPath: string): Promise<void> => {
    if (!absPath) throw new Error('absPath 不能为空');
    const errorMessage = await shell.openPath(absPath);
    if (errorMessage) throw new Error(errorMessage);
  });

  // 通过系统默认浏览器打开受信任的外部链接
  handle('shell:open-external', async (url: string): Promise<void> => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      throw new Error('仅允许打开 HTTPS 链接');
    }
    const allowedHosts = new Set(['github.com', 'yangbang.de']);
    if (!allowedHosts.has(parsed.hostname.toLowerCase())) {
      throw new Error('链接域名不在白名单中');
    }
    await shell.openExternal(parsed.toString());
  });

  // 在资源管理器中定位文件
  handle('file:reveal-in-explorer', async (absPath: string): Promise<void> => {
    if (!absPath) throw new Error('absPath 不能为空');
    shell.showItemInFolder(absPath);
  });

  /**
   * 移到系统回收站（可从回收站找回，不做物理删除）。
   * 路径来自渲染进程，所以先过守卫：只允许动已添加根目录里的文件，
   * 越界的逐条记失败原因而不是悄悄跳过。单条失败不影响其余。
   */
  handle('file:trash', async (absPaths: string[]): Promise<TrashResult> => {
    const roots = (await deps.roots.list()).map((r) => r.path);
    const trashed: string[] = [];
    const failed: TrashResult['failed'] = [];
    for (const absPath of absPaths ?? []) {
      if (!isInsideRoot(absPath, roots)) {
        failed.push({ absPath, reason: '不在任何已添加的根目录内，已拒绝（不会进入系统回收站）' });
        continue;
      }
      try {
        await shell.trashItem(absPath);
        trashed.push(absPath);
      } catch (err) {
        failed.push({ absPath, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return { trashed, failed };
  });

  /**
   * 视图偏好（排序、缩略图档位、扫描完成提示）：持久化于 userData/settings.json 的 ui 段。
   * 枚举字段按白名单校验、布尔字段按类型校验——存进一个拼错的值会让界面筛出空列表或让开关形同虚设。
   */
  const SORT_KEYS: SortKey[] = ['name', 'time', 'size'];
  const SORT_DIRS: SortDir[] = ['asc', 'desc'];
  const THUMB_SIZES: ThumbSize[] = ['small', 'medium', 'large'];
  const settingsFile = (): string => join(app.getPath('userData'), 'settings.json');
  const readUiPrefs = async (): Promise<UiPrefs | null> => {
    try {
      const raw = JSON.parse(await fsp.readFile(settingsFile(), 'utf8')) as { ui?: Partial<UiPrefs> };
      return raw.ui ? { ...DEFAULT_UI_PREFS, ...raw.ui } : null;
    } catch {
      return null; // 文件不存在或坏了都按"没有偏好"处理
    }
  };

  handle('prefs:get', async (): Promise<UiPrefs> => (await readUiPrefs()) ?? { ...DEFAULT_UI_PREFS });

  handle('prefs:set', async (patch: Partial<UiPrefs>): Promise<UiPrefs> => {
    const base = (await readUiPrefs()) ?? { ...DEFAULT_UI_PREFS };
    const p = patch ?? {};
    // 代理地址走 shared/proxyRule 的校验：不合法就保留原值，绝不把乱填的东西存进配置再交给 setProxy
    const proxyInput = typeof p.proxyRules === 'string' ? p.proxyRules : base.proxyRules;
    const proxy = sanitizeProxyRules(proxyInput);
    const next: UiPrefs = {
      sortKey: SORT_KEYS.includes(p.sortKey as SortKey) ? (p.sortKey as SortKey) : base.sortKey,
      sortDir: SORT_DIRS.includes(p.sortDir as SortDir) ? (p.sortDir as SortDir) : base.sortDir,
      thumbSize: THUMB_SIZES.includes(p.thumbSize as ThumbSize) ? (p.thumbSize as ThumbSize) : base.thumbSize,
      scanDoneToast: typeof p.scanDoneToast === 'boolean' ? p.scanDoneToast : base.scanDoneToast,
      treeCollapsed: typeof p.treeCollapsed === 'boolean' ? p.treeCollapsed : base.treeCollapsed,
      filterBarVisible: typeof p.filterBarVisible === 'boolean' ? p.filterBarVisible : base.filterBarVisible,
      exifPanelExpanded: typeof p.exifPanelExpanded === 'boolean' ? p.exifPanelExpanded : base.exifPanelExpanded,
      proxyRules: proxy.ok ? proxy.value : base.proxyRules
    };
    let all: Record<string, unknown> = {};
    const file = settingsFile();
    try {
      all = JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, unknown>;
    } catch {
      all = {};
    }
    all.ui = next;
    await fsp.mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(all, null, 2));
    await fsp.rename(tmp, file);
    // 存完立刻生效，不等重启：否则用户在设置里填了代理、当场试一次下载还是失败，等于没有反馈
    if (proxy.ok) await deps.applyProxy?.(next.proxyRules);
    return next;
  });

  /**
   * 右上角三个按钮由渲染层自绘（系统那块画在网页之上，预览遮不住也藏不掉，见 main.ts 的 frame:false）。
   * 这里只做动作转发，不判状态：close 特意走 win.close()，好让它经过主进程既有的
   * "非退出即藏进托盘"逻辑，而不是渲染层自己 unmount 装作关掉了。
   */
  handle('window:minimize', (): void => {
    const win = deps.getWindow();
    if (win && !win.isDestroyed()) win.minimize();
  });

  handle('window:toggle-maximize', (): void => {
    const win = deps.getWindow();
    if (!win || win.isDestroyed()) throw new Error('主窗口不可用');
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  handle('window:close', (): void => {
    const win = deps.getWindow();
    if (!win || win.isDestroyed()) throw new Error('主窗口不可用');
    win.close();
  });

  handle('window:is-maximized', (): boolean => {
    const win = deps.getWindow();
    return !!win && !win.isDestroyed() && win.isMaximized();
  });

  // 复制文件到剪贴板（FileNameW 格式，Windows 资源管理器可直接粘贴）
  handle('clipboard:copy-file', (absPath: string): void => {
    if (!absPath) throw new Error('absPath 不能为空');
    clipboard.writeBuffer('FileNameW', Buffer.from(`${absPath}\0`, 'utf16le'));
  });

  // 复制纯文本（状态栏复制目录路径）。不能复用上面那条：FileNameW 粘进资源管理器是"粘贴文件"
  handle('clipboard:copy-text', (text: string): void => {
    if (!text) throw new Error('text 不能为空');
    clipboard.writeText(text);
  });

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

  // 自动更新（electron-updater + GitHub Releases；开发模式返回 dev-mode）
  handle('update:check', (): Promise<UpdateStatus> => deps.updater.check());
  handle('update:download', (): Promise<UpdateStatus> => deps.updater.download());
  handle('update:install', (): UpdateStatus => deps.updater.install());

}
