// preprocess 单测：解码 → EXIF 转正 → 等比缩放补边 → 归一化成 CHW 张量。
// 对应规格 §4.4 的 EXIF 方向（A3）与 D7 ③（具体形状不得进通用代码路径）。
import { describe, it, expect, beforeAll } from 'vitest';
import { createHash } from 'crypto';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';

import { PIPELINE_VERSION, loadUprightRgb, preprocessImage, assertSingleFrame } from '../../electron/ai/preprocess';
import type { ModelSpec } from '../../electron/ai/capabilityCatalog';

const IMAGENET = { rescale: 1 / 255, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] };

/** 造一个模型规格：形状完全由参数决定，用来证明实现里没有写死的 320 */
function specWith(w: number, h: number): ModelSpec {
  return {
    id: 't',
    displayName: 't',
    repoId: 't/t',
    filePath: 't.onnx',
    fileName: 't.onnx',
    sizeBytes: 1,
    sha256: 't',
    verified: true,
    inputName: 'input.1',
    inputDims: [1, 3, h, w],
    outputNameIndex: 0,
    normalize: IMAGENET
  };
}

async function solidPng(size: { width: number; height: number }, rgb: [number, number, number]): Promise<string> {
  const px = Buffer.alloc(size.width * size.height * 3);
  for (let i = 0; i < size.width * size.height; i++) {
    px[i * 3] = rgb[0];
    px[i * 3 + 1] = rgb[1];
    px[i * 3 + 2] = rgb[2];
  }
  return sharp(px, { raw: { ...size, channels: 3 } }).png().toBuffer().then(async (buf) => {
    const p = join(tmp, `solid-${createHash('sha1').update(buf).digest('hex').slice(0, 12)}.png`);
    await writeFile(p, buf);
    return p;
  });
}

let tmp = '';
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ptm-preprocess-'));
});

const FIXTURE_ORIENTED = join(process.cwd(), 'tests', 'fixtures', 'ai', 'oriented-6.jpg');

describe('ai/preprocess —— 管线版本', () => {
  it('导出手工递增的 PIPELINE_VERSION（缓存键第五分量）', () => {
    expect(Number.isInteger(PIPELINE_VERSION)).toBe(true);
    expect(PIPELINE_VERSION).toBe(1);
  });

  it('D7 ③ 防线：预处理源码里不得出现写死的 320 / input.1 / u2netp', async () => {
    const src = await readFile(join(process.cwd(), 'electron', 'ai', 'preprocess.ts'), 'utf8');
    expect(src).not.toMatch(/\b320\b/);
    expect(src).not.toContain('input.1');
    expect(src).not.toContain('u2netp');
  });
});

describe('ai/preprocess —— EXIF 转正（A3）', () => {
  beforeAll(() => {
    expect(existsSync(FIXTURE_ORIENTED)).toBe(true);
  });

  it('夹具本身是"像素横向 + 带 Orientation 标记"，否则这条验收没有意义', async () => {
    // withMetadata 只写标记不转像素，所以未转正的存储尺寸必须是 40x20
    const meta = await sharp(FIXTURE_ORIENTED).metadata();
    expect(meta.orientation).toBe(6);
    const noRotate = await sharp(FIXTURE_ORIENTED).rotate(0).raw().toBuffer({ resolveWithObject: true });
    expect(noRotate.info.width).toBe(40);
    expect(noRotate.info.height).toBe(20);
  });

  it('Orientation=6 显式 .rotate() 后：宽高互换，明暗分布与肉眼所见一致', async () => {
    const up = await loadUprightRgb(FIXTURE_ORIENTED);
    // 存储是 40x20 横向（上白下黑）；Orientation 6 = 顺时针转 90° 显示 → 20x40 竖图，左黑右白
    expect(up.width).toBe(20);
    expect(up.height).toBe(40);
    expect(up.channels).toBe(3);
    const at = (x: number, y: number): number => up.data[(y * up.width + x) * up.channels];
    expect(at(2, 20)).toBe(0); // 左侧黑
    expect(at(17, 20)).toBe(255); // 右侧白
  });

  it('不显式转正时会退化成横向像素 —— 说明 .rotate() 是必须存在的（回归高发点）', async () => {
    const raw = await sharp(FIXTURE_ORIENTED).rotate(0).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(raw.info.width).toBe(40);
    const up = await loadUprightRgb(FIXTURE_ORIENTED);
    expect(up.width * up.height).toBe(raw.info.width * raw.info.height); // 面积守恒，只是方向不同
  });
});

