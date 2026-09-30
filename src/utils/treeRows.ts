import { rootKey } from '../store/useAppStore';
import type { FolderNode, ImageFile, RootEntry } from '../../shared/types';

/**
 * 批次2 G5：把「根目录列表」与「目录树」合成一棵树的行序列（纯结构，不碰 React）。
 * 所有状态（展开、隐藏、选中）都以 rootKey(rootId, relPath) 为键，保证不同根下的同名目录互不串桶。
 * 隐藏目录不进树（没有"显示已隐藏目录"的查看开关）：恢复入口在树行右键菜单，见 listHiddenUnder。
 */

export interface TreeRow {
  /** rootKey(rootId, relPath)，同时作为 React key 与展开态键 */
  key: string;
  rootId: string;
  /** '' 表示根节点自身 */
  relPath: string;
  /** 根行显示别名，目录行显示目录名 */
  name: string;
  depth: number;
  isRoot: boolean;
  /** 根行 = 可见顶层目录之和 + 根目录直属图片；目录行 = 该子树总数 */
  totalCount: number;
  hasChildren: boolean;
  expanded: boolean;
  /** 网格正在浏览这一层 */
  selected: boolean;
  /** 属于当前选中根（弱化标记用） */
  rootSelected: boolean;
}

export interface BuildTreeRowsInput {
  roots: RootEntry[];
  treesByRoot: Map<string, FolderNode[]>;
  hiddenSet: Set<string>;
  /** rootId → 直接放在该根目录里的图片数（不属于任何子目录 FolderNode，只能由调用方给） */
  rootDirectCounts: Map<string, number>;
  /** 未登记的根行默认「选中根展开、其余折叠」；目录行默认折叠 */
  expanded: Record<string, boolean>;
  selectedRootId: string | null;
  selectedDir: string | null;
}

export function buildTreeRows(input: BuildTreeRowsInput): TreeRow[] {
  const rows: TreeRow[] = [];
  const visible = (rootId: string, node: FolderNode): boolean =>
    !node.hidden && !input.hiddenSet.has(rootKey(rootId, node.relPath));

  const walk = (rootId: string, nodes: FolderNode[], depth: number): void => {
    for (const node of nodes) {
      if (!visible(rootId, node)) continue;
      const key = rootKey(rootId, node.relPath);
      const expanded = input.expanded[key] === true;
      const children = node.children.filter((child) => visible(rootId, child));
      rows.push({
        key,
        rootId,
        relPath: node.relPath,
        name: node.name,
        depth,
        isRoot: false,
        totalCount: node.totalCount,
        hasChildren: children.length > 0,
        expanded,
        selected: rootId === input.selectedRootId && node.relPath === input.selectedDir,
        rootSelected: rootId === input.selectedRootId
      });
      if (expanded) walk(rootId, children, depth + 1);
    }
  };

  for (const root of input.roots) {
    const key = rootKey(root.id, '');
    const children = (input.treesByRoot.get(root.id) ?? []).filter((child) => visible(root.id, child));
    const expanded = input.expanded[key] ?? root.id === input.selectedRootId;
    rows.push({
      key,
      rootId: root.id,
      relPath: '',
      name: root.alias,
      depth: 0,
      isRoot: true,
      totalCount: children.reduce((sum, child) => sum + child.totalCount, 0) + (input.rootDirectCounts.get(root.id) ?? 0),
      hasChildren: children.length > 0,
      expanded,
      selected: root.id === input.selectedRootId && (input.selectedDir ?? '') === '',
      rootSelected: root.id === input.selectedRootId
    });
    if (expanded) walk(root.id, children, 1);
  }
  return rows;
}

/**
 * 列出某目录子树内被单独隐藏的**后代** relPath。
 * 隐藏目录不进树（没有"显示已隐藏目录"的查看开关），能右键到的行本身必然不在隐藏集里，所以不含自身；
 * 根行（relPath 传 ''）则覆盖该根全部隐藏项。持久层逐条记录隐藏、不级联（见 folderStore.unhide：
 * 取消隐藏只清自身），所以「这个目录下还有几个被单独隐藏」只能在渲染端按 relPath 前缀扫隐藏集得出。
 * 结果按层级浅→深排序。
 */
export function listHiddenUnder(hiddenSet: Set<string>, rootId: string, relPath: string): string[] {
  const bucket = rootKey(rootId, '');
  const scope = relPath === '' ? '' : `${relPath}/`;
  const out: string[] = [];
  for (const key of hiddenSet) {
    if (!key.startsWith(bucket)) continue;
    const path = key.slice(bucket.length);
    // 根自身不参与隐藏；scope 为空表示该根全部隐藏项，非空时要求落在自身子树内（带斜杠，不误收 20241 这类同前缀兄弟）
    if (path !== '' && (scope === '' || path.startsWith(scope))) out.push(path);
  }
  return out.sort(
    (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b, 'zh-Hans-CN')
  );
}

/** 累加若干目录的图片数（按根分桶；调用方用 collectDirAndDescendants 决定目录集合） */
export function countImagesInDirs(
  imagesByDir: Map<string, ImageFile[]>,
  rootId: string,
  dirs: string[]
): number {
  let total = 0;
  for (const dir of dirs) total += imagesByDir.get(rootKey(rootId, dir))?.length ?? 0;
  return total;
}
