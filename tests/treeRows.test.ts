import { describe, expect, it } from 'vitest';
import { buildTreeRows, countImagesInDirs } from '../src/utils/treeRows';
import { rootKey } from '../src/store/useAppStore';
import type { FolderNode, ImageFile, RootEntry } from '../shared/types';

/**
 * 批次2 G5：左栏「根目录列表 + 目录树」合并成一棵树的纯结构函数。
 * 重点是按根分桶不能破——两个根可以有同名 relPath，展开态与隐藏集都必须按 rootKey 隔离。
 */

function node(relPath: string, opts: { hidden?: boolean; children?: FolderNode[] } = {}): FolderNode {
  const children = opts.children ?? [];
  return {
    relPath,
    name: relPath.split('/').pop() ?? '',
    directCount: 1,
    totalCount: 1 + children.reduce((sum, c) => sum + c.totalCount, 0),
    hidden: opts.hidden ?? false,
    childrenLoaded: true,
    children
  };
}

const roots: RootEntry[] = [
  { id: 'r1', path: 'C:/截图', alias: '截图', addedAt: 1 },
  { id: 'r2', path: 'D:/资料', alias: '资料', addedAt: 2 }
];

// r1 的顶层目录与根别名同名（正是整改前的混淆点），r2 下也有同名 relPath
const treesByRoot = new Map<string, FolderNode[]>([
  ['r1', [node('截图', { children: [node('截图/2024')] }), node('其他')]],
  ['r2', [node('截图', { children: [node('截图/0626')] })]]
]);

function rows(overrides: Partial<Parameters<typeof buildTreeRows>[0]> = {}) {
  return buildTreeRows({
    roots,
    treesByRoot,
    hiddenSet: new Set(),
    expanded: {},
    selectedRootId: 'r1',
    selectedDir: '',
    showHidden: false,
    ...overrides
  });
}

const keys = (list: ReturnType<typeof rows>): string[] => list.map((r) => `${r.rootId}:${r.relPath}`);

describe('buildTreeRows 合并树结构', () => {
  it('根为顶层节点；默认只有选中根展开，子目录缩进一层', () => {
    const list = rows();
    expect(keys(list)).toEqual(['r1:', 'r1:截图', 'r1:其他', 'r2:']);
    expect(list.map((r) => r.depth)).toEqual([0, 1, 1, 0]);
    expect(list[0]).toMatchObject({ isRoot: true, name: '截图', expanded: true });
    expect(list[3]).toMatchObject({ isRoot: true, name: '资料', expanded: false });
  });

  it('展开态按 rootKey 隔离：展开 r1 的「截图」不会带上 r2 的同名子树', () => {
    expect(keys(rows({ expanded: { [rootKey('r1', '截图')]: true } }))).toEqual([
      'r1:',
      'r1:截图',
      'r1:截图/2024',
      'r1:其他',
      'r2:'
    ]);
    // 换选 r2 后 r1 默认折叠：这里显式展开 r1 两跳，才能对比出 r2 的展开只带自己的子树
    expect(
      keys(
        rows({
          selectedRootId: 'r2',
          expanded: { [rootKey('r1', '')]: true, [rootKey('r1', '截图')]: true, [rootKey('r2', '截图')]: true }
        })
      )
    ).toEqual(['r1:', 'r1:截图', 'r1:截图/2024', 'r1:其他', 'r2:', 'r2:截图', 'r2:截图/0626']);
  });

  it('选中根被手动折叠时，其子树一并不渲染', () => {
    expect(keys(rows({ expanded: { [rootKey('r1', '')]: false } }))).toEqual(['r1:', 'r2:']);
  });

  it('隐藏集按 rootKey 生效：只剪 r1 的「截图」子树，r2 的同名目录照常', () => {
    const list = rows({ hiddenSet: new Set([rootKey('r1', '截图')]) });
    expect(keys(list)).toEqual(['r1:', 'r1:其他', 'r2:']);
    expect(list.some((r) => r.rootId === 'r2')).toBe(true);
  });

  it('showHidden 下隐藏节点回到树上并标记 hidden（其后代仍需该节点展开）', () => {
    const list = rows({
      hiddenSet: new Set([rootKey('r1', '截图')]),
      showHidden: true,
      expanded: { [rootKey('r1', '截图')]: true }
    });
    const hiddenRow = list.find((r) => r.rootId === 'r1' && r.relPath === '截图');
    expect(hiddenRow?.hidden).toBe(true);
    expect(keys(list)).toContain('r1:截图/2024');
  });

  it('选中判定只在所属根内进行：r1 的「截图」选中时 r2 的同名行不算选中', () => {
    const list = rows({ selectedDir: '截图', expanded: { [rootKey('r2', '')]: true } });
    const selected = list.filter((r) => r.selected).map((r) => `${r.rootId}:${r.relPath}`);
    expect(selected).toEqual(['r1:截图']);
    const r2Row = list.find((r) => r.rootId === 'r2' && r.relPath === '截图');
    expect(r2Row).toMatchObject({ selected: false, rootSelected: false });
    expect(list.find((r) => r.isRoot && r.rootId === 'r1')).toMatchObject({ rootSelected: true });
  });

  it('根行汇总只算可见顶层；唯一子目录隐藏后根不再有展开箭头', () => {
    expect(rows().find((r) => r.rootId === 'r1')?.totalCount).toBe(3);
    const onlyHidden = buildTreeRows({
      roots,
      treesByRoot: new Map([['r1', [node('a')]], ['r2', []]]),
      hiddenSet: new Set([rootKey('r1', 'a')]),
      expanded: {},
      selectedRootId: 'r1',
      selectedDir: '',
      showHidden: false
    });
    expect(onlyHidden[0]).toMatchObject({ totalCount: 0, hasChildren: false });
    expect(onlyHidden[0].expanded).toBe(true);
  });
});

function image(absPath: string): ImageFile {
  return {
    id: absPath,
    absPath,
    relPath: absPath,
    name: absPath.split('/').pop() ?? '',
    ext: '.jpg',
    size: 1,
    mtimeMs: 1,
    dirRelPath: '',
    tags: []
  };
}

describe('countImagesInDirs 按根分桶', () => {
  const imagesByDir = new Map<string, ImageFile[]>([
    [rootKey('r1', ''), [image('a.jpg'), image('b.jpg')]],
    [rootKey('r1', '截图'), [image('截图/c.jpg')]],
    [rootKey('r2', ''), [image('d.jpg')]]
  ]);

  it('只累加所属根的图片，不串到另一个根', () => {
    expect(countImagesInDirs(imagesByDir, 'r1', ['', '截图'])).toBe(3);
    expect(countImagesInDirs(imagesByDir, 'r2', [''])).toBe(1);
    expect(countImagesInDirs(imagesByDir, 'r1', ['截图'])).toBe(1);
  });

  it('目录集合为空时计 0', () => {
    expect(countImagesInDirs(imagesByDir, 'r1', [])).toBe(0);
  });
});
