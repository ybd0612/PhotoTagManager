import { beforeEach, describe, expect, it } from 'vitest';
import { collectDirAndDescendants } from '../src/utils/folders';
import { useAppStore } from '../src/store/useAppStore';
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
});
