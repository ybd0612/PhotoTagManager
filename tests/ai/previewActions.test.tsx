// @vitest-environment jsdom
// 批次3 · G9 —— 预览动作条分层 + 「按住看原图」改成空格与图上浮层。
// 不变的口径（D15）：默认看到抠图结果，按住才切回原图；换形态不是改判交互。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';

import { PreviewOverlay } from '../../src/components/PreviewOverlay';
import { OVERLAY } from '../../src/components/AiCompareView';
import { rootKey, useAppStore } from '../../src/store/useAppStore';
import { useAiStore } from '../../src/store/useAiStore';
import type { AiDonePayload } from '../../shared/types';

function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

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
  getThumbnail: vi.fn(async () => ok(null)),
  revealFileInExplorer: vi.fn(async () => ok(undefined)),
  trashFiles: vi.fn(async () => ok({ trashed: [], failed: [] })),
  copyFileToClipboard: vi.fn(async () => ok(undefined))
};

const IMG_A = {
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

const TEMP = 'C:/Users/x/AppData/ai-preview/deadbeef.png';

function done(): AiDonePayload {
  return {
    taskId: 'ai-3',
    tempPath: TEMP,
    sourceAbsPath: IMG_A.absPath,
    cacheHit: false,
    didApplySigmoid: false,
    maskWidth: 320,
    maskHeight: 320,
    capabilityId: 'portrait-cutout',
    modelId: 'u2netp',
    actionTag: 'AI人像抠图',
    inputWidth: 320,
    inputHeight: 320
  };
}

beforeEach(() => {
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
  useAppStore.setState({
    selectedRootId: 'r1',
    imagesByDir: new Map([[rootKey('r1', ''), [IMG_A]]]),
    preview: { image: IMG_A, index: 0, list: [IMG_A] as never[] }
  } as never);
  useAiStore.setState({
    catalog: null,
    result: done(),
    task: null,
    error: null,
    pendingConfirm: null,
    compareMode: 'hold',
    holdingOriginal: false
  });
});

describe('G9 预览动作条分层', () => {
  it('模式切换与保存动作分成两段，中间有分隔', () => {
    render(<PreviewOverlay />);
    const bar = screen.getByTestId('ai-bar');
    const modes = screen.getByTestId('ai-mode-group');
    const commits = screen.getByTestId('ai-commit-group');
    expect(bar.contains(modes)).toBe(true);
    expect(bar.contains(commits)).toBe(true);
    expect(screen.getByTestId('ai-actions-divider')).toBeTruthy();
    // 分段不许串味：左边只有模式，右边只有保存/不保存
    expect(modes.textContent).toContain('原位对比');
    expect(modes.textContent).toContain('左右双栏');
    expect(modes.textContent).not.toContain('保存');
    expect(commits.textContent).toContain('保存');
    expect(commits.textContent).not.toContain('双栏');
  });

  it('「按住看原图」不再挤在动作条里', () => {
    render(<PreviewOverlay />);
    const bar = screen.getByTestId('ai-bar');
    expect(within(bar).queryByRole('button', { name: /按住看原图/ })).toBeNull();
  });

  it('按住空格切回原图，松开立刻回来（D15 口径不变，只是换了触发方式）', () => {
    render(<PreviewOverlay />);
    const img = () => screen.getByTestId('ai-compare-img') as HTMLImageElement;
    expect(img().src).toContain('deadbeef'); // 默认看结果
    fireEvent.keyDown(window, { key: ' ' });
    expect(useAiStore.getState().holdingOriginal).toBe(true);
    expect(img().src).toContain('a.jpg'); // 按住看原图
    fireEvent.keyUp(window, { key: ' ' });
    expect(useAiStore.getState().holdingOriginal).toBe(false);
    expect(img().src).toContain('deadbeef');
  });

  it('大图上给一条浮层提示，写明空格与按住两种触发', () => {
    render(<PreviewOverlay />);
    const hint = screen.getByTestId('ai-hold-hint');
    expect(hint.textContent).toContain('空格');
  });

  it('反面腿：切到左右双栏后浮层消失（原图同屏已在，不需要按住）', () => {
    render(<PreviewOverlay />);
    fireEvent.click(screen.getByRole('button', { name: '左右双栏' }));
    expect(screen.queryByTestId('ai-hold-hint')).toBeNull();
    expect(screen.getByTestId('ai-split-pair')).toBeTruthy();
  });

  it('反面腿：没有抠图结果时空格不改动按住状态', () => {
    useAiStore.setState({ result: null });
    render(<PreviewOverlay />);
    fireEvent.keyDown(window, { key: ' ' });
    expect(useAiStore.getState().holdingOriginal).toBe(false);
  });

  it('在大图上按下看原图，松手回到结果', () => {
    render(<PreviewOverlay />);
    const stage = screen.getByTestId('preview-stage');
    const img = () => screen.getByTestId('ai-compare-img') as HTMLImageElement;
    fireEvent.mouseDown(stage);
    expect(useAiStore.getState().holdingOriginal).toBe(true);
    expect(img().src).toContain('a.jpg');
    fireEvent.mouseUp(stage);
    expect(useAiStore.getState().holdingOriginal).toBe(false);
    expect(img().src).toContain('deadbeef');
  });

  it('反面腿：分屏模式在大图上按下不抢鼠标（原图同屏已在，按下要留给拖动平移）', () => {
    useAiStore.setState({ compareMode: 'split' });
    render(<PreviewOverlay />);
    fireEvent.mouseDown(screen.getByTestId('preview-stage'));
    expect(useAiStore.getState().holdingOriginal).toBe(false);
  });

  it('反面腿：焦点在标签输入框里打空格照常输字，不被当成"按住看原图"', () => {
    render(<PreviewOverlay />);
    const box = screen.getByPlaceholderText('添加标签后回车');
    fireEvent.keyDown(box, { key: ' ' });
    expect(useAiStore.getState().holdingOriginal).toBe(false);
  });

  it('反面腿：按住状态下翻到下一张，holding 必须跟着换图复位', () => {
    const IMG_B = { ...IMG_A, id: 'b1', absPath: 'C:/photos/b.jpg', relPath: 'b.jpg', name: 'b.jpg' };
    render(<PreviewOverlay />);
    fireEvent.keyDown(window, { key: ' ' });
    expect(useAiStore.getState().holdingOriginal).toBe(true);
    act(() => {
      useAppStore.setState({
        imagesByDir: new Map([[rootKey('r1', ''), [IMG_A, IMG_B]]]),
        preview: { image: IMG_B, index: 1, list: [IMG_A, IMG_B] as never[] }
      } as never);
    });
    expect(useAiStore.getState().holdingOriginal).toBe(false);
  });
});

/**
 * G10 的渲染效果（暗底上到底看不看得出来）只能靠像素层复验，jsdom 拿不到伪类与
 * emotion 计算样式。这里钉的是**数值本身**：谁把描边改回 0.25、placeholder 改回 0.45 就红。
 */
describe('G10 暗底输入框对比 token', () => {
  it('描边与 placeholder 的对比值停在整改后的档位，focus 用主题 primary.light', () => {
    expect(OVERLAY.fieldBorder).toBe('rgba(255,255,255,0.35)');
    expect(OVERLAY.fieldPlaceholder).toBe('rgba(255,255,255,0.6)');
    expect(OVERLAY.focus).toBe('#818cf8');
    // 三档必须真的比整改前强，否则这条绊线只是把旧值钉死
    expect(parseFloat(/([\d.]+)\)$/.exec(OVERLAY.fieldBorder)?.[1] ?? '0')).toBeGreaterThanOrEqual(0.35);
    expect(parseFloat(/([\d.]+)\)$/.exec(OVERLAY.fieldPlaceholder)?.[1] ?? '0')).toBeGreaterThanOrEqual(0.6);
  });

  it('压图的浮层文字比元数据那一档更亮（同一层界面只有一个口径）', () => {
    const alpha = (v: string): number => Number(/([\d.]+)\)$/.exec(v)?.[1] ?? 0);
    expect(alpha(OVERLAY.textStrong)).toBeGreaterThan(alpha(OVERLAY.mid));
    expect(alpha(OVERLAY.mid)).toBeGreaterThan(alpha(OVERLAY.dim));
  });

  it('输入框在底栏里，placeholder 文案未被改动', () => {
    render(<PreviewOverlay />);
    const box = screen.getByPlaceholderText('添加标签后回车');
    expect(box).toBeTruthy();
  });
});
