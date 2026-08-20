import { app, BrowserWindow, Menu, nativeImage, net, protocol, Tray } from 'electron';
import { pathToFileURL } from 'url';
import { join } from 'path';
import electronLog from 'electron-log';
import { ScanService } from './services/scanService';
import { XmpService } from './services/xmpService';
import { ThumbnailService } from './services/thumbnailService';
import { FolderStore } from './services/folderStore';
import { RootStore } from './services/rootStore';
import { UpdaterService } from './services/updaterService';
import { registerIpc } from './ipc';

electronLog.initialize();

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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 920,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    title: 'PhotoTagManager',
    backgroundColor: '#f8fafc',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false // preload 需要 require('electron')
    }
  });

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

void app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;

  const userDataPath = app.getPath('userData');

  scan = new ScanService();
  xmp = new XmpService(userDataPath);
  thumb = new ThumbnailService(xmp, userDataPath);
  folders = new FolderStore(userDataPath);
  roots = new RootStore(userDataPath);
  updater = new UpdaterService();
  createTray();

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
    getWindow: () => mainWindow
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
