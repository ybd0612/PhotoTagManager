import type { RootEntry } from '../../shared/types';

/**
 * 根目录排序（树里拖拽 + 右键菜单上移/下移共用的纯逻辑，不碰 React）。
 *
 * 只重排顶层根目录：子目录属于各自根的子树，跟着根整体搬家，不单独参与排序。
 * 所有函数都以「新的根 id 顺序」返回，调用方负责写回 store 与落盘。
 */

/** 拖拽落点：插到目标根之前还是之后 */
export type DropPosition = 'before' | 'after';

/**
 * 把 fromId 拖到 toId 的前/后，返回新顺序。
 * fromId === toId 时原样返回（拖回自己身上不算改动）。
 */
export function reorderRootsByDrop(
  roots: RootEntry[],
  fromId: string,
  toId: string,
  position: DropPosition
): string[] {
  const ids = roots.map((root) => root.id);
  if (!ids.includes(fromId) || !ids.includes(toId) || fromId === toId) return ids;
  const next = ids.filter((id) => id !== fromId);
  // 目标落点：'after' 插到目标后一格，'before' 插到目标原位（fromId 已在前面时过滤后自然后让）
  const target = next.indexOf(toId) + (position === 'after' ? 1 : 0);
  next.splice(target, 0, fromId);
  return next;
}

/**
 * 上移/下移一位（键盘可达的排序入口）。已在顶/底时原样返回。
 * delta 取 -1 / +1。
 */
export function moveRootByOffset(roots: RootEntry[], rootId: string, delta: -1 | 1): string[] {
  const ids = roots.map((root) => root.id);
  const from = ids.indexOf(rootId);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= ids.length) return ids;
  const next = [...ids];
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}

/** 两个顺序是否一致（拖回原位、已在顶/底时用来跳过无谓的落盘） */
export function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}