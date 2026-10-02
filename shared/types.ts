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

/** 模型在本机的状态（下拉里每行都要显示）。只描述磁盘/传输真相，不掺能力判断 */
export type AiModelStatus = 'absent' | 'downloading' | 'present';

/** 清单里的一个候选模型 + 它的本机状态（能力清单是唯一事实源，界面不写死任何字段） */
export interface AiModelView {
  id: string;
  displayName: string;
  sizeBytes: number;
  /** 只有实测跑通的条目允许进 UI（规格 §4.3 硬规则） */
  verified: boolean;
  status: AiModelStatus;
  /**
   * 本机跑不动时给一句"为什么 + 怎么办"（规格 §6「无可用 GPU → 条目转不可用并说明原因」）。
   * 刻意不并进 status：status 要如实反映磁盘状态，否则那颗 下载/删除 按钮会判错。
   */
  statusReason?: string;
  /** 是否已加载进显存。加载对用户不可见（D14），但下拉里要如实显示 */
  loaded: boolean;
  isDefault: boolean;
  /** 掩码在多少像素上算的：分屏模式要据此注明（§4.5） */
  inputWidth: number;
  inputHeight: number;
}

/** 一个行为（M1 只有「人像抠图」） */
export interface AiCapabilityView {
  id: string;
  /** 主按钮文案，语义恒定不随内部状态变化（D13） */
  label: string;
  description: string;
  /** 派生文件要追加的行为标签；UI / 写入 / 筛选都取这个字段（D10） */
  actionTag: string;
  outputSuffix: string;
  outputExt: string;
  defaultModelId: string;
  models: AiModelView[];
}

export interface AiCatalogResult {
  capabilities: AiCapabilityView[];
}

/** 用户显式选择的推理后端：默认走 GPU（DirectML），CPU 是慢速兜底、只能由人勾选 */
export type AiBackend = 'dml' | 'cpu';

/**
 * 抠图底色预设的标识（方案 §4：第一版面板只放这一个参数）。
 * 渲染层与主进程之间**只传这个 id、不传颜色数组**——RGBA 的唯一事实源在主进程
 * `BG_COLOR_PRESETS`，界面里再抄一份就成了第二处事实源（"证件照蓝底是哪个蓝"两处答案）。
 */
export type AiBgColorId = 'transparent' | 'white' | 'blue' | 'red';

/** 详情页参数面板带过去的抠图参数。 */
export interface AiCutoutParamsPayload {
  bgcolor?: AiBgColorId;
}

export interface AiRunRequest {
  absPath: string;
  capabilityId: string;
  modelId?: string;
  /** 首次下载的代价告知已由界面确认（AG2）。已下载时不需要 */
  downloadApproved?: boolean;
  /** 显式选 CPU 慢速模式（D12：必须用户显式勾选，不允许无声降级）。变化时主进程必须重建会话 */
  backend?: AiBackend;
  /**
   * 抠图后处理参数。以前主进程把默认值写死在 `execute()` 里，改参数在请求上没有入口；
   * 面板改了要在这里带上，否则"改了就能看出效果"无从谈起（方案附录 A「参数流转」）。
   * 与 backend 同一条口径：会话内记住、重启回默认，不写进 settings.json（§6 裁定 2）。
   */
  cutout?: AiCutoutParamsPayload;
}

/** ai:run 立刻回 taskId；进度与结果一律走事件（一次点击内部走完下载与加载） */
export interface AiRunAck {
  taskId: string;
}

export type AiPhase = 'download' | 'load' | 'infer' | 'encode';

export interface AiProgressPayload {
  taskId: string;
  phase: AiPhase;
  percent?: number;
}

export interface AiDonePayload {
  taskId: string;
  /** 暂存文件的绝对路径（userData 下，不在照片目录内） */
  tempPath: string;
  sourceAbsPath: string;
  /** true 表示命中缓存、没有重跑推理 */
  cacheHit: boolean;
  didApplySigmoid: boolean;
  /**
   * 掩码实际计算尺寸（取自清单的 inputDims）。界面那句"掩码在 NxN 下计算"读的就是它。
   * 这里刻意只留这一对名字：以前另有 inputWidth/inputHeight 别名，生产者只写 mask*、
   * 界面只读 input*，过 IPC 时是 unknown 所以编译期看不见，真机上那句注明一直是空白的（U5）。
   */
  maskWidth: number;
  maskHeight: number;
  capabilityId: string;
  modelId: string;
  actionTag: string;
}

export interface AiErrorPayload {
  taskId: string;
  code: string;
  message: string;
}

export interface AiSaveResult {
  savedPath: string;
  targetName: string;
  /** true 表示首选举了名，实际写成 .cutout.N.png（§4.4 同名冲突） */
  renamed: boolean;
  tagsWritten: string[];
}

export interface AiGpuMemory {
  usedMiB: number;
  totalMiB: number;
  /** 只能是整卡口径：分进程显存拿不到（nvidia-smi --query-compute-apps 返回 [N/A]） */
  scope: 'whole-gpu';
}

export interface AiStorageStats {
  preview: { entries: number; totalBytes: number };
  models: Array<{ id: string; sizeBytes: number; status: AiModelStatus }>;
  loadedModelId: string | null;
  /** 读不到时为 null，界面要显示"未知"而不是 0 */
  freeDiskBytes: number | null;
  /** 整卡显存；null = 拿不到（非 NVIDIA / 命令不可用） */
  gpu: AiGpuMemory | null;
  retention: { retentionDays: number; maxBytes: number };
}

export interface AiModelOpResult {
  modelId: string;
  status: AiModelStatus;
  /** 卸载/删除没生效时给一句原因，不静默 */
  reason?: string;
}

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
   * 模型下载与检查更新走的代理，形如 `127.0.0.1:7890`；空字符串 = 不覆盖，跟随系统默认。
   * 只影响这两件事——照片始终不出本机，本应用没有任何上传照片的请求。
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
}

/** 默认与既有行为一致：按相对路径升序、最小档缩略图、左栏展开 */
export const DEFAULT_UI_PREFS: UiPrefs = {
  sortKey: 'name',
  sortDir: 'asc',
  thumbSize: 'small',
  scanDoneToast: false,
  proxyRules: '',
  treeCollapsed: false,
  filterBarVisible: true
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
  // 照片 AI 处理（M1：人像抠图）。用户侧只有 aiRun 一个动作——下载与加载是它的内部步骤（D14）
  aiCatalog(): Promise<IpcResult<AiCatalogResult>>;
  aiRun(req: AiRunRequest): Promise<IpcResult<AiRunAck>>;
  aiCancel(taskId: string): Promise<IpcResult<boolean>>;
  aiSave(taskId: string): Promise<IpcResult<AiSaveResult>>;
  aiModelDownload(modelId: string): Promise<IpcResult<AiModelOpResult>>;
  aiModelDelete(modelId: string): Promise<IpcResult<AiModelOpResult>>;
  aiModelUnload(modelId: string): Promise<IpcResult<AiModelOpResult>>;
  aiModelSetDefault(capabilityId: string, modelId: string): Promise<IpcResult<AiCatalogResult>>;
  aiStorageStats(): Promise<IpcResult<AiStorageStats>>;
  onAiProgress(cb: (p: AiProgressPayload) => void): () => void;
  onAiDone(cb: (payload: AiDonePayload) => void): () => void;
  onAiError(cb: (err: AiErrorPayload) => void): () => void;
  // 注意：**没有** aiDiscard——D18 之后"不保存就是丢弃"，不需要显式删除动作
}
