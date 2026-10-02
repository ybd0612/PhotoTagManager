import sharp from 'sharp';

import { loadUprightRgb } from './preprocess';
import type { AiBgColorId } from '../../shared/types';

/**
 * 掩码后处理与成品合成（D7 ② 要求的"输出后处理函数"落点）。
 *
 * 已实装的可调项只有**底色**（切片一），它属于合成阶段、不碰 alpha；其余参数仍取默认值、
 * 掩码到 alpha 是恒等路径。但**参数结构体与缓存键里的位置必须现在就存在**——缓存的是成品图，
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

/**
 * 底色预设（方案 §4：第一版面板只放这一个参数）。
 *
 * 颜色数值的**唯一事实源**就在这里：界面只摆四块色板、只传 id，不让用户自由取色——
 * 自由颜色会让"改了就一定看得出"变成"改了不知道会不会被拒"，而且 RGBA 四个字节要进
 * 缓存键就得先保证形状稳定。
 */
export const BG_COLOR_PRESETS: Array<{ id: AiBgColorId; label: string; rgba: [number, number, number, number] | null }> = [
  { id: 'transparent', label: '透明', rgba: null },
  { id: 'white', label: '白', rgba: [255, 255, 255, 255] },
  { id: 'blue', label: '蓝', rgba: [67, 135, 242, 255] },
  { id: 'red', label: '红', rgba: [255, 0, 0, 255] }
];

/**
 * 预设 id → RGBA。认不出来的 id 当**透明**处理：
 * 宁可不铺底色，也不要替用户猜一个颜色写进他的成品文件里。
 */
export function resolveBgColorId(id: AiBgColorId | string): [number, number, number, number] | null {
  return BG_COLOR_PRESETS.find((p) => p.id === id)?.rgba ?? null;
}

/**
 * 把外部（IPC 载荷）带来的底色收敛成 RGBA 或透明。
 *
 * 这条链的形状不可控，宁可判成透明也不能拿残缺数组当颜色用：
 * `[255]` 会被 sharp 读成 r=255,g=0,b=0——用户选白、出图变红，且没有任何一处报错。
 */
export function normalizeBgColor(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const bytes = value.map((v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN));
  if (bytes.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) return null;
  return bytes as [number, number, number, number];
}

export interface MaskPlane {
  data: Float32Array;
  width: number;
  height: number;
}

/** 掩码落盘格式的头部宽度：uint32 宽 + uint32 高。 */
const MASK_HEADER_BYTES = 8;

/**
 * 掩码平面 → 字节流（掩码级缓存的落盘形态）。
 *
 * 头部写上宽高，所以文件名只需要掩码键——掩码尺寸是「原图内容区 + 输入尺寸」的函数，
 * 而这两个都在键里；把尺寸放进文件头还能让读取时校验"文件是否完整"。
 * float32 按本机小端原样落盘：这是**同机同端**的缓存，不跨机器搬运，不值得为它做编码层。
 */
export function maskToBytes(mask: MaskPlane): Buffer {
  const header = Buffer.alloc(MASK_HEADER_BYTES);
  header.writeUInt32LE(mask.width, 0);
  header.writeUInt32LE(mask.height, 4);
  const data = Buffer.from(mask.data.buffer, mask.data.byteOffset, mask.data.byteLength);
  return Buffer.concat([header, data]);
}

/**
 * 字节流 → 掩码平面。任何对不上的一律返回 null，调用方按"没有缓存"重跑。
 *
 * 尺寸必须**精确**等于 `8 + w*h*4`：多了或少了都说明这不是这个版本写的那份数据，
 * 拿一串垃圾当掩码合成出去的后果是"抠图少了一块"，而整条链不会报任何错。
 */
