import { describe, expect, it } from 'vitest';
import { moveRootByOffset, reorderRootsByDrop, sameOrder } from '../src/utils/rootOrder';
import type { RootEntry } from '../shared/types';

/**
 * rootOrder.test.ts —— 根目录拖拽排序纯逻辑单测。
 * 只排顶层根；子目录随根整体搬家，不参与排序。
 */

const roots: RootEntry[] = [
  { id: 'a', path: 'C:/A', alias: 'A', addedAt: 1, sortOrder: 0 },
  { id: 'b', path: 'C:/B', alias: 'B', addedAt: 2, sortOrder: 1 },
  { id: 'c', path: 'C:/C', alias: 'C', addedAt: 3, sortOrder: 2 }
];

describe('根目录拖拽排序', () => {
  it('落到目标下半区 = 插到目标之后', () => {
    expect(reorderRootsByDrop(roots, 'a', 'c', 'after')).toEqual(['b', 'c', 'a']);
  });

  it('落到目标上半区 = 插到目标之前', () => {
    expect(reorderRootsByDrop(roots, 'c', 'a', 'before')).toEqual(['c', 'a', 'b']);
  });

  it('向前拖到中间目标之前：过滤自身后目标位次要重算，不能错位一格', () => {
    expect(reorderRootsByDrop(roots, 'a', 'b', 'before')).toEqual(['a', 'b', 'c']);
    expect(reorderRootsByDrop(roots, 'c', 'b', 'after')).toEqual(['a', 'b', 'c']);
  });

  it('相邻互换两个方向都成立', () => {
    expect(reorderRootsByDrop(roots, 'a', 'b', 'after')).toEqual(['b', 'a', 'c']);
    expect(reorderRootsByDrop(roots, 'b', 'a', 'before')).toEqual(['b', 'a', 'c']);
  });

  it('拖回自己 / 未知 id：原顺序返回（不该把顺序搅乱）', () => {
    expect(reorderRootsByDrop(roots, 'a', 'a', 'before')).toEqual(['a', 'b', 'c']);
    expect(reorderRootsByDrop(roots, 'a', 'zz', 'before')).toEqual(['a', 'b', 'c']);
    expect(reorderRootsByDrop(roots, 'zz', 'a', 'before')).toEqual(['a', 'b', 'c']);
  });

  it('上移/下移一位，边界位原样返回', () => {
    expect(moveRootByOffset(roots, 'c', -1)).toEqual(['a', 'c', 'b']);
    expect(moveRootByOffset(roots, 'a', 1)).toEqual(['b', 'a', 'c']);
    expect(moveRootByOffset(roots, 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moveRootByOffset(roots, 'c', 1)).toEqual(['a', 'b', 'c']);
  });

  it('sameOrder：拖回原位时用来跳过无谓写盘', () => {
    expect(sameOrder(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameOrder(['a'], ['a', 'b'])).toBe(false);
  });
});