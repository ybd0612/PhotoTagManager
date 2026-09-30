// @vitest-environment jsdom
// T11 · useAiStore + 组合按钮「抠图 ▾」。
// 盯三条硬约束：主按钮语义恒定不置灰、进行中用背景进度 + 可取消、下拉必须可键盘导航。
// 只用原生 DOM 断言：项目没装 @testing-library/jest-dom，不为此加依赖。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within, act, waitFor } from '@testing-library/react';

import { AiActionSplitButton } from '../../src/components/AiActionSplitButton';
import { useAiStore, describeDownloadCost } from '../../src/store/useAiStore';
import type { AiCapabilityView, AiCatalogResult, AiDonePayload, AiErrorPayload, AiPhase } from '../../shared/types';

/** IPC 一律走 IpcResult 信封；mock 必须包一层才过得了 src/api.ts 的 call() */
function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

const baseCap: AiCapabilityView = {
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
};

const catalogFixture: AiCatalogResult = { capabilities: [baseCap] };

function capWith(
  patch: Partial<AiCapabilityView> = {},
  modelPatch: Partial<AiCapabilityView['models'][number]> = {}
): AiCapabilityView {
  return { ...baseCap, ...patch, models: [{ ...baseCap.models[0], ...modelPatch }] };
}

/** 场景靠改清单构造，不靠 mock 时序 */
function seedCatalog(cap: AiCapabilityView): void {
  useAiStore.setState({
    catalog: { capabilities: [cap] },
    task: null,
    result: null,
    error: null,
    pendingConfirm: null,
    backend: 'dml'
  });
}

/**
 * store 的事件订阅只在第一次 init() 时建立（模块级去重），所以这三个回调引用
 * 必须跨用例存活——不能在 beforeEach 里 mockReset 它们，否则后续用例拿到 null，
 * 表现为"事件像被吞了"的假失败。
 */
const listeners: {
  progress: ((p: { taskId: string; phase: AiPhase; percent?: number }) => void) | null;
  done: ((p: AiDonePayload) => void) | null;
  error: ((e: AiErrorPayload) => void) | null;
} = { progress: null, done: null, error: null };

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
  onAiProgress: vi.fn((cb: (typeof listeners)['progress']) => {
    listeners.progress = cb;
    return () => undefined;
  }),
  onAiDone: vi.fn((cb: (typeof listeners)['done']) => {
    listeners.done = cb;
    return () => undefined;
  }),
  onAiError: vi.fn((cb: (typeof listeners)['error']) => {
    listeners.error = cb;
    return () => undefined;
  })
};

function fireDone(payload: Partial<AiDonePayload> = {}): void {
  listeners.done?.({
    taskId: 'ai-1',
    tempPath: 'C:/userData/ai-preview/aaaa.png',
    sourceAbsPath: 'C:/photos/a.jpg',
    cacheHit: false,
    didApplySigmoid: false,
    maskWidth: 320,
    maskHeight: 320,
    capabilityId: 'portrait-cutout',
    modelId: 'u2netp',
    actionTag: 'AI人像抠图',
    ...payload
  });
}

beforeEach(async () => {
  vi.stubGlobal('api', api);
  // 假清单必须忠实：aiCatalog 每次返回"当前那份"，等价于服务端状态未变时重取拿到同样数据。
  // 写死 catalogFixture 的话，下拉一打开就重取清单，把用例刚 seed 的场景刷回默认，
  // 表现为"第二行模型不见了"的假失败（假件自己不忠实，不是被测代码错）
  api.aiCatalog.mockReset().mockImplementation(async () => ok(useAiStore.getState().catalog ?? catalogFixture));
  api.aiRun.mockReset().mockResolvedValue(ok({ taskId: 'ai-1' }));
  api.aiCancel.mockReset().mockResolvedValue(ok(true));
  api.aiSave.mockReset().mockResolvedValue(ok({ savedPath: 'C:/p/a.cutout.png', targetName: 'a.cutout.png', renamed: false, tagsWritten: [] }));
  api.aiModelDownload.mockReset().mockResolvedValue(ok({ modelId: 'u2netp', status: 'present' }));
  api.aiModelDelete.mockReset().mockResolvedValue(ok({ modelId: 'u2netp', status: 'absent' }));
  api.aiModelUnload.mockReset().mockResolvedValue(ok({ modelId: 'u2netp', status: 'present' }));
  api.aiModelSetDefault.mockReset().mockResolvedValue(ok(catalogFixture));
  useAiStore.setState({
    catalog: null,
    task: null,
    result: null,
    error: null,
    pendingConfirm: null,
    backend: 'dml'
  });
  // 先订阅事件再拉清单：每条用例都从"清单已加载 + 事件已接上"出发
  useAiStore.getState().init();
  await useAiStore.getState().ensureCatalog();
});

