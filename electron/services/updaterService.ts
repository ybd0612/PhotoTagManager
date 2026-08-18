import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { WebContents } from 'electron';
import type { UpdateStatus } from '../../shared/types';

/**
 * 自动更新服务（electron-updater + GitHub Releases）。
 * 仅在打包环境（app.isPackaged === true）下可用：开发模式下所有操作返回"开发模式不可用"，
 * 避免在开发态误触发下载/安装逻辑。
 *
 * 事件流（主进程 → 渲染进程）统一走 'update:status' 通道，由 UpdateStatus 描述状态机：
 * idle → checking → available/not-available → downloading → downloaded →（安装重启）
 */
export class UpdaterService {
  private wc: WebContents | null = null;

  constructor() {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    // 事件转发到渲染层
    autoUpdater.on('checking-for-update', () => this.emit({ state: 'checking' }));
    autoUpdater.on('update-available', (info) => this.emit({ state: 'available', version: info.version }));
    autoUpdater.on('update-not-available', () => this.emit({ state: 'not-available' }));
    autoUpdater.on('download-progress', (p) => this.emit({ state: 'downloading', percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => this.emit({ state: 'downloaded', version: info.version }));
    autoUpdater.on('error', (err) => this.emit({ state: 'error', message: err.message }));
  }

  /** 绑定目标窗口（渲染进程），用于推送状态事件 */
  bind(wc: WebContents): void {
    this.wc = wc;
  }

  private emit(status: UpdateStatus): void {
    if (this.wc && !this.wc.isDestroyed()) {
      this.wc.send('update:status', status);
    }
  }

  private devMode(): boolean {
    return !app.isPackaged;
  }

  /** 检查更新（启动时静默检查 / 用户手动触发） */
  async check(): Promise<UpdateStatus> {
    if (this.devMode()) {
      const status: UpdateStatus = { state: 'dev-mode', message: '当前为开发模式，更新功能不可用' };
      this.emit(status);
      return status;
    }
    this.emit({ state: 'checking' });
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      // error 事件已转发给渲染层，这里无需重复处理
    }
    return { state: 'checking' };
  }

  /** 下载更新（仅在 available 状态后调用） */
  async download(): Promise<void> {
    if (this.devMode()) return;
    try {
      await autoUpdater.downloadUpdate();
    } catch {
      // error 事件已转发给渲染层
    }
  }

  /** 退出应用并安装（下载完成后调用） */
  install(): void {
    if (this.devMode()) return;
    autoUpdater.quitAndInstall(false, true);
  }
}
