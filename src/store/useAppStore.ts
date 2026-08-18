import { create } from 'zustand';
import type {
  FolderNode,
  ImageFile,
  ScanBatch,
  ScanStats,
  TagInfo
} from '../../shared/types';

/**
 * 全局内存模型（ARCHITECTURE §3.2）。
 * 目录树节点用模块级 nodeMap 保存（增量合并，不参与响应式）；store 只暴露 tree。
 */

export type ScanState = 'idle' | 'scanning' | 'done' | 'error';

export interface PreviewState {
  image: ImageFile;
  index: number;
  list: ImageFile[];
}

export interface TagFilterState {
  tags: string[];
  mode: 'AND' | 'OR';
}

interface AppState {
  rootPath: string | null;
  scanState: ScanState;
  scanStats: ScanStats | null;
  tree: FolderNode[];
  imagesByDir: Map<string, ImageFile[]>;
  hiddenSet: Set<string>;
  tagFilter: TagFilterState;
  selectedDir: string | null;
  selectedImages: Set<string>;
  tagCache: Map<string, string[]>;
  tagCounts: Map<string, number>;
  tagEpoch: number;
  preview: PreviewState | null;
  snackbar: string | null;

  // 扫描
  setRootPath(rootPath: string | null): void;
  setScanState(state: ScanState): void;
  setScanStats(stats: ScanStats | null): void;
  resetScan(): void;
  mergeScanBatch(batch: ScanBatch): void;
  // 隐藏
  setHiddenSet(relPaths: string[]): void;
  hideFolderLocal(relPath: string): void;
  unhideFolderLocal(relPath: string): void;
  // 目录/选择
  selectDir(relPath: string): void;
  toggleSelectImage(id: string): void;
  clearSelection(): void;
  // 标签筛选
  toggleFilterTag(tag: string): void;
  setFilterMode(mode: 'AND' | 'OR'): void;
  clearFilter(): void;
  // 标签数据
  setTagsForImages(results: TagInfo[]): void;
  setTagsForPath(absPath: string, tags: string[], label?: string): void;
  bumpTagEpoch(): void;
  // 预览
  setPreview(image: ImageFile, list: ImageFile[]): void;
  closePreview(): void;
  previewStep(delta: number): void;
  // 提示
  setSnackbar(message: string | null): void;
}

// 模块级目录节点索引：relPath → FolderNode（增量合并用）
const nodeMap = new Map<string, FolderNode>();

/** 取父目录 relPath（'' 表示根目录） */
export function getParentRelPath(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '' : relPath.slice(0, idx);
}

/** 递归写入节点及其子树到索引（保证索引对象与最新克隆一致） */
function setNodeSubtree(map: Map<string, FolderNode>, node: FolderNode): void {
  map.set(node.relPath, node);
  for (const child of node.children) {
    setNodeSubtree(map, child);
  }
}

function markHiddenFromSet(): void {
  const { hiddenSet } = useAppStore.getState();
  for (const node of nodeMap.values()) {
    node.hidden = hiddenSet.has(node.relPath);
  }
}

/** 重建根目录子节点列表（父 relPath 为 '' 的节点） */
function rebuildRootChildren(): FolderNode[] {
  const roots: FolderNode[] = [];
  for (const node of nodeMap.values()) {
    if (getParentRelPath(node.relPath) === '') {
      roots.push(node);
    }
  }
  roots.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return roots;
}

