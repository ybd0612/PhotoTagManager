// @vitest-environment jsdom
// T12 · 对比视图：舞台在大图区原位替换、棋盘格底纹、分屏为次要且必须注明掩码尺寸。
// 只用原生 DOM 断言（项目没装 jest-dom）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';

import { AiCompareActions, AiCompareStage } from '../../src/components/AiCompareView';
import { useAiStore } from '../../src/store/useAiStore';
import type { AiDonePayload } from '../../shared/types';

const SOURCE = 'C:/photos/portrait.jpg';
const OTHER = 'C:/photos/next.jpg';

const api = {
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
  onAiError: vi.fn(() => () => undefined)
};

function payload(over: Partial<AiDonePayload> = {}): AiDonePayload {
  return {
    taskId: 'ai-7',
    tempPath: 'C:/Users/x/AppData/ai-preview/aaaa.png',
    sourceAbsPath: SOURCE,
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

/** 舞台与动作条分开挂（前者在大图区、后者在底栏），测试里用同一个宿主还原真实组合 */
function Harness({ absPath = SOURCE, onSaved }: { absPath?: string; onSaved?: (r: unknown) => void }) {
  return (
    <div data-testid="stage-host" style={{ position: 'relative' }}>
      <AiCompareStage absPath={absPath} alt="portrait.jpg" onError={() => undefined} />
      <AiCompareActions absPath={absPath} onSaved={onSaved} />
    </div>
  );
}

beforeEach(() => {
  vi.stubGlobal('api', api);
  api.aiSave.mockReset().mockResolvedValue({
    ok: true as const,
    data: { savedPath: 'C:/photos/portrait.cutout.png', targetName: 'portrait.cutout.png', renamed: false, overwrote: false, tagsWritten: [] }
  });
  useAiStore.setState({
    result: payload(),
    task: null,
    error: null,
    pendingConfirm: null,
    compareMode: 'hold',
    holdingOriginal: false
  });
});

function srcOf(testid: string): string {
  return (screen.getByTestId(testid) as HTMLImageElement).getAttribute('src') ?? '';
}

function bgOf(testid: string): string {
  return window.getComputedStyle(screen.getByTestId(testid) as HTMLElement).backgroundImage;
}

async function actClick(el: HTMLElement): Promise<void> {
  const { act } = await import('@testing-library/react');
  await act(async () => {
    fireEvent.click(el);
  });
}

describe('ai/AiCompareStage —— 原位替换 + 按住看原图（默认模式）', () => {
  it('默认显示的就是抠好的结果，且舞台只有一个 img：同位同尺寸由构造保证', () => {
    render(<Harness />);
    expect(screen.getAllByTestId('ai-compare-img')).toHaveLength(1);
    // 不是"叠两层再对齐"——旧实现靠两层叠加，对齐与尺寸都要靠 CSS 断言自证
    expect(screen.queryByTestId('ai-original')).toBeNull();
    expect(screen.queryByTestId('ai-result')).toBeNull();
    expect(srcOf('ai-compare-img')).toContain('aaaa');
  });

  it('① 按住显示原图、松开回到结果（同一个元素换 src，不会错位）', () => {
    render(<Harness />);
    const before = srcOf('ai-compare-img');
    // G9 起触发器是大图区按住 / 空格，归 PreviewOverlay；本组件只认 store 里的 holding 态
    act(() => useAiStore.getState().setHoldingOriginal(true));
    const held = srcOf('ai-compare-img');
    expect(held).not.toBe(before);
    expect(held).toContain(encodeURIComponent(SOURCE));
    act(() => useAiStore.getState().setHoldingOriginal(false));
    expect(srcOf('ai-compare-img')).toBe(before);
  });

  it('holding 一旦复位就立刻回到结果（松开链路见 previewActions：移出大图/在别处松手都必须复位）', () => {
    render(<Harness />);
    act(() => useAiStore.getState().setHoldingOriginal(true));
    act(() => useAiStore.getState().setHoldingOriginal(false));
    expect(useAiStore.getState().holdingOriginal).toBe(false);
    expect(srcOf('ai-compare-img')).toContain('aaaa');
  });

  it('② 棋盘格画在 img 自身背景上：透明像素才透出底纹，也不会铺到照片以外', () => {
    render(<Harness />);
    const bg = bgOf('ai-compare-img');
    expect(bg).toContain('gradient');
    expect(bg).toMatch(/repeating|conic/);
  });

  it('按住时看的是不透明原图，此时不该再有棋盘格', () => {
    render(<Harness />);
    act(() => useAiStore.getState().setHoldingOriginal(true));
    expect(bgOf('ai-compare-img')).not.toMatch(/gradient/);
  });

  it('两张图源都走 ptm-file 协议（不给 file:// 权限）', () => {
    render(<Harness />);
    expect(srcOf('ai-compare-img').startsWith('ptm-file://')).toBe(true);
    act(() => useAiStore.getState().setHoldingOriginal(true));
    expect(srcOf('ai-compare-img').startsWith('ptm-file://')).toBe(true);
  });

  it('结果属于别的照片时舞台与动作条都不出现（翻页不继承上一张的对比）', () => {
    render(<Harness absPath={OTHER} />);
    expect(screen.queryByTestId('ai-compare-img')).toBeNull();
    expect(screen.queryByTestId('ai-compare-root')).toBeNull();
  });
});

describe('ai/AiCompareActions —— 底栏动作', () => {
  it('④ 两个动作：保存 / 不保存，且不存在「丢弃」按钮（D18）', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: /^保存$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /不保存/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /丢弃/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /替换原图/ })).toBeNull();
  });

  it('保存走 ai:save(taskId) 并清空结果，同时把对比视图复位', async () => {
    const onSaved = vi.fn();
    render(<Harness onSaved={onSaved} />);
    await actClick(screen.getByRole('button', { name: /^保存$/ }));
    expect(api.aiSave).toHaveBeenCalledWith('ai-7');
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ savedPath: 'C:/photos/portrait.cutout.png' }));
    expect(useAiStore.getState().result).toBeNull();
    expect(useAiStore.getState().holdingOriginal).toBe(false);
    expect(useAiStore.getState().compareMode).toBe('hold');
  });

  it('不保存只收起预览：文件留在暂存由清理策略回收，不删任何东西', async () => {
    render(<Harness />);
    await actClick(screen.getByRole('button', { name: /不保存/ }));
    expect(useAiStore.getState().result).toBeNull();
    expect(api.aiSave).not.toHaveBeenCalled();
    expect(Object.keys(api).filter((k) => /delete|remove/i.test(k) && api[k as keyof typeof api].mock.calls.length > 0)).toEqual([]);
  });

  it('保存失败时给可读原因，不静默收起预览（§6/A5）', async () => {
    api.aiSave.mockResolvedValueOnce({
      ok: false as const,
      error: { code: 'SAVE_FAILED', message: '保存到照片目录失败：文件正被其他程序使用' }
    });
    render(<Harness />);
    await actClick(screen.getByRole('button', { name: /^保存$/ }));
    expect(useAiStore.getState().result).not.toBeNull();
    expect(screen.getByTestId('ai-compare-error').textContent).toContain('文件正被其他程序使用');
  });
});

