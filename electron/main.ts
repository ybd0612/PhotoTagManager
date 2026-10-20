import { app, BrowserWindow, Menu, nativeImage, net, protocol, session, Tray } from 'electron';
import { pathToFileURL } from 'url';
import { join } from 'path';
import { existsSync } from 'fs';
import electronLog from 'electron-log/main';
import { USER_DATA_DIR_NAME, legacyUserDataDirFor, userDataDirFor } from './userDataDir';
import { ScanService } from './services/scanService';
import { XmpService } from './services/xmpService';
import { ThumbnailService } from './services/thumbnailService';
import { FolderStore } from './services/folderStore';
import { RootStore } from './services/rootStore';
import { UpdaterService } from './services/updaterService';
import { registerIpc } from './ipc';
import { sanitizeProxyRules } from '../shared/proxyRule';
import { readFile } from 'fs/promises';
import { APP_ICON_TRAY_DATA_URL, APP_ICON_WINDOW_DATA_URL } from './appIcon';

electronLog.initialize();

/**
 * U4：钉死 userData 目录名。必须在任何取 userData 的代码之前执行。
 * 只 setPath 不 setName 的话，第三方库读 `app.name` 仍会算出另一个目录，所以两个都钉。
 * 名字一旦改动，老用户的根目录与应用偏好就会"看起来凭空消失"——详见 electron/userDataDir.ts。
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
  // 所以用 npm run icon 从品牌 SVG 预先渲染好的 RGBA PNG（与 build/icon.ico 同源），
  // 既不依赖外部文件，也不会再出现"托盘一张图、主界面另一张图"。
  const trayIcon = nativeImage.createFromDataURL(APP_ICON_TRAY_DATA_URL);
  tray = new Tray(trayIcon);
  tray.setToolTip('图片管家');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '退出 图片管家（PhotoTagManager）',
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
    const raw = JSON.parse(await readFile(join(app.getPath('userData'), 'settings.json'), 'utf8')) as { ui?: { proxyRules?: unknown } };
    const v = raw.ui?.proxyRules;
    return typeof v === 'string' ? sanitizeProxyRules(v).value : '';
  } catch {
    return '';
  }
}

/** electron-updater 自己发请求用的会话分区名（改名要跟 node_modules 里那份常量一致） */
const UPDATER_SESSION = 'electron-updater';

/**
 * 把代理设置作用到「本应用会发外部请求的每一条网络出口」。留空 = 不覆盖，跟随系统默认。
 * 必须显式调用：应用网络请求使用 Electron session，因此代理设置必须同步作用到相关会话；
 * 否则用户在设置里填写代理不会影响应用发出的网络请求。
 *
 * 为什么是两个会话而不止 defaultSession：electron-updater 6.x 走 Chromium 的 net.request，
 * 且自己建了名为 electron-updater 的分区（out/electronHttpExecutor.js），不受 defaultSession 管。
 * 实测 session.fromPartition 同名返回同一实例，所以这里能直接把规则推给它——
 * 否则「检查更新」只会跟随 Windows 系统代理，用户在设置里填的代理对它无效。
 */
async function applyProxyRules(rules: string): Promise<void> {
  const sessions = [session.defaultSession, session.fromPartition(UPDATER_SESSION, { cache: false })];
  for (const ses of sessions) {
    if (rules) await ses.setProxy({ proxyRules: rules, proxyBypassRules: '<-loopback>' });
    else await ses.setProxy({ mode: 'system' });
  }
  if (rules) electronLog.info(`网络代理：已启用 ${rules}（含更新会话）`);
  else electronLog.info('网络代理：跟随系统默认（本应用未覆盖，含更新会话）');
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
    title: '图片管家 PhotoTagManager',
    /**
     * 不传 icon 时 Windows 取的是"当前可执行文件"的图标：装出来的包有 build/icon.ico，
     * 而 npm run dev / npx electron . 跑的是 electron.exe，任务栏就成了 Electron 默认蓝图标。
     * 显式传一张与那张 ICO 同源的品牌 PNG，开发态和安装包就是同一张图。
     */
    icon: nativeImage.createFromDataURL(APP_ICON_WINDOW_DATA_URL),
    backgroundColor: '#f8fafc',
    /**
     * 整条窗口边框交回网页自己画：顶栏本来就是自绘的，右上角三个控件原先留给了系统覆盖层
     * （titleBarStyle: 'hidden' + titleBarOverlay），但那块由 DWM 画在网页之上——
     * 全屏预览的遮罩盖不住它（右上角糊一块白），MUI 对话框也压不住它，
     * 而 Windows 侧没有任何 API 能把它们隐藏（win.setWindowButtonVisibility 标的是 @platform darwin）。
     * 改成 frame:false 自绘后它们就是一条普通内容：预览覆盖层一盖就没了，不需要任何切换逻辑。
     * thickFrame 保持默认 true：阴影、Win11 圆角、边缘拖缩放和 Aero Snap 都靠它。
     */
    frame: false,
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

  /**
   * 自绘的最大化按钮要按当前状态换图标（最大化 ↔ 还原），所以状态一变就推给渲染层。
   * 只推不拉不够：用户拖标题栏双击、Win+↑、点任务栏最大化都会绕过渲染层。
   */
  const pushMaximized = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('window:maximized-changed', mainWindow.isMaximized());
  };
  mainWindow.on('maximize', pushMaximized);
  mainWindow.on('unmaximize', pushMaximized);

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

  await applyProxyRules(await readSavedProxyRules());
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
    applyProxy: applyProxyRules
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // 窗口关闭时保留托盘驻留；仅托盘菜单的“退出”设置 isQuitting 后才退出。
});

// 退出前释放资源：终止扫描 Worker、退出 exiftool 子进程，避免孤儿进程（§7）
app.on('will-quit', () => {
  scan?.dispose();
  void xmp?.dispose();
});