describe('ai/useAiStore —— 状态机', () => {
  it('init 拉清单并订阅三个事件', () => {
    expect(api.aiCatalog).toHaveBeenCalled();
    expect(listeners.progress).toBeTypeOf('function');
    expect(listeners.done).toBeTypeOf('function');
    expect(listeners.error).toBeTypeOf('function');
  });

  it('④ 未实测跑通的行为与模型根本不进 store（不是灰着显示）', () => {
    seedCatalog(capWith({ id: 'general-cutout', label: '通用抠图' }, { id: 'birefnet', verified: false }));
    expect(useAiStore.getState().usableCapabilities()).toEqual([]);

    // 混合：行为可见，但未验证的模型被摘掉
    seedCatalog({ ...baseCap, models: [baseCap.models[0], { ...baseCap.models[0], id: 'birefnet', verified: false }] });
    const caps = useAiStore.getState().usableCapabilities();
    expect(caps.map((c) => c.id)).toEqual(['portrait-cutout']);
    expect(caps[0].models.map((m) => m.id)).toEqual(['u2netp']);
  });

  it('① 主按钮文案恒定：跑之前、跑之中、跑完之后 label 都不变', async () => {
    expect(useAiStore.getState().primaryLabel()).toBe('抠图');
    await useAiStore.getState().startRun('C:/photos/a.jpg');
    expect(useAiStore.getState().primaryLabel()).toBe('抠图');
    fireDone();
    expect(useAiStore.getState().primaryLabel()).toBe('抠图');
  });

  it('③ 进度事件按阶段推进，percent 供背景填充', async () => {
    await useAiStore.getState().startRun('C:/photos/a.jpg');
    listeners.progress?.({ taskId: 'ai-1', phase: 'load' });
    expect(useAiStore.getState().task?.phase).toBe('load');
    listeners.progress?.({ taskId: 'ai-1', phase: 'download', percent: 42 });
    expect(useAiStore.getState().task?.percent).toBe(42);
  });

  it('忽略不属于当前任务的进度推送（旧任务的尾巴不能污染新任务）', async () => {
    await useAiStore.getState().startRun('C:/photos/a.jpg');
    listeners.progress?.({ taskId: 'ai-999', phase: 'encode', percent: 88 });
    expect(useAiStore.getState().task?.percent).toBe(0);
  });

  it('done 事件写入结果并清空进行中标记', async () => {
    await useAiStore.getState().startRun('C:/photos/a.jpg');
    fireDone({ cacheHit: true });
    const s = useAiStore.getState();
    expect(s.task).toBeNull();
    expect(s.result?.cacheHit).toBe(true);
  });

  // 实测缺陷（2026-09-30 CDP 取证抓到）：推理成功后 runner 里模型已驻留，
  // 但清单不刷新 → 行内"已加载"永远显示不出来，用户看不出谁在内存里。
  it('成功事件也要顺手刷新清单，否则「已加载」这个状态在界面上永远出不来', async () => {
    api.aiCatalog.mockClear();
    await useAiStore.getState().startRun('C:/photos/a.jpg');
    fireDone({ cacheHit: false });
    await vi.waitFor(() => expect(api.aiCatalog).toHaveBeenCalled());
  });

  it('error 事件保留错误上下文，让界面能解释而不是变灰', async () => {
    await useAiStore.getState().startRun('C:/photos/a.jpg');
    listeners.error?.({ taskId: 'ai-1', code: 'MODEL_NOT_VERIFIED', message: '该模型在本引擎不支持' });
    const s = useAiStore.getState();
    expect(s.error?.code).toBe('MODEL_NOT_VERIFIED');
    expect(s.task).toBeNull();
  });

  // 上面那条只断言"store 里留着错误"，抓不到下面这个真缺陷：
  // 错误条上那颗「卸载已加载的模型」判据读的是 catalog 里的 loaded，
  // 而推理崩时模型往往已经驻留——失败后不刷新清单，按钮就永远不出现（真机验证时露馅）
  it('失败事件要顺手刷新清单，否则那颗「卸载已加载的模型」永远不出现', async () => {
    api.aiCatalog.mockClear();
    await useAiStore.getState().startRun('C:/photos/a.jpg');
    listeners.error?.({ taskId: 'ai-1', code: 'GPU_MEMORY_LOW', message: '显存不够，没能完成这次处理。' });
    await vi.waitFor(() => expect(api.aiCatalog).toHaveBeenCalled());
  });

  it('⑤ 模型未下载时先要代价确认，取消则完全不发请求', async () => {
    seedCatalog(capWith({}, { status: 'absent' }));
    await useAiStore.getState().requestRun('C:/photos/a.jpg');
    expect(useAiStore.getState().pendingConfirm).toMatchObject({ absPath: 'C:/photos/a.jpg' });
    expect(api.aiRun).not.toHaveBeenCalled();
    useAiStore.getState().dismissConfirm();
    expect(useAiStore.getState().pendingConfirm).toBeNull();
    expect(api.aiRun).not.toHaveBeenCalled();
  });

  it('⑤ 确认后带 downloadApproved 再发，且不需要第二次点击', async () => {
    seedCatalog(capWith({}, { status: 'absent' }));
    await useAiStore.getState().requestRun('C:/photos/a.jpg');
    await useAiStore.getState().approveDownload();
    expect(api.aiRun).toHaveBeenCalledWith(
      expect.objectContaining({ absPath: 'C:/photos/a.jpg', downloadApproved: true })
    );
  });

  it('模型已就位时不问，直接跑', async () => {
    await useAiStore.getState().requestRun('C:/photos/a.jpg');
    expect(useAiStore.getState().pendingConfirm).toBeNull();
    expect(api.aiRun).toHaveBeenCalledTimes(1);
  });

  it('② 取消进行中的任务：调 aiCancel 并清状态', async () => {
    await useAiStore.getState().startRun('C:/photos/a.jpg');
    await useAiStore.getState().cancelRun();
    expect(api.aiCancel).toHaveBeenCalledWith('ai-1');
    expect(useAiStore.getState().task).toBeNull();
  });

  it('保存成功后清空结果，避免同一 taskId 被重复保存', async () => {
    fireDone();
    await useAiStore.getState().saveResult();
    expect(api.aiSave).toHaveBeenCalledWith('ai-1');
    expect(useAiStore.getState().result).toBeNull();
  });

  it('§8-16 默认按 GPU 发请求；用户显式勾选 CPU 后每次请求都带着它', async () => {
    await useAiStore.getState().startRun('C:/photos/a.jpg');
    expect(api.aiRun).toHaveBeenLastCalledWith(expect.objectContaining({ backend: 'dml' }));
    useAiStore.getState().setBackend('cpu');
    await useAiStore.getState().startRun('C:/photos/b.jpg');
    expect(api.aiRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ absPath: 'C:/photos/b.jpg', backend: 'cpu' })
    );
  });

  it('§8-16 首次下载的代价确认走完之后仍带着 CPU 选择，不因弹窗丢失', async () => {
    seedCatalog(capWith({}, { status: 'absent' }));
    useAiStore.getState().setBackend('cpu');
    await useAiStore.getState().requestRun('C:/photos/a.jpg');
    await useAiStore.getState().approveDownload();
    expect(api.aiRun).toHaveBeenCalledWith(expect.objectContaining({ downloadApproved: true, backend: 'cpu' }));
  });

  it('代价文案用实测速率算粗估，且只有这一处一次性询问，不做实时剩余时间外推', () => {
    const text = describeDownloadCost(4_574_861);
    expect(text).toContain('4.4MB');
    expect(text).toMatch(/约 \d+ 秒/);
  });
});

