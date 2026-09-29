import { beforeEach, describe, expect, it } from 'vitest';
import { collectDirAndDescendants } from '../src/utils/folders';
import { listHiddenUnder } from '../src/utils/treeRows';
import { rootKey, useAppStore } from '../src/store/useAppStore';
import type { FolderNode, ImageFile, ScanBatch } from '../shared/types';

/**
 * 隐藏目录不参与内容（R05/D2）。
 * - util 轴：collectDirAndDescendants 对 hidden 子树剪枝（网格取图 + 标签计数共用）
 * - store 轴：hideFolderLocal 后汇总同步收窄，且隐藏正在浏览的目录时选中态复位根目录
 */

function node(relPath: string, hidden = false, children: FolderNode[] = []): FolderNode {
  return {
    relPath,
    name: relPath.split('/').pop() ?? '',
    directCount: 1,
    totalCount: 1 + children.reduce((sum, c) => sum + c.totalCount, 0),
    hidden,
    childrenLoaded: true,
    children
  };
}

const tree: FolderNode[] = [
  node('2024', true, [node('2024/01'), node('2024/02')]),
  node('2025', false, [node('2025/03')])
];

describe('collectDirAndDescendants 隐藏剪枝', () => {
  it('选根目录时不含隐藏子树（R05/D2）', () => {
    expect(collectDirAndDescendants(tree, '')).toEqual(['', '2025', '2025/03']);
  });

  it('隐藏目录自身作为后代被排除，其子目录一并排除', () => {
    const dirs = collectDirAndDescendants(tree, '');
    expect(dirs).not.toContain('2024');
    expect(dirs).not.toContain('2024/01');
    expect(dirs).not.toContain('2024/02');
  });

  it('选中未隐藏目录时，其可见后代照常返回', () => {
    expect(collectDirAndDescendants(tree, '2025')).toEqual(['2025', '2025/03']);
  });

  it('显式选中隐藏目录时照常出图（剪枝只作用于父级上卷）', () => {
    expect(collectDirAndDescendants(tree, '2024')).toEqual(['2024', '2024/01', '2024/02']);
  });
});

function image(dirRelPath: string, name: string): ImageFile {
  const relPath = dirRelPath ? `${dirRelPath}/${name}` : name;
  return {
    id: relPath,
    absPath: `C:/Photos/${relPath}`,
    relPath,
    name,
    ext: '.jpg',
    size: 1,
    mtimeMs: 1,
    dirRelPath,
    tags: []
  };
}

/** 重建 r1：2024（含 2024/01）、2025 两个顶层目录 + 根目录直接图片 */
function scannedRoot(): void {
  const store = useAppStore.getState();
  store.addRootLocal({ id: 'r1', path: 'C:/Photos', alias: '照片', addedAt: 1 });
  store.selectRoot('r1');
  store.resetScan('r1', 's1');
  const batch: ScanBatch = {
    rootId: 'r1',
    scanId: 's1',
    kind: 'data',
    batchIndex: 0,
    folders: [node('2024', false, [node('2024/01')]), node('2025')],
    images: [
      image('', 'root.jpg'),
      image('2024', 'a.jpg'),
      image('2024/01', 'b.jpg'),
      image('2025', 'c.jpg')
    ],
    stats: { scannedFiles: 4, imageCount: 4, totalFiles: 4, done: true }
  };
  useAppStore.getState().mergeScanBatch(batch);
}

