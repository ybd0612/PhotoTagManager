// @vitest-environment jsdom
// 批次3 · G8 —— 设置对话框「常规」分区做实。
// 全局约束里最硬的一条：只允许出现真的接上行为的控件。
// 所以每条判据都同时盯"界面点了 → store 变了 → 落盘了"，开关类还要有反面腿。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { SettingsDialog } from '../src/components/settings/SettingsDialog';
import { useAppStore } from '../src/store/useAppStore';
import { useScanSubscriptions } from '../src/hooks/useScan';
import { DEFAULT_UI_PREFS } from '../shared/types';
import type { ScanStats } from '../shared/types';

function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

const api = {
  getPrefs: vi.fn(),
  setPrefs: vi.fn(),
  onScanDone: vi.fn(),
  onScanError: vi.fn(),
  onScanProgress: vi.fn(),
  listHiddenFolders: vi.fn(async () => ok([]))
};

/** 由 onScanDone 捕获的回调，用于在测试里模拟一次扫描完成事件 */
let fireScanDone: ((p: { rootId: string; scanId: string; stats: ScanStats }) => void) | null = null;

function ScanProbe(): JSX.Element | null {
  useScanSubscriptions();
  return null;
}

const stats = (over: Partial<ScanStats> = {}): ScanStats => ({
  scannedFiles: 3392,
  imageCount: 3392,
  totalFiles: 3392,
  done: true,
  ...over
});

beforeEach(() => {
  vi.stubGlobal('api', api);
  api.getPrefs.mockReset().mockResolvedValue(ok({ ...DEFAULT_UI_PREFS }));
  api.setPrefs.mockReset().mockImplementation((patch: Record<string, unknown>) =>
    Promise.resolve(ok({ ...DEFAULT_UI_PREFS, ...patch }))
  );
  fireScanDone = null;
  api.onScanDone.mockReset().mockImplementation((cb: (p: never) => void) => {
    fireScanDone = cb as never;
    return () => undefined;
  });
  api.onScanError.mockReset().mockReturnValue(() => undefined);
  api.onScanProgress.mockReset().mockReturnValue(() => undefined);
  useAppStore.setState({
    ...DEFAULT_UI_PREFS,
    snackbar: null,
    scanDoneToast: DEFAULT_UI_PREFS.scanDoneToast
  });
});

describe('设置对话框 · 常规分区', () => {
  it('放了三组真生效偏好，且不再写"暂无常规设置项"', () => {
    render(<SettingsDialog open onClose={() => undefined} />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByText(/暂无常规设置/)).toBeNull();
    expect(within(dialog).getByText(/排序/)).toBeTruthy();
    expect(within(dialog).getByText(/缩略图/)).toBeTruthy();
    expect(within(dialog).getByRole('checkbox', { name: /扫描完成后/ })).toBeTruthy();
  });

  it('点缩略图「大」→ store 变 large 并落盘（不是只在界面上亮一下）', () => {
    render(<SettingsDialog open onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '大' }));
    expect(useAppStore.getState().thumbSize).toBe('large');
    expect(api.setPrefs).toHaveBeenCalledWith({ thumbSize: 'large' });
  });

  it('点排序「时间」→ store 变 time 并落盘', () => {
    render(<SettingsDialog open onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '时间' }));
    expect(useAppStore.getState().sortKey).toBe('time');
    expect(api.setPrefs).toHaveBeenCalledWith({ sortKey: 'time', sortDir: 'asc' });
  });

  it('开关拨一下 → store.scanDoneToast 变 true 并落盘', () => {
    render(<SettingsDialog open onClose={() => undefined} />);
    const sw = screen.getByRole('checkbox', { name: /扫描完成后/ });
    expect(sw.checked).toBe(false);
    fireEvent.click(sw);
    expect(useAppStore.getState().scanDoneToast).toBe(true);
    expect(api.setPrefs).toHaveBeenCalledWith({ scanDoneToast: true });
  });

  it('控件初值从 store 读回，写死初始态会在这里红', () => {
    useAppStore.setState({ thumbSize: 'large', sortKey: 'size', sortDir: 'desc', scanDoneToast: true });
    render(<SettingsDialog open onClose={() => undefined} />);
    expect(screen.getByRole('button', { name: '大' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '中' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('checkbox', { name: /扫描完成后/ }).checked).toBe(true);
  });
});

describe('G8 新偏好 scanDoneToast —— 必须真接上扫描完成这条链路', () => {
  it('打开时：扫描完成弹一条 snackbar 报张数', () => {
    useAppStore.setState({ scanDoneToast: true });
    useAppStore.getState().resetScan('r1', 's1');
    render(<ScanProbe />);
    useAppStore.getState().setSnackbar(null);
    fireScanDone!({ rootId: 'r1', scanId: 's1', stats: stats() });
    expect(useAppStore.getState().snackbar).toContain('已扫描 3,392 个文件');
  });

  it('反面腿：默认关闭时同样完成一次扫描，一条提示都不发（状态栏已常驻计数）', () => {
    expect(useAppStore.getState().scanDoneToast).toBe(false);
    useAppStore.getState().resetScan('r1', 's1');
    render(<ScanProbe />);
    useAppStore.getState().setSnackbar(null);
    fireScanDone!({ rootId: 'r1', scanId: 's1', stats: stats() });
    expect(useAppStore.getState().snackbar).toBeNull();
  });

  it('开关打开但扫描未走完（被取消/换根）：不发提示，也不能抛', () => {
    useAppStore.setState({ scanDoneToast: true });
    useAppStore.getState().resetScan('r1', 's1');
    render(<ScanProbe />);
    useAppStore.getState().setSnackbar(null);
    expect(() => fireScanDone!({ rootId: 'r1', scanId: '其他扫描', stats: stats() })).not.toThrow();
    expect(useAppStore.getState().snackbar).toBeNull();
  });

  it('重启读回：loadUiPrefs 逐字段赋值，漏了这个字段就会在这里红', async () => {
    api.getPrefs.mockResolvedValue(ok({ ...DEFAULT_UI_PREFS, scanDoneToast: true }));
    useAppStore.setState({ scanDoneToast: false });
    await useAppStore.getState().loadUiPrefs();
    expect(useAppStore.getState().scanDoneToast).toBe(true);
  });
});
