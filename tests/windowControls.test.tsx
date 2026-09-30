// @vitest-environment jsdom
// 自绘窗口控件的行为：三个按钮各自打到对应通道，最大化状态要真的把图标与无障碍名带过去。
// 后者是这条链唯一容易断的地方——双击标题栏、Win+↑、点任务栏都能改变窗口状态而不经过本组件。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import { WindowControls } from '../src/components/WindowControls';
import { useAppStore } from '../src/store/useAppStore';

function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

const api = {
  windowMinimize: vi.fn(async () => ok(undefined)),
  windowToggleMaximize: vi.fn(async () => ok(undefined)),
  windowClose: vi.fn(async () => ok(undefined)),
  isWindowMaximized: vi.fn(async () => ok(false)),
  onWindowMaximized: vi.fn(() => () => undefined)
};

beforeEach(() => {
  vi.stubGlobal('api', api);
  api.windowMinimize.mockClear();
  api.windowToggleMaximize.mockClear();
  api.windowClose.mockClear();
  api.isWindowMaximized.mockReset().mockResolvedValue(ok(false));
  api.onWindowMaximized.mockReset().mockImplementation(() => () => undefined);
});

describe('自绘窗口控件', () => {
  it('三个按钮分别触发最小化 / 切换最大化 / 关闭', () => {
    render(<WindowControls />);
    fireEvent.click(screen.getByRole('button', { name: '最小化' }));
    fireEvent.click(screen.getByRole('button', { name: '最大化窗口' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }));
    expect(api.windowMinimize).toHaveBeenCalledTimes(1);
    expect(api.windowToggleMaximize).toHaveBeenCalledTimes(1);
    expect(api.windowClose).toHaveBeenCalledTimes(1);
  });

  it('关闭走的是主进程的 close（要经过"非退出即藏进托盘"那段），不是渲染层自己 unmount', () => {
    render(<WindowControls />);
    fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }));
    expect(api.windowClose).toHaveBeenCalledTimes(1);
  });

  it('初值是最大化时，中间那颗报"还原窗口"', async () => {
    api.isWindowMaximized.mockResolvedValue(ok(true));
    render(<WindowControls />);
    await waitFor(() => expect(screen.getByRole('button', { name: '还原窗口' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: '最大化窗口' })).toBeNull();
  });

  it('窗口状态被外部改掉（双击标题栏 / Win+↑）时，图标跟着订阅换', () => {
    let listener: ((maximized: boolean) => void) | undefined;
    api.onWindowMaximized.mockImplementation((cb: (maximized: boolean) => void) => {
      listener = cb;
      return () => undefined;
    });
    render(<WindowControls />);
    expect(screen.getByRole('button', { name: '最大化窗口' })).toBeTruthy();

    // 主进程推来"已最大化"——组件自己没有点过任何按钮
    act(() => listener?.(true));
    expect(screen.getByRole('button', { name: '还原窗口' })).toBeTruthy();
  });

  /**
   * 预览打开时三颗让位。起因（2026-09-30）：为了让预览盖住它们，把预览覆盖层的
   * z-index 抬到 1800，结果连预览自己弹出的下拉、对话框和右键菜单一起被压住
   * ——那些是 portal 挂 body、按 MUI 模态带 1300 画的。盖不住就用显式隐藏，别抬层。
   */
  it('预览开着时三颗让位，关掉预览又回来', () => {
    useAppStore.setState({ preview: { image: {} as never, index: 0, list: [] as never[] } });
    render(<WindowControls />);
    expect(screen.queryByTestId('window-controls'), '预览开着还浮着三颗').toBeNull();

    act(() => useAppStore.setState({ preview: null }));
    expect(screen.getByTestId('window-controls'), '关掉预览后三颗没回来').toBeTruthy();
  });

  /**
   * 预览覆盖层必须自己声明"我不是标题栏"。起因（2026-09-30）：主顶栏 `.ptm-titlebar` 是
   * `-webkit-app-region: drag`，登记了一条横跨窗口顶部 0..44px 的拖拽带；预览覆盖层画在它上面
   * （z-index 1300）却没声明 no-drag，而**层级高不等于能命中——拖拽带是按像素登记的**，
   * 于是落在带里的点击被当成"拖动窗口"吞掉。实测：「上一张」中心 x=31 在带里，点不动；
   * 「下一张」中心 x=1118 恰好压在主顶栏「设置」那颗 no-drag 洞（x 1087.7..1126）上才侥幸能动。
   * jsdom 量不到 OS 命中层，这条只能钉源码；真判据是一次真实鼠标点击（改完在活窗口上读
   * computed `-webkit-app-region` 确认属性真落到了元素上）。
   */
  it('预览覆盖层显式 app-region: no-drag，否则主顶栏的拖拽带会吞掉它顶栏里的按钮', () => {
    const src = readFileSync(join('src', 'components', 'PreviewOverlay.tsx'), 'utf8');
    expect(src).toMatch(/WebkitAppRegion:\s*'no-drag'/);
  });
});