describe('AiActionSplitButton —— 组合按钮', () => {
  it('① 主按钮文案取自清单，恒定显示「抠图」', () => {
    render(<AiActionSplitButton absPath="C:/photos/a.jpg" />);
    expect(screen.getByRole('button', { name: /^抠图$/ }).textContent).toContain('抠图');
  });

  it('② 进行中不置灰：主按钮仍可点，进度用背景填充 + 另有「取消」', async () => {
    render(<AiActionSplitButton absPath="C:/photos/a.jpg" />);
    await act(async () => {
      await useAiStore.getState().startRun('C:/photos/a.jpg');
      listeners.progress?.({ taskId: 'ai-1', phase: 'infer', percent: 60 });
    });
    const primary = screen.getByRole('button', { name: /^抠图$/ }) as HTMLButtonElement;
    // 置灰会让用户以为程序坏了；进行中必须仍可点
    expect(primary.disabled).toBe(false);
    expect(primary.className).not.toMatch(/Mui-disabled/);
    expect(primary.getAttribute('aria-valuenow')).toBe('60');
    expect(screen.getByRole('button', { name: /取消/ })).toBeTruthy();
  });

  it('③ 下拉可纯键盘操作：打开即落在选中行、方向键换行、回车选中该行', async () => {
    seedCatalog({
      ...baseCap,
      models: [
        baseCap.models[0],
        { ...baseCap.models[0], id: 'birefnet', displayName: 'BiRefNet', isDefault: false }
      ]
    });
    render(<AiActionSplitButton absPath="C:/photos/a.jpg" />);
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }));
    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items).toHaveLength(2);
    // 只让当前行可被 Tab 落到，其余靠方向键换行
    expect(items[0].getAttribute('tabindex')).toBe('0');
    expect(items[1].getAttribute('tabindex')).toBe('-1');
    // 焦点在下一帧落位（Modal 挂载时自己会动一次焦点）
    await waitFor(() => expect(document.activeElement).toBe(items[0]));

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(items[1]));
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    await waitFor(() => expect(document.activeElement).toBe(items[0]));

    // 回车 = 选中当前行（与鼠标点整行同义），执行的是 set-default 而不是行内主动作
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(items[1]));
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(api.aiModelSetDefault).toHaveBeenCalledWith('portrait-cutout', 'birefnet');
    expect(api.aiModelDelete).not.toHaveBeenCalled();
  });

  it('每行只有一个主动作：未加载的行不给「卸载」（点了只会拿到"该模型未加载，无需卸载"）', () => {
    seedCatalog({
      ...baseCap,
      models: [
        { ...baseCap.models[0], loaded: true },
        { ...baseCap.models[0], id: 'modnet', displayName: 'MODNet', isDefault: false }
      ]
    });
    render(<AiActionSplitButton absPath="C:/photos/a.jpg" />);
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }));
    const items = within(screen.getByRole('menu')).getAllByRole('menuitemradio');
    // 状态与动作必须自洽：写"已加载"的给卸载，写"已下载"的给删除
    expect(items[0].textContent).toContain('已加载');
    expect(within(items[0]).getByRole('button', { name: '卸载' })).toBeTruthy();
    expect(items[1].textContent).toContain('已下载');
    expect(within(items[1]).queryByRole('button', { name: '卸载' })).toBeNull();
    expect(within(items[1]).getByRole('button', { name: '删除' })).toBeTruthy();
    // 状态还得看得出差别：只有驻留那行给实心绿标签（纯灰文本肉眼分不出"已加载/已下载"）
    const chipOf = (li: Element) => li.querySelector('[data-testid="model-status"]')?.className ?? '';
    expect(chipOf(items[0])).toContain('MuiChip-colorSuccess');
    expect(chipOf(items[1])).not.toContain('MuiChip-colorSuccess');
  });

  it('整行即选项：点未选中那行就换默认，行内不再有复选框', () => {
    seedCatalog({
      ...baseCap,
      models: [
        baseCap.models[0],
        { ...baseCap.models[0], id: 'modnet', displayName: 'MODNet', isDefault: false }
      ]
    });
    render(<AiActionSplitButton absPath="C:/photos/a.jpg" />);
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }));
    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitemradio');
    // 可见控件撤掉了，单选语义必须还在（读屏软件要能说出哪行是当前模型）
    expect(items[0].getAttribute('aria-checked')).toBe('true');
    expect(items[1].getAttribute('aria-checked')).toBe('false');
    // 菜单里不该再有任何复选框（CPU 那颗在 ul 之外，不在本判据范围内）
    expect(within(menu).queryAllByRole('checkbox')).toHaveLength(0);
    expect(items[0].textContent).not.toContain('· 默认');

    fireEvent.click(items[1]);
    expect(api.aiModelSetDefault).toHaveBeenCalledWith('portrait-cutout', 'modnet');
    // 点已选中的那行不动作：没有"无默认模型"这个状态
    api.aiModelSetDefault.mockClear();
    fireEvent.click(items[0]);
    expect(api.aiModelSetDefault).not.toHaveBeenCalled();
  });

  it('下拉打开时焦点落在默认模型那一行（高亮与焦点不能分家）', async () => {
    seedCatalog({
      ...baseCap,
      models: [
        { ...baseCap.models[0], isDefault: false },
        { ...baseCap.models[0], id: 'modnet', displayName: 'MODNet', isDefault: true }
      ]
    });
    render(<AiActionSplitButton absPath="C:/photos/a.jpg" />);
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }));
    const items = within(screen.getByRole('menu')).getAllByRole('menuitemradio');
    await waitFor(() => expect(document.activeElement).toBe(items[1]));
  });

  it('③ 未下载的模型：行内「下载」按钮执行下载', () => {
    seedCatalog(capWith({}, { status: 'absent' }));
    render(<AiActionSplitButton absPath="C:/photos/a.jpg" />);
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }));
    fireEvent.click(screen.getByRole('button', { name: '下载' }));
    expect(api.aiModelDownload).toHaveBeenCalledWith('u2netp');
  });

  it('点行内动作按钮不能顺手换默认（动作与选中是两件事）', () => {
    seedCatalog({
      ...baseCap,
      models: [
        baseCap.models[0],
        { ...baseCap.models[0], id: 'modnet', displayName: 'MODNet', isDefault: false }
      ]
    });
    render(<AiActionSplitButton absPath="C:/photos/a.jpg" />);
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }));
    const btn = within(screen.getByRole('menu')).getAllByRole('menuitemradio')[1].querySelector('button') as HTMLButtonElement;
    // 键盘可达：没被 tabindex=-1 摘出 Tab 序列（整行改成"点即选中"后，主动作只剩这条路）
    expect(btn.getAttribute('tabindex')).not.toBe('-1');
    fireEvent.click(btn);
    expect(api.aiModelDelete).toHaveBeenCalledWith('modnet');
    expect(api.aiModelSetDefault).not.toHaveBeenCalled();
  });

  it('③ Escape 关闭下拉并把焦点还给触发按钮', () => {
    render(<AiActionSplitButton absPath="C:/photos/a.jpg" />);
    const trigger = screen.getByRole('button', { name: /选择模型/ });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.queryByRole('menu')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('菜单不得挂在预览层深色容器内：那里 color:white，白底菜单会变成白底白字（实测缺陷）', () => {
    const { container } = render(
      <div data-testid="dark-overlay" style={{ color: '#ffffff' }}>
        <AiActionSplitButton absPath="C:/photos/a.jpg" />
      </div>
    );
    const overlay = screen.getByTestId('dark-overlay');
    expect(within(overlay).getByRole('button', { name: /选择模型/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }));
    const menu = screen.getByRole('menu');
    // 挂在深色容器里 = 继承 color:white；渲染到 Portal 才拿得到主题默认文字色
    expect(overlay.contains(menu)).toBe(false);
    expect(container.contains(menu)).toBe(false);
    // 模型行的可见文字也不能继承到白色
    const row = within(menu).getAllByRole('menuitemradio')[0];
    expect(overlay.contains(row)).toBe(false);
    expect(row.textContent).toContain('U²-Netp');
  });

  it('打开下拉要重取清单：驻留是主进程快照，空闲自动卸载不会推给渲染层', async () => {
    render(<AiActionSplitButton absPath="C:/photos/a.jpg" />);
    api.aiCatalog.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }));
    await waitFor(() => expect(api.aiCatalog).toHaveBeenCalled());
  });

  it('hover 不承载动作：悬停不出现浮层，按钮数恒定两个', () => {
    render(<AiActionSplitButton absPath="C:/photos/a.jpg" />);
    const wrap = screen.getByTestId('ai-split-button');
    fireEvent.mouseEnter(wrap);
    fireEvent.mouseOver(wrap);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(within(wrap).queryAllByRole('button')).toHaveLength(2);
  });

  it('§8-16 下拉里的 CPU 开关可点可达，勾选后界面常驻说明代价', () => {
    render(<AiActionSplitButton absPath="C:/photos/a.jpg" />);
    expect(screen.queryByTestId('ai-backend-notice')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }));

    const toggle = screen.getByRole('checkbox', { name: /CPU/ });
    fireEvent.click(toggle);
    expect(useAiStore.getState().backend).toBe('cpu');
    const notice = screen.getByTestId('ai-backend-notice');
    expect(notice.textContent).toMatch(/CPU/);
    expect(notice.textContent).toMatch(/慢/);

    // 提示必须跟着实际后端走：关掉就消失，不能常驻当装饰文案
    fireEvent.click(screen.getByRole('checkbox', { name: /CPU/ }));
    expect(useAiStore.getState().backend).toBe('dml');
    expect(screen.queryByTestId('ai-backend-notice')).toBeNull();
  });

  it('§8-16 CPU 模式下主按钮语义恒定仍是「抠图」，且点它发的是 CPU 请求（D13）', async () => {
    render(<AiActionSplitButton absPath="C:/photos/a.jpg" />);
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /CPU/ }));
    expect(screen.getByTestId('ai-backend-notice')).toBeTruthy();
    // 菜单是模态浮层（开着时应用容器被标 aria-hidden），关掉再操作主按钮
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    const primary = screen.getByRole('button', { name: /^抠图$/ }) as HTMLButtonElement;
    expect(primary.disabled).toBe(false);
    expect(primary.textContent).toContain('抠图');
    expect(primary.textContent).not.toMatch(/CPU/);
    await act(async () => {
      fireEvent.click(primary);
    });
    expect(api.aiRun).toHaveBeenCalledWith(expect.objectContaining({ backend: 'cpu' }));
  });

  it('⑤ 首次运行弹代价确认，取消则不发请求', async () => {
    seedCatalog(capWith({}, { status: 'absent' }));
    render(<AiActionSplitButton absPath="C:/photos/a.jpg" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^抠图$/ }));
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('4.4MB');
    expect(dialog.textContent).toMatch(/约 \d+ 秒/);
    expect(api.aiRun).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: /取消/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.aiRun).not.toHaveBeenCalled();
  });

  it('只渲染 verified 的条目：未实测的行为在组件里根本不出现', () => {
    seedCatalog(capWith({ id: 'general-cutout', label: '通用抠图' }, { id: 'birefnet', verified: false }));
    render(<AiActionSplitButton absPath="C:/photos/a.jpg" />);
    expect(screen.queryByRole('button', { name: /^通用抠图$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^抠图$/ })).toBeNull();
  });

  it('布局按可扩展做：超过 5 个行为时后面的收进「更多」', () => {
    useAiStore.setState({
      catalog: {
        capabilities: Array.from({ length: 6 }, (_, i) => ({ ...baseCap, id: `cap-${i}`, label: `行为${i}` }))
      }
    });
    render(<AiActionSplitButton absPath="C:/photos/a.jpg" />);
    expect(screen.getByRole('button', { name: /更多/ })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^行为\d$/ })).toHaveLength(5);
    expect(screen.queryByRole('button', { name: '行为5' })).toBeNull();
  });
});
