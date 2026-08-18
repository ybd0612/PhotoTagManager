import { app, BrowserWindow, net, protocol } from 'electron';
import { pathToFileURL } from 'url';
import { join } from 'path';
import electronLog from 'electron-log';
import { ScanService } from './services/scanService';
import { XmpService } from './services/xmpService';
import { ThumbnailService } from './services/thumbnailService';
import { FolderStore } from './services/folderStore';
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // electron-vite dev 模式注入 ELECTRON_RENDERER_URL；生产加载构建产物
  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(() => {
  const userDataPath = app.getPath('userData');

  scan = new ScanService();
  xmp = new XmpService();
  thumb = new ThumbnailService(xmp, userDataPath);
  folders = new FolderStore(userDataPath);

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
    getWindow: () => mainWindow
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 退出前释放资源：终止扫描 Worker、退出 exiftool 子进程，避免孤儿进程（§7）
app.on('will-quit', () => {
  scan?.dispose();
  void xmp?.dispose();
});
