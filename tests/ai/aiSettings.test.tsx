// @vitest-environment jsdom
// T13 · 应用级设置总入口 + AI 分区。
// 三条判据：只读统计（含"整卡"口径标注）、不重复提供模型操作（D17）、
// 参数区可以为空但不许出现调了没反应的假控件。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { SettingsDialog } from '../../src/components/settings/SettingsDialog';
import { AiSettingsPane } from '../../src/components/settings/AiSettingsPane';
import { useAiStore } from '../../src/store/useAiStore';
import type { AiStorageStats } from '../../shared/types';

function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

const statsFixture: AiStorageStats = {
  preview: { entries: 7, totalBytes: 7_864_320 },
  models: [{ id: 'u2netp', sizeBytes: 4_574_861, status: 'present' }],
  loadedModelId: 'u2netp',
  freeDiskBytes: 247 * 1024 * 1024 * 1024,
  gpu: { usedMiB: 1178, totalMiB: 8151, scope: 'whole-gpu' },
  retention: { retentionDays: 30, maxBytes: 1024 * 1024 * 1024 }
};

const api = {
  aiStorageStats: vi.fn(),
  aiCatalog: vi.fn(),
  aiRun: vi.fn(),
  aiCancel: vi.fn(),
  aiSave: vi.fn(),
  aiModelDownload: vi.fn(),
  aiModelDelete: vi.fn(),
  aiModelUnload: vi.fn(),
  aiModelSetDefault: vi.fn(),
  onAiProgress: vi.fn(() => () => undefined),
  onAiDone: vi.fn(() => () => undefined),
  onAiError: vi.fn(() => () => undefined),
  listRoots: vi.fn(async () => ok([])),
  scanStart: vi.fn(async () => ok({ rootId: 'r1', rootPath: 'C:/P', scanId: 's1' })),
  scanCancel: vi.fn(async () => ok(undefined)),
  readBulkTags: vi.fn(async () => ok([])),
  getThumbnail: vi.fn(async () => ok(null)),
  hideFolder: vi.fn(async () => ok(undefined)),
  unhideFolder: vi.fn(async () => ok(undefined)),
  listHiddenFolders: vi.fn(async () => ok([])),
  openFolderInExplorer: vi.fn(async () => ok(undefined)),
  openExternal: vi.fn(async () => ok(undefined)),
  revealFileInExplorer: vi.fn(async () => ok(undefined)),
  copyFileToClipboard: vi.fn(async () => ok(undefined)),
  readImageTags: vi.fn(async () => ok({ absPath: '', subjects: [], ok: true })),
  writeImageTags: vi.fn(async () => ok({ absPath: '', subjects: [], ok: true })),
  writeBatchTags: vi.fn(async () => ok({ okCount: 0, failCount: 0 })),
  renameTag: vi.fn(async () => ok(0)),
  getImageInfo: vi.fn(async () => ok({ absPath: '', ok: true })),
  pickDirectory: vi.fn(async () => ok(null)),
  addRoot: vi.fn(async () => ok({ id: 'r1', path: 'C:/P', alias: 'P', addedAt: 1 })),
  removeRoot: vi.fn(async () => ok(undefined)),
  renameRoot: vi.fn(async () => ok(null)),
  onScanProgress: vi.fn(() => () => undefined),
  onScanDone: vi.fn(() => () => undefined),
  onScanError: vi.fn(() => () => undefined),
  onBatchProgress: vi.fn(() => () => undefined),
  onThumbReady: vi.fn(() => () => undefined),
  checkUpdate: vi.fn(async () => ok({ state: 'idle' as const })),
  downloadUpdate: vi.fn(async () => ok({ state: 'idle' as const })),
  installUpdate: vi.fn(async () => ok({ state: 'idle' as const })),
  onUpdateStatus: vi.fn(() => () => undefined)
};

beforeEach(() => {
  vi.stubGlobal('api', api);
  api.aiStorageStats.mockReset().mockResolvedValue(ok(statsFixture));
  api.aiCatalog.mockReset().mockResolvedValue(ok({ capabilities: [] }));
  useAiStore.setState({ stats: null, result: null, task: null, error: null });
});

