import { app, clipboard, dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import { promises as fsp } from 'fs';
import { dirname } from 'path';
import type {
  AiGpuMemory,
  AiRunAck,
  AiRunRequest,
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
import { settingsFile } from './ai/paths';
import type { ScanService } from './services/scanService';
import type { XmpService } from './services/xmpService';
import type { ThumbnailService } from './services/thumbnailService';
import type { FolderStore } from './services/folderStore';
import type { RootStore } from './services/rootStore';
import type { UpdaterService } from './services/updaterService';
import type { AiEvent, RunRequest, RunResult, SaveResult } from './ai/aiService';
import type { CapabilitySpec } from './ai/capabilityCatalog';
import { GPU_UNAVAILABLE_REASON, activeFakeGpu, type GpuCapability } from './ai/gpuCapability';
import { sanitizeProxyRules } from '../shared/proxyRule';
import type { ModelDownloadSpec, ModelStore } from './ai/modelStore';

/** AI 推理子进程的只读运行态视图（ipc 只需要"当前驻留哪个模型"和卸载入口） */
export interface AiRunnerView {
  readonly loadedModelId: string | null;
  unload(): Promise<void>;
}

/** ipc 用到的 ModelStore 那部分，声明成视图便于契约测试注入假件。 */
export interface AiStoreView {
  status(modelId: string): Promise<'absent' | 'downloading' | 'present'>;
  download(spec: ModelDownloadSpec, signal?: AbortSignal): Promise<{ path: string }>;
  remove(modelId: string): Promise<void>;
  installedModels(): Promise<Awaited<ReturnType<ModelStore['installedModels']>>>;
}

/**
 * ipc 只用到 AiService 的这几个方法。声明成结构化视图而不是依赖具体类，
 * 这样契约测试里的假件能被编译检查，而不是靠一次 as unknown 绕过类型。
 */
export interface AiServiceView {
  startRun(req: RunRequest): { taskId: string; promise: Promise<RunResult> };
  cancel(taskId: string): boolean;
  save(taskId: string): Promise<SaveResult>;
  previewStats(): Promise<{ entries: number; totalBytes: number }>;
  subscribe(listener: (event: AiEvent) => void): () => void;
  usableCatalog(): CapabilitySpec[];
  defaultModelFor(capabilityId: string): Promise<string>;
  setDefaultModel(capabilityId: string, modelId: string): Promise<void>;
  findModelSpec(modelId: string): { capabilityId: string; spec: ModelDownloadSpec } | null;
}

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
  /** 照片 AI 处理（M1：人像抠图） */
  ai: {
    service: AiServiceView;
    store: AiStoreView;
    runner: AiRunnerView;
    freeDiskBytes(): Promise<number | null>;
    /** 整卡显存（口径必须标注"整卡"，分进程显存拿不到） */
    gpuStats(): Promise<AiGpuMemory | null>;
    /**
     * 本机 GPU 加速能力（规格 §6「无可用设备 → 条目转不可用并说明原因」）。
     * 可选且缺省为 unknown：不在这里默认起 PowerShell，否则每次 IPC 契约测试都会真去探测。
     * 生产由 main.ts 注入 readGpuCapability。
     */
    capability?(): Promise<GpuCapability>;
    retention: { retentionDays: number; maxBytes: number };
  };
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
   * 视图偏好（排序、缩略图档位、扫描完成提示）：与 AI 设置同文件、不同键（settings.json 的 ui 段）。
   * 枚举字段按白名单校验、布尔字段按类型校验——存进一个拼错的值会让界面筛出空列表或让开关形同虚设。
   */
  const SORT_KEYS: SortKey[] = ['name', 'time', 'size'];
  const SORT_DIRS: SortDir[] = ['asc', 'desc'];
  const THUMB_SIZES: ThumbSize[] = ['small', 'medium', 'large'];
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

  // ── 照片 AI 处理（M1：人像抠图）────────────────────────────────────────
  // 用户侧只有一个动作 ai:run：确保模型就绪（下载 + 加载）是 aiService 的内部步骤，
  // 不暴露成独立通道（D14）。这里也**不存在** ai:discard / ai:pending-review（D18 已作废）。
  const sendAiEvent = (channel: string, payload: unknown): void => {
    const win = deps.getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  };

  /** 清单 + 本机状态一次拿全。只含实测跑通的条目（§4.3 硬规则：没跑通的连灰都不给看）。 */
  const buildCatalog = async () => {
    const usable = deps.ai.service.usableCatalog();
    // unknown（探测失败）一律按"能用"处理：误报不可用会把整条功能从能跑的机器上拿走
    const gpuCap = deps.ai.capability ? await deps.ai.capability() : 'unknown';
    const noGpu = gpuCap === 'unavailable';
    // 模拟出来的"不可用"必须看得出来是模拟，否则调试截图会被当成真机结论
    const fake = activeFakeGpu();
    const noGpuReason = GPU_UNAVAILABLE_REASON + (fake ? `（模拟：PTM_FAKE_GPU=${fake}，非本机真实情况）` : '');
    const capabilities = await Promise.all(
      usable.map(async (cap) => {
        const preferred = await deps.ai.service.defaultModelFor(cap.id);
        return {
          id: cap.id,
          label: cap.label,
          description: cap.description,
          actionTag: cap.actionTag,
          outputSuffix: cap.outputSuffix,
          outputExt: cap.outputExt,
          defaultModelId: preferred,
          models: await Promise.all(
            cap.models.map(async (m) => {
              const diskStatus = await deps.ai.store.status(m.id);
              // 只挂原因、不改 status：磁盘状态要如实，下载/删除那颗按钮靠它判断
              const unavailable = noGpu && diskStatus !== 'downloading';
              return {
                id: m.id,
                displayName: m.displayName,
                sizeBytes: m.sizeBytes,
                verified: m.verified,
                status: diskStatus,
                statusReason: unavailable ? noGpuReason : undefined,
                loaded: deps.ai.runner.loadedModelId === m.id,
                isDefault: preferred === m.id,
                inputWidth: m.inputDims[3] ?? 0,
                inputHeight: m.inputDims[2] ?? 0
              };
            })
          )
        };
      })
    );
    return { capabilities };
  };

  handle('ai:catalog', (): Promise<unknown> => buildCatalog());

  handle('ai:run', (req: AiRunRequest): AiRunAck => {
    const handle = deps.ai.service.startRun(req);
    return { taskId: handle.taskId };
  });

  handle('ai:cancel', (taskId: string): boolean => deps.ai.service.cancel(taskId));

  handle('ai:save', (taskId: string): Promise<unknown> => deps.ai.service.save(taskId));

  // 模型管理（D17：唯一入口是组合按钮的下拉，设置页不重复提供这些操作）
  handle('ai:model-download', async (modelId: string): Promise<unknown> => {
    const target = deps.ai.service.findModelSpec(modelId);
    if (!target) throw new Error(`找不到这个模型：${modelId}`);
    await deps.ai.store.download(target.spec);
    return { modelId, status: await deps.ai.store.status(modelId) };
  });

  handle('ai:model-delete', async (modelId: string): Promise<unknown> => {
    const loaded = deps.ai.runner.loadedModelId === modelId;
    if (loaded) await deps.ai.runner.unload(); // 先释放显存再回收磁盘，别留半卸载状态
    await deps.ai.store.remove(modelId);
    return {
      modelId,
      status: await deps.ai.store.status(modelId),
      reason: loaded ? '已先卸载再删除' : undefined
    };
  });

  handle('ai:model-unload', async (modelId: string): Promise<unknown> => {
    if (deps.ai.runner.loadedModelId !== modelId) {
      return { modelId, status: await deps.ai.store.status(modelId), reason: '该模型未加载，无需卸载' };
    }
    await deps.ai.runner.unload();
    return { modelId, status: await deps.ai.store.status(modelId), unloaded: true };
  });

  handle('ai:model-set-default', async (capabilityId: string, modelId: string): Promise<unknown> => {
    await deps.ai.service.setDefaultModel(capabilityId, modelId);
    return buildCatalog();
  });

  handle('ai:storage-stats', async (): Promise<unknown> => {
    const [preview, freeDiskBytes, gpu] = await Promise.all([
      deps.ai.service.previewStats(),
      deps.ai.freeDiskBytes(),
      deps.ai.gpuStats()
    ]);
    const installed = await deps.ai.store.installedModels();
    return {
      preview,
      models: Object.entries(installed).map(([id, entry]) => ({
        id,
        sizeBytes: entry.sizeBytes,
        status: 'present' as const
      })),
      loadedModelId: deps.ai.runner.loadedModelId,
      freeDiskBytes,
      gpu,
      retention: deps.ai.retention
    };
  });

  // 事件转发：一次点击内可能是 download / load / infer / encode 四个阶段
  deps.ai.service.subscribe((event) => {
    if (event.type === 'progress') sendAiEvent('ai:progress', event.payload);
    else if (event.type === 'done') sendAiEvent('ai:done', { ...event.payload });
    else sendAiEvent('ai:error', event.payload);
  });
}