describe('ai/AiCompareStage —— 分屏为次要模式', () => {
  it('③ 切到分屏必须注明掩码计算尺寸，数值取自清单而非写死', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /左右双栏/ }));
    expect(screen.getByTestId('ai-mask-note').textContent).toContain('掩码在 320×320 下计算');

    // 换一组数字：证明它渲染自 payload 而不是硬编码
    await act(async () => {
      useAiStore.setState({ result: payload({ maskWidth: 512, maskHeight: 288 }) });
    });
    expect(screen.getByTestId('ai-mask-note').textContent).toContain('掩码在 512×288 下计算');
  });

  it('分屏是次要选项：默认不选中，切过去才并排两张图', () => {
    render(<Harness />);
    const split = screen.getByRole('button', { name: /左右双栏/ });
    expect(split.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(split);
    expect(screen.getByRole('button', { name: /左右双栏/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('ai-split-pair')).toBeTruthy();
    const pair = within(screen.getByTestId('ai-split-pair'));
    expect(pair.getByTestId('ai-original').getAttribute('src')).toContain(encodeURIComponent(SOURCE));
    // 右半是结果，透明区仍要落在棋盘格上
    expect(bgOf('ai-result')).toMatch(/repeating|conic/);
  });

  it('分屏下没有"第二处事实源"：模式与按住态都取 store，动作条与舞台同步', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /左右双栏/ }));
    expect(useAiStore.getState().compareMode).toBe('split');
    // G9：双栏下原图同屏已在，不该再挂一条"按住看原图"的图上提示
    expect(screen.queryByTestId('ai-hold-hint')).toBeNull();
  });
});
