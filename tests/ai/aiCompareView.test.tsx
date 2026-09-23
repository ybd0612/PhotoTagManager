// @vitest-environment jsdom
// T12 · 对比视图：默认按住对比、棋盘格底纹、分屏为次要且必须注明掩码尺寸。
// 只用原生 DOM 断言（项目没装 jest-dom）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { AiCompareView } from '../../src/components/AiCompareView';
import { useAiStore } from '../../src/store/useAiStore';
import type { AiDonePayload } from '../../shared/types';

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
    sourceAbsPath: 'C:/photos/portrait.jpg',
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

beforeEach(() => {
  vi.stubGlobal('api', api);
  api.aiSave.mockReset().mockResolvedValue({
    ok: true as const,
    data: { savedPath: 'C:/photos/portrait.cutout.png', targetName: 'portrait.cutout.png', renamed: false, tagsWritten: [] }
  });
  useAiStore.setState({ result: payload(), task: null, error: null, pendingConfirm: null });
});

function layerOpacity(testid: string): string {
  const el = screen.getByTestId(testid) as HTMLElement;
  return el.style.opacity;
}

describe('ai/AiCompareView —— 按住对比（默认模式）', () => {
  it('默认就是按住模式：松开显示结果、原图隐藏', () => {
    render(<AiCompareView />);
    expect(layerOpacity('ai-original')).toBe('0');
    expect(layerOpacity('ai-result')).toBe('1');
    expect(screen.getByRole('button', { name: /^按住对比$/ })).toBeTruthy();
  });

  it('① 按住显示原图、松开回到结果（两图同位同尺寸叠加）', () => {
    render(<AiCompareView />);
    const hold = screen.getByRole('button', { name: /^按住对比$/ });
    fireEvent.mouseDown(hold);
    expect(layerOpacity('ai-original')).toBe('1');
    expect(layerOpacity('ai-result')).toBe('0');
    fireEvent.mouseUp(hold);
    expect(layerOpacity('ai-original')).toBe('0');
    expect(layerOpacity('ai-result')).toBe('1');
  });

  it('两张图叠在同一位置、同一尺寸（对齐才能看边缘）', () => {
    render(<AiCompareView />);
    const original = screen.getByTestId('ai-original') as HTMLElement;
    const result = screen.getByTestId('ai-result') as HTMLElement;
    const wrap = screen.getByTestId('ai-compare-stage') as HTMLElement;
    expect(window.getComputedStyle(original).position).toBe('absolute');
    expect(window.getComputedStyle(result).position).toBe('absolute');
    expect(original.style.inset).toBe(result.style.inset);
    expect(original.style.width).toBe(result.style.width);
    expect(original.style.height).toBe(result.style.height);
    expect(wrap).toBeTruthy();
  });

  it('两张图源分别是原图与暂存结果（走 ptm-file 协议，不给 file:// 权限）', () => {
    render(<AiCompareView />);
    const original = screen.getByTestId('ai-original') as HTMLImageElement;
    const result = screen.getByTestId('ai-result') as HTMLImageElement;
    expect(original.getAttribute('src')).toContain(encodeURIComponent('C:/photos/portrait.jpg'));
    expect(result.getAttribute('src')).toContain('aaaa');
    expect(String(original.getAttribute('src')).startsWith('ptm-file://')).toBe(true);
    expect(String(result.getAttribute('src')).startsWith('ptm-file://')).toBe(true);
  });

  it('② 透明区必须落在棋盘格底纹上，不允许纯白/纯黑底', () => {
    render(<AiCompareView />);
    const board = screen.getByTestId('ai-checkerboard') as HTMLElement;
    const bg = window.getComputedStyle(board);
    // 棋盘格由两层重复渐变叠出，纯色背景不会匹配
    expect(bg.backgroundImage).toContain('gradient');
    expect(bg.backgroundImage).toMatch(/repeating|conic|linear/);
    expect(bg.backgroundImage.split('gradient').length).toBeGreaterThanOrEqual(3);
  });

  it('④ 两个动作：保存 / 不保存，且不存在「丢弃」按钮（D18）', async () => {
    render(<AiCompareView />);
    expect(screen.getByRole('button', { name: /^保存$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /不保存/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /丢弃/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /替换原图/ })).toBeNull();
  });

  it('保存走 ai:save(taskId) 并清空结果，让预览层收起', async () => {
    const onSaved = vi.fn();
    render(<AiCompareView onSaved={onSaved} />);
    await actClick(screen.getByRole('button', { name: /^保存$/ }));
    expect(api.aiSave).toHaveBeenCalledWith('ai-7');
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ savedPath: 'C:/photos/portrait.cutout.png' }));
    expect(useAiStore.getState().result).toBeNull();
  });

  it('不保存只收起预览：文件留在暂存由清理策略回收，不删任何东西', async () => {
    render(<AiCompareView />);
    await actClick(screen.getByRole('button', { name: /不保存/ }));
    expect(useAiStore.getState().result).toBeNull();
    expect(api.aiSave).not.toHaveBeenCalled();
    // 没有任何"删除暂存"的调用
    expect(Object.keys(api).filter((k) => /delete|remove/i.test(k) && api[k as keyof typeof api].mock.calls.length > 0)).toEqual([]);
  });

  it('保存失败时给可读原因，不静默收起预览（§6/A5）', async () => {
    api.aiSave.mockResolvedValueOnce({
      ok: false as const,
      error: { code: 'SAVE_FAILED', message: '保存到照片目录失败：文件正被其他程序使用' }
    });
    render(<AiCompareView />);
    await actClick(screen.getByRole('button', { name: /^保存$/ }));
    // 预览仍在，用户可以重试
    expect(useAiStore.getState().result).not.toBeNull();
    expect(screen.getByTestId('ai-compare-error').textContent).toContain('文件正被其他程序使用');
  });
});

describe('ai/AiCompareView —— 分屏为次要模式', () => {
  it('③ 切到分屏必须注明掩码计算尺寸，数值取自清单而非写死', () => {
    render(<AiCompareView />);
    fireEvent.click(screen.getByRole('button', { name: /分屏/ }));
    const note = screen.getByTestId('ai-mask-note').textContent ?? '';
    expect(note).toContain('掩码在 320×320 下计算');
    // 换一组数字，验证它是渲染自 payload 而不是硬编码
    useAiStore.setState({ result: payload({ inputWidth: 512, inputHeight: 288 }) });
    const second = render(<AiCompareView />);
    // 上一次 render 的实例还在 DOM 里，取最后挂载的那个
    fireEvent.click(within(second.container).getByRole('button', { name: /分屏/ }));
    expect(within(second.container).getByTestId('ai-mask-note').textContent).toContain('掩码在 512×288 下计算');
  });

  it('分屏是次要选项：默认不选中它，且不提供"替换原图"', () => {
    render(<AiCompareView />);
    const split = screen.getByRole('button', { name: /分屏/ });
    expect(split.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(split);
    expect(screen.getByRole('button', { name: /分屏/ }).getAttribute('aria-pressed')).toBe('true');
    // 分屏下两张图并排，右侧变糊是预期的，所以注明必须可见
    expect(screen.getByTestId('ai-mask-note')).toBeTruthy();
  });
});

async function actClick(el: HTMLElement): Promise<void> {
  const { act } = await import('@testing-library/react');
  await act(async () => {
    fireEvent.click(el);
  });
}
