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
  aiMaskEdit: vi.fn(),
  aiMobileSamStatus: vi.fn().mockResolvedValue({ ok: true, data: { statuses: [{ status: 'present' }, { status: 'present' }] } }),
  aiMobileSamInstall: vi.fn(),
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
  api.aiMobileSamStatus.mockReset().mockResolvedValue({ ok: true, data: { statuses: [{ status: 'present' }, { status: 'present' }] } });
  api.aiMaskEdit.mockReset().mockResolvedValue({
    ok: true as const,
    data: { tempPath: 'C:/Users/x/AppData/ai-preview/bbbb.png', maskCanUndo: true, maskCanRedo: false }
  });
  useAiStore.setState({
    result: payload({ maskEditable: true, maskCanUndo: false, maskCanRedo: false }),
    maskEditing: false,
    task: null,
    error: null,
    pendingConfirm: null,
    compareMode: 'hold',
    holdingOriginal: false,
    maskPromptMode: false
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
  it('显示点提示与撤销/重做状态，并调用相应历史操作', async () => {
    useAiStore.setState({ result: payload({ maskEditable: true, maskCanUndo: true }), maskPromptMode: true });
    api.aiMaskEdit
      .mockResolvedValueOnce({ ok: true as const, data: { tempPath: 'C:/preview/undo.png', maskCanUndo: false, maskCanRedo: true } })
      .mockResolvedValueOnce({ ok: true as const, data: { tempPath: 'C:/preview/redo.png', maskCanUndo: true, maskCanRedo: false } });
    render(<Harness />);
    expect(screen.getByText('左键=要保留 · 右键=要去掉')).toBeTruthy();
    expect(screen.getByRole('button', { name: '撤销' }).hasAttribute('disabled')).toBe(false);

    await actClick(screen.getByRole('button', { name: '撤销' }));
    expect(api.aiMaskEdit).toHaveBeenNthCalledWith(1, 'ai-7', { action: 'undo' });
    expect(useAiStore.getState().result?.tempPath).toBe('C:/preview/undo.png');
    expect(screen.getByRole('button', { name: '重做' }).hasAttribute('disabled')).toBe(false);

    await actClick(screen.getByRole('button', { name: '重做' }));
    expect(api.aiMaskEdit).toHaveBeenNthCalledWith(2, 'ai-7', { action: 'redo' });
    expect(useAiStore.getState().result?.tempPath).toBe('C:/preview/redo.png');
  });

  it('点提示默认不开启：不进模式时既没有工具条也没有命中层', () => {
    render(<Harness />);
    expect(screen.queryByTestId('mask-brush-overlay')).toBeNull();
    expect(screen.queryByRole('button', { name: '撤销' })).toBeNull();
  });

  it('底栏「修正抠图」按钮切换点提示模式', async () => {
    render(<Harness />);
    const toggle = screen.getByRole('button', { name: '修正抠图' });
    await actClick(toggle);
    expect(useAiStore.getState().maskPromptMode).toBe(true);
    expect(screen.getByTestId('mask-brush-overlay')).toBeTruthy();
    expect(screen.getByRole('button', { name: '点提示中 · 点击退出' })).toBeTruthy();
    await actClick(screen.getByRole('button', { name: '点提示中 · 点击退出' }));
    expect(useAiStore.getState().maskPromptMode).toBe(false);
    expect(screen.queryByTestId('mask-brush-overlay')).toBeNull();
  });

  it('左键提交前景点（label=1）', async () => {
    api.aiMobileSamStatus = vi.fn().mockResolvedValue({ ok: true, data: { statuses: [{ status: 'present' }, { status: 'present' }] } });
    render(<Harness />);
    await act(async () => { useAiStore.getState().setMaskPromptMode(true); });
    const svg = screen.getByTestId('mask-brush-overlay');
    Object.defineProperty(svg, 'getBoundingClientRect', { configurable: true, value: () => ({ x: 10, y: 20, left: 10, top: 20, right: 330, bottom: 340, width: 320, height: 320, toJSON: () => ({}) }) });
    await act(async () => { fireEvent.mouseDown(svg, { button: 0, clientX: 90, clientY: 100 }); await Promise.resolve(); });
    expect(api.aiMaskEdit).toHaveBeenCalledWith('ai-7', { action: 'prompt', prompt: { x: 0.25, y: 0.25, label: 1 } });
  });

  /**
   * 右键走 contextmenu 收事件，不靠 onMouseDown 的 button 判断。
   * 旧实现在 mousedown 里就 preventDefault，Windows 上右键的 button 值失灵，
   * 实测右键点下去全被记成前景点（圈全是绿的）。这条钉住后台点真的能发出去。
   */
  it('右键提交背景点（label=0），且不会弹右键菜单', async () => {
    api.aiMobileSamStatus = vi.fn().mockResolvedValue({ ok: true, data: { statuses: [{ status: 'present' }, { status: 'present' }] } });
    render(<Harness />);
    await act(async () => { useAiStore.getState().setMaskPromptMode(true); });
    const svg = screen.getByTestId('mask-brush-overlay');
    Object.defineProperty(svg, 'getBoundingClientRect', { configurable: true, value: () => ({ x: 10, y: 20, left: 10, top: 20, right: 330, bottom: 340, width: 320, height: 320, toJSON: () => ({}) }) });
    await act(async () => { fireEvent.contextMenu(svg, { clientX: 170, clientY: 180 }); await Promise.resolve(); });
    expect(api.aiMaskEdit).toHaveBeenCalledWith('ai-7', { action: 'prompt', prompt: { x: 0.5, y: 0.5, label: 0 } });
  });

  /**
   * 真实浏览器时序：右键按下**也会发 mousedown**（button===2），且早于 contextmenu。
   * 若mousedown 守卫写成 `button > 2`，右键会先提交 label=1，
   * 随后的 contextmenu 被 inFlight 挡掉——表现为「右键永远=要保留」。
   * 这条按真实顺序发事件，只允许一条 label=0 出去。
   */
  it('右键按下的完整时序（mousedown→contextmenu）只提交一条背景点', async () => {
    api.aiMobileSamStatus = vi.fn().mockResolvedValue({ ok: true, data: { statuses: [{ status: 'present' }, { status: 'present' }] } });
    render(<Harness />);
    await act(async () => { useAiStore.getState().setMaskPromptMode(true); });
    const svg = screen.getByTestId('mask-brush-overlay');
    Object.defineProperty(svg, 'getBoundingClientRect', { configurable: true, value: () => ({ x: 10, y: 20, left: 10, top: 20, right: 330, bottom: 340, width: 320, height: 320, toJSON: () => ({}) }) });
    await act(async () => {
      fireEvent.mouseDown(svg, { button: 2, clientX: 170, clientY: 180 });
      fireEvent.contextMenu(svg, { clientX: 170, clientY: 180 });
      await Promise.resolve();
    });
    const promptCalls = api.aiMaskEdit.mock.calls.filter((c) => c[1]?.action === 'prompt');
    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0][1].prompt.label).toBe(0);
  });

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

  // 双栏模式原先在 mode==='split' 分支里提前 return，overlay 根本没渲染，
  // 于是点提示只能挤在 hold 模式里跟"按住看原图"抢左键。现在两模式都铺overlay。
  it('分屏模式下点提示层铺在右侧结果图上', async () => {
    render(<Harness />);
    await act(async () => {
      useAiStore.setState({ result: payload({ maskEditable: true }), maskPromptMode: true });
    });
    expect(screen.getByTestId('mask-brush-overlay')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /左右双栏/ }));
    const overlay = screen.getByTestId('mask-brush-overlay');
    expect(overlay).toBeTruthy();
    // overlay 必须在结果图那一侧：其最近的定位祖先里应含 ai-result
    const resultImg = screen.getByTestId('ai-result');
    expect(resultImg.parentElement?.contains(overlay)).toBe(true);
  });

  it('掩码不可编辑时不显示「修正抠图」入口', async () => {
    render(<Harness />);
    await act(async () => {
      useAiStore.setState({ result: payload({ maskEditable: false }) });
    });
    expect(screen.queryByRole('button', { name: '修正抠图' })).toBeNull();
  });
});
