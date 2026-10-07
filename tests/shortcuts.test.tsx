// @vitest-environment jsdom
// 批次3 · G11 —— 快捷键帮助。要守的两条：列表只准来自一个数据源，且只列真实现的键。
// 键位行为本身另有绊线：空格见 previewActions，←/→/Esc/Ctrl+C 见 aiUi 与既有预览用例。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { SettingsDialog } from '../src/components/settings/SettingsDialog';
import { SHORTCUTS } from '../src/utils/shortcuts';
import { useAppStore } from '../src/store/useAppStore';

function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

const api: Record<string, ReturnType<typeof vi.fn>> = {
  aiCatalog: vi.fn(async () => ok({ capabilities: [] })),
  aiStorageStats: vi.fn(async () => ok(null)),
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
  reorderRoots: vi.fn(async () => ok(undefined)),
  trashFiles: vi.fn(async () => ok({ trashed: [], failed: [] })),
  getPrefs: vi.fn(async () => ok({ sortKey: 'name', sortDir: 'asc', thumbSize: 'small', scanDoneToast: false })),
  setPrefs: vi.fn(async () => ok({ sortKey: 'name', sortDir: 'asc', thumbSize: 'small', scanDoneToast: false })),
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
  // 选中根+目录后网格会挂载，react-window 的自动测宽依赖 ResizeObserver，jsdom 没有这个宿主能力
  if (!('ResizeObserver' in globalThis)) {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  }
  useAppStore.setState({ roots: [], selectedRootId: null, selectedDir: null, snackbar: null });
});

describe('G11 快捷键数据源', () => {
  it('每条都有键位与动作，且没有空条目', () => {
    expect(SHORTCUTS.length).toBeGreaterThan(0);
    for (const s of SHORTCUTS) {
      expect(s.keys.trim().length).toBeGreaterThan(0);
      expect(s.action.trim().length).toBeGreaterThan(0);
      expect(s.scope.trim().length).toBeGreaterThan(0);
    }
  });

  it('只列真已实现的键位：空格与 ? 都在列，未实现的组合键一律不许出现', () => {
    const allKeys = SHORTCUTS.map((s) => s.keys).join(' ');
    expect(allKeys).toContain('空格');
    expect(allKeys).toContain('?');
    // M4 之前没有批量，Del/Delete 之类的键位压根没实现
    for (const notImplemented of ['Del', 'Delete', 'Ctrl+A', 'Ctrl+S']) {
      expect(allKeys).not.toContain(notImplemented);
    }
  });
});

describe('G11 设置里的快捷键分区', () => {
  it('有「快捷键」tab，渲染的行数等于数据源条数（界面不许各写一份）', () => {
    render(<SettingsDialog open onClose={() => undefined} />);
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('tab', { name: /快捷键/ }));
    const pane = screen.getByTestId('shortcut-list');
    expect(within(pane).getAllByRole('row')).toHaveLength(SHORTCUTS.length + 1); // +1 表头
    expect(pane.textContent).toContain('按住空格看原图');
    // 反面腿：左键已让给点提示，快捷键表里不得再出现「按住图片」的说法
    expect(pane.textContent).not.toContain('按住图片');
  });

  it('initialTab 能把对话框直接开到快捷键分区（? 唤出走的是这条路）', () => {
    render(
      <SettingsDialog open onClose={() => undefined} initialTab="shortcuts" />
    );
    expect(screen.getByTestId('shortcut-list')).toBeTruthy();
  });
});

describe('G11 全局 ? 唤出快捷键', () => {
  it('按 ? 打开设置并停在快捷键分区', async () => {
    const { AppLayout } = await import('../src/components/AppLayout');
    render(<AppLayout />);
    expect(screen.queryByTestId('shortcut-list')).toBeNull();
    fireEvent.keyDown(window, { key: '?', shiftKey: true });
    expect(screen.getByTestId('shortcut-list')).toBeTruthy();
  });

  it('反面腿：焦点在输入框里打 ? 是输字符，不许把设置弹出来', async () => {
    const { AppLayout } = await import('../src/components/AppLayout');
    // TagFilterBar 只在选中根+目录时渲染，roots 置空会让这条变成空跑
    useAppStore.setState({
      roots: [{ id: 'r1', path: 'C:/P', alias: 'P', addedAt: 1 }],
      selectedRootId: 'r1',
      selectedDir: ''
    } as never);
    render(<AppLayout />);
    const box = screen.getByPlaceholderText('搜索文件名');
    fireEvent.keyDown(box, { key: '?', shiftKey: true });
    expect(screen.queryByTestId('shortcut-list')).toBeNull();
  });
});
