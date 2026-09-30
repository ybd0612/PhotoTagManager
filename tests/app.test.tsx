// @vitest-environment jsdom
import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import App from '../src/App';
import { AppLayout } from '../src/components/AppLayout';
import { rootKey, useAppStore } from '../src/store/useAppStore';
import { SHORTCUTS } from '../src/utils/shortcuts';
import { DEFAULT_UI_PREFS } from '../shared/types';
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
    getPrefs: vi.fn(async () => ({ ok: true as const, data: { sortKey: "name" as const, sortDir: "asc" as const, thumbSize: "small" as const, scanDoneToast: false, proxyRules: "", treeCollapsed: false } })),
    setPrefs: vi.fn(async () => ({ ok: true as const, data: { sortKey: "name" as const, sortDir: "asc" as const, thumbSize: "small" as const, scanDoneToast: false, proxyRules: "", treeCollapsed: false } })),
    windowMinimize: vi.fn(async () => ({ ok: true as const, data: undefined })),
    windowToggleMaximize: vi.fn(async () => ({ ok: true as const, data: undefined })),
    windowClose: vi.fn(async () => ({ ok: true as const, data: undefined })),
    isWindowMaximized: vi.fn(async () => ({ ok: true as const, data: false })),
    onWindowMaximized: vi.fn(() => () => undefined),
    copyFileToClipboard: vi.fn(async () => ({ ok: true as const, data: undefined })),
    copyTextToClipboard: vi.fn(async () => ({ ok: true as const, data: undefined })),
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
    snackbar: null,
    treeCollapsed: false,
  });
});