describe('ai/preprocess —— 张量形状与数值', () => {
  it('输出长度 = 3*H*W，形状取自传入的清单规格（这里用 48x64 非方形）', async () => {
    const p = await solidPng({ width: 30, height: 70 }, [10, 20, 30]);
    const out = await preprocessImage(p, specWith(64, 48));
    expect(out.dims).toEqual([1, 3, 48, 64]);
    expect(out.tensor).toBeInstanceOf(Float32Array);
    expect(out.tensor.length).toBe(3 * 48 * 64);
    expect(out.inputName).toBe('input.1');
  });

  it('逐像素等于 (v/255 - mean)/std，三通道各自归一化', async () => {
    const p = await solidPng({ width: 4, height: 4 }, [128, 64, 200]);
    const out = await preprocessImage(p, specWith(4, 4));
    for (let ch = 0; ch < 3; ch++) {
      const raw = [128, 64, 200][ch];
      const want = (raw / 255 - IMAGENET.mean[ch]) / IMAGENET.std[ch];
      for (let i = 0; i < 16; i++) {
        expect(out.tensor[ch * 16 + i]).toBeCloseTo(want, 4);
      }
    }
  });

  it('排布是 CHW 而不是 HWC：上红下蓝时 R 平面先连续出现', async () => {
    const px = Buffer.alloc(1 * 2 * 3);
    px[0] = 255; // row0 = 红
    px[1] = 0;
    px[2] = 0;
    px[3] = 0; // row1 = 蓝
    px[4] = 0;
    px[5] = 255;
    const p = join(tmp, 'redblue.png');
    await writeFile(p, await sharp(px, { raw: { width: 1, height: 2, channels: 3 } }).png().toBuffer());

    const out = await preprocessImage(p, specWith(1, 2));
    const norm = (v: number, ch: number) => (v / 255 - IMAGENET.mean[ch]) / IMAGENET.std[ch];
    // 平面 0 = R：row0 红(255) → 高值；row1 蓝(0) → 低值
    expect(out.tensor[0]).toBeCloseTo(norm(255, 0), 4);
    expect(out.tensor[1]).toBeCloseTo(norm(0, 0), 4);
    // 若是 HWC，index 1 会是 G 通道而不是 R 的第二行
    expect(out.tensor[2 * 2 + 1]).toBeCloseTo(norm(255, 2), 4);
  });

  it('等比缩放 + 居中补边：100x50 进 64x64 → 内容 64x32，上下各 16 行补边', async () => {
    const p = await solidPng({ width: 100, height: 50 }, [128, 128, 128]);
    const out = await preprocessImage(p, specWith(64, 64));
    expect(out.scale).toBeCloseTo(0.64, 6);
    expect(out.padX).toBe(0);
    expect(out.padY).toBe(16);
    const norm = (v: number, ch: number) => (v / 255 - IMAGENET.mean[ch]) / IMAGENET.std[ch];
    const W = 64;
    // 第 0 行属于补边区（补边像素值 0）
    expect(out.tensor[0 * W + 0]).toBeCloseTo(norm(0, 0), 4);
    // 第 32 行落在内容区（16 + 16 = 32 起为内容），值是原图的 128
    expect(out.tensor[0 * W + 32 * W + 5]).toBeCloseTo(norm(128, 0), 4);
  });

  it('补边用的是像素值 0（对应归一化后的负常数），不是均值填充', async () => {
    const p = await solidPng({ width: 10, height: 4 }, [255, 255, 255]);
    const out = await preprocessImage(p, specWith(20, 20));
    const normZero = (0 / 255 - IMAGENET.mean[0]) / IMAGENET.std[0];
    // scale = min(20/10, 20/4) = 2 → 内容 20x8，padY = 6；第 0 行是补边
    expect(out.padY).toBe(6);
    expect(out.tensor[0]).toBeCloseTo(normZero, 4);
    expect(out.tensor[0 * 20 + 6 * 20]).toBeCloseTo((255 / 255 - IMAGENET.mean[0]) / IMAGENET.std[0], 4);
  });

  it('源图小于目标时只放大不裁切，面积与 scale 自洽', async () => {
    const p = await solidPng({ width: 3, height: 5 }, [7, 7, 7]);
    const out = await preprocessImage(p, specWith(30, 30));
    expect(out.sourceWidth).toBe(3);
    expect(out.sourceHeight).toBe(5);
    // scale 受高度限制：min(30/3, 30/5) = 6 → 内容 18 宽 x 30 高，补边落在左右
    expect(out.scale).toBeCloseTo(6, 6);
    expect(out.padY).toBe(0);
    expect(out.padX).toBe(6);
  });
});

describe('ai/preprocess —— 输入形态闸门（§6 的 GIF/多帧与 RAW 行）', () => {
  it('多帧输入（GIF/动图）明确拒绝，而不是静默取首帧当正常结果', async () => {
    expect(() => assertSingleFrame({ pages: 2, width: 8, height: 4 })).toThrow(/多帧|动图/);
    // 单帧必须放行（否则所有普通照片都被挡掉）
    expect(() => assertSingleFrame({ pages: 1, width: 8, height: 4 })).not.toThrow();
    expect(() => assertSingleFrame({ width: 8, height: 4 })).not.toThrow();
  });

  it('元数据都读不出时，两种可能都要说，不许把正常 RAW 断言成"文件损坏"', async () => {
    const junk = join(tmp, 'broken.jpg');
    await writeFile(junk, Buffer.from('这不是图片'));
    const model = specWith(4, 4);
    const err = (await preprocessImage(junk, model).catch((e: unknown) => e as Error)) as Error;
    expect(err.message).toContain('不支持的格式');
    expect(err.message).toContain('请先转成 JPG 或 PNG');
    expect(err.message).toContain('也可能文件已损坏');
    // 旧写法把"格式不支持"和"损坏"混成一句结论，反钉不许回来
    expect(err.message).not.toMatch(/无法解码该图片（RAW\/HEIC 或文件损坏）/);
  });

  it('真多帧 GIF 必须被拒绝（夹具由 ffmpeg 生成，pages=4）', async () => {
    const gif = join(process.cwd(), 'tests', 'fixtures', 'ai', 'anim2.gif');
    const meta = await sharp(gif).metadata();
    // 夹具本身必须是多帧，否则这条断言又会是空转
    expect((meta.pages ?? 1)).toBeGreaterThan(1);
    await expect(preprocessImage(gif, specWith(4, 4))).rejects.toThrow(/多帧|动图/);
  });
});
