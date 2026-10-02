// @vitest-environment jsdom
// 抠图参数面板（方案 §3 / §8-4）：它是详情页预览层的浮层，不属于设置页——
// 所以本文件测的是"面板自身"，不去动 aiSettings.test.tsx 里那条零输入控件的断言。
// 钉三件能被改坏的事：① 控件必须是真按钮（键盘 Tab 得到，不是 hover 才出现）；
// ② 一次 Esc 只退一层（关面板，不许把整个预览关掉）；③ 选完底色面板不许消失。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor, act } from '@testing-library/react';

import { CutoutParamsPanel } from '../../src/components/CutoutParamsPanel';
import { useAiStore } from '../../src/store/useAiStore';
import type { AiDonePayload } from '../../shared/types';

const ABS = 'C:/photos/a.jpg';

function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

const api: Record<string, ReturnType<typeof vi.fn>> = {
  aiRun: vi.fn(),
  aiCatalog: vi.fn(),
  onAiProgress: vi.fn(() => () => undefined),
  onAiDone: vi.fn(() => () => undefined),
  onAiError: vi.fn(() => () => undefined)
};

function done(over: Partial<AiDonePayload> = {}): AiDonePayload {
  return {
    taskId: 'ai-3',
    tempPath: 'C:/Users/x/AppData/ai-preview/deadbeef.png',
    sourceAbsPath: ABS,
    cacheHit: false,
    didApplySigmoid: false,
    maskWidth: 320,
    maskHeight: 160,
    capabilityId: 'portrait-cutout',
    modelId: 'u2netp',
    actionTag: 'AI人像抠图',
    ...over
  };
}

beforeEach(() => {
  vi.stubGlobal('api', api);
  api.aiRun.mockReset().mockResolvedValue(ok({ taskId: 'ai-9' }));
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
  useAiStore.setState({
    catalog: null,
    result: done(),
    task: null,
    error: null,
    bgcolor: 'transparent',
    backend: 'dml',
    compareMode: 'hold',
    holdingOriginal: false
  });
});

/** 打开面板并返回它（关闭态只有一个触发按钮） */
function openPanel(): HTMLElement {
  fireEvent.click(screen.getByTestId('cutout-panel-trigger'));
  return screen.getByTestId('cutout-panel');
}