describe('App 冒烟', () => {
  it('无根目录时渲染空状态引导与「添加根目录」入口（R10）', () => {
    render(<App />);
    expect(screen.getByText('PhotoTagManager')).toBeTruthy();
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
  it('更新在设置「关于与更新」分区就地完成，不再另开对话框', async () => {
    seedGallery();
    render(<AppLayout />);
    const header = screen.getByRole('banner');
    expect(within(header).queryByRole('button', { name: '更多操作' })).toBeNull();
    expect(within(header).queryByRole('button', { name: '检查更新' })).toBeNull();
    expect(within(header).queryByRole('button', { name: /关于/ })).toBeNull();

    fireEvent.click(within(header).getByRole('button', { name: '设置' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('tab', { name: '关于与更新' }));
    expect(within(dialog).getByText(`当前版本：${packageJson.version}`)).toBeTruthy();
    // 程序名后面那串说明已收进 ⓘ 悬浮提示，正文只剩一行
    expect(within(dialog).getByText('程序名：PhotoTagManager')).toBeTruthy();
    expect(within(dialog).getByTestId('app-name-hint')).toBeTruthy();

    // 启动那轮静默检查的结果直接落在分区里，用户不用再点一次才看见
    await waitFor(() =>
      expect(within(dialog).getByTestId('update-status').textContent).toContain('已是最新版本')
    );

    const api = (window as unknown as { api: PhotoTagApi }).api;
    const checksBefore = vi.mocked(api.checkUpdate).mock.calls.length;
    fireEvent.click(within(dialog).getByRole('button', { name: '检查更新' }));
    await waitFor(() => expect(vi.mocked(api.checkUpdate).mock.calls.length).toBe(checksBefore + 1));

    // 就地出结果：设置不收起，页面上也只有设置这一个模态
    expect(screen.getByTestId('settings-about')).toBeTruthy();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    // "已是最新版本"没什么可说的，不该占住右下角
    expect(screen.queryByTestId('update-notice')).toBeNull();
  });

  it('批次4 整改后：添加根目录在树头，重新扫描改由树行右键菜单发起（常驻图标已撤）', () => {
    seedGallery();
    render(<AppLayout />);
    const header = screen.getByRole('banner');
    expect(within(header).queryByRole('button', { name: '添加根目录' })).toBeNull();
    expect(within(header).queryByRole('button', { name: /重新扫描/ })).toBeNull();

    // 树头只剩加号；那颗常驻刷新图标不再存在
    expect(screen.getByRole('button', { name: '添加根目录' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重新扫描当前根目录' })).toBeNull();

    fireEvent.contextMenu(screen.getByRole('treeitem', { name: /根目录 截图/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: '重新扫描' }));
    // 关键：真的发起对该行所属根 r1 的重扫，而不是只留一个菜单项
    const scanStart = (window as unknown as { api: PhotoTagApi }).api.scanStart as ReturnType<
      typeof vi.fn
    >;
    expect(scanStart).toHaveBeenCalledTimes(1);
    expect(scanStart.mock.calls[0][0]).toBe('r1');
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
    expect(lines[0].textContent).toBe('已扫描 40 个文件（含非图片）');
  });

  it('当前目录只在状态栏说一次：目录名 + 绝对路径 + 两个张数', () => {
    seedGallery('截图');
    render(<AppLayout />);
    // 顶栏不再挂路径（顶栏是窗口拖拽区），网格上方那条目录条也已撤
    const header = screen.getByRole('banner');
    expect(within(header).queryByText(/C:\/截图/)).toBeNull();
    expect(screen.queryByText(/当前目录：/)).toBeNull();

    expect(screen.getByTestId('status-dir-name').textContent).toBe('截图');
    expect(screen.getByRole('button', { name: '复制当前目录路径' }).textContent).toContain(
      'C:/截图\\截图'
    );
    expect(screen.getByText(/当前 2 张/)).toBeTruthy();
    expect(screen.getByText(/共 3 张/)).toBeTruthy();
  });

  it('选中根本身时两个数相等，只报一次「共」', () => {
    seedGallery('');
    render(<AppLayout />);
    expect(screen.queryByText(/当前 \d+ 张/)).toBeNull();
    expect(screen.getByText(/共 3 张/)).toBeTruthy();
  });

  it('点状态栏路径 = 复制绝对路径文本，并给成功反馈', async () => {
    seedGallery('截图');
    render(<AppLayout />);
    fireEvent.click(screen.getByRole('button', { name: '复制当前目录路径' }));
    const api = (window as unknown as { api: PhotoTagApi }).api;
    await waitFor(() =>
      expect(vi.mocked(api.copyTextToClipboard)).toHaveBeenCalledWith('C:/截图\\截图')
    );
    expect(await screen.findByText('已复制路径')).toBeTruthy();
  });

  it('超长路径只省略中段，头尾仍可读', () => {
    seedGallery('截图');
    useAppStore.setState((s) => ({
      roots: s.roots.map((r) =>
        r.id === 'r1' ? { ...r, path: 'C:\\Users\\ybd06\\Documents\\我的图片归档\\PixPinAutoSave\\2026\\09月\\项目截图' } : r
      )
    }));
    render(<AppLayout />);
    const shown = screen.getByRole('button', { name: '复制当前目录路径' }).textContent ?? '';
    expect(shown).toContain('…');
    expect(shown).toContain('C:\\Users\\ybd06');
    expect(shown).toContain('项目截图');
    // 中段真的被切掉了：整段目录名不可能同时出现在省略后的文本里
    expect(shown).not.toContain('PixPinAutoSave');
  });
});

/**
 * 左栏折叠：分界线上的悬浮把手 + Ctrl+B + 状态落盘。
 * 收起走 180ms 宽度过渡（.ptm-tree-pane--collapsed），不再用 display:none 硬切；
 * 因此"收起后树不可达"这条断言靠的是容器上的 DOM 层 aria-hidden，而不是内联样式。
 */
describe('左栏折叠与展开', () => {
  const queryTree = (): HTMLElement | null => screen.queryByRole('tree', { name: '图库目录树' });
  const setPrefsMock = (): ReturnType<typeof vi.fn> =>
    (window as unknown as { api: { setPrefs: ReturnType<typeof vi.fn> } }).api.setPrefs;

  it('折叠把手「折叠侧栏」一点收起目录树，再点展开', () => {
    seedGallery();
    render(<AppLayout />);
    expect(queryTree()).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '折叠侧栏' }));
    expect(queryTree()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '展开侧栏' }));
    expect(queryTree()).toBeTruthy();
  });

  it('折叠把手挂在左栏右缘，鼠标贴近分界线才现身', () => {
    seedGallery();
    render(<AppLayout />);
    const handle = screen
      .getByRole('button', { name: '折叠侧栏' })
      .closest('.ptm-tree-handle') as HTMLElement;
    // 顶栏那颗常驻按钮已撤：把手不在 header 里，顶栏也就没有第二个出口
    expect(handle.closest('header')).toBeNull();
    expect(handle.className).not.toContain('ptm-tree-handle--visible');

    // jsdom 的 getBoundingClientRect 恒为 0，clientX 就等于相对分界线的偏移
    const body = handle.parentElement as HTMLElement;
    // 落在分界线上（滚动条那一侧）不唤出，否则把手会跑到指针底下抢走滚动条那一枪
    fireEvent.mouseMove(body, { clientX: 0 });
    expect(handle.className).not.toContain('ptm-tree-handle--visible');

    fireEvent.mouseMove(body, { clientX: 12 });
    expect(handle.className).toContain('ptm-tree-handle--visible');
    // 已现身后退进滞留带：指针挪到把手左半不能把自己藏掉，否则看着在眼前却点不着
    fireEvent.mouseMove(body, { clientX: 0 });
    expect(handle.className).toContain('ptm-tree-handle--visible');

    fireEvent.mouseMove(body, { clientX: 400 });
    expect(handle.className).not.toContain('ptm-tree-handle--visible');
  });

  it('折叠状态写进偏好：收起发 treeCollapsed:true，展开发 false', () => {
    seedGallery();
    render(<AppLayout />);
    const setPrefs = setPrefsMock();

    fireEvent.click(screen.getByRole('button', { name: '折叠侧栏' }));
    expect(setPrefs).toHaveBeenCalledWith(expect.objectContaining({ treeCollapsed: true }));

    fireEvent.click(screen.getByRole('button', { name: '展开侧栏' }));
    expect(setPrefs).toHaveBeenCalledWith(expect.objectContaining({ treeCollapsed: false }));
  });

  it('Ctrl + B 在全局切换折叠', () => {
    seedGallery();
    render(<AppLayout />);
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    expect(queryTree()).toBeNull();
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    expect(queryTree()).toBeTruthy();
  });

  it('快捷键表列出 Ctrl + B（表里只许有已实现的键位）', () => {
    expect(SHORTCUTS.some((s) => s.keys === 'Ctrl + B')).toBe(true);
  });

  it('启动时从偏好读回折叠状态，跨重启保留', async () => {
    (window as unknown as { api: { getPrefs: ReturnType<typeof vi.fn> } }).api.getPrefs = vi.fn(
      async () => ({ ok: true as const, data: { ...DEFAULT_UI_PREFS, treeCollapsed: true } })
    );
    await useAppStore.getState().loadUiPrefs();
    expect(useAppStore.getState().treeCollapsed).toBe(true);
  });
});

/**
 * 左栏右键菜单的「取消隐藏」区（平铺分组）。
 * 播种必须走 mergeScanBatch：它才把目录节点登记进 store 内部的节点索引，批量恢复用的 setHiddenSet
 * 靠那份索引重建目录树——直接 setState 灌 treesByRoot 会让重建拿到空索引，树行凭空消失。
 */
describe('左栏右键菜单的「取消隐藏」区', () => {
  function nested(relPath: string, children: FolderNode[] = []): FolderNode {
    return {
      relPath,
      name: relPath.split('/').pop() ?? '',
      directCount: 1,
      totalCount: 1 + children.reduce((sum, c) => sum + c.totalCount, 0),
      hidden: false,
      childrenLoaded: true,
      children
    };
  }

  function seedScannedRoot(): void {
    const stats: ScanStats = { scannedFiles: 4, imageCount: 4, totalFiles: 4, done: true };
    const store = useAppStore.getState();
    store.addRootLocal({ id: 'r1', path: 'C:/Photos', alias: '照片', addedAt: 1 });
    store.selectRoot('r1');
    store.resetScan('r1', 's1');
    store.mergeScanBatch({
      rootId: 'r1',
      scanId: 's1',
      kind: 'data',
      batchIndex: 0,
      folders: [nested('2024', [nested('2024/01', [nested('2024/01/上午')])]), nested('2025')],
      images: [
        image('', 'root.jpg'),
        image('2024', 'a.jpg'),
        image('2024/01', 'b.jpg'),
        image('2025', 'c.jpg')
      ],
      stats
    });
    store.finishScan('r1', 's1', 'done', stats);
  }

  const rootRow = (): HTMLElement => screen.getByRole('treeitem', { name: /根目录 照片/ });

  it('根行菜单：没有「隐藏文件夹」（根本身不许隐藏），有改别名与删除根目录', () => {
    seedScannedRoot();
    render(<AppLayout />);
    fireEvent.contextMenu(rootRow());
    expect(screen.queryByRole('menuitem', { name: '隐藏文件夹' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: '改别名' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '删除根目录' })).toBeTruthy();
    // 子树里没有隐藏项时，「取消隐藏」整块也不出现（旧版是点不亮的永久灰项）
    expect(screen.queryByRole('menuitem', { name: '取消隐藏' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /全部恢复/ })).toBeNull();
  });

  it('目录行菜单：有「隐藏文件夹」，不出现改别名与删除根目录', () => {
    seedScannedRoot();
    render(<AppLayout />);
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: /2024，/ }));
    expect(screen.getByRole('menuitem', { name: '隐藏文件夹' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: '改别名' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '删除根目录' })).toBeNull();
  });

  it('子树里只有一个隐藏项时给单行「取消隐藏」，不铺分组', () => {
    seedScannedRoot();
    useAppStore.getState().hideFolderLocal('r1', '2024/01');
    render(<AppLayout />);
    fireEvent.contextMenu(rootRow());
    expect(screen.getByRole('menuitem', { name: '取消隐藏' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /全部恢复/ })).toBeNull();
  });

  it('两个及以上平铺成「全部恢复（N）」+ 已隐藏小标题 + 逐项', () => {
    seedScannedRoot();
    useAppStore.getState().hideFolderLocal('r1', '2024');
    useAppStore.getState().hideFolderLocal('r1', '2024/01');
    render(<AppLayout />);
    fireEvent.contextMenu(rootRow());
    expect(screen.getByRole('menuitem', { name: '全部恢复（2 个）' })).toBeTruthy();
    expect(screen.getByText('已隐藏')).toBeTruthy();
    // 根行作用域下标签就是全 relPath，按层级浅→深
    expect(screen.getByRole('menuitem', { name: '2024' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '2024/01' })).toBeTruthy();
  });

  it('点「全部恢复」逐条调用持久层、目录回到树里、菜单收起', async () => {
    seedScannedRoot();
    useAppStore.getState().hideFolderLocal('r1', '2024');
    useAppStore.getState().hideFolderLocal('r1', '2024/01');
    render(<AppLayout />);
    fireEvent.contextMenu(rootRow());
    fireEvent.click(screen.getByRole('menuitem', { name: '全部恢复（2 个）' }));

    const unhide = vi.mocked((window as unknown as { api: PhotoTagApi }).api.unhideFolder);
    await waitFor(() => expect(unhide).toHaveBeenCalledTimes(2));
    expect(unhide.mock.calls.map((c) => c[1]).sort()).toEqual(['2024', '2024/01']);
    expect(unhide.mock.calls.every((c) => c[0] === 'r1')).toBe(true);
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: /全部恢复/ })).toBeNull());
    expect(screen.getByRole('treeitem', { name: /2024，/ })).toBeTruthy();
  });

  it('右键子目录时隐藏后代标签按相对该目录的路径显示，不重复带祖先前缀', () => {
    seedScannedRoot();
    useAppStore.getState().hideFolderLocal('r1', '2024/01');
    useAppStore.getState().hideFolderLocal('r1', '2024/01/上午');
    render(<AppLayout />);
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: /2024，/ }));
    expect(screen.getByRole('menuitem', { name: '全部恢复（2 个）' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '01' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '01/上午' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: '2024/01' })).toBeNull();
  });
});
