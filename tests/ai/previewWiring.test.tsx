// @vitest-environment jsdom
// T14 · 接线：预览底栏必须真的挂上组合按钮与对比视图。
// 组件各自的用例过了不代表挂载对了——这一条盯的是"接没接上"。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';

import { PreviewOverlay } from '../../src/components/PreviewOverlay';
import { rootKey, useAppStore } from '../../src/store/useAppStore';
import { useAiStore } from '../../src/store/useAiStore';
import type { AiDonePayload } from '../../shared/types';

function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

// vi.mock 会被提到文件顶部，替身要用 vi.hoisted 才拿得到同一个引用
const { rescanMock } = vi.hoisted(() => ({ rescanMock: vi.fn(async () => undefined) }));
vi.mock('../../src/hooks/useScan', () => ({
  useScanSubscriptions: () => undefined,
  startScan: vi.fn(async () => undefined),
  rescan: rescanMock,
  cancelScan: vi.fn(async () => undefined),
  autoScanAllRoots: vi.fn(async () => undefined)
}));

const api: Record<string, ReturnType<typeof vi.fn>> = {
  aiCatalog: vi.fn(),
  aiRun: vi.fn(),
  aiCancel: vi.fn(),
  aiSave: vi.fn(),
  aiModelDownload: vi.fn(),
  aiModelDelete: vi.fn(),
  aiModelUnload: vi.fn(),
  aiModelSetDefault: vi.fn(),
  aiStorageStats: vi.fn(),
  onAiProgress: vi.fn(() => () => undefined),
  onAiDone: vi.fn(() => () => undefined),
  onAiError: vi.fn(() => () => undefined),
  getImageInfo: vi.fn(async () => ok({ absPath: '', ok: true })),
  readImageTags: vi.fn(async () => ok({ absPath: '', subjects: [], ok: true })),
  writeImageTags: vi.fn(async () => ok({ absPath: '', subjects: [], ok: true })),
  readBulkTags: vi.fn(async () => ok([])),
  getThumbnail: vi.fn(async () => ok(null)),
  revealFileInExplorer: vi.fn(async () => ok(undefined)),
  trashFiles: vi.fn(async () => ok({ trashed: [], failed: [] })),
  copyFileToClipboard: vi.fn(async () => ok(undefined)),
  openFolderInExplorer: vi.fn(async () => ok(undefined))
};

function done(over: Partial<AiDonePayload> = {}): AiDonePayload {
  return {
    taskId: 'ai-3',
    tempPath: 'C:/Users/x/AppData/ai-preview/deadbeef.png',
    sourceAbsPath: 'C:/photos/a.jpg',
    cacheHit: false,
    didApplySigmoid: false,
    maskWidth: 320,
    maskHeight: 320,
    capabilityId: 'portrait-cutout',
    modelId: 'u2netp',
    actionTag: 'AI人像抠图',
    ...over
  };
}

/** 字段完整的图片：删除类断言要求它真的在 imagesByDir 账上，否则移除会空过 */
const STAGE_IMAGE = {
  id: 'a1',
  absPath: 'C:/photos/a.jpg',
  relPath: 'a.jpg',
  name: 'a.jpg',
  ext: '.jpg',
  size: 100,
  mtimeMs: 1,
  dirRelPath: '',
  tags: []
};

beforeEach(async () => {
  vi.stubGlobal('api', api);
  api.aiCatalog.mockReset().mockResolvedValue(
    ok({
      capabilities: [
        {
          id: 'portrait-cutout',
          label: '抠图',
          description: '去除人像背景',
          actionTag: 'AI人像抠图',
          outputSuffix: 'cutout',
          outputExt: '.png',
          defaultModelId: 'u2netp',
          models: [
            {
              id: 'u2netp',
              displayName: 'U²-Netp',
              sizeBytes: 4_574_861,
              verified: true,
              status: 'present',
              loaded: false,
              isDefault: true,
              inputWidth: 320,
              inputHeight: 320
            }
          ]
        }
      ]
    })
  );
  api.aiSave.mockReset().mockResolvedValue(
    ok({ savedPath: 'C:/photos/a.cutout.png', targetName: 'a.cutout.png', renamed: false, tagsWritten: [] })
  );
  useAppStore.setState({
    selectedRootId: 'r1',
    imagesByDir: new Map([[rootKey('r1', ''), [STAGE_IMAGE]]]),
    preview: { image: STAGE_IMAGE, index: 0, list: [STAGE_IMAGE] as never[] }
  } as never);
  useAiStore.setState({ catalog: null, result: null, task: null, error: null, pendingConfirm: null });
});

