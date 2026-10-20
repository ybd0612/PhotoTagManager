import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcResult } from '../shared/types';

/**
 * file:trash 的契约测试：这条通道能删用户的文件，所以最该被钉住的是"越界的必须被拒绝、
 * 且拒绝时根本不碰 shell"，以及"部分失败要逐条给原因、不许静默"。
 */
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<IpcResult<unknown>>>();
// vi.mock 会被提升到文件顶部，替身必须用 vi.hoisted 才在工厂执行前就位
const { trashItem } = vi.hoisted(() => ({ trashItem: vi.fn(async () => undefined) }));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<IpcResult<unknown>>) => {
      handlers.set(channel, fn);
    }
  },
  app: { getPath: () => '/tmp/userData', getVersion: () => '0.1.3' },
  clipboard: { writeBuffer: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn(), trashItem }
}));

import { registerIpc } from '../electron/ipc';

registerIpc({
  roots: { list: async () => [{ id: 'r1', path: 'C:/Photos', alias: 'Photos', addedAt: 0 }] },
  getWindow: () => ({ webContents: { send: () => undefined }, isDestroyed: () => false })
} as never);

interface TrashResultLike {
  trashed: string[];
  failed: Array<{ absPath: string; reason: string }>;
}

async function trash(paths: string[]): Promise<TrashResultLike> {
  const result = await handlers.get('file:trash')!(null, paths);
  if (!result.ok) throw new Error(`信封不对：${JSON.stringify(result)}`);
  return result.data as TrashResultLike;
}

beforeEach(() => {
  trashItem.mockReset().mockResolvedValue(undefined);
});

describe('ipc file:trash —— 移到回收站', () => {
  it('根目录内的路径放行，并逐条交给 shell.trashItem', async () => {
    const result = await trash(['C:/Photos/a.jpg', 'C:\\PHOTOS\\sub\\b.jpg']);
    expect(trashItem).toHaveBeenCalledTimes(2);
    expect(result.trashed).toHaveLength(2);
    expect(result.failed).toEqual([]);
  });

  it('根外的路径一律拒绝，且拒绝时根本不碰 shell（含"前缀像但是兄弟目录"这种绕过）', async () => {
    const result = await trash(['C:/Windows/x.jpg', 'C:/PhotosEvil/y.jpg']);
    expect(trashItem).not.toHaveBeenCalled();
    expect(result.trashed).toEqual([]);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0].reason).toContain('已拒绝');
    expect(result.failed.map((f) => f.absPath)).toEqual(['C:/Windows/x.jpg', 'C:/PhotosEvil/y.jpg']);
  });

  it('部分失败不静默：失败的那条给原因，成功的那条照常计入 trashed', async () => {
    trashItem.mockRejectedValueOnce(new Error('文件正被其他程序使用'));
    const result = await trash(['C:/Photos/locked.jpg', 'C:/Photos/ok.jpg']);
    expect(result.trashed).toEqual(['C:/Photos/ok.jpg']);
    expect(result.failed).toEqual([{ absPath: 'C:/Photos/locked.jpg', reason: '文件正被其他程序使用' }]);
  });

  it('空入参不炸也不碰 shell', async () => {
    expect(await trash([])).toEqual({ trashed: [], failed: [] });
    expect(trashItem).not.toHaveBeenCalled();
  });
});
