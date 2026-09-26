import { rootKey } from '../store/useAppStore';
import type { FolderNode, ImageFile, RootEntry } from '../../shared/types';

/**
 * 批次2 G5：把「根目录列表」与「目录树」合成一棵树的行序列（纯结构，不碰 React）。
 * 所有状态（展开、隐藏、选中）都以 rootKey(rootId, relPath) 为键，保证不同根下的同名目录互不串桶。
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
  /** 根行 = 可见顶层目录汇总；目录行 = 该子树总数 */
  totalCount: number;
  hasChildren: boolean;
  expanded: boolean;
  hidden: boolean;
  /** 网格正在浏览这一层 */
  selected: boolean;
  /** 属于当前选中根（弱化标记用） */
  rootSelected: boolean;
}

export interface BuildTreeRowsInput {
  roots: RootEntry[];
  treesByRoot: Map<string, FolderNode[]>;
  hiddenSet: Set<string>;
  /** 未登记的根行默认「选中根展开、其余折叠」；目录行默认折叠 */
  expanded: Record<string, boolean>;
  selectedRootId: string | null;
  selectedDir: string | null;
  showHidden: boolean;
}

export function buildTreeRows(input: BuildTreeRowsInput): TreeRow[] {
  const rows: TreeRow[] = [];
  const isHidden = (rootId: string, node: FolderNode): boolean =>
    node.hidden || input.hiddenSet.has(rootKey(rootId, node.relPath));
  const visible = (rootId: string, node: FolderNode): boolean => input.showHidden || !isHidden(rootId, node);

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
        hidden: isHidden(rootId, node),
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
      totalCount: children.reduce((sum, child) => sum + child.totalCount, 0),
      hasChildren: children.length > 0,
      expanded,
      hidden: false,
      selected: root.id === input.selectedRootId && (input.selectedDir ?? '') === '',
      rootSelected: root.id === input.selectedRootId
    });
    if (expanded) walk(root.id, children, 1);
  }
  return rows;
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
