import type { ImageFile, SortDir, SortKey, ThumbSize } from '../../shared/types';

export type { SortDir, SortKey, ThumbSize };

/**
 * 找图相关的纯视图计算：搜索、排序、缩略图档位。
 * 刻意做成无副作用的纯函数——渲染层的 memo 依赖数组引用，
 * 就地排序会让"数据没变"的判断出错（所以 sortImages 一定先拷贝）。
 */

/** 三档缩略图基准宽（px）。行高按现有 168×148 的比例跟着缩放 */
export const THUMB_SIZES: Record<ThumbSize, number> = { small: 168, medium: 216, large: 300 };

export const ROW_RATIO = 148 / 168;

/** 文件名子串搜索：大小写不敏感；空查询原样返回（不复制不重排） */
export function matchName(images: ImageFile[], query: string): ImageFile[] {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return images;
  return images.filter((image) => image.name.toLowerCase().includes(q));
}

export function sortImages(images: ImageFile[], key: SortKey, dir: SortDir): ImageFile[] {
  const factor = dir === 'asc' ? 1 : -1;
  return [...images].sort((a, b) => {
    if (key === 'time') return (a.mtimeMs - b.mtimeMs) * factor;
    if (key === 'size') return (a.size - b.size) * factor;
    return a.relPath.localeCompare(b.relPath, 'zh-Hans-CN') * factor;
  });
}
