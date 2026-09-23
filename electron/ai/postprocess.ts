import sharp from 'sharp';

import { loadUprightRgb } from './preprocess';

/**
 * 掩码后处理与成品合成（D7 ② 要求的"输出后处理函数"落点）。
 *
 * M1 只实装恒等路径：CutoutParams 全部取默认值，界面上一个可调项都没有。
 * 但**参数结构体与缓存键里的位置必须现在就存在**——缓存的是成品图，
 * 成品是「模型 + 参数」的函数，等参数实装时再往键里加就是 A1 那个静默出错。
 *
 * 另：§4.7 的 rembg 参数是 Python + OpenCV 的实现，onnxruntime-node 这边
 * 没有任何现成等价物，每加一个都要单独实现、单独验证"真的影响输出"。
 */

export interface CutoutParams {
  alphaMatting: boolean;
  alphaMattingForegroundThreshold: number;
  alphaMattingBackgroundThreshold: number;
  alphaMattingErodeSize: number;
  postProcessMask: boolean;
  decontaminate: boolean;
  bgcolor: [number, number, number, number] | null;
  onlyMask: boolean;
}

/** M1：全默认、全关闭，掩码到 alpha 是恒等映射。 */
export const DEFAULT_CUTOUT_PARAMS: CutoutParams = {
  alphaMatting: false,
  alphaMattingForegroundThreshold: 240,
  alphaMattingBackgroundThreshold: 10,
  alphaMattingErodeSize: 10,
  postProcessMask: false,
  decontaminate: false,
  bgcolor: null,
  onlyMask: false
};

/** 摊平成可稳定序列化的对象，交给缓存键的第四个分量。 */
export function toCacheParams(p: CutoutParams): Record<string, unknown> {
  return { ...p };
}

export interface MaskPlane {
  data: Float32Array;
  width: number;
  height: number;
}

export interface NumericRange {
  min: number;
  max: number;
}

export interface AlphaResult {
  alpha: Uint8Array;
  didApplySigmoid: boolean;
}

/**
 * 判据来自实测：u2netp 首输出范围 [0.000, 0.997]，**已经过 sigmoid**。
 * 再套一层 sigmoid 会把 0.5 抬成 0.62、把 0.9 压成 0.71，边缘肉眼可见地错，
 * 却不报任何错。所以按数值范围自动判定，而不是按模型名写死。
 */
export function isAlreadyProbability(range: NumericRange): boolean {
  return range.min >= -0.01 && range.max <= 1.01;
}

export function scanRange(data: Float32Array): NumericRange {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 0 };
  return { min, max };
}

export function toAlphaBytes(
  mask: MaskPlane,
  range: NumericRange = scanRange(mask.data),
  params: CutoutParams = DEFAULT_CUTOUT_PARAMS
): AlphaResult {
  const alpha = new Uint8Array(mask.width * mask.height);
  const probability = isAlreadyProbability(range);
  // M1 的恒等路径：不做阈值化、不做腐蚀、不做形态学清理（params 全为默认值）。
  void params;
  for (let i = 0; i < alpha.length; i++) {
    let v = mask.data[i];
    if (!probability) v = 1 / (1 + Math.exp(-v));
    if (Number.isNaN(v)) v = 0;
    alpha[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
  }
  return { alpha, didApplySigmoid: !probability };
}

export interface ComposeResult {
  png: Buffer;
  width: number;
  height: number;
  didApplySigmoid: boolean;
  /** 掩码原始分辨率，界面要据此说明"掩码在 NxN 下计算" */
  maskWidth: number;
  maskHeight: number;
}

/**
 * 原图 + 掩码 → 带透明通道的 PNG。
 *
 * 方向规则（§4.4 / A3）：一切以"按 EXIF 转正后的像素"为准，成品 PNG 不写方向标记。
 * 色彩：原图 ICC 剖面按字节透传，宽色域照片不得因为重编码偏色。
 */
export async function composeCutoutPng(
  absSourcePath: string,
  mask: MaskPlane,
  params: CutoutParams = DEFAULT_CUTOUT_PARAMS
): Promise<ComposeResult> {
  const upright = await loadUprightRgb(absSourcePath);
  const { alpha, didApplySigmoid } = toAlphaBytes(mask, scanRange(mask.data), params);

  // 掩码分辨率远低于原图，先按单波段放大到原图尺寸再当 alpha 用。
  // 注意 sharp 的 raw() 会把灰度图扩成 3 波段，必须按 info.channels 取首波段，
  // 否则下标整体错位，成品会"看起来正常"地全不透明。
  const { data: resized, info: resizedInfo } = await sharp(
    Buffer.from(alpha.buffer, alpha.byteOffset, alpha.byteLength),
    { raw: { width: mask.width, height: mask.height, channels: 1 } }
  )
    .resize(upright.width, upright.height, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bandStep = resizedInfo.channels;

  // dest-in 只认 overlay 的 alpha 波段，所以掩码必须放在 LA 图的第二个波段上；
  // 直接给单波段灰度图会被当成"全不透明"，抠图不生效且完全不报错。
  const la = Buffer.alloc(upright.width * upright.height * 2);
  for (let i = 0; i < upright.width * upright.height; i++) {
    la[i * 2] = 0;
    la[i * 2 + 1] = resized[i * bandStep];
  }
  const maskOverlay = await sharp(la, {
    raw: { width: upright.width, height: upright.height, channels: 2 }
  })
    .png()
    .toBuffer();

  // 不用 joinChannel：源图本身带 alpha 时它会被静默忽略（实测掩码根本没生效）。
  // dest-in 同时完成"源 alpha × 掩码"，且整链从源文件起，ICC 才能原样带出。
  const png = await sharp(absSourcePath)
    .rotate()
    .composite([{ input: maskOverlay, blend: 'dest-in' }])
    .keepIccProfile()
    .png()
    .toBuffer();

  return {
    png,
    width: upright.width,
    height: upright.height,
    didApplySigmoid,
    maskWidth: mask.width,
    maskHeight: mask.height
  };
}

export interface PostprocessContext {
  absSourcePath: string;
  mask: MaskPlane;
  params?: CutoutParams;
}

export type PostprocessFn = (ctx: PostprocessContext) => Promise<ComposeResult>;

const registry = new Map<string, PostprocessFn>();

registry.set('portrait-cutout-alpha', ({ absSourcePath, mask, params }) =>
  composeCutoutPng(absSourcePath, mask, params ?? DEFAULT_CUTOUT_PARAMS)
);

/** 按能力清单里的 postprocessId 取实现；未注册必须报错，不能静默 undefined。 */
export function getPostprocessor(postprocessId: string): PostprocessFn {
  const fn = registry.get(postprocessId);
  if (!fn) throw new Error(`能力清单引用的后处理函数未注册：${postprocessId}`);
  return fn;
}