/** 从 tagCache 全量重算标签计数（缓存规模可控，MVP 足够） */
function recomputeTagCounts(tagCache: Map<string, string[]>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const tags of tagCache.values()) {
    for (const tag of tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return counts;
}

/** 更新 imagesByDir 中某张图片的 tags/label（保持引用更新触发重渲染） */
function updateImageTagsInDir(
  imagesByDir: Map<string, ImageFile[]>,
  absPath: string,
  tags: string[],
  label?: string
): Map<string, ImageFile[]> {
  const next = new Map(imagesByDir);
  for (const [dir, images] of next) {
    const idx = images.findIndex((img) => img.absPath === absPath);
    if (idx !== -1) {
      const arr = [...images];
      arr[idx] = { ...arr[idx], tags, label };
      next.set(dir, arr);
      break;
    }
  }
  return next;
}

export const useAppStore = create<AppState>((set, get) => ({
  rootPath: null,
  scanState: 'idle',
  scanStats: null,
  tree: [],
  imagesByDir: new Map(),
  hiddenSet: new Set(),
  tagFilter: { tags: [], mode: 'AND' },
  selectedDir: null,
  selectedImages: new Set(),
  tagCache: new Map(),
  tagCounts: new Map(),
  tagEpoch: 0,
  preview: null,
  snackbar: null,

  setRootPath: (rootPath) => set({ rootPath }),
  setScanState: (scanState) => set({ scanState }),
  setScanStats: (scanStats) => set({ scanStats }),

  resetScan: () => {
    nodeMap.clear();
    set({
      scanState: 'scanning',
      scanStats: null,
      tree: [],
      imagesByDir: new Map(),
      selectedDir: null,
      selectedImages: new Set(),
      tagCache: new Map(),
      tagCounts: new Map(),
      preview: null
    });
  },

  mergeScanBatch: (batch) => {
    for (const folder of batch.folders) {
      setNodeSubtree(nodeMap, folder);
    }
    const tree = rebuildRootChildren();

    const imagesByDir = new Map(get().imagesByDir);
    for (const image of batch.images) {
      const arr = imagesByDir.get(image.dirRelPath) ?? [];
      arr.push(image);
      imagesByDir.set(image.dirRelPath, arr);
    }

    set({ tree, imagesByDir, scanStats: batch.stats });
  },

  setHiddenSet: (relPaths) => {
    const hiddenSet = new Set(relPaths);
    set({ hiddenSet });
    markHiddenFromSet();
    set({ tree: rebuildRootChildren() });
  },

  hideFolderLocal: (relPath) => {
    const hiddenSet = new Set(get().hiddenSet);
    hiddenSet.add(relPath);
    const node = nodeMap.get(relPath);
    if (node) node.hidden = true;
    set({ hiddenSet, tree: rebuildRootChildren() });
  },

  unhideFolderLocal: (relPath) => {
    const hiddenSet = new Set(get().hiddenSet);
    hiddenSet.delete(relPath);
    const node = nodeMap.get(relPath);
    if (node) node.hidden = false;
    set({ hiddenSet, tree: rebuildRootChildren() });
  },

  selectDir: (relPath) => {
    set({ selectedDir: relPath, selectedImages: new Set() });
  },

  toggleSelectImage: (id) => {
    const selectedImages = new Set(get().selectedImages);
    if (selectedImages.has(id)) selectedImages.delete(id);
    else selectedImages.add(id);
    set({ selectedImages });
  },

  clearSelection: () => set({ selectedImages: new Set() }),

  toggleFilterTag: (tag) => {
    const { tags } = get().tagFilter;
    const next = tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag];
    set({ tagFilter: { ...get().tagFilter, tags: next } });
  },

  setFilterMode: (mode) => set({ tagFilter: { ...get().tagFilter, mode } }),

  clearFilter: () => set({ tagFilter: { tags: [], mode: get().tagFilter.mode } }),

  setTagsForImages: (results) => {
    const tagCache = new Map(get().tagCache);
    let imagesByDir = get().imagesByDir;
    for (const result of results) {
      if (!result.ok) continue;
      tagCache.set(result.absPath, result.subjects);
      imagesByDir = updateImageTagsInDir(imagesByDir, result.absPath, result.subjects, result.label);
    }
    set({ tagCache, tagCounts: recomputeTagCounts(tagCache), imagesByDir });
  },

  setTagsForPath: (absPath, tags, label) => {
    const tagCache = new Map(get().tagCache);
    tagCache.set(absPath, tags);
    const imagesByDir = updateImageTagsInDir(get().imagesByDir, absPath, tags, label);
    set({ tagCache, tagCounts: recomputeTagCounts(tagCache), imagesByDir });
  },

  bumpTagEpoch: () => set({ tagEpoch: get().tagEpoch + 1 }),

  setPreview: (image, list) => {
    const index = Math.max(
      0,
      list.findIndex((img) => img.absPath === image.absPath)
    );
    set({ preview: { image: list[index] ?? image, index, list } });
  },

  closePreview: () => set({ preview: null }),

  previewStep: (delta) => {
    const preview = get().preview;
    if (!preview || preview.list.length === 0) return;
    const nextIndex = (preview.index + delta + preview.list.length) % preview.list.length;
    set({
      preview: {
        ...preview,
        index: nextIndex,
        image: preview.list[nextIndex]
      }
    });
  },

  setSnackbar: (snackbar) => set({ snackbar })
}));
