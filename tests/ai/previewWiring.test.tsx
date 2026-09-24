// @vitest-environment jsdom
// T14 · 接线：预览底栏必须真的挂上组合按钮与对比视图。
// 组件各自的用例过了不代表挂载对了——这一条盯的是"接没接上"。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { PreviewOverlay } from '../../src/components/PreviewOverlay';
import { useAppStore } from '../../src/store/useAppStore';
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
    inputWidth: 320,
    inputHeight: 320,
    ...over
  };
}

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
    preview: {
      image: { absPath: 'C:/photos/a.jpg', rootId: 'r1', relPath: 'a.jpg', name: 'a.jpg', size: 100, mtimeMs: 1 },
      index: 0,
      list: []
    }
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