describe('hideFolderLocal 与内容视图联动', () => {
  beforeEach(() => {
    useAppStore.setState({
      roots: [],
      selectedRootId: null,
      tree: [],
      treesByRoot: new Map(),
      imagesByDir: new Map(),
      scannedRoots: new Set(),
      hiddenSet: new Set(),
      selectedDir: null,
      selectedImages: new Set(),
      activeScanIds: new Map(),
      scanStateByRoot: new Map(),
      scanStatsByRoot: new Map()
    });
  });

  it('隐藏后该目录及其子树从可见汇总中消失', () => {
    scannedRoot();
    expect(collectDirAndDescendants(useAppStore.getState().tree, '')).toEqual([
      '',
      '2024',
      '2024/01',
      '2025'
    ]);
    useAppStore.getState().hideFolderLocal('r1', '2024');
    expect(collectDirAndDescendants(useAppStore.getState().tree, '')).toEqual(['', '2025']);
  });

  it('隐藏正在浏览目录的祖先时，选中态复位到根目录', () => {
    scannedRoot();
    useAppStore.getState().selectDir('2024/01');
    useAppStore.getState().hideFolderLocal('r1', '2024');
    expect(useAppStore.getState().selectedDir).toBe('');
    expect(useAppStore.getState().selectedImages.size).toBe(0);
  });

  it('隐藏无关目录时保持当前选中', () => {
    scannedRoot();
    useAppStore.getState().selectDir('2024/01');
    useAppStore.getState().hideFolderLocal('r1', '2025');
    expect(useAppStore.getState().selectedDir).toBe('2024/01');
  });

  it('批量恢复走 setHiddenSet：恢复的子树回到可见汇总，清单外的隐藏项原样保住', () => {
    scannedRoot();
    useAppStore.getState().hideFolderLocal('r1', '2024');
    useAppStore.getState().hideFolderLocal('r1', '2024/01');
    useAppStore.getState().hideFolderLocal('r1', '2025');
    expect(collectDirAndDescendants(useAppStore.getState().tree, '')).toEqual(['']);
    // 「全部恢复 2024 子树」= 该根隐藏集减去这两条，2025 不在恢复清单里必须留下
    const remain = listHiddenUnder(useAppStore.getState().hiddenSet, 'r1', '').filter(
      (path) => path !== '2024' && path !== '2024/01'
    );
    useAppStore.getState().setHiddenSet('r1', remain);
    expect(collectDirAndDescendants(useAppStore.getState().tree, '')).toEqual(['', '2024', '2024/01']);
    expect(listHiddenUnder(useAppStore.getState().hiddenSet, 'r1', '')).toEqual(['2025']);
  });
});

/**
 * 右键菜单的「取消隐藏」清单怎么来：持久层逐条记隐藏不级联，子树范围靠 relPath 前缀扫隐藏集。
 * 这里盯住三个容易出错的点：同前缀兄弟目录（2024 vs 20241）、跨根串桶、层级顺序。
 */
describe('listHiddenUnder 子树隐藏项清点', () => {
  const hidden = new Set([
    rootKey('r1', '2024'),
    rootKey('r1', '2024/01'),
    rootKey('r1', '2024-旅行'),
    rootKey('r1', '2024/01/上午'),
    rootKey('r1', '2025'),
    rootKey('r2', '2024')
  ]);

  it('右键目录：含自身与全部后代，同前缀的兄弟目录不误收', () => {
    expect(listHiddenUnder(hidden, 'r1', '2024')).toEqual(['2024', '2024/01', '2024/01/上午']);
  });

  it('跨根隔离：r2 的隐藏项不出现在 r1 的任何结果里', () => {
    expect(listHiddenUnder(hidden, 'r1', '2024')).not.toContain('2024-旅行');
    expect(listHiddenUnder(hidden, 'r2', '2024')).toEqual(['2024']);
    expect(listHiddenUnder(hidden, 'r2', '2024/01')).toEqual([]);
  });

  it('根行（relPath 为空）返回该根全部隐藏项，按层级浅→深', () => {
    expect(listHiddenUnder(hidden, 'r1', '')).toEqual([
      '2024',
      '2024-旅行',
      '2025',
      '2024/01',
      '2024/01/上午'
    ]);
  });

  it('子树里没有隐藏项时返回空数组——菜单据此整块不渲染「取消隐藏」', () => {
    // 夹具里的 2025 自己就被隐藏了，这里要挑「自身与后代都不在隐藏集」的目录
    expect(listHiddenUnder(hidden, 'r1', '2025/03')).toEqual([]);
    expect(listHiddenUnder(hidden, 'r1', '2026')).toEqual([]);
    expect(listHiddenUnder(new Set(), 'r1', '2024')).toEqual([]);
  });
});
