import { mkdirSync } from 'fs';
import { join } from 'path';

/**
 * AI 相关磁盘目录的唯一解析入口（规格 §5.0）。
 * 主进程在 app.whenReady 内调用 configureAiPaths(app.getPath('userData'))；
 * 推理子进程不写盘，因此不需要（也拿不到）这里的任何路径。
 */

const MODELS_DIR_NAME = 'models';
const PREVIEW_DIR_NAME = 'ai-preview';
const INDEX_FILE_NAME = 'index.json';
const SETTINGS_FILE_NAME = 'settings.json';

let userDataPath: string | null = null;

/** 未配置就取路径会拼出 `undefined/models` 这种幽灵目录，直接抛可读错误。 */
function root(): string {
  if (!userDataPath) {
    throw new Error('ai/paths 尚未初始化：必须先调用 configureAiPaths(userData)');
  }
  return userDataPath;
}

function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 配置 userData 根目录，并预建 models / ai-preview。可重复调用（换目录场景）。 */
export function configureAiPaths(nextUserDataPath: string): void {
  if (!nextUserDataPath) throw new Error('configureAiPaths 需要一个非空的 userData 路径');
  userDataPath = nextUserDataPath;
  ensureDir(modelsDir());
  ensureDir(previewDir());
}

/** 仅测试用：回到未初始化状态。 */
export function resetAiPaths(): void {
  userDataPath = null;
}

export function modelsDir(): string {
  return join(root(), MODELS_DIR_NAME);
}

/** 单个模型的权重目录。默认不建目录，下载器写入时传 create: true。 */
export function modelDir(modelId: string, opts: { create?: boolean } = {}): string {
  const dir = join(modelsDir(), modelId);
  return opts.create ? ensureDir(dir) : dir;
}

/** 本地已装模型索引文件（`models/index.json`）。父目录随 modelsDir 一起建好。 */
export function indexFile(): string {
  return join(modelsDir(), INDEX_FILE_NAME);
}

/**
 * 预览暂存 = 结果缓存目录。红线：必须在 userData 下、绝不在任何照片扫描根内，
 * 且与 thumbnails 分目录（扫描器只按扩展名过滤，放错位置半成品会被扫进用户网格）。
 */
export function previewDir(): string {
  return join(root(), PREVIEW_DIR_NAME);
}

export function previewFile(fileName: string): string {
  return join(previewDir(), fileName);
}

/**
 * 掩码级缓存目录：预览暂存**之内**的子目录（方案 §6 裁定 3 / 附录 A）。
 *
 * 放在 `ai-preview/` 里而不是另起一个目录，是为了让现成的那套 LRU 索引和
 * "清理只允许作用于暂存目录"这条红线（§5.0 红线 3）天然把它一起管住——
 * 不新建第二套清理机制，也就少一处会被忘记加前缀校验的删除入口。
 * 目录本身不在 `configureAiPaths` 里预建：只有真算出掩码才会写，空目录是纯噪音。
 */
const MASKS_DIR_NAME = 'masks';

export function masksDir(): string {
  return join(previewDir(), MASKS_DIR_NAME);
}

export function maskFile(fileName: string): string {
  return join(masksDir(), fileName);
}

/** 掩码文件名 = `<掩码键>.mask.bin`；文件头自带宽高，所以键本身就够定位一个掩码。 */
export const MASK_FILE_EXT = '.mask.bin';

export function maskFileName(cacheKey: string): string {
  return `${cacheKey}${MASK_FILE_EXT}`;
}

/** AI 偏好（后处理参数、暂存保留期与容量上限）。 */
export function settingsFile(): string {
  return join(root(), SETTINGS_FILE_NAME);
}
