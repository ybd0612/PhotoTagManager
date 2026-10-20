import { create } from 'zustand';
import { call, getApi } from '../api';
import { DEFAULT_UI_PREFS } from '../../shared/types';
import type {
  FolderNode,
  ImageFile,
  RootEntry,
  ScanBatch,
  ScanStats,
  SortDir,
  SortKey,
  TagInfo,
  ThumbSize,
  UiPrefs
} from '../../shared/types';

/** 偏好落盘失败只影响下次启动的默认值，不该打断当前交互 */
function persistPrefs(patch: Partial<UiPrefs>): void {
  try {
    void call(getApi().setPrefs(patch)).catch(() => undefined);
  } catch {
    // 测试环境没有 window.api 时忽略
  }
}

/**
 * 全局内存模型（ARCHITECTURE §3.2，多根 R10）。
 * - 多根：roots[] + selectedRootId；目录树/图片/隐藏均按 rootId 分桶。
 * - 目录树节点用模块级 nodeMap 保存（增量合并，不参与响应式）；store 只暴露当前根 tree。
 * - 复合 key = `${rootId}\u0000${relPath}`，避免不同根同 relPath 冲突。
 */

import { planImageRemoval } from './removeImages';

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

/** 复合 key：rootId + 根内相对路径 */
export const rootKey = (rootId: string, relPath: string): string => `${rootId}\u0000${relPath}`;

interface AppState {
  roots: RootEntry[];
  selectedRootId: string | null;
  scanState: ScanState;
  scanStateByRoot: Map<string, ScanState>;
  scanStats: ScanStats | null; // 最后一次扫描（全局，兼容旧引用）
  scanStatsByRoot: Map<string, ScanStats>; // 按根统计（底部状态栏按选中根显示）
  activeScanIds: Map<string, string>;
  tree: FolderNode[]; // 当前选中根的顶层目录（由 treesByRoot 派生，切换根时重建）
  treesByRoot: Map<string, FolderNode[]>;
  imagesByDir: Map<string, ImageFile[]>; // key = rootKey(rootId, dirRelPath)
  scannedRoots: Set<string>; // 懒扫描：已扫过的根集合
  hiddenSet: Set<string>; // key = rootKey(rootId, relPath)
  tagFilter: TagFilterState;
  selectedDir: string | null; // 当前根内相对路径
  selectedImages: Set<string>;
  /** 文件名搜索串（批次1）：只过滤当前目录视图，不动扫描数据 */
  nameQuery: string;
  /** 视图偏好：排序、缩略图档位与扫描完成提示，启动时从 settings.json 读回 */
  sortKey: SortKey;
  sortDir: SortDir;
  thumbSize: ThumbSize;
  scanDoneToast: boolean;
  /** 应用网络请求使用的代理，形如 127.0.0.1:7890；空 = 不覆盖，跟随系统默认 */
  proxyRules: string;
  /** 左栏目录树是否收起（落盘，重启保留用户上次的选择） */
  treeCollapsed: boolean;
  /** 找图工具行是否展开（落盘，与左栏折叠同一套做法） */
  filterBarVisible: boolean;
  /** 大图预览左上角 EXIF 面板是否展开（落盘，用户 2026-10-20 明确要求记住） */
  exifPanelExpanded: boolean;
  toggleExifPanel(): void;
  setNameQuery(query: string): void;
  /** 同一个键再点一次 = 翻转方向；换键 = 该键的默认方向 asc */
  setSort(key: SortKey): void;
  setThumbSize(size: ThumbSize): void;
  setScanDoneToast(on: boolean): void;
  setProxyRules(rules: string): void;
  toggleTreeCollapsed(): void;
  toggleFilterBar(): void;
  loadUiPrefs(): Promise<void>;
  tagCache: Map<string, string[]>;
  tagCounts: Map<string, number>;
  tagEpoch: number;
  preview: PreviewState | null;
  snackbar: string | null;

