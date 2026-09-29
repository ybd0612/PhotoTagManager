import { app, BrowserWindow, Menu, nativeImage, net, protocol, session, Tray, utilityProcess } from 'electron';
import { pathToFileURL } from 'url';
import { join } from 'path';
import { existsSync } from 'fs';
import electronLog from 'electron-log';
import { USER_DATA_DIR_NAME, legacyUserDataDirFor, userDataDirFor } from './userDataDir';
import { ScanService } from './services/scanService';
import { XmpService } from './services/xmpService';
import { ThumbnailService } from './services/thumbnailService';
import { FolderStore } from './services/folderStore';
import { RootStore } from './services/rootStore';
import { UpdaterService } from './services/updaterService';
import { registerIpc } from './ipc';
import { configureAiPaths, modelsDir, settingsFile } from './ai/paths';
import { sanitizeProxyRules } from '../shared/proxyRule';
import { ModelStore } from './ai/modelStore';
import { ChildRunner, makeUtilityProcessSpawner } from './ai/runner';
import { AiService, type MetadataGateway } from './ai/aiService';
import { statfs, readFile } from 'fs/promises';
import { readWholeGpuMemory } from './ai/gpuStats';
import { readGpuCapability, activeFakeGpu } from './ai/gpuCapability';
import type { InferenceRunner } from './ai/runner';

electronLog.initialize();

/**
 * U4：钉死 userData 目录名。必须在任何取 userData 的代码之前执行。
 * 只 setPath 不 setName 的话，第三方库读 `app.name` 仍会算出另一个目录，所以两个都钉。
 * 名字一旦改动，老用户的根目录与已下载模型就会"看起来凭空消失"——详见 electron/userDataDir.ts。
 */
app.setName(USER_DATA_DIR_NAME);
app.setPath('userData', userDataDirFor(app.getPath('appData')));

// 历史遗留的另一份目录（大小写形式）只做只读探测与告警，绝不去合并别人的 roots.json
if (existsSync(join(legacyUserDataDirFor(app.getPath('appData')), 'roots.json'))) {
  electronLog.warn(
    `检测到遗留数据目录 ${legacyUserDataDirFor(app.getPath('appData'))}（内含旧的 roots.json），` +
      `当前使用的是 ${userDataDirFor(app.getPath('appData'))}；两边根目录不一致时以告警为准，不要静默改用户数据`
  );
}

/**
 * 自定义协议 ptm-file：渲染进程经 <img src="ptm-file://local/..."> 加载本地大图。
 * 必须在 app ready 之前注册特权（standard/secure，允许 http 页面引用）。
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'ptm-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

let mainWindow: BrowserWindow | null = null;
let scan: ScanService | null = null;
let xmp: XmpService | null = null;
let thumb: ThumbnailService | null = null;
let folders: FolderStore | null = null;
let roots: RootStore | null = null;
let updater: UpdaterService | null = null;
let tray: Tray | null = null;
let aiRunner: ChildRunner | null = null;
let ai: AiService | null = null;
let isQuitting = false;

// 同一台电脑只允许一个 PhotoTagManager 实例运行。
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  // 已有实例时，当前进程不再创建窗口，直接退出。
  app.quit();
} else {
  app.on('second-instance', () => {
    // 已隐藏到托盘时也要恢复并聚焦已有窗口。
    showMainWindow();
  });
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray(): void {
  if (tray) return;
  // Windows 托盘对内联 SVG 的透明色/颜色解析不稳定，可能显示为黑色；
  // 使用内嵌 RGBA PNG，避免依赖外部文件且在浅色/深色主题下都保持可见。
  const trayIcon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAQ0lEQVR42mNgGAWDCfi7Pf1PDzzqgFEHEO0AaoFRB1DNAcTG8agDRh0w6oBRBwxfB4zWBXR3wGiLaNQBdHfAKBgIAAAYy6QiwpOj4wAAAABJRU5ErkJggg=='
  );
  tray = new Tray(trayIcon);
  tray.setToolTip('PhotoTagManager');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '退出 PhotoTagManager',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );
  tray.on('click', showMainWindow);
}

/** 读已保存的代理设置（settings.json 的 ui.proxyRules）。读不到或值不合法都按"不覆盖"处理。 */
async function readSavedProxyRules(): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(settingsFile(), 'utf8')) as { ui?: { proxyRules?: unknown } };
    const v = raw.ui?.proxyRules;
    return typeof v === 'string' ? sanitizeProxyRules(v).value : '';
  } catch {
    return '';
  }
}