describe('ai/AiSettingsPane —— 只读统计', () => {
  it('① 拉一次统计并显示模型占用 / 可用磁盘 / 暂存条目', async () => {
    render(<AiSettingsPane />);
    await screen.findByTestId('ai-stats-loaded');
    const text = screen.getByTestId('ai-stats-loaded').textContent ?? '';
    expect(text).toContain('4.4MB'); // 模型占用
    expect(text).toContain('247GB'); // 可用磁盘
    expect(text).toContain('7'); // 暂存条目数
  });

  it('① 显存必须标注「整卡」口径，不能谎称是 AI 占用（分进程显存拿不到）', async () => {
    render(<AiSettingsPane />);
    const note = await screen.findByTestId('ai-gpu-line');
    expect(note.textContent).toContain('整卡已用 1178 MiB / 8151 MiB');
    expect(note.textContent).toContain('整卡');
    expect(note.textContent).not.toMatch(/AI\s*占用|本应用占用/);
  });

  it('可用磁盘读不到时显示"未知"而不是 0（会让人以为盘满）', async () => {
    api.aiStorageStats.mockResolvedValue(ok({ ...statsFixture, freeDiskBytes: null }));
    render(<AiSettingsPane />);
    const text = (await screen.findByTestId('ai-stats-loaded')).textContent ?? '';
    expect(text).toContain('未知');
    expect(text).not.toContain('0.0GB');
  });

  it('显示暂存保留期与容量上限（§4.7 ③）', async () => {
    render(<AiSettingsPane />);
    const text = (await screen.findByTestId('ai-retention-line')).textContent ?? '';
    expect(text).toContain('30 天');
    expect(text).toContain('1.0GB');
  });
});

describe('ai/SettingsDialog —— 应用级总入口', () => {
  it('① 打开后有 AI 分区，且它是应用级设置的一部分而不是 AI 专属弹窗', async () => {
    render(<SettingsDialog open onClose={() => undefined} />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('tab', { name: /常规/ })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('tab', { name: /AI/ }));
    expect(within(dialog).getByTestId('ai-settings-pane')).toBeTruthy();
  });

  it('② 不含模型下载 / 卸载 / 删除 / 设为默认——同一状态只允许一处可改（D17）', async () => {
    render(<SettingsDialog open onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('tab', { name: /AI/ }));
    const pane = await screen.findByTestId('ai-settings-pane');
    for (const banned of ['下载', '卸载', '删除', '设为默认']) {
      expect(within(pane).queryByRole('button', { name: new RegExp(banned) })).toBeNull();
    }
  });

  it('③ 参数区为空态并明确标注「暂无可调参数」，且不许出现任何无效控件', async () => {
    render(<SettingsDialog open onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('tab', { name: /AI/ }));
    const pane = await screen.findByTestId('ai-settings-pane');
    expect(pane.textContent).toContain('暂无可调参数');
    // 滑块 / 开关 / 下拉 / 输入框：M1 一个都不许出现，否则就是调了没反应的假控件
    expect(within(pane).queryAllByRole('slider')).toHaveLength(0);
    expect(within(pane).queryAllByRole('switch')).toHaveLength(0);
    expect(within(pane).queryAllByRole('combobox')).toHaveLength(0);
    expect(within(pane).queryAllByRole('spinbutton')).toHaveLength(0);
    expect(pane.querySelectorAll('input[type=range], input[type=checkbox], input:not([type=range])')).toHaveLength(0);
  });

  it('④ 顶栏有「设置」入口，点开能进 AI 分区', async () => {
    const { AppLayout } = await import('../../src/components/AppLayout');
    render(<AppLayout />);
    fireEvent.click(await screen.findByRole('button', { name: /设置/ }));
    fireEvent.click(await screen.findByRole('tab', { name: /AI/ }));
    expect(screen.getByTestId('ai-settings-pane')).toBeTruthy();
  });
});
