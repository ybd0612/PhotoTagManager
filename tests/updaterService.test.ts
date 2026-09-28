// @vitest-environment node
// U1 / U2：更新服务的日志与错误态可重试。
// 除了正向断言，还专门测了三种"不该发生"的情况：下载中被重查打断、开发版偷偷联网查更、
// 非 available 态发起下载——守卫检查若只测成功路径，等于没设。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UpdaterService } from '../electron/services/updaterService';

/**
 * 自带一个极简事件器，不在顶层 import 'events'：
 * vi.hoisted 的工厂会在所有 import 初始化之前执行，引用顶层导入会直接报
 * "Cannot access '__vi_import_0__' before initialization"。
 */
const { autoUpdater, app, log } = vi.hoisted(() => {
  const listeners = new Map<string, Array<(p: never) => void>>();
  const au = {
    logger: null as unknown,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on(name: string, cb: (p: never) => void) {
      const arr = listeners.get(name) ?? [];
      arr.push(cb);
      listeners.set(name, arr);
      return au;
    },
    emit(name: string, payload: never) {
      for (const cb of listeners.get(name) ?? []) cb(payload);
    },
    reset() {
      listeners.clear();
    },
    checkForUpdates: vi.fn(async () => undefined),
    downloadUpdate: vi.fn(() => Promise.resolve()),
    quitAndInstall: vi.fn()
  };
  return {
    autoUpdater: au,
    app: { isPackaged: true },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  };
});

vi.mock('electron', () => ({ app }));
vi.mock('electron-updater', () => ({ autoUpdater }));
vi.mock('electron-log', () => ({ default: log }));

type Pushed = { state: string; message?: string; version?: string };
const sent: Pushed[] = [];

function makeService() {
  // 每个用例一套干净的事件与日志，避免上一条的状态粘过来
  autoUpdater.reset();
  log.info.mockClear();
  log.error.mockClear();
  autoUpdater.logger = null;
  autoUpdater.checkForUpdates.mockClear();
  autoUpdater.downloadUpdate.mockClear();
  const svc = new UpdaterService(log);
  svc.bind({ isDestroyed: () => false, send: (_ch: string, payload: Pushed) => sent.push(payload) } as never);
  return svc;
}

beforeEach(() => {
  sent.length = 0;
  app.isPackaged = true;
});

describe('U1 更新器必须落日志', () => {
  it('构造时就把 logger 交给 electron-updater（否则"差分失败回退整包"那句永远看不到）', () => {
    makeService();
    expect(autoUpdater.logger).toBeTruthy();
  });

  it('发现新版本要写日志，带版本号', () => {
    makeService();
    autoUpdater.emit('update-available', { version: '0.1.5' } as never);
    expect(log.info.mock.calls.map((c) => String(c[0])).some((m) => m.includes('0.1.5'))).toBe(true);
  });

  it('失败要写 error 日志并保留原文，同时状态里给出"重试"', () => {
    makeService();
    autoUpdater.emit('update-available', { version: '0.1.5' } as never);
    autoUpdater.emit('error', new Error('Cannot download differentially, fallback to full download') as never);
    expect(log.error.mock.calls.map((c) => String(c[0])).some((m) => m.includes('differentially'))).toBe(true);
    const last = sent[sent.length - 1];
    expect(last.state).toBe('error');
    expect(last.message).toContain('重试');
    expect(last.message).toContain('0.1.5');
  });

  it('下载进度只记整数百分比，不逐帧刷屏', () => {
    makeService();
    autoUpdater.emit('update-available', { version: '0.1.5' } as never);
    autoUpdater.emit('download-progress', { percent: 12.7, bytesPerSecond: 1_048_576 } as never);
    autoUpdater.emit('download-progress', { percent: 12.9, bytesPerSecond: 1_048_576 } as never);
    const lines = log.info.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('下载中'));
    expect(lines.length).toBe(2);
    expect(lines.every((m) => m.includes('13%'))).toBe(true);
  });
});

describe('U2 出错态可重试，且不把在跑的打断', () => {
  it('error 之后再 check 会真的重查一次', async () => {
    const svc = makeService();
    autoUpdater.emit('update-available', { version: '0.1.5' } as never);
    autoUpdater.emit('error', new Error('net::ERR_CONNECTION_RESET') as never);
    await svc.check();
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    await svc.check();
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('不该发生：downloading 中调 check 又发起检查（进度会被自己打断）', async () => {
    const svc = makeService();
    autoUpdater.emit('update-available', { version: '0.1.5' } as never);
    await svc.download();
    await svc.check();
    await svc.check();
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(0);
  });

  it('不该发生：开发版联网查更或下载', async () => {
    app.isPackaged = false;
    const svc = makeService();
    await svc.check();
    await svc.download();
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(sent[sent.length - 1].state).toBe('dev-mode');
  });

  it('download 只在 available 态发起', async () => {
    const svc = makeService();
    await svc.download(); // idle 态
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    autoUpdater.emit('update-available', { version: '0.1.5' } as never);
    await svc.download();
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
  });
});