  // 根目录
  setRoots(roots: RootEntry[]): void;
  addRootLocal(entry: RootEntry): void;
  removeRootLocal(rootId: string): void;
  renameRootLocal(rootId: string, alias: string): void;
  reorderRootsLocal(orderedIds: string[]): void;
  selectRoot(rootId: string): void;
  // 扫描
  setScanState(state: ScanState): void;
  setRootScanState(rootId: string, state: ScanState): void;
  setScanStats(stats: ScanStats | null): void;
  resetScan(rootId: string, scanId?: string): void;
  mergeScanBatch(batch: ScanBatch): void;
  finishScan(rootId: string, scanId: string, state: Exclude<ScanState, 'scanning'>, stats?: ScanStats): boolean;
  cancelRootScan(rootId: string): void;
  // 隐藏
  setHiddenSet(rootId: string, relPaths: string[]): void;
  hideFolderLocal(rootId: string, relPath: string): void;
  unhideFolderLocal(rootId: string, relPath: string): void;
  // 目录/选择
  selectDir(relPath: string): void;
  toggleSelectImage(id: string): void;
  clearSelection(): void;
  /** 文件已被移到回收站：把内存里的账目对齐（列表 / 目录计数 / 选中 / 标签 / 预览） */
  removeImagesLocal(absPaths: string[]): void;
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

// 模块级目录节点索引：rootKey(rootId, relPath) → FolderNode（增量合并用）
const nodeMap = new Map<string, FolderNode>();

/** 取父目录 relPath（'' 表示根目录） */
export function getParentRelPath(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '' : relPath.slice(0, idx);
}

/** 递归写入节点及其子树到索引（key 带 rootId 前缀，保证索引对象与最新克隆一致） */
function setNodeSubtree(map: Map<string, FolderNode>, rootId: string, node: FolderNode): void {
  map.set(rootKey(rootId, node.relPath), node);
  for (const child of node.children) {
    setNodeSubtree(map, rootId, child);
  }
}

function markHiddenFromSet(rootId: string): void {
  const { hiddenSet } = useAppStore.getState();
  const prefix = `${rootId}\u0000`;
  for (const [key, node] of nodeMap) {
    if (key.startsWith(prefix)) {
      node.hidden = hiddenSet.has(key);
    }
  }
}

/** 重建指定根的顶层目录子节点列表（父 relPath 为 '' 的节点） */
function rebuildRootChildren(rootId: string): FolderNode[] {
  const prefix = `${rootId}\u0000`;
  const roots: FolderNode[] = [];
  for (const [key, node] of nodeMap) {
    if (!key.startsWith(prefix)) continue;
    if (getParentRelPath(key.slice(prefix.length)) === '') {
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
  roots: [],
  selectedRootId: null,
  scanState: 'idle',
  scanStateByRoot: new Map(),
  scanStats: null,
  scanStatsByRoot: new Map(),
  activeScanIds: new Map(),
  tree: [],
  treesByRoot: new Map(),
  imagesByDir: new Map(),
  scannedRoots: new Set(),
  hiddenSet: new Set(),
  tagFilter: { tags: [], mode: 'AND' },
  selectedDir: null,
  selectedImages: new Set(),
  nameQuery: '',
  sortKey: DEFAULT_UI_PREFS.sortKey,
  sortDir: DEFAULT_UI_PREFS.sortDir,
  thumbSize: DEFAULT_UI_PREFS.thumbSize,
  scanDoneToast: DEFAULT_UI_PREFS.scanDoneToast,
  proxyRules: DEFAULT_UI_PREFS.proxyRules,
  treeCollapsed: DEFAULT_UI_PREFS.treeCollapsed,
  filterBarVisible: DEFAULT_UI_PREFS.filterBarVisible,
  exifPanelExpanded: DEFAULT_UI_PREFS.exifPanelExpanded,

  setNameQuery: (nameQuery) => set({ nameQuery }),

  setSort: (key) => {
    const s = get();
    const sortDir: SortDir = s.sortKey === key ? (s.sortDir === 'asc' ? 'desc' : 'asc') : 'asc';
    set({ sortKey: key, sortDir });
    persistPrefs({ sortKey: key, sortDir });
  },

  setThumbSize: (thumbSize) => {
    set({ thumbSize });
    persistPrefs({ thumbSize });
  },

  setScanDoneToast: (scanDoneToast) => {
    set({ scanDoneToast });
    persistPrefs({ scanDoneToast });
  },

  setProxyRules: (proxyRules) => {
    set({ proxyRules });
    persistPrefs({ proxyRules });
  },

  toggleTreeCollapsed: () => {
    const treeCollapsed = !get().treeCollapsed;
    set({ treeCollapsed });
    persistPrefs({ treeCollapsed });
  },

  toggleFilterBar: () => {
    const filterBarVisible = !get().filterBarVisible;
    set({ filterBarVisible });
    persistPrefs({ filterBarVisible });
  },

  toggleExifPanel: () => {
    const exifPanelExpanded = !get().exifPanelExpanded;
    set({ exifPanelExpanded });
    persistPrefs({ exifPanelExpanded });
  },

  loadUiPrefs: async () => {
    try {
      const prefs = await call(getApi().getPrefs());
      // 逐字段赋值：新增偏好漏一行，它就会在重启后静默回到默认值
      set({
        sortKey: prefs.sortKey,
        sortDir: prefs.sortDir,
        thumbSize: prefs.thumbSize,
        scanDoneToast: prefs.scanDoneToast,
        proxyRules: prefs.proxyRules,
        treeCollapsed: prefs.treeCollapsed,
        filterBarVisible: prefs.filterBarVisible,
        exifPanelExpanded: prefs.exifPanelExpanded
      });
    } catch {
      // 读不到偏好就用默认值，不能因此卡住启动
    }
  },
  tagCache: new Map(),
  tagCounts: new Map(),
  tagEpoch: 0,
  preview: null,
  snackbar: null,

  // ---- 根目录（R10） ----
  setRoots: (roots) => {
    const selectedRootId = get().selectedRootId;
    const treesByRoot = new Map<string, FolderNode[]>();
    for (const root of roots) {
      treesByRoot.set(root.id, rebuildRootChildren(root.id));
    }
    set({
      roots,
      treesByRoot,
      tree: selectedRootId ? (treesByRoot.get(selectedRootId) ?? []) : []
    });
  },

  addRootLocal: (entry) => {
    if (get().roots.some((root) => root.id === entry.id)) return;
    const roots = [...get().roots, entry];
    const treesByRoot = new Map(get().treesByRoot);
    treesByRoot.set(entry.id, rebuildRootChildren(entry.id));
    set({ roots, treesByRoot });
  },

  removeRootLocal: (rootId) => {
    const roots = get().roots.filter((r) => r.id !== rootId);
    const prefix = `${rootId}\u0000`;
    for (const key of [...nodeMap.keys()]) {
      if (key.startsWith(prefix)) nodeMap.delete(key);
    }
    const treesByRoot = new Map(get().treesByRoot);
    treesByRoot.delete(rootId);
    const imagesByDir = new Map(get().imagesByDir);
    for (const key of [...imagesByDir.keys()]) {
      if (key.startsWith(prefix)) imagesByDir.delete(key);
    }
    const scannedRoots = new Set(get().scannedRoots);
    scannedRoots.delete(rootId);
    const hiddenSet = new Set(get().hiddenSet);
    for (const key of [...hiddenSet]) {
      if (key.startsWith(prefix)) hiddenSet.delete(key);
    }
    const wasSelected = get().selectedRootId === rootId;
    const selectedRootId = wasSelected ? (roots[0]?.id ?? null) : get().selectedRootId;
    const scanStatsByRoot = new Map(get().scanStatsByRoot);
    scanStatsByRoot.delete(rootId);
    const scanStateByRoot = new Map(get().scanStateByRoot);
    scanStateByRoot.delete(rootId);
    const activeScanIds = new Map(get().activeScanIds);
    activeScanIds.delete(rootId);
    set({
      roots,
      treesByRoot,
      imagesByDir,
      scannedRoots,
      hiddenSet,
      scanStatsByRoot,
      scanStateByRoot,
      activeScanIds,
      selectedRootId,
      selectedDir: wasSelected ? '' : get().selectedDir,
      tree: selectedRootId ? (treesByRoot.get(selectedRootId) ?? []) : []
    });
  },

  renameRootLocal: (rootId, alias) => {
    const roots = get().roots.map((r) => (r.id === rootId ? { ...r, alias } : r));
    set({ roots });
  },

  /**
   * 按给定 id 顺序重排根目录（树里拖拽 / 菜单上移下移）。
   * 保持 id 与序号写回 roots 本身，树与网格都从 roots 派生，不用另开一份排序状态。
   * 未列出的根按原相对次序接在后面——不会因为一次局部重排把别的根弄丢。
   */
  reorderRootsLocal: (orderedIds) => {
    const roots = get().roots;
    if (roots.length === 0) return;
    const rank = new Map(orderedIds.map((id, index) => [id, index]));
    if (rank.size === 0) return;
    const sorted = [...roots].sort((a, b) => {
      const ra = rank.get(a.id);
      const rb = rank.get(b.id);
      // 两边都没被点名 = 保持原相对次序（稳定排序）
      if (ra === undefined && rb === undefined) return roots.indexOf(a) - roots.indexOf(b);
      if (ra === undefined) return 1;
      if (rb === undefined) return -1;
      return ra - rb;
    });
    if (sorted.every((root, i) => root.id === roots[i].id)) return;
    set({ roots: sorted.map((root, index) => ({ ...root, sortOrder: index })) });
  },

  selectRoot: (rootId) => {
    const treesByRoot = get().treesByRoot;
    set({
      selectedRootId: rootId,
      selectedDir: '',
      selectedImages: new Set(),
      scanState: get().scanStateByRoot.get(rootId) ?? 'idle',
      tree: treesByRoot.get(rootId) ?? []
    });
  },

  // ---- 扫描 ----
  setScanState: (scanState) => set({ scanState }),
  setRootScanState: (rootId, scanState) => {
    const scanStateByRoot = new Map(get().scanStateByRoot);
    scanStateByRoot.set(rootId, scanState);
    set({ scanStateByRoot, ...(get().selectedRootId === rootId ? { scanState } : {}) });
  },
  setScanStats: (scanStats) => set({ scanStats }),

  resetScan: (rootId, scanId) => {
    const prefix = `${rootId}\u0000`;
    for (const key of [...nodeMap.keys()]) {
      if (key.startsWith(prefix)) nodeMap.delete(key);
    }
    const treesByRoot = new Map(get().treesByRoot);
    treesByRoot.set(rootId, []);
    const imagesByDir = new Map(get().imagesByDir);
    for (const key of [...imagesByDir.keys()]) {
      if (key.startsWith(prefix)) imagesByDir.delete(key);
    }
    const isSelected = get().selectedRootId === rootId;
    const scanStatsByRoot = new Map(get().scanStatsByRoot);
    scanStatsByRoot.delete(rootId);
    const scanStateByRoot = new Map(get().scanStateByRoot);
    scanStateByRoot.set(rootId, 'scanning');
    const activeScanIds = new Map(get().activeScanIds);
    if (scanId) activeScanIds.set(rootId, scanId);
    else activeScanIds.delete(rootId);
    set({
      scanState: isSelected ? 'scanning' : get().scanState,
      scanStats: isSelected ? null : get().scanStats,
      scanStatsByRoot,
      scanStateByRoot,
      activeScanIds,
      treesByRoot,
      imagesByDir,
      // 后台扫描非选中根时不重置当前选中根的浏览状态（启动自动扫描所有根场景）
      ...(isSelected ? { selectedDir: '', selectedImages: new Set(), tree: [] } : {})
    });
  },

  mergeScanBatch: (batch) => {
    const rootId = batch.rootId;
    if (get().activeScanIds.get(rootId) !== batch.scanId || batch.kind === 'progress' && batch.images.length > 0) return;
    for (const folder of batch.folders) {
      setNodeSubtree(nodeMap, rootId, folder);
    }
    const treesByRoot = new Map(get().treesByRoot);
    treesByRoot.set(rootId, rebuildRootChildren(rootId));

    const imagesByDir = new Map(get().imagesByDir);
    for (const image of batch.images) {
      const key = rootKey(rootId, image.dirRelPath);
      const arr = [...(imagesByDir.get(key) ?? [])];
      const index = arr.findIndex((current) => current.id === image.id);
      if (index >= 0) arr[index] = image;
      else arr.push(image);
      imagesByDir.set(key, arr);
    }

    const scannedRoots = new Set(get().scannedRoots);

    const scanStatsByRoot = new Map(get().scanStatsByRoot);
    scanStatsByRoot.set(rootId, batch.stats);

    const tree = get().selectedRootId === rootId ? (treesByRoot.get(rootId) ?? []) : get().tree;

    set({ treesByRoot, tree, imagesByDir, scannedRoots, scanStatsByRoot, scanStats: batch.stats });
  },

  finishScan: (rootId, scanId, state, stats) => {
    if (get().activeScanIds.get(rootId) !== scanId) return false;
    const scanStateByRoot = new Map(get().scanStateByRoot);
    scanStateByRoot.set(rootId, state);
    const activeScanIds = new Map(get().activeScanIds);
    const scannedRoots = new Set(get().scannedRoots);
    if (state === 'done') scannedRoots.add(rootId);
    else scannedRoots.delete(rootId);
    const isSelected = get().selectedRootId === rootId;
    set({
      scanStateByRoot,
      activeScanIds,
      scannedRoots,
      ...(isSelected ? { scanState: state, scanStats: stats ?? get().scanStats } : {})
    });
    return true;
  },

  cancelRootScan: (rootId) => {
    const scanStateByRoot = new Map(get().scanStateByRoot);
    scanStateByRoot.set(rootId, 'idle');
    const activeScanIds = new Map(get().activeScanIds);
    activeScanIds.delete(rootId);
    const scannedRoots = new Set(get().scannedRoots);
    scannedRoots.delete(rootId);
    const isSelected = get().selectedRootId === rootId;
    set({ scanStateByRoot, activeScanIds, scannedRoots, ...(isSelected ? { scanState: 'idle' } : {}) });
  },

  // ---- 隐藏（按根） ----
  setHiddenSet: (rootId, relPaths) => {
    const hiddenSet = new Set(get().hiddenSet);
    const prefix = `${rootId}\u0000`;
    for (const key of [...hiddenSet]) {
      if (key.startsWith(prefix)) hiddenSet.delete(key);
    }
    for (const relPath of relPaths) {
      hiddenSet.add(rootKey(rootId, relPath));
    }
    set({ hiddenSet });
    markHiddenFromSet(rootId);
    const treesByRoot = new Map(get().treesByRoot);
    treesByRoot.set(rootId, rebuildRootChildren(rootId));
    const tree = get().selectedRootId === rootId ? (treesByRoot.get(rootId) ?? []) : get().tree;
    set({ treesByRoot, tree });
  },

  hideFolderLocal: (rootId, relPath) => {
    const hiddenSet = new Set(get().hiddenSet);
    hiddenSet.add(rootKey(rootId, relPath));
    const node = nodeMap.get(rootKey(rootId, relPath));
    if (node) node.hidden = true;
    const treesByRoot = new Map(get().treesByRoot);
    treesByRoot.set(rootId, rebuildRootChildren(rootId));
    const tree = get().selectedRootId === rootId ? (treesByRoot.get(rootId) ?? []) : get().tree;
    // 隐藏当前浏览目录或其祖先：该节点已从树上消失，选中态复位到根目录（避免停在不可达的空选中）
    const { selectedDir } = get();
    const hidesSelection =
      relPath !== '' &&
      selectedDir !== null &&
      (selectedDir === relPath || selectedDir.startsWith(`${relPath}/`));
    set({
      hiddenSet,
      treesByRoot,
      tree,
      ...(hidesSelection ? { selectedDir: '', selectedImages: new Set<string>() } : {})
    });
  },

  unhideFolderLocal: (rootId, relPath) => {
    const hiddenSet = new Set(get().hiddenSet);
    hiddenSet.delete(rootKey(rootId, relPath));
    const node = nodeMap.get(rootKey(rootId, relPath));
    if (node) node.hidden = false;
    const treesByRoot = new Map(get().treesByRoot);
    treesByRoot.set(rootId, rebuildRootChildren(rootId));
    const tree = get().selectedRootId === rootId ? (treesByRoot.get(rootId) ?? []) : get().tree;
    set({ hiddenSet, treesByRoot, tree });
  },

  // ---- 目录/选择 ----
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

  // ---- 标签筛选 ----
  toggleFilterTag: (tag) => {
    const { tags } = get().tagFilter;
    const next = tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag];
    set({ tagFilter: { ...get().tagFilter, tags: next } });
  },

  setFilterMode: (mode) => set({ tagFilter: { ...get().tagFilter, mode } }),

  clearFilter: () => set({ tagFilter: { tags: [], mode: get().tagFilter.mode } }),

  // ---- 标签数据（按 absPath 全局，跨根天然唯一） ----
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

  // ---- 预览 ----
  setPreview: (image, list) => {
    const index = Math.max(
      0,
      list.findIndex((img) => img.absPath === image.absPath)
    );
    set({ preview: { image: list[index] ?? image, index, list } });
  },

  removeImagesLocal: (absPaths) => {
    const s = get();
    const patch = planImageRemoval(
      {
        imagesByDir: s.imagesByDir,
        selectedImages: s.selectedImages,
        tagCache: s.tagCache,
        preview: s.preview,
        selectedRootId: s.selectedRootId
      },
      absPaths,
      (key) => nodeMap.get(key)
    );
    if (!patch) return;
    const treesByRoot = new Map(s.treesByRoot);
    for (const rootId of patch.touchedRootIds) treesByRoot.set(rootId, rebuildRootChildren(rootId));
    set({
      imagesByDir: patch.imagesByDir,
      selectedImages: patch.selectedImages,
      ...(patch.tagCache ? { tagCache: patch.tagCache, tagCounts: recomputeTagCounts(patch.tagCache) } : {}),
      preview: patch.preview,
      treesByRoot,
      tree: s.selectedRootId ? treesByRoot.get(s.selectedRootId) ?? [] : s.tree
    });
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