/**
 * 把代理设置作用到默认会话。留空 = 不覆盖，跟随系统默认。
 * 必须显式调用：实测 Node 的全局 fetch 与 Electron 的 net.fetch 都**不会**自动使用
 * Windows 系统代理（这台机器上系统代理未开、只有显式指定 127.0.0.1:7897 才通），
 * 所以设置里那个输入框若不落到 session.setProxy，就是填了也没用的假控件。
 */
async function applyProxyRules(rules: string): Promise<void> {
  const ses = session.defaultSession;
  if (rules) {
    await ses.setProxy({ proxyRules: rules, proxyBypassRules: '<-loopback>' });
    electronLog.info(`网络代理：已启用 ${rules}`);
  } else {
    await ses.setProxy({ mode: 'system' });
    electronLog.info('网络代理：跟随系统默认（本应用未覆盖）');
  }
}

function createWindow(): void {
  /**
   * 不要原生菜单栏（U6）。`autoHideMenuBar: true` 的语义是"平时藏、按 Alt 显"，
   * 所以按 Alt 冒出来的那排 File/Edit/View 就是 Electron 的默认应用菜单——
   * 本应用的快捷键全部在渲染层自实现（←/→/Esc/空格/Ctrl+C/Enter/Ctrl+单击/?），
   * 原生菜单一项都没用上，去掉零损失。
   * 托盘右键菜单走 setContextMenu，独立于应用菜单，不受这里影响。
   */
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 920,
    minHeight: 620,
    show: false,
    title: 'PhotoTagManager',
    backgroundColor: '#f8fafc',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false // preload 需要 require('electron')
    }
  });

  // 应用菜单被去掉后，dev 下的 devtools 快捷键也一起没了，这里自己接回来（只认 Ctrl+Shift+I）
  if (!app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') {
        mainWindow?.webContents.toggleDevTools();
      }
    });
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 自动更新状态推送到该窗口（窗口可能重建，故在 createWindow 内绑定）
  updater?.bind(mainWindow.webContents);

  // electron-vite dev 模式注入 ELECTRON_RENDERER_URL；生产加载构建产物
  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;

  const userDataPath = app.getPath('userData');

  scan = new ScanService();
  const xmpService = new XmpService(userDataPath);
  xmp = xmpService;
  thumb = new ThumbnailService(xmpService, userDataPath);
  folders = new FolderStore(userDataPath);
  roots = new RootStore(userDataPath);
  updater = new UpdaterService();
  createTray();

  // AI 处理（M1：人像抠图）。目录布局必须在任何 ai 模块被用到之前配好。
  configureAiPaths(userDataPath);
  await applyProxyRules(await readSavedProxyRules());
  // 下载走 net.fetch 而不是 Node 全局 fetch：只有 Chromium 网络栈受 session.setProxy 管
  const aiStore = new ModelStore({
    fetchImpl: (url, init) => net.fetch(url as string, init as Parameters<typeof net.fetch>[1]),
    logger: electronLog
  });
  const runner = new ChildRunner({
    spawn: makeUtilityProcessSpawner(utilityProcess),
    // 推理一律在 utilityProcess 子进程：原生层报错是进程级崩溃，不能带崩窗口（D9）
    entry: join(__dirname, 'aiChild.js'),
    loadTimeoutMs: 30_000,
    requestTimeoutMs: 60_000
  });
  aiRunner = runner;
  const aiMeta: MetadataGateway = {
    readTags: async (absPath) => (await xmpService.read(absPath)).subjects,
    writeTags: async (absPath, add) => {
      const result = await xmpService.write({ absPath, add });
      if (!result.ok) throw new Error(result.error ?? '标签写入失败');
    },
    copyBase: (fromPath, toPath) => xmpService.copyMetadataFrom(fromPath, toPath)
  };
  const aiRetention = { retentionDays: 30, maxBytes: 1024 * 1024 * 1024 };
  /**
   * 本地调试开关 PTM_FAKE_GPU（见 electron/ai/gpuCapability.ts）：
   * - `none`：能力探测直接判"无可用 GPU"，用来验清单条目的「不可用 + 原因」分支；
   * - `oom`：让**推理那一步**抛一条显存不足形态的错，用来验错误条与「卸载已加载的模型」。
   *   刻意不挂在 load 上：load 失败时模型根本没驻留，那颗卸载按钮按判据不会出现，
   *   就只能验到文案、验不到按钮。挂在 infer 上，加载照常成功 → 错误条出现 →
   *   点按钮真的把模型卸掉，整条路径都能走通。
   * 用 getter 转发而不是展开对象：ChildRunner 的 loadedModelId 是活值，展开会把它冻在当下，
   * 会话重建判据（模型或后端任一变化即重建）就废了。
   */
  const fakeGpu = activeFakeGpu();
  if (fakeGpu) electronLog.warn(`PTM_FAKE_GPU=${process.env.PTM_FAKE_GPU} 生效：GPU 能力/推理结果为模拟值，不代表本机真实情况`);
  const serviceRunner: InferenceRunner =
    fakeGpu === 'oom'
      ? {
          get loadedModelId() {
            return runner.loadedModelId;
          },
          get restartCount() {
            return runner.restartCount;
          },
          load: (req) => runner.load(req),
          infer: async (req) => {
            throw new Error('DML: out of memory. Failed to allocate 2147483648 bytes for the tensor');
          },
          unload: () => runner.unload(),
          dispose: () => runner.dispose()
        }
      : runner;
  const aiService = new AiService({
    runner: serviceRunner,
    store: aiStore,
    meta: aiMeta,
    previewRetention: aiRetention
  });
  ai = aiService;

  // 本地文件协议处理：ptm-file://local/<encodeURIComponent(absPath)>
  protocol.handle('ptm-file', async (request) => {
    try {
      const url = new URL(request.url);
      const encoded = url.pathname.replace(/^\//, '');
      if (!encoded) {
        return new Response('Not Found', { status: 404 });
      }
      const absPath = decodeURIComponent(encoded);
      return await net.fetch(pathToFileURL(absPath).toString());
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });

  registerIpc({
    scan,
    xmp,
    thumb,
    folders,
    roots,
    updater,
    getWindow: () => mainWindow,
    // 设置里保存代理后立刻作用到会话，不等重启
    applyProxy: applyProxyRules,
    ai: {
      service: aiService,
      store: aiStore,
      runner,
      freeDiskBytes: async () => {
        try {
          const { bsize, bavail } = await statfs(modelsDir());
          return Number(bsize) * Number(bavail);
        } catch {
          return null; // 读不到就报"未知"，不能显示 0 让用户以为盘满了
        }
      },
      // 只能拿到整卡显存：分进程显存本机驱动返回 [N/A]，所以口径必须标"整卡"
      gpuStats: () => readWholeGpuMemory(),
      // 规格 §6：无可用 GPU 加速设备时，清单条目要转「不可用」并说明原因。
      // ipc 侧缺省是 unknown（不让契约测试去起 PowerShell），生产必须在这里接上真探测
      capability: () => readGpuCapability(),
      retention: aiRetention
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // 窗口关闭时保留托盘驻留；仅托盘菜单的“退出”设置 isQuitting 后才退出。
});

// 退出前释放资源：终止扫描 Worker、退出 exiftool 子进程、终止推理子进程，避免孤儿进程（§7）
app.on('will-quit', () => {
  scan?.dispose();
  void xmp?.dispose();
  // 推理跑在 utilityProcess 里，不显式回收就会在窗口关掉后留一个占着显存的孤儿进程（D9）
  void ai?.dispose().catch(() => undefined);
  void aiRunner?.dispose().catch(() => undefined);
});
