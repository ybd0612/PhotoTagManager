import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import electronLog from 'electron-log/main';
import type { WebContents } from 'electron';
import type { UpdateStatus } from '../../shared/types';
import { classifyUpdateError } from '../../shared/updateError';

/**
 * 可注入的日志面。单测要能断言"这些事件确实落了日志"，
 * 所以构造时收进来，而不是在方法里到处直接 import 单例。
 */
export interface UpdateLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/**
 * 自动更新服务：状态机 + 并发保护 + 可追溯日志。
 *
 * U1 为什么必须落日志：electron-updater 最关键的几个判断——尤其是
 * `Cannot download differentially, fallback to full download`（差分失败静默回退整包，
 * 表现就是进度从 88% 跳回 5%）——**只写 `autoUpdater.logger`**。
 * 不设 logger 时这些原因在本机无处可看，上次排障只能靠读 node_modules 源码定位。
 */
export class UpdaterService {
  private wc: WebContents | null = null;
  private status: UpdateStatus = { state: 'idle' };
  private checkInFlight = false;
  private downloadInFlight = false;
  private installInFlight = false;
  /** 最后一次确认存在的新版本；出错后要告诉用户"重试"是重试哪个版本 */
  private lastVersion: string | null = null;

  constructor(private readonly log: UpdateLogger = electronLog) {
    // 把 electron-updater 的内部判断也接到同一份日志上（含差分回退那句）
    autoUpdater.logger = electronLog as unknown as typeof autoUpdater.logger;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    // U3 定案（2026-09-29 真机证据，别随手翻成 true）：保留差分下载。
    // 当天 0.1.4→0.1.5 确实出现过"进度 89% 归零"，根因不是差分本身坏，而是缓存里的
    // current.blockmap 还停在 8-20（4486 块），和拿来当旧包的 installer.exe（0.1.4，5795 块）
    // 不配对——因为 0.1.4 是手动覆盖安装的，没走更新器那条"下载完成才刷新缓存"的路径。
    // 整包下完后缓存已自愈；0.1.4 与 0.1.5 的 blockmap 只有 902/5798 块不同，
    // 差分约 18 MB 对比整包 115.8 MB，正常用户省八成流量，留着值。
    // 真失败时 electron-updater 会自己回退整包并把原因写进上面的 logger，进度归零不再无声无息。
    autoUpdater.disableDifferentialDownload = false;
    autoUpdater.on('checking-for-update', () => {
      this.log.info('更新：开始检查');
      this.updateStatus({ state: 'checking' });
    });
    autoUpdater.on('update-available', (info) => {
      this.lastVersion = info.version;
      this.log.info(`更新：发现新版本 ${info.version}`);
      this.updateStatus({ state: 'available', version: info.version });
    });
    autoUpdater.on('update-not-available', () => {
      this.log.info('更新：已是最新版本');
      this.updateStatus({ state: 'not-available' });
    });
    autoUpdater.on('download-progress', (p) => {
      // 只记整数百分比：每秒一条会把日志刷满，又给不出新信息
      const pct = Math.round(p.percent);
      this.log.info(`更新：下载中 ${pct}%（约 ${Math.round(p.bytesPerSecond / 1024)} KB/s）`);
      this.updateStatus({ state: 'downloading', percent: pct, version: this.status.version });
    });
    autoUpdater.on('update-downloaded', (info) => {
      this.log.info(`更新：下载完成 ${info.version}，等待安装`);
      this.updateStatus({ state: 'downloaded', version: info.version, percent: 100 });
    });
    autoUpdater.on('error', (err) => {
      this.checkInFlight = false;
      this.downloadInFlight = false;
      const detail = err instanceof Error ? err.message : String(err);
      // 原文必须留在日志里：进度归零这类现象的唯一线索就在这
      const { kind, message } = classifyUpdateError(detail);
      this.log.error(`更新失败（${kind}）：${detail}`);
      this.updateStatus({
        state: 'error',
        // 界面上给人话，错误码只留在上面那行日志里
        message: message + (this.lastVersion ? `重试仍指向 v${this.lastVersion}。` : '')
      });
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

  /**
   * 检查更新。出错后允许再查一次（界面「重试」走的就是这条路）；
   * 但下载中与已下载不重查——那会把正在跑的连接打断。
   */
  async check(): Promise<UpdateStatus> {
    if (this.devMode()) {
      const status: UpdateStatus = { state: 'dev-mode', message: '当前为开发版，不检查更新' };
      this.updateStatus(status);
      return status;
    }
    // 并发只由 checkInFlight 挡。刻意不再用 state === 'checking' 加一道：
    // 那样一旦 electron-updater 没回任何事件，状态就永久卡在 checking，用户再也点不动重试
    if (this.checkInFlight) return this.status;
    if (this.status.state === 'downloading' || this.status.state === 'downloaded') return this.status;
    this.checkInFlight = true;
    this.updateStatus({ state: 'checking' });
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      // error 事件已负责日志与状态，这里不重复处理
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
    this.log.info(`更新：开始下载 ${this.status.version ?? this.lastVersion ?? '未知版本'}`);
    this.updateStatus({ state: 'downloading', percent: 0, version: this.status.version });
    void autoUpdater.downloadUpdate().catch(() => {
      // error 事件负责日志与状态
    });
    return this.status;
  }

  install(): UpdateStatus {
    if (this.devMode() || this.installInFlight || this.status.state !== 'downloaded') return this.status;
    this.installInFlight = true;
    this.log.info('更新：退出并安装（非静默向导，需要用户点 UAC）');
    autoUpdater.quitAndInstall(false, true);
    return this.status;
  }
}
