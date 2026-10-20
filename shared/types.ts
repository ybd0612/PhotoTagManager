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
  hidden: boolean; // 是否在隐藏集（树渲染剪枝 + 父级递归汇总剪枝；显式选中该目录时仍出图）
  childrenLoaded: boolean; // 懒加载标记：false 时 children 为空，展开时再填充
  children: FolderNode[]; // 子目录（按名称排序）
}

/** 根目录条目（多根 + 别名）：根列表持久化于 userData/roots.json */
export interface RootEntry {
  id: string; // sha1(path) 前 8 位，稳定唯一
  path: string; // 绝对路径
  alias: string; // 别名（默认目录名，可改），如"照片""资料"
  addedAt: number; // 添加时间戳
  /**
   * 手动排序序号（树里拖拽根目录写入），越小越靠前。
   * 老数据没有这个字段：读取时按 addedAt 升序补齐，所以正常不会缺失；list() 里仍留兜底排序。
   */
  sortOrder?: number;
}

/** 扫描增量批（Worker → 主 → 渲染，每 ~200 文件一批；rootId 由主进程补全） */
export interface ScanBatch {
  rootId: string; // 所属根目录 id（worker 侧为空串，主进程转发时填充）
  scanId: string; // 本次扫描唯一标识，阻断旧 Worker 消息串线
  kind: 'data' | 'progress'; // 数据批次或纯进度消息
  batchIndex: number;
  folders: FolderNode[]; // 本批新增/更新的目录节点（覆盖合并到 store 树）
  images: ImageFile[]; // 本批图片
  stats: ScanStats;
}

export interface ScanStats {
  scannedFiles: number; // 已扫描文件数（含非图片）
  imageCount: number; // 已发现图片数
  totalFiles: number; // 预计总文件数；扫描进行中按已知文件数估计，完成后等于 scannedFiles
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
  add?: string[]; // 要新增的标签（写 XMP-ptm:Tags，自动去重）
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
  /* ── 摄影参数与文件信息（2026-10-20：预览左上角信息面板要的全套 EXIF）──
   * 全部可选：exiftool 读不到的字段一律不给键，界面也不占位显示空值。
   * 格式换算见 electron/services/exifFields.ts（换算是本项目做的，不是 exiftool 直接给的）。 */
  /** 文件名（含扩展名，与扫描器一致） */
  fileName?: string;
  /** 拍摄时间，形如 `2023/09/23 09:50:48`。**不带时区偏移** —— EXIF 里那个是拍摄地墙上时间，与文件修改时间（本地时）混排会让人以为照片被改过 */
  dateTimeOriginalWithOffset?: string;
  /** 文件系统修改时间，形如 `2026/10/07 01:56:29` */
  fileModified?: string;
  /** 相机软件/固件版本，如 `ILCE-7M4 v1.10` */
  software?: string;
  /** 闪光灯状态原文，如 `Off, Did not fire` */
  flash?: string;
  /** 焦距，如 `46mm`；与实际焦距不同时会追加「（等效 35mm：24mm）」 */
  focalLength?: string;
  /** 快门速度，如 `0.006s (1/160)` */
  shutterSpeed?: string;
  /** 光圈，如 `f/4.0` */
  aperture?: string;
  /** ISO 感光度，如 `125` */
  iso?: string;
  /** 曝光程序，如 `Manual` */
  exposureProgram?: string;
  /** 测光模式，如 `Multi-segment` */
  meteringMode?: string;
  /** 曝光补偿，如 `+0.3 EV`。**为 0 时不给键** —— 有值与「补偿了 0」是两回事 */
  exposureCompensation?: string;
  /** 图像格式，如 `JPEG` */
  fileType?: string;
  /** 色彩空间，如 `Uncalibrated` */
  colorSpace?: string;
}

/** 自动更新状态（electron-updater → 主进程 → 渲染进程，经 'update:status' 通道推送） */
export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'dev-mode';
  version?: string; // 可用新版本号
  percent?: number; // 下载进度 0-100
  message?: string; // 错误信息
}

/** IPC 统一响应信封 */
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

/** 视图偏好：排序与缩略图档位，持久化在 userData/settings.json 的 ui 段 */
export type SortKey = 'name' | 'time' | 'size';
export type SortDir = 'asc' | 'desc';
export type ThumbSize = 'small' | 'medium' | 'large';

