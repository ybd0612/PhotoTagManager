import type { FolderNode, ImageFile } from '../../shared/types';
import { getParentRelPath, rootKey } from './useAppStore';

/** 从 useAppStore 抽出来的纯计算：输入当前内存账目，输出要写回的补丁。 */
export interface RemovalInput {
  imagesByDir: Map<string, ImageFile[]>;
  selectedImages: Set<string>;
  tagCache: Map<string, string[]>;
  preview: { image: ImageFile; index: number; list: ImageFile[] } | null;
  selectedRootId: string | null;
}

export interface RemovalPatch {
  imagesByDir: Map<string, ImageFile[]>;
  selectedImages: Set<string>;
  tagCache?: Map<string, string[]>;
  preview: RemovalInput['preview'];
  touchedRootIds: string[];
  removedCount: number;
}

/**
 * 算出"这些文件已经不在磁盘上了"之后内存里该怎么改。
 * 目录节点的计数在 nodeMap（模块级索引）里原地更新，所以这里只交出被碰过的 rootId，
 * 由调用方 rebuildRootChildren 重建数组引用触发重渲染。
 * 路径不在内存账上时返回 null：重复调用不该把任何数字改小。
 */
export function planImageRemoval(
  input: RemovalInput,
  absPaths: string[],
  nodeOf: (key: string) => FolderNode | undefined
): RemovalPatch | null {
  const targets = new Set((absPaths ?? []).filter(Boolean));
  if (targets.size === 0) return null;

  const hitPaths = new Set<string>();
  const removedIds = new Set<string>();
  const byDir = new Map<string, number>();
  const nextImages = new Map(input.imagesByDir);

  for (const [key, arr] of input.imagesByDir) {
    const hit = arr.filter((img) => targets.has(img.absPath));
    if (hit.length === 0) continue;
    byDir.set(key, hit.length);
    for (const img of hit) {
      hitPaths.add(img.absPath);
      removedIds.add(img.id);
    }
    const kept = arr.filter((img) => !targets.has(img.absPath));
    if (kept.length === 0) nextImages.delete(key);
    else nextImages.set(key, kept);
  }
  if (hitPaths.size === 0) return null;

  // 所在目录 directCount / totalCount 各减，各级祖先只减 totalCount
  const touchedRoots = new Set<string>();
  for (const [key, n] of byDir) {
    const sep = key.indexOf('\u0000');
    if (sep < 0) continue;
    const rootId = key.slice(0, sep);
    const dirRelPath = key.slice(sep + 1);
    touchedRoots.add(rootId);
    const self = nodeOf(key);
    if (self) {
      self.directCount -= n;
      self.totalCount -= n;
    }
    let parent = getParentRelPath(dirRelPath);
    for (;;) {
      const anc = nodeOf(rootKey(rootId, parent));
      if (anc) anc.totalCount -= n;
      if (parent === '') break;
      parent = getParentRelPath(parent);
    }
  }

  // 预览：当前这张被删就落到下一张；整列空了就关闭
  let preview = input.preview;
  if (preview) {
    const list = preview.list.filter((img) => !hitPaths.has(img.absPath));
    if (list.length === 0) {
      preview = null;
    } else {
      const goneBefore = preview.list.slice(0, preview.index).filter((img) => hitPaths.has(img.absPath)).length;
      const index = Math.max(0, Math.min(preview.index - goneBefore, list.length - 1));
      preview = { image: list[index], index, list };
    }
  }

  const nextTagCache = new Map(input.tagCache);
  for (const p of hitPaths) nextTagCache.delete(p);
  const tagsChanged = nextTagCache.size !== input.tagCache.size;

  return {
    imagesByDir: nextImages,
    selectedImages: new Set([...input.selectedImages].filter((id) => !removedIds.has(id))),
    ...(tagsChanged ? { tagCache: nextTagCache } : {}),
    preview,
    touchedRootIds: [...touchedRoots],
    removedCount: hitPaths.size
  };
}
