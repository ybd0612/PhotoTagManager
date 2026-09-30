// @vitest-environment jsdom
// 批次3 · G8 —— 设置对话框「常规」分区做实。
// 全局约束里最硬的一条：只允许出现真的接上行为的控件。
// 所以每条判据都同时盯"界面点了 → store 变了 → 落盘了"，开关类还要有反面腿。
// 2026-09-30：排序与缩略图两行撤掉——主界面工具条上就是同一套控件、同一个偏好，
// 这里再放一遍等于把同一事实说两遍，还让人怀疑两边是否同步。本文件反过来钉住它不许回来。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';

import { SettingsDialog } from '../src/components/settings/SettingsDialog';
import { updateStub } from './fixtures/updateStub';
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
  it('只剩扫描完成与网络代理两项真生效偏好，且不再写"暂无常规设置项"', () => {
    render(<SettingsDialog open onClose={() => undefined} update={updateStub()} />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByText(/暂无常规设置/)).toBeNull();
    expect(within(dialog).getByRole('checkbox', { name: /扫描完成后/ })).toBeTruthy();
    expect(within(dialog).getByRole('textbox', { name: '网络代理地址' })).toBeTruthy();
  });

  it('排序与缩略图不在设置里重复：主界面工具条已有同一套控件，同一事实只允许一处可改', () => {
    render(<SettingsDialog open onClose={() => undefined} update={updateStub()} />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByText('默认排序')).toBeNull();
    expect(within(dialog).queryByText('缩略图')).toBeNull();
    for (const label of ['名称', '时间', '大小', '小', '中', '大']) {
      expect(within(dialog).queryByRole('button', { name: label })).toBeNull();
    }
  });

  it('开关拨一下 → store.scanDoneToast 变 true 并落盘', () => {
    render(<SettingsDialog open onClose={() => undefined} update={updateStub()} />);
    const sw = screen.getByRole('checkbox', { name: /扫描完成后/ });
    expect(sw.checked).toBe(false);
    fireEvent.click(sw);
    expect(useAppStore.getState().scanDoneToast).toBe(true);
    expect(api.setPrefs).toHaveBeenCalledWith({ scanDoneToast: true });
  });

  it('控件初值从 store 读回，写死初始态会在这里红', () => {
    useAppStore.setState({ scanDoneToast: true });
    render(<SettingsDialog open onClose={() => undefined} update={updateStub()} />);
    expect(screen.getByRole('checkbox', { name: /扫描完成后/ }).checked).toBe(true);
  });

  it('解释型长句收进问号图标，悬浮才展开正文', async () => {
    render(<SettingsDialog open onClose={() => undefined} update={updateStub()} />);
    const dialog = screen.getByRole('dialog');
    // 正文一开始不在 DOM 里，才说明它真被收起来了而不是只是变小
    expect(within(dialog).queryByText(/只影响「模型下载」/)).toBeNull();
    const hints = within(dialog).getAllByRole('button', { name: '说明' });
    expect(hints).toHaveLength(2);
    fireEvent.mouseOver(hints[1]);
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeTruthy());
    expect(screen.getByRole('tooltip').textContent).toContain('照片始终不出本机');
  });
});

describe('G8 新偏好 scanDoneToast —— 必须真接上扫描完成这条链路', () => {
  it('打开时：扫描完成弹一条 snackbar 报张数', () => {
    useAppStore.setState({ scanDoneToast: true });
    useAppStore.getState().resetScan('r1', 's1');
    render(<ScanProbe />);
    useAppStore.getState().setSnackbar(null);
    fireScanDone!({ rootId: 'r1', scanId: 's1', stats: stats() });
    expect(useAppStore.getState().snackbar).toContain('已扫描 3,392 张图片');
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

describe('网络代理设置', () => {
  it('有一行代理输入框；没改动时「应用」不可点（每敲一个字就 setProxy 会反复重建连接）', () => {
    render(<SettingsDialog open onClose={() => undefined} />);
    expect(screen.getByRole('textbox', { name: '网络代理地址' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '应用' }).hasAttribute('disabled')).toBe(true);
  });

  it('填合法地址点应用 → store 改值并落盘', () => {
    render(<SettingsDialog open onClose={() => undefined} />);
    fireEvent.change(screen.getByRole('textbox', { name: '网络代理地址' }), { target: { value: '127.0.0.1:7890' } });
    const btn = screen.getByRole('button', { name: '应用' });
    expect(btn.hasAttribute('disabled')).toBe(false);
    fireEvent.click(btn);
    expect(useAppStore.getState().proxyRules).toBe('127.0.0.1:7890');
    expect(api.setPrefs).toHaveBeenCalledWith({ proxyRules: '127.0.0.1:7890' });
  });

  it('不该发生：带账号密码仍给应用，或不说明原因就静默存空值', () => {
    render(<SettingsDialog open onClose={() => undefined} />);
    fireEvent.change(screen.getByRole('textbox', { name: '网络代理地址' }), { target: { value: 'http://u:p@127.0.0.1:7890' } });
    expect(screen.getByRole('button', { name: '应用' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('proxy-hint').textContent).toContain('账号密码');
  });

  it('留空说的是"跟随系统默认"，不写会误导的"直连"', () => {
    render(<SettingsDialog open onClose={() => undefined} />);
    expect(screen.getByTestId('proxy-hint').textContent).toContain('跟随系统默认');
  });
});
