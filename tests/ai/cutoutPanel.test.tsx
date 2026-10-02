// @vitest-environment jsdom
// 抠图参数面板（方案 §3 / §8-4）：它是详情页预览层的浮层，不属于设置页——
// 所以本文件测的是"面板自身"，不去动 aiSettings.test.tsx 里那条零输入控件的断言。
// 钉三件能被改坏的事：① 控件必须是真按钮（键盘 Tab 得到，不是 hover 才出现）；
// ② 一次 Esc 只退一层（关面板，不许把整个预览关掉）；③ 选完底色面板不许消失。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor, act } from '@testing-library/react';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

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

// 结构绊线（照 tests/structuralPins.test.ts 的写法）：下面这几条在真机上"看不见"——
// 面板挪进底栏只是照片矮了 40 px、设置页摆个参数控件只是那天你恰好没打开设置页。
// 不钉死就会静默复发（判据 5 / 红线 1 / 红线 2）。
describe('CutoutParamsPanel —— 结构绊线', () => {
  const root = process.cwd();
  const read = (p: string) => readFileSync(join(root, p), 'utf8');
  const overlaySrc = read(join('src', 'components', 'PreviewOverlay.tsx'));
  const panelSrc = read(join('src', 'components', 'CutoutParamsPanel.tsx'));

  it('面板挂在 preview-stage 之内、底栏之前（§8-5：展开不吃大图高度）', () => {
    // 上界取大图区自己的收尾 </Box>（从图内的缩放读数之后找），不能取"错误条之前"——
    // 实测那样写会把"面板被挪出大图区、成了外层 Box 的子项"这种真回归判成通过
    const stage = overlaySrc.indexOf('data-testid="preview-stage"');
    const panel = overlaySrc.indexOf('<CutoutParamsPanel');
    const badge = overlaySrc.indexOf('preview-zoom-badge');
    const stageEnd = badge === -1 ? -1 : overlaySrc.indexOf('</Box>', badge);
    expect(stage).toBeGreaterThan(-1);
    expect(badge).toBeGreaterThan(stage);
    expect(stageEnd).toBeGreaterThan(badge); // 锚点失效时这条先红，而不是让下面两条空转
    expect(panel).toBeGreaterThan(stage);
    expect(panel).toBeLessThan(stageEnd);
  });

  it('组件自己声明 absolute 浮层（挪掉这行就红）', () => {
    // 判据 5 由两条一起钉：这条钉"自己声明浮层"，上面那条钉"它挂在大图区里而不是底栏"。
    // 不去禁 flex 相关写法——面板内部的标题行本来就在用它排版，那类断言永不失败。
    expect(panelSrc).toMatch(/position:\s*'absolute'/);
  });

  it('抠图参数不进设置页（红线 1）', () => {
    const dir = join(root, 'src', 'components', 'settings');
    const files = readdirSync(dir);
    expect(files.length).toBeGreaterThan(0); // 一个文件都没扫到就是这条在空转
    for (const f of files) expect(read(`src/components/settings/${f}`)).not.toContain('CutoutParamsPanel');
  });

  it('aiSettings 那条"设置分区零输入控件"断言未被削弱', () => {
    const line = read(join('tests', 'ai', 'aiSettings.test.tsx'))
      .split('\n')
      .find((l) => l.includes('input:not([type=range])'));
    expect(line).toBeDefined();
    expect(line).toMatch(/toHaveLength\(0\)/);
  });

  it('面板源码不写死模型形状（红线 2：320 / 512 只允许出现在清单里）', () => {
    expect(panelSrc).not.toMatch(/\b(320|512)\b/);
    expect(panelSrc).toContain('result.maskWidth'); // 尺寸一律从结果里读
  });
});
