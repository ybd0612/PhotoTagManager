// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from '../src/App';
import type { PhotoTagApi } from '../shared/types';

/**
 * app.test.tsx —— 渲染集成冒烟（vitest + testing-library，mock window.api）。
 * 验证空状态引导正确渲染，且 App 挂载/订阅不崩溃（多根 R10）。
 */

function createMockApi(): PhotoTagApi {
  return {
    pickDirectory: vi.fn(async () => ({ ok: true as const, data: null })),
    // 多根（R10）
    listRoots: vi.fn(async () => ({ ok: true as const, data: [] })),
    addRoot: vi.fn(async () => ({
      ok: true as const,
      data: { id: 'r1', path: 'C:/Photos', alias: '照片', addedAt: 1 }
    })),
    removeRoot: vi.fn(async () => ({ ok: true as const, data: undefined })),
    renameRoot: vi.fn(async () => ({
      ok: true as const,
      data: { id: 'r1', path: 'C:/Photos', alias: '新名', addedAt: 1 }
    })),
    // 扫描（带 rootId）
    scanStart: vi.fn(async (_rootId: string, _rootPath: string, scanId: string) => ({ ok: true as const, data: { rootId: 'r1', rootPath: 'C:/Photos', scanId } })),
    scanCancel: vi.fn(async () => ({ ok: true as const, data: undefined })),
    onScanProgress: vi.fn(() => () => undefined),
    onScanDone: vi.fn(() => () => undefined),
    onScanError: vi.fn(() => () => undefined),
    // 隐藏（按根）
    hideFolder: vi.fn(async () => ({ ok: true as const, data: undefined })),
    unhideFolder: vi.fn(async () => ({ ok: true as const, data: undefined })),
    listHiddenFolders: vi.fn(async () => ({ ok: true as const, data: [] })),
    openFolderInExplorer: vi.fn(async () => ({ ok: true as const, data: undefined })),
    revealFileInExplorer: vi.fn(async () => ({ ok: true as const, data: undefined })),
    copyFileToClipboard: vi.fn(async () => ({ ok: true as const, data: undefined })),
    readImageTags: vi.fn(async () => ({
      ok: true as const,
      data: { absPath: '', subjects: [], ok: true }
    })),
    readBulkTags: vi.fn(async () => ({ ok: true as const, data: [] })),
    writeImageTags: vi.fn(async () => ({
      ok: true as const,
      data: { absPath: '', subjects: [], ok: true }
    })),
    writeBatchTags: vi.fn(async () => ({ ok: true as const, data: { okCount: 0, failCount: 0 } })),
    onBatchProgress: vi.fn(() => () => undefined),
    renameTag: vi.fn(async () => ({ ok: true as const, data: 0 })),
    getThumbnail: vi.fn(async () => ({ ok: true as const, data: null })),
    onThumbReady: vi.fn(() => () => undefined),
    getImageInfo: vi.fn(async () => ({
      ok: true as const,
      data: { absPath: '', ok: true }
    })),
    // 自动更新
    checkUpdate: vi.fn(async () => ({ ok: true as const, data: { state: 'not-available' as const } })),
    downloadUpdate: vi.fn(async () => ({ ok: true as const, data: { state: 'downloading' as const, percent: 0 } })),
    installUpdate: vi.fn(async () => ({ ok: true as const, data: { state: 'downloaded' as const, percent: 100 } })),
    onUpdateStatus: vi.fn(() => () => undefined)
  };
}

beforeEach(() => {
  (window as unknown as { api: PhotoTagApi }).api = createMockApi();
});

describe('App 冒烟', () => {
  it('无根目录时渲染空状态引导与「添加根目录」入口（R10）', () => {
    render(<App />);
    expect(screen.getByText('PhotoTagManager')).toBeTruthy();
    expect(screen.getByText('添加一个或多个图片根目录，起个名字方便管理')).toBeTruthy();
    expect(screen.getAllByText('添加根目录').length).toBeGreaterThanOrEqual(1);
  });
});