export function maskFromBytes(bytes: Buffer): MaskPlane | null {
  if (bytes.byteLength <= MASK_HEADER_BYTES) return null;
  const width = bytes.readUInt32LE(0);
  const height = bytes.readUInt32LE(4);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  if (bytes.byteLength !== MASK_HEADER_BYTES + width * height * 4) return null;
  const copy = Buffer.alloc(width * height * 4);
  bytes.copy(copy, 0, MASK_HEADER_BYTES);
  // 必须另起一个 buffer：Buffer 池里的切片 byteOffset 未必 4 字节对齐，
  // 直接 new Float32Array(bytes.buffer, offset, n) 会抛 RangeError
  return { data: new Float32Array(copy.buffer, copy.byteOffset, width * height), width, height };
}

export interface NumericRange {
  min: number;
  max: number;
}

export interface MaskRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 把掩码裁到"补边画布上的内容区"。
 *
 * 掩码是在等比缩放 + 居中补边后的画布上算出来的；不先裁掉补边就整幅放大回原图，
 * 内容与原图会整体错位（横向图会被纵向拉伸）。越界部分夹进画布，空矩形退化为一像素。
 */
export function cropMaskPlane(plane: MaskPlane, rect: MaskRect): MaskPlane {
  const width = Math.max(1, Math.min(Math.round(rect.width), plane.width));
  const height = Math.max(1, Math.min(Math.round(rect.height), plane.height));
  const x = Math.max(0, Math.min(Math.round(rect.x), plane.width - width));
  const y = Math.max(0, Math.min(Math.round(rect.y), plane.height - height));
  const out = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    const from = (y + row) * plane.width + x;
    out.set(plane.data.subarray(from, from + width), row * width);
  }
  return { data: out, width, height };
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
  // 底色**不走这里**——它是合成阶段往成品上铺的一层，改动 alpha 会同时改掉掩码本身。
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
 * 原图 + 掩码 → **透明底**成品 PNG（分界线以下的"重活"到此为止）。
 *
 * 方向规则（§4.4 / A3）：一切以"按 EXIF 转正后的像素"为准，成品 PNG 不写方向标记。
 * 色彩：原图 ICC 剖面按字节透传，宽色域照片不得因为重编码偏色。
 *
 * 单独拆出来是因为这一段的输出与底色无关——底色只是往这张现成 PNG 上再铺一层，
 * 那次铺色不必回头碰解码与 alpha（方案 §2 的分界线）。
 */
async function composeTransparentPng(
  absSourcePath: string,
  mask: MaskPlane,
  params: CutoutParams
): Promise<{ png: Buffer; width: number; height: number; didApplySigmoid: boolean }> {
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

  return { png, width: upright.width, height: upright.height, didApplySigmoid };
}

/**
 * 把带 alpha 的成品铺到指定底色上。
 *
 * 实测 `flatten` 会把通道从 4 降到 3、alpha 消失，这正是"铺上底色"应有的结果。
 * `keepIccProfile()` 必须再写一次：实测 sharp 单独 `.png()` 就会把 iCCP 块丢掉
 * （只有显式声明才留住），而 §4.4 要求宽色域照片不得因为重编码偏色。
 */
async function flattenOntoBgcolor(
  png: Buffer,
  bgcolor: [number, number, number, number]
): Promise<Buffer> {
  const [r, g, b] = bgcolor;
  return sharp(png)
    .flatten({ background: { r, g, b } })
    .keepIccProfile()
    .png()
    .toBuffer();
}

/**
 * 原图 + 掩码 → 成品 PNG（透明底，或按 params.bgcolor 铺好的底色）。
 *
 * 底色属于**这一步**（合成阶段），不属于 `toAlphaBytes`——后者是掩码到 alpha 的
 * 恒等映射，方案附录 A 明写不许把底色塞进 alpha 计算里。
 */
export async function composeCutoutPng(
  absSourcePath: string,
  mask: MaskPlane,
  params: CutoutParams = DEFAULT_CUTOUT_PARAMS
): Promise<ComposeResult> {
  const transparent = await composeTransparentPng(absSourcePath, mask, params);
  const bgcolor = normalizeBgColor(params.bgcolor);
  const png = bgcolor ? await flattenOntoBgcolor(transparent.png, bgcolor) : transparent.png;

  return {
    png,
    width: transparent.width,
    height: transparent.height,
    didApplySigmoid: transparent.didApplySigmoid,
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
