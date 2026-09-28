// @vitest-environment jsdom
import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import App from '../src/App';
import { AppLayout } from '../src/components/AppLayout';
import { AboutDialog } from '../src/components/AboutDialog';
import { rootKey, useAppStore } from '../src/store/useAppStore';
import packageJson from '../package.json';
import type { FolderNode, ImageFile, PhotoTagApi, ScanStats } from '../shared/types';

/**
 * app.test.tsx —— 渲染集成冒烟（vitest + testing-library，mock window.api）。
 * 验证空状态引导正确渲染，且 App 挂载/订阅不崩溃（多根 R10）；
 * 批次2 起还覆盖顶栏（G6）、合并目录树（G5）与状态栏（G7）的真实 DOM 断言。
 */

/** jsdom 无 ResizeObserver；空实现让网格停在零尺寸早退分支，本文件不断言网格内容 */
beforeAll(() => {
  class NoopResizeObserver {
    observe(): void {
      /* 不上报尺寸：容器宽高保持 0 */
    }
    unobserve(): void {
      /* noop */
    }
    disconnect(): void {
      /* noop */
    }
  }
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
});

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
    openExternal: vi.fn(async () => ({ ok: true as const, data: undefined })),
    revealFileInExplorer: vi.fn(async () => ({ ok: true as const, data: undefined })),
    trashFiles: vi.fn(async () => ({ ok: true as const, data: { trashed: [] as string[], failed: [] } })),
    getPrefs: vi.fn(async () => ({ ok: true as const, data: { sortKey: "name" as const, sortDir: "asc" as const, thumbSize: "small" as const, scanDoneToast: false } })),
    setPrefs: vi.fn(async () => ({ ok: true as const, data: { sortKey: "name" as const, sortDir: "asc" as const, thumbSize: "small" as const, scanDoneToast: false } })),
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
    onUpdateStatus: vi.fn(() => () => undefined),
    // 照片 AI 处理（M1）
    aiCatalog: vi.fn(async () => ({ ok: true as const, data: { capabilities: [] } })),
    aiRun: vi.fn(async () => ({ ok: true as const, data: { taskId: 'ai-1' } })),
    aiCancel: vi.fn(async () => ({ ok: true as const, data: true })),
    aiSave: vi.fn(async () => ({ ok: true as const, data: { savedPath: '', targetName: '', renamed: false, tagsWritten: [] } })),
    aiModelDownload: vi.fn(async () => ({ ok: true as const, data: { modelId: 'u2netp', status: 'present' as const } })),
    aiModelDelete: vi.fn(async () => ({ ok: true as const, data: { modelId: 'u2netp', status: 'absent' as const } })),
    aiModelUnload: vi.fn(async () => ({ ok: true as const, data: { modelId: 'u2netp', status: 'present' as const } })),
    aiModelSetDefault: vi.fn(async () => ({ ok: true as const, data: { capabilities: [] } })),
    aiStorageStats: vi.fn(async () => ({ ok: true as const, data: { preview: { entries: 0, totalBytes: 0 }, models: [], loadedModelId: null, freeDiskBytes: null, gpu: null, retention: { retentionDays: 30, maxBytes: 1 } } })),
    onAiProgress: vi.fn(() => () => undefined),
    onAiDone: vi.fn(() => () => undefined),
    onAiError: vi.fn(() => () => undefined),
  };
}

beforeEach(() => {
  (window as unknown as { api: PhotoTagApi }).api = createMockApi();
  useAppStore.setState({
    roots: [],
    selectedRootId: null,
    scanState: 'idle',
    scanStateByRoot: new Map(),
    scanStats: null,
    scanStatsByRoot: new Map(),
    activeScanIds: new Map(),
    tree: [],
    treesByRoot: new Map(),
    imagesByDir: new Map(),
    scannedRoots: new Set(),
    hiddenSet: new Set(),
    tagFilter: { tags: [], mode: 'AND' },
    selectedDir: null,
    selectedImages: new Set(),
    nameQuery: '',
    tagCache: new Map(),
    tagCounts: new Map(),
    preview: null,
    snackbar: null
  });
});

describe('App 冒烟', () => {
  it('无根目录时渲染空状态引导与「添加根目录」入口（R10）', () => {
    render(<App />);
    expect(screen.getByText('PhotoTagManager')).toBeTruthy();
    render(<AboutDialog open onClose={() => undefined} />);
    expect(screen.getByText(`当前版本：${packageJson.version}`)).toBeTruthy();
    expect(screen.getByText('添加一个或多个图片根目录，起个名字方便管理')).toBeTruthy();
    expect(screen.getAllByText('添加根目录').length).toBeGreaterThanOrEqual(1);
  });
});

