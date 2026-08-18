import type { FolderNode } from '../../shared/types';

/**
 * 收集目录及其全部后代目录的 relPath（含自身；'' 额外包含根目录直接图片）。
 * 用于递归汇总视图：选中根目录显示全盘图片，选中子目录显示该目录及子树图片。
 * ThumbnailGrid（取图）与 TagFilterBar（上下文标签统计）共用。
 */
export function collectDirAndDescendants(tree: FolderNode[], dir: string): string[] {
  const out: string[] = [];
  const walk = (nodes: FolderNode[]): void => {
    for (const n of nodes) {
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
