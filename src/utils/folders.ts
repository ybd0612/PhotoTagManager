import type { FolderNode } from '../../shared/types';

/**
 * 收集目录及其全部可见后代目录的 relPath（含自身；'' 额外包含根目录直接图片）。
 * 用于递归汇总视图：选中根目录显示全盘图片，选中子目录显示该目录及子树图片。
 * ThumbnailGrid（取图）与 TagFilterBar（上下文标签统计）共用。
 * D2 剪枝只作用于上卷：walk 跳过 hidden 节点及其整个子树，隐藏目录的图片不进父级汇总；
 * find 不剪枝，显式选中某目录时即使它处于隐藏集中照常出图（「显示已隐藏目录」下可直接点进隐藏节点）。
 */
export function collectDirAndDescendants(tree: FolderNode[], dir: string): string[] {
  const out: string[] = [];
  const walk = (nodes: FolderNode[]): void => {
    for (const n of nodes) {
      if (n.hidden) continue;
      out.push(n.relPath);
      if (n.children.length > 0) walk(n.children);
    }
  };
  if (dir === '') {
    out.push('');
    walk(tree);
    return out;
  }
  const find = (nodes: FolderNode[]): boolean => {
    for (const n of nodes) {
      if (n.relPath === dir) {
        out.push(n.relPath);
        walk(n.children);
        return true;
      }
      if (find(n.children)) return true;
    }
    return false;
  };
  find(tree);
  return out;
}