describe('预览层 AI 接线', () => {
  it('底栏挂了组合按钮，且只有一个（M1 只有人像抠图一个行为）', async () => {
    render(<PreviewOverlay />);
    const bar = await screen.findByTestId('ai-bar');
    expect(bar).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^抠图$/ })).toHaveLength(1);
  });

  it('没有结果时不占位：对比视图不出现', () => {
    render(<PreviewOverlay />);
    expect(screen.queryByTestId('ai-compare-root')).toBeNull();
  });

  it('有结果时对比视图出现在同一个底栏里', async () => {
    useAiStore.setState({ result: done() });
    render(<PreviewOverlay />);
    const bar = await screen.findByTestId('ai-bar');
    expect(screen.getByTestId('ai-compare-root')).toBeTruthy();
    expect(bar.contains(screen.getByTestId('ai-compare-root'))).toBe(true);
  });

  it('保存后主动刷新当前目录并告知，不静默也不甩给用户重扫（§4.4 C2 选①）', async () => {
    useAiStore.setState({ result: done() });
    const { act } = await import('@testing-library/react');
    render(<PreviewOverlay />);
    rescanMock.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^保存$/ }));
    });
    expect(api.aiSave).toHaveBeenCalledWith('ai-3');
    // Snackbar 挂在 AppLayout 上，接线契约是 store 里那条消息
    const text = useAppStore.getState().snackbar ?? '';
    expect(text).toContain('a.cutout.png');
    expect(text).toMatch(/正在刷新/);
    // 关键：真的发起刷新，而不是只写一句"请重新扫描"
    expect(rescanMock).toHaveBeenCalledTimes(1);
  });
});

describe('预览层 · 移到回收站', () => {
  it('大图区右键出菜单，确认后发出删除请求并把这张从账上划掉', async () => {
    api.trashFiles.mockReset().mockResolvedValue(ok({ trashed: ['C:/photos/a.jpg'], failed: [] }));
    render(<PreviewOverlay />);
    fireEvent.contextMenu(screen.getByTestId('preview-stage'));
    fireEvent.click(await screen.findByTestId('preview-menu-trash'));
    const dialog = await screen.findByRole('dialog', { name: /移到回收站/ });
    expect(dialog.textContent).toContain('回收站');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /^移到回收站/ }));
    });
    expect(api.trashFiles).toHaveBeenCalledWith(['C:/photos/a.jpg']);
    const s = useAppStore.getState();
    expect(s.preview).toBeNull();
    expect(s.imagesByDir.get(rootKey('r1', '')) ?? []).toEqual([]);
    expect(s.snackbar ?? '').toContain('回收站');
  });

  it('确认框里点取消：一个请求都不发，账目不动', async () => {
    api.trashFiles.mockReset();
    render(<PreviewOverlay />);
    fireEvent.contextMenu(screen.getByTestId('preview-stage'));
    fireEvent.click(await screen.findByTestId('preview-menu-trash'));
    const dialog = await screen.findByRole('dialog', { name: /移到回收站/ });
    fireEvent.click(within(dialog).getByRole('button', { name: /取消/ }));
    expect(api.trashFiles).not.toHaveBeenCalled();
    expect(useAppStore.getState().preview).not.toBeNull();
    expect(useAppStore.getState().imagesByDir.get(rootKey('r1', ''))).toHaveLength(1);
  });

  it('没删成（被占用等）：原因说给人听，那张仍留在预览与列表里', async () => {
    api.trashFiles.mockReset().mockResolvedValue(
      ok({ trashed: [], failed: [{ absPath: 'C:/photos/a.jpg', reason: '文件正被其他程序使用' }] })
    );
    render(<PreviewOverlay />);
    fireEvent.contextMenu(screen.getByTestId('preview-stage'));
    fireEvent.click(await screen.findByTestId('preview-menu-trash'));
    const dialog = await screen.findByRole('dialog', { name: /移到回收站/ });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /^移到回收站/ }));
    });
    expect(useAppStore.getState().preview).not.toBeNull();
    expect(useAppStore.getState().imagesByDir.get(rootKey('r1', ''))).toHaveLength(1);
    expect(useAppStore.getState().snackbar ?? '').toContain('文件正被其他程序使用');
  });
});