export interface UiPrefs {
  sortKey: SortKey;
  sortDir: SortDir;
  thumbSize: ThumbSize;
  /** 扫描完成后是否额外弹一条 snackbar。状态栏已常驻「已扫描 N 张图片」，默认不重复播报 */
  scanDoneToast: boolean;
  /**
   * 应用网络请求使用的代理，形如 `127.0.0.1:7890`；空字符串 = 不覆盖，跟随系统默认。
   * 只影响应用自身的网络请求——照片始终不出本机，本应用没有任何上传照片的请求。
   */
  proxyRules: string;
  /**
   * 左侧目录树是否收起。收起后网格多出约 280px（约一列缩略图），
   * 当前目录仍由顶栏面包屑显示，所以不会失去定位。默认展开。
   */
  treeCollapsed: boolean;
  /**
   * 找图工具行（搜索 + 排序 + 标签筛选 + 缩略图档位）是否展开。
   * 收起后只剩「常用标签」那一行，图片区多出约 40px；默认展开。
   */
  filterBarVisible: boolean;
  /**
   * 大图预览左上角的 EXIF 信息面板是否展开（2026-10-20）。
   *
   * 完整面板 15 行会盖住画面左上角约三分之一，所以可折叠。
   * **默认展开**：用户明确要求「默认显示，可以折叠，并记住设置」。
   */
  exifPanelExpanded: boolean;
}

/** 默认与既有行为一致：按相对路径升序、最小档缩略图、左栏展开 */
export const DEFAULT_UI_PREFS: UiPrefs = {
  sortKey: 'name',
  sortDir: 'asc',
  thumbSize: 'small',
  scanDoneToast: false,
  proxyRules: '',
  treeCollapsed: false,
  filterBarVisible: true,
  exifPanelExpanded: true
};

/** 移到回收站的结果：逐条给失败原因，部分失败不允许静默 */
export interface TrashResult {
  trashed: string[];
  failed: Array<{ absPath: string; reason: string }>;
}

/** preload 暴露到 window.api 的白名单接口（electron/preload.ts 与 src/api.ts 严格一致） */
export interface PhotoTagApi {
  // 移到系统回收站（可恢复）；主进程只放行落在已添加根目录内的路径
  trashFiles(absPaths: string[]): Promise<IpcResult<TrashResult>>;
  // 视图偏好（排序、缩略图档位）持久化在 userData/settings.json
  getPrefs(): Promise<IpcResult<UiPrefs>>;
  setPrefs(patch: Partial<UiPrefs>): Promise<IpcResult<UiPrefs>>;
  // 窗口控制：右上角三个按钮由渲染层自绘（系统的画在网页之上，预览遮不住、对话框也压不住）
  windowMinimize(): Promise<IpcResult<void>>;
  windowToggleMaximize(): Promise<IpcResult<void>>;
  windowClose(): Promise<IpcResult<void>>;
  isWindowMaximized(): Promise<IpcResult<boolean>>;
  onWindowMaximized(cb: (maximized: boolean) => void): () => void;
  // 目录选择
  pickDirectory(): Promise<IpcResult<string | null>>;
  // 多根目录（R10：多根 + 别名）
  listRoots(): Promise<IpcResult<RootEntry[]>>;
  addRoot(path: string, alias?: string): Promise<IpcResult<RootEntry>>;
  removeRoot(rootId: string): Promise<IpcResult<void>>;
  renameRoot(rootId: string, alias: string): Promise<IpcResult<RootEntry | null>>;
  /** 重排根目录：按给定 id 顺序重写排序序号（树里拖拽根目录落盘用） */
  reorderRoots(orderedIds: string[]): Promise<IpcResult<void>>;
  // 扫描（懒扫描：选中未扫过的根才触发；rootId + scanId 标识扫描代际）
  scanStart(rootId: string, rootPath: string, scanId: string): Promise<IpcResult<{ rootId: string; rootPath: string; scanId: string }>>;
  scanCancel(): Promise<IpcResult<void>>;
  onScanProgress(cb: (batch: ScanBatch) => void): () => void;
  onScanDone(cb: (payload: { rootId: string; rootPath: string; scanId: string; stats: ScanStats }) => void): () => void;
  onScanError(cb: (error: { code: string; message: string; rootId: string; scanId: string }) => void): () => void;
  // 文件夹隐藏（按根隔离）
  hideFolder(rootId: string, relPath: string): Promise<IpcResult<void>>;
  unhideFolder(rootId: string, relPath: string): Promise<IpcResult<void>>;
  listHiddenFolders(rootId: string): Promise<IpcResult<HiddenFolderRecord[]>>;
  // 在资源管理器中打开目录
  openFolderInExplorer(absPath: string): Promise<IpcResult<void>>;
  // 通过系统默认浏览器打开白名单外部链接
  openExternal(url: string): Promise<IpcResult<void>>;
  // 在资源管理器中定位文件
  revealFileInExplorer(absPath: string): Promise<IpcResult<void>>;
  // 复制文件到剪贴板（FileNameW 格式，可在资源管理器粘贴；text 同时写入路径）
  copyFileToClipboard(absPath: string): Promise<IpcResult<void>>;
  // 复制纯文本到剪贴板（底部状态栏「点击复制路径」）
  copyTextToClipboard(text: string): Promise<IpcResult<void>>;
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
  // 自动更新（electron-updater + GitHub Releases）
  checkUpdate(): Promise<IpcResult<UpdateStatus>>;
  downloadUpdate(): Promise<IpcResult<UpdateStatus>>;
  installUpdate(): Promise<IpcResult<UpdateStatus>>;
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void;
}
