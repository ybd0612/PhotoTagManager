/**
 * PhotoTagManager 共享类型定义（主进程 / Worker / 渲染进程共用）。
 * 约定（ARCHITECTURE §7）：一切跨进程类型只放本文件；本文件不得 import electron。
 */

/** 图片文件元数据（扫描产物，不含 XMP 标签——标签按需读取） */
export interface ImageFile {
  id: string; // sha1(absPath) 前 16 位，全局唯一
  absPath: string; // 绝对路径（Windows，如 C:\Photos\a.jpg）
  relPath: string; // 相对根目录路径，统一用 '/' 分隔（如 2024/01/a.jpg，根目录直接文件为文件名）
  name: string; // 文件名
  ext: string; // 小写扩展名，如 .jpg
  size: number; // 字节
  mtimeMs: number; // 修改时间戳（缩略图缓存 key 的一部分）
  dirRelPath: string; // 所在目录相对路径（'' 表示根目录直接文件）
  tags: string[]; // 内存中的标签缓存（读取后填充；写回后更新）
  label?: string; // xmp:Label 主标签
}

/** 目录节点（D1：directCount + totalCount，totalCount>0 才显示） */
export interface FolderNode {
  relPath: string; // '' 为根；子目录如 '2024/01'
  name: string; // 目录名
  directCount: number; // 直接包含的图片数
  totalCount: number; // 递归包含的图片总数（含全部后代）
  hidden: boolean; // 是否在隐藏集（渲染时剪枝）
  childrenLoaded: boolean; // 懒加载标记：false 时 children 为空，展开时再填充
  children: FolderNode[]; // 子目录（按名称排序）
}

/** 根目录条目（多根 + 别名）：根列表持久化于 userData/roots.json */
export interface RootEntry {
  id: string; // sha1(path) 前 8 位，稳定唯一
  path: string; // 绝对路径
  alias: string; // 别名（默认目录名，可改），如"照片""资料"
  addedAt: number; // 添加时间戳
}

/** 扫描增量批（Worker → 主 → 渲染，每 ~200 文件一批；rootId 由主进程补全） */
export interface ScanBatch {
  rootId: string; // 所属根目录 id（worker 侧为空串，主进程转发时填充）
  batchIndex: number;
  folders: FolderNode[]; // 本批新增/更新的目录节点（覆盖合并到 store 树）
  images: ImageFile[]; // 本批图片
  stats: ScanStats;
}

export interface ScanStats {
  scannedFiles: number; // 已扫描文件数（含非图片）
  imageCount: number; // 已发现图片数
  totalFiles: number; // 预计总文件数（遍历中渐进估计；完成后等于 scannedFiles）
  done: boolean; // 是否最后一批
}

/** 隐藏持久化记录（D2：按 rootId + 相对根目录路径） */
export interface HiddenFolderRecord {
  rootId: string; // 所属根目录 id
  relPath: string; // 如 '2024/01' 或 ''（隐藏整个根目录的场景允许，UI 上根目录隐藏被禁用）
  hiddenAt: number; // 时间戳
}

/** XMP 标签读取结果（D3：dc:subject 合并去重 + xmp:Label） */
export interface TagInfo {
  absPath: string;
  subjects: string[]; // dc:subject 去重合并
  label?: string; // xmp:Label
  ok: boolean;
  error?: string;
}

/** 标签写入请求（D3：add/remove 差量，保留其他字段） */
export interface TagWriteRequest {
  absPath: string;
  add?: string[]; // 要新增的标签（写 dc:subject，自动去重）
  remove?: string[]; // 要删除的标签
  setLabel?: string; // 设置主标签 xmp:Label
}

/** 缩略图（缓存 key = sha1(`${absPath}:${mtimeMs}:${size}`)） */
export interface ThumbnailResult {
  absPath: string;
  dataUrl: string; // base64 data URL（jpeg）
  width: number;
  height: number;
  source: 'cache' | 'native' | 'exiftool' | 'placeholder';
}

/** 图片基本信息（P1：预览时展示分辨率/拍摄时间/文件大小） */
export interface ImageInfo {
  absPath: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
  dateTimeOriginal?: string;
  make?: string;
  model?: string;
  ok: boolean;
  error?: string;
}

/** IPC 统一响应信封 */
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

/** preload 暴露到 window.api 的白名单接口（electron/preload.ts 与 src/api.ts 严格一致） */
export interface PhotoTagApi {
  // 目录选择
  pickDirectory(): Promise<IpcResult<string | null>>;
  // 多根目录（R10：多根 + 别名）
  listRoots(): Promise<IpcResult<RootEntry[]>>;
  addRoot(path: string, alias?: string): Promise<IpcResult<RootEntry>>;
  removeRoot(rootId: string): Promise<IpcResult<void>>;
  renameRoot(rootId: string, alias: string): Promise<IpcResult<RootEntry | null>>;
  // 扫描（懒扫描：选中未扫过的根才触发；rootId 标识所属根）
  scanStart(rootId: string, rootPath: string): Promise<IpcResult<{ rootId: string; rootPath: string }>>;
  scanCancel(): Promise<IpcResult<void>>;
  onScanProgress(cb: (batch: ScanBatch) => void): () => void;
  onScanDone(cb: (payload: { rootId: string; rootPath: string; stats: ScanStats }) => void): () => void;
  onScanError(cb: (error: { code: string; message: string }) => void): () => void;
  // 文件夹隐藏（按根隔离）
  hideFolder(rootId: string, relPath: string): Promise<IpcResult<void>>;
  unhideFolder(rootId: string, relPath: string): Promise<IpcResult<void>>;
  listHiddenFolders(rootId: string): Promise<IpcResult<HiddenFolderRecord[]>>;
  // 在资源管理器中打开目录
  openFolderInExplorer(absPath: string): Promise<IpcResult<void>>;
  // 标签
  readImageTags(absPath: string): Promise<IpcResult<TagInfo>>;
  readBulkTags(absPaths: string[]): Promise<IpcResult<TagInfo[]>>;
  writeImageTags(req: TagWriteRequest): Promise<IpcResult<TagInfo>>;
  writeBatchTags(reqs: TagWriteRequest[]): Promise<IpcResult<{ okCount: number; failCount: number }>>;
  onBatchProgress(cb: (p: { done: number; total: number }) => void): () => void;
  renameTag(from: string, to: string): Promise<IpcResult<number>>; // P1
  // 缩略图
  getThumbnail(absPath: string): Promise<IpcResult<ThumbnailResult | null>>;
  onThumbReady(cb: (thumb: ThumbnailResult) => void): () => void;
  // 图片信息（P1）
  getImageInfo(absPath: string): Promise<IpcResult<ImageInfo>>;
}
