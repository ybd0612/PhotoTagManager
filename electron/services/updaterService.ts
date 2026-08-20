import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { WebContents } from 'electron';
import type { UpdateStatus } from '../../shared/types';

/** 自动更新服务，负责状态机与并发保护。 */
export class UpdaterService {
  private wc: WebContents | null = null;
  private status: UpdateStatus = { state: 'idle' };
  private checkInFlight = false;
  private downloadInFlight = false;
  private installInFlight = false;

  constructor() {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => this.updateStatus({ state: 'checking' }));
    autoUpdater.on('update-available', (info) => this.updateStatus({ state: 'available', version: info.version }));
    autoUpdater.on('update-not-available', () => this.updateStatus({ state: 'not-available' }));
    autoUpdater.on('download-progress', (p) => this.updateStatus({ state: 'downloading', percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => this.updateStatus({ state: 'downloaded', version: info.version, percent: 100 }));
    autoUpdater.on('error', (err) => {
      this.checkInFlight = false;
      this.downloadInFlight = false;
      this.updateStatus({ state: 'error', message: err.message });
    });
  }

  bind(wc: WebContents): void {
    this.wc = wc;
    if (this.status.state !== 'idle') this.emit(this.status);
  }

  private emit(status: UpdateStatus): void {
    if (this.wc && !this.wc.isDestroyed()) this.wc.send('update:status', status);
  }

  private updateStatus(status: UpdateStatus): void {
    this.status = status;
    if (status.state !== 'checking') this.checkInFlight = false;
    if (status.state === 'downloaded' || status.state === 'error') this.downloadInFlight = false;
    this.emit(status);
  }

  private devMode(): boolean {
    return !app.isPackaged;
  }

  async check(): Promise<UpdateStatus> {
    if (this.devMode()) {
      const status: UpdateStatus = { state: 'dev-mode', message: '当前为开发模式，更新功能不可用' };
      this.updateStatus(status);
      return status;
    }
    if (this.checkInFlight || this.status.state === 'checking') return this.status;
    if (this.status.state === 'downloading' || this.status.state === 'downloaded') return this.status;
    this.checkInFlight = true;
    this.updateStatus({ state: 'checking' });
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      // error event updates status
    } finally {
      this.checkInFlight = false;
    }
    return this.status;
  }

  /** 触发后台下载并立即返回，不阻塞 IPC 调用方。 */
  async download(): Promise<UpdateStatus> {
    if (this.devMode()) return this.status;
    if (this.downloadInFlight || this.status.state === 'downloading' || this.status.state === 'downloaded') return this.status;
    if (this.status.state !== 'available') return this.status;
    this.downloadInFlight = true;
    this.updateStatus({ state: 'downloading', percent: 0, version: this.status.version });
    void autoUpdater.downloadUpdate().catch(() => {
      // error event updates status
    });
    return this.status;
  }

  install(): UpdateStatus {
    if (this.devMode() || this.installInFlight || this.status.state !== 'downloaded') return this.status;
    this.installInFlight = true;
    autoUpdater.quitAndInstall(false, true);
    return this.status;
  }
}