function folder(relPath: string, directCount: number): FolderNode {
  return {
    relPath,
    name: relPath.split('/').pop() ?? '',
    directCount,
    totalCount: directCount,
    hidden: false,
    childrenLoaded: true,
    children: []
  };
}

function image(dirRelPath: string, name: string): ImageFile {
  const relPath = dirRelPath ? `${dirRelPath}/${name}` : name;
  return {
    id: relPath,
    absPath: `C:/截图/${relPath}`,
    relPath,
    name,
    ext: '.jpg',
    size: 1,
    mtimeMs: 1,
    dirRelPath,
    tags: []
  };
}

/**
 * 播种「两个根 + 根别名与子目录同名」的场景（G5 整改前的混淆点）：
 * 根「截图」下有子目录也叫「截图」（2 张）与「其他」（1 张）；另有未扫描的根「资料」。
 */
function seedGallery(selectedDir = '截图'): void {
  const store = useAppStore.getState();
  const stats: ScanStats = { scannedFiles: 40, imageCount: 3, totalFiles: 40, done: true };
  store.addRootLocal({ id: 'r1', path: 'C:/截图', alias: '截图', addedAt: 1 });
  store.addRootLocal({ id: 'r2', path: 'D:/资料', alias: '资料', addedAt: 2 });
  store.selectRoot('r1');
  useAppStore.setState({
    treesByRoot: new Map([
      ['r1', [folder('截图', 2), folder('其他', 1)]],
      ['r2', []]
    ]),
    tree: [folder('截图', 2), folder('其他', 1)],
    imagesByDir: new Map([
      [rootKey('r1', '截图'), [image('截图', 'a.jpg'), image('截图', 'b.jpg')]],
      [rootKey('r1', '其他'), [image('其他', 'c.jpg')]]
    ]),
    scannedRoots: new Set(['r1']),
    scanState: 'done',
    scanStateByRoot: new Map([['r1', 'done' as const]]),
    scanStatsByRoot: new Map([['r1', stats]]),
    selectedDir
  });
}

describe('批次2 G6 顶栏', () => {
  it('检查更新与关于不在顶栏裸露，收进「更多操作」溢出菜单', () => {
    seedGallery();
    render(<AppLayout />);
    expect(screen.queryByRole('button', { name: '检查更新' })).toBeNull();
    expect(screen.queryByRole('button', { name: '关于照片标签管家' })).toBeNull();
    expect(screen.getAllByRole('button', { name: '添加根目录' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: /重新扫描/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: '设置' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    expect(screen.getByRole('menuitem', { name: '检查更新' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: '关于照片标签管家' }));
    expect(screen.getByText(`当前版本：${packageJson.version}`)).toBeTruthy();
  });
});

describe('批次2 G5 左栏合并单棵树', () => {
  it('根作为顶层节点，同名根与子目录各占一行且标签不冲突', () => {
    seedGallery('');
    render(<AppLayout />);
    expect(screen.getByRole('treeitem', { name: '根目录 截图，共 3 张图片' })).toBeTruthy();
    expect(screen.getByRole('treeitem', { name: '截图，2 张图片' })).toBeTruthy();
    expect(screen.getByRole('treeitem', { name: '其他，1 张图片' })).toBeTruthy();
    expect(screen.getByRole('treeitem', { name: '根目录 资料，未扫描' })).toBeTruthy();
  });

  it('不再有独立的「根目录（N）」列表块', () => {
    seedGallery('');
    render(<AppLayout />);
    expect(screen.queryByText(/根目录（/)).toBeNull();
    expect(screen.queryByRole('button', { name: '选择根目录：截图' })).toBeNull();
  });
});

describe('批次2 G7 状态栏', () => {
  it('「已扫描」与「扫描已完成」不再同义并列，只留一条', () => {
    seedGallery('');
    render(<AppLayout />);
    const lines = screen
      .getAllByText(/扫描/)
      .filter((el) => /已扫描|扫描已完成/.test(el.textContent ?? ''));
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toBe('已扫描 40 个文件');
  });

  it('目录条显示当前目录张数，状态栏显示本根总数', () => {
    seedGallery('截图');
    render(<AppLayout />);
    expect(screen.getByText('当前目录：截图 · 2 张图片')).toBeTruthy();
    expect(screen.getByText(/共 3 张/)).toBeTruthy();
  });
});
