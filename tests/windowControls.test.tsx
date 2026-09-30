// @vitest-environment jsdom
// 自绘窗口控件的行为：三个按钮各自打到对应通道，最大化状态要真的把图标与无障碍名带过去。
// 后者是这条链唯一容易断的地方——双击标题栏、Win+↑、点任务栏都能改变窗口状态而不经过本组件。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import { WindowControls } from '../src/components/WindowControls';

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
});