describe('CutoutParamsPanel —— 出现条件', () => {
  it('这张图没有抠图结果时什么都不画（没有参数可调）', () => {
    useAiStore.setState({ result: null });
    const { container } = render(<CutoutParamsPanel absPath={ABS} />);
    expect(container.firstChild).toBeNull();
  });

  it('结果属于另一张图时也不画', () => {
    useAiStore.setState({ result: done({ sourceAbsPath: 'C:/photos/other.jpg' }) });
    const { container } = render(<CutoutParamsPanel absPath={ABS} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('CutoutParamsPanel —— 键盘可达（D17 / §3-2）', () => {
  it('触发按钮是能聚焦的真按钮，不是 hover 才出现的浮层', () => {
    render(<CutoutParamsPanel absPath={ABS} />);
    const trigger = screen.getByTestId('cutout-panel-trigger');
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('aria-label')).toBe('抠图参数');
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
  });

  it('展开后四块色板与关闭键都是真 <button>（Tab 逐站能走到）', () => {
    render(<CutoutParamsPanel absPath={ABS} />);
    const panel = openPanel();
    expect(panel.getAttribute('role')).toBe('dialog');
    // 关闭 1 颗 + 四块底色；换成 div+onClick 的话这里就是 1
    const buttons = within(panel).getAllByRole('button');
    expect(buttons).toHaveLength(5);
    for (const b of buttons) expect(b.tabIndex).toBe(0);
    expect(within(panel).queryAllByRole('radio')).toHaveLength(0); // 不是单选框那套形状
    const labels = ['底色：透明', '底色：白', '底色：蓝', '底色：红'];
    for (const label of labels) expect(within(panel).getByLabelText(label)).toBeTruthy();
  });

  it('面板默认是收起的，不做 hover 展开', () => {
    render(<CutoutParamsPanel absPath={ABS} />);
    expect(screen.queryByTestId('cutout-panel')).toBeNull();
    fireEvent.mouseEnter(screen.getByTestId('cutout-panel-trigger'));
    expect(screen.queryByTestId('cutout-panel')).toBeNull();
  });
});

describe('CutoutParamsPanel —— 底色流转', () => {
  it('选「白」：写进 store 并带进 aiRun 载荷，面板不许消失', async () => {
    render(<CutoutParamsPanel absPath={ABS} />);
    const panel = openPanel();
    fireEvent.click(within(panel).getByLabelText('底色：白'));

    expect(useAiStore.getState().bgcolor).toBe('white');
    // setBgColor 内部先 await 清单再发 aiRun，这条要等异步链落地
    await waitFor(() => expect(api.aiRun).toHaveBeenCalledTimes(1));
    expect(api.aiRun.mock.calls[0][0]).toMatchObject({
      absPath: ABS,
      capabilityId: 'portrait-cutout',
      cutout: { bgcolor: 'white' }
    });
    // 同一张图重跑不能把结果清空：否则用户选完一个颜色就找不到第二个的入口
    expect(screen.getByTestId('cutout-panel')).toBeTruthy();
    expect(within(screen.getByTestId('cutout-panel')).getByLabelText('底色：白').getAttribute('aria-pressed')).toBe('true');
  });

  it('没有结果可依据时不发起处理（面板此时也不出现）', async () => {
    useAiStore.setState({ result: null });
    await useAiStore.getState().setBgColor('blue');
    expect(api.aiRun).not.toHaveBeenCalled();
    expect(useAiStore.getState().bgcolor).toBe('blue');
  });

  it('面板必须写明"这是预览，还没保存"（§3-3 派生文件红线）', () => {
    render(<CutoutParamsPanel absPath={ABS} />);
    const panel = openPanel();
    expect(within(panel).getByTestId('cutout-panel-note').textContent).toContain('还没保存');
  });

  it('掩码尺寸那句取自结果，不在界面写死数字（红线 2）', () => {
    render(<CutoutParamsPanel absPath={ABS} />);
    const panel = openPanel();
    expect(within(panel).getByTestId('cutout-panel-status').textContent).toContain('320×160');
    act(() => useAiStore.setState({ result: done({ maskWidth: 512, maskHeight: 512 }) }));
    expect(within(screen.getByTestId('cutout-panel')).getByTestId('cutout-panel-status').textContent).toContain('512×512');
  });
});

describe('CutoutParamsPanel —— Esc 只退一层 + 不抢宿主手势', () => {
  it('Esc 关掉面板，且事件不冒泡到窗口（预览不许一起被关掉）', () => {
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    try {
      render(<CutoutParamsPanel absPath={ABS} />);
      const panel = openPanel();
      fireEvent.keyDown(panel, { key: 'Escape' });
      expect(screen.queryByTestId('cutout-panel')).toBeNull();
      expect(onWindowKey).not.toHaveBeenCalled();
      // 对照组：同一个事件从面板外面打进来时必须冒泡到窗口，否则上面那条是假断言
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(onWindowKey).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', onWindowKey);
    }
  });

  it('Esc 关掉的只是面板，收起后触发按钮仍在', () => {
    render(<CutoutParamsPanel absPath={ABS} />);
    const panel = openPanel();
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(screen.getByTestId('cutout-panel-trigger')).toBeTruthy();
  });

  it('点关闭键同样收起', () => {
    render(<CutoutParamsPanel absPath={ABS} />);
    const panel = openPanel();
    fireEvent.click(within(panel).getByTestId('cutout-panel-close'));
    expect(screen.queryByTestId('cutout-panel')).toBeNull();
  });

  it('面板上的按住与双击不许冒到大图区（否则会闪一下原图 / 误复位缩放）', () => {
    const host = vi.fn();
    const { container } = render(
      <div data-testid="fake-stage" onMouseDown={host} onDoubleClick={host}>
        <CutoutParamsPanel absPath={ABS} />
      </div>
    );
    const trigger = screen.getByTestId('cutout-panel-trigger');
    fireEvent.mouseDown(trigger);
    fireEvent.doubleClick(trigger);
    expect(host).not.toHaveBeenCalled();

    const panel = openPanel();
    fireEvent.mouseDown(within(panel).getByLabelText('底色：白'));
    fireEvent.doubleClick(within(panel).getByTestId('cutout-panel-close'));
    expect(container).toBeTruthy();
    expect(host).not.toHaveBeenCalled();
  });
});
