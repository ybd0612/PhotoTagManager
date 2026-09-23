import { createHash } from 'crypto';

/**
 * 预览暂存的五元组缓存键（规格 D18 ③ / §5.3）。缺任何一项就有一类静默出错：
 *
 *   sha1( 原图指纹 : 模型指纹 : 输入尺寸 : 后处理参数 : 预处理管线版本 )
 *
 * 缓存的内容是**成品图**，成品是「模型 + 输入尺寸 + 后处理参数」的函数，
 * 又是由我们这套解码/转正/缩放管线烘出来的——所以参数和管线版本都必须在键里，
 * 不存在「M1 还没有可调参数所以先不入键」这种豁免（§5.3 明写）。
 */

export interface SourceImageFingerprint {
  absPath: string;
  mtimeMs: number;
  size: number;
}

export interface CacheKeyInput {
  source: SourceImageFingerprint;
  /** 权重文件 sha256，来自能力清单 */
  modelSha256: string;
  /** 模型输入形状，来自能力清单（不在通用代码里写死） */
  inputDims: number[];
  /** 后处理参数结构体，M1 全取默认值，但键必须已经含它 */
  postprocessParams: Record<string, unknown>;
  /** preprocess 模块手工递增的管线版本 */
  pipelineVersion: number;
}

/** 照抄缩略图既有约定 sha1(absPath:mtimeMs:size)，不另造一套。 */
export function sourceFingerprint(src: SourceImageFingerprint): string {
  return createHash('sha1').update(`${src.absPath}:${src.mtimeMs}:${src.size}`).digest('hex');
}

/**
 * 稳定序列化：对象键按字典序输出，数组保持原序。
 * 参数来自设置页读取或 JSON 反序列化，书写顺序不可控，若不规范化，
 * 同一份参数会算出两个键，等于缓存永远不命中（表现为"每次都重跑"）。
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

export function computeCacheKey(input: CacheKeyInput): string {
  const material = canonical([
    sourceFingerprint(input.source),
    input.modelSha256,
    input.inputDims,
    input.postprocessParams,
    input.pipelineVersion
  ]);
  return createHash('sha1').update(material).digest('hex');
}
