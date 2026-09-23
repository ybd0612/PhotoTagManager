import sharp from 'sharp';

import type { ModelSpec } from './capabilityCatalog';

/**
 * 解码 → EXIF 转正 → 等比缩放 + 居中补边 → 归一化成 CHW 张量。
 *
 * 本文件是"预处理管线"的落点，改任何一步的实现（换转码器、改 resize 算法、
 * 换补边策略）都必须把下面的版本常量 +1，否则暂存缓存里全是旧管线烘出来的图，
 * 却仍然对得上缓存键（规格 §5.3 里最隐蔽的那类失效）。
 */
export const PIPELINE_VERSION = 1;

export interface UprightRgb {
  data: Buffer;
  width: number;
  height: number;
  channels: 3;
}

/**
 * 按 EXIF 方向转正后的 RGB 像素。
 *
 * sharp 默认会应用 EXIF 旋转，但**这里仍然显式调用无参 .rotate()**：
 * 手机照片的像素常常是横的、靠方向标记告诉查看器转多少度，而模型吃的是像素、
 * 不吃标记。依赖默认行为等于把方向正确性押在依赖库的默认值上，属回归高发点。
 */
export async function loadUprightRgb(absPath: string): Promise<UprightRgb> {
  const { data, info } = await sharp(absPath)
    .rotate()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) {
    throw new Error(`解码后不是三通道 RGB（实际 ${info.channels} 通道），无法送入模型`);
  }
  return { data, width: info.width, height: info.height, channels: 3 };
}

export interface PreprocessedInput {
  inputName: string;
  dims: number[];
  /** CHW 排布的归一化张量 */
  tensor: Float32Array;
  sourceWidth: number;
  sourceHeight: number;
  /** 等比缩放系数，后处理要用它把掩码映回原图 */
  scale: number;
  padX: number;
  padY: number;
}

/** 补边像素值（转正后、缩放后的 RGB 空间用 0 填充）。 */
const PAD_VALUE = 0;

export async function preprocessImage(absPath: string, model: ModelSpec): Promise<PreprocessedInput> {
  const dims = model.inputDims;
  if (dims.length !== 4) {
    throw new Error(`模型输入必须是 4 维 NCHW，实际 ${dims.length} 维`);
  }
  const [, channels, targetHeight, targetWidth] = dims;
  if (channels !== 3) {
    throw new Error(`本管线只支持 3 通道输入，清单给的模型是 ${channels} 通道`);
  }

  const rgb = await loadUprightRgb(absPath);
  const scale = Math.min(targetWidth / rgb.width, targetHeight / rgb.height);
  const contentWidth = Math.max(1, Math.min(targetWidth, Math.round(rgb.width * scale)));
  const contentHeight = Math.max(1, Math.min(targetHeight, Math.round(rgb.height * scale)));

  const { data: scaled } = await sharp(rgb.data, {
    raw: { width: rgb.width, height: rgb.height, channels: 3 }
  })
    .resize(contentWidth, contentHeight, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const padX = Math.floor((targetWidth - contentWidth) / 2);
  const padY = Math.floor((targetHeight - contentHeight) / 2);
  const planeSize = targetWidth * targetHeight;
  const tensor = new Float32Array(channels * planeSize);
  const { rescale, mean, std } = model.normalize;

  // 先把整平面铺成补边值的归一化结果，再把内容区覆盖上去
  for (let ch = 0; ch < channels; ch++) {
    const padNorm = (PAD_VALUE * rescale - mean[ch]) / std[ch];
    tensor.fill(padNorm, ch * planeSize, (ch + 1) * planeSize);
  }
  for (let ch = 0; ch < channels; ch++) {
    const base = ch * planeSize;
    const invStd = 1 / std[ch];
    const minusMean = -mean[ch];
    for (let y = 0; y < contentHeight; y++) {
      const srcRow = y * contentWidth;
      const dstRow = base + (y + padY) * targetWidth + padX;
      for (let x = 0; x < contentWidth; x++) {
        const raw = scaled[(srcRow + x) * 3 + ch];
        tensor[dstRow + x] = (raw * rescale + minusMean) * invStd;
      }
    }
  }

  return {
    inputName: model.inputName,
    dims: [...dims],
    tensor,
    sourceWidth: rgb.width,
    sourceHeight: rgb.height,
    scale,
    padX,
    padY
  };
}
