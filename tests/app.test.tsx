// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from '../src/App';
import type { PhotoTagApi } from '../shared/types';

/**
 * app.test.tsx —— 渲染集成冒烟（vitest + testing-library，mock window.api）。
 * 验证空状态引导正确渲染，且 App 挂载/订阅不崩溃。
 */

function createMockApi(): PhotoTagApi {
  return {
    pickDirectory: vi.fn(async () => ({ ok: true as const, data: null })),
    scanStart: vi.fn(async () => ({ ok: true as const, data: { rootPath: '' } })),
    scanCancel: vi.fn(async () => ({ ok: true as const, data: undefined })),
    onScanProgress: vi.fn(() => () => undefined),
    onScanDone: vi.fn(() => () => undefined),
    onScanError: vi.fn(() => () => undefined),
    hideFolder: vi.fn(async () => ({ ok: true as const, data: undefined })),
    unhideFolder: vi.fn(async () => ({ ok: true as const, data: undefined })),
    listHiddenFolders: vi.fn(async () => ({ ok: true as const, data: [] })),
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
    }))
  };
}

beforeEach(() => {
  (window as unknown as { api: PhotoTagApi }).api = createMockApi();
});

describe('App 冒烟', () => {
  it('空状态下渲染标题与「选择根目录」引导（R01 入口）', () => {
    render(<App />);
    expect(screen.getByText('PhotoTagManager')).toBeTruthy();
    expect(screen.getByText('选择一个包含图片的文件夹开始管理标签')).toBeTruthy();
    // 至少存在一个「选择根目录」按钮（顶栏 + 空态）
    expect(screen.getAllByText('选择根目录').length).toBeGreaterThanOrEqual(1);
  });
});
