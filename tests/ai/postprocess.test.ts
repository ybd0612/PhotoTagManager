// postprocess 单测：sigmoid 自动判定 → 掩码映回原图 → alpha 合成 → PNG 编码。
// 对应规格 §4.4（EXIF/ICC/输出形态）、D18 ②③（参数进缓存键）、D7 ②（后处理函数落点）。
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { inflateSync } from 'zlib';
import sharp from 'sharp';

import {
  DEFAULT_CUTOUT_PARAMS,
  isAlreadyProbability,
  toAlphaBytes,
  toCacheParams,
  composeCutoutPng,
  getPostprocessor,
  type MaskPlane
} from '../../electron/ai/postprocess';
import { computeCacheKey, type CacheKeyInput } from '../../electron/ai/cacheKey';
import { getCapability } from '../../electron/ai/capabilityCatalog';

let tmp = '';
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ptm-postprocess-'));
});
afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  tmp = '';
});

function plane(width: number, height: number, fill: (x: number, y: number) => number): MaskPlane {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = fill(x, y);
  return { data, width, height };
}

async function pngWithColors(): Promise<string> {
  const W = 8, H = 4;
  const px = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    px[i * 3] = 200;
    px[i * 3 + 1] = 100;
    px[i * 3 + 2] = 50;
  }
  const p = join(tmp, 'src.png');
  await writeFile(
    p,
    await sharp(px, { raw: { width: W, height: H, channels: 3 } }).png().withIccProfile('srgb').toBuffer()
  );
  return p;
}

/** 从 PNG 里把 iCCP 块解出来（存在即返回解压后的剖面字节） */
function iccOf(png: Buffer): Buffer | null {
  let offset = 8;
  while (offset + 8 <= png.length) {
    const len = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + len);
    if (type === 'iCCP') {
      const nameEnd = data.indexOf(0);
      // name \0 compressionMethod \0 [language \0] compressed profile
      const afterMethod = nameEnd + 2;
      return inflateSync(data.subarray(afterMethod));
    }
    if (type === 'IDAT') break;
    offset += 12 + len;
  }
  return null;
}

describe('ai/postprocess —— 数值范围自动判定（实测 u2netp 首输出已是概率）', () => {
  it('最小 ≥ -0.01 且最大 ≤ 1.01 视为概率，判 true', () => {
    expect(isAlreadyProbability({ min: 0.0, max: 0.997 })).toBe(true);
    expect(isAlreadyProbability({ min: -0.009, max: 1.009 })).toBe(true);
  });

  it('出现明显负值或大于 1 的就是 logits，判 false（必须再过 sigmoid）', () => {
    expect(isAlreadyProbability({ min: -8.2, max: 7.9 })).toBe(false);
    expect(isAlreadyProbability({ min: 0, max: 1.5 })).toBe(false);
    expect(isAlreadyProbability({ min: -0.5, max: 0.9 })).toBe(false);
  });
});

describe('ai/postprocess —— 掩码转 alpha', () => {
  it('概率掩码直接 ×255，不再过 sigmoid（再过一遍会把 0.5 抬成 158）', () => {
    const m = plane(2, 1, (x) => (x === 0 ? 0.5 : 0));
    const out = toAlphaBytes(m, { min: 0, max: 0.997 });
    expect(out.alpha[0]).toBeCloseTo(128, 0);
    expect(out.alpha[1]).toBe(0);
    expect(out.didApplySigmoid).toBe(false);
  });

  it('logits 掩码先过 sigmoid：0 → 128、-8 → 约 0、8 → 约 255', () => {
    const m = plane(3, 1, (x) => [-8, 0, 8][x]);
    const out = toAlphaBytes(m, { min: -8, max: 8 });
    expect(out.didApplySigmoid).toBe(true);
    expect(out.alpha[0]).toBeLessThan(2);
    expect(out.alpha[1]).toBeCloseTo(128, 0);
    expect(out.alpha[2]).toBeGreaterThan(250);
  });

  it('全零掩码与常量掩码都不崩，且 alpha 形状正确', () => {
    const zero = toAlphaBytes(plane(4, 4, () => 0), { min: 0, max: 0 });
    expect(zero.alpha.length).toBe(16);
    expect(Math.max(...zero.alpha)).toBe(0);
    const flat = toAlphaBytes(plane(4, 4, () => 0.4), { min: 0.4, max: 0.4 });
    expect(flat.alpha.length).toBe(16);
    expect(flat.alpha.every((v) => v === flat.alpha[0])).toBe(true);
  });
});

describe('ai/postprocess —— CutoutParams（M1 全默认值，但必须已在缓存键里）', () => {
  it('默认值全取恒等/关闭，界面上一个可调项都还没实装', () => {
    expect(DEFAULT_CUTOUT_PARAMS).toEqual({
      alphaMatting: false,
      alphaMattingForegroundThreshold: 240,
      alphaMattingBackgroundThreshold: 10,
      alphaMattingErodeSize: 10,
      postProcessMask: false,
      decontaminate: false,
      bgcolor: null,
      onlyMask: false
    });
  });

  it('默认参数下掩码是恒等变换：不做阈值化、不做腐蚀', () => {
    // 阈值化会把 0.5 判成背景（< 240/255），恒等则保留 128
    const m = plane(2, 1, (x) => (x === 0 ? 0.5 : 0));
    const out = toAlphaBytes(m, { min: 0, max: 0.997 }, DEFAULT_CUTOUT_PARAMS);
    expect(out.alpha[0]).toBeCloseTo(128, 0);
  });

  it('D18 ②：参数变化必须换缓存键（改参数拿旧图是静默出错）', () => {
    const base: CacheKeyInput = {
      source: { absPath: 'C:/p/a.jpg', mtimeMs: 1, size: 2 },
      modelSha256: 'm',
      inputDims: [1, 3, 320, 320],
      postprocessParams: toCacheParams(DEFAULT_CUTOUT_PARAMS),
      pipelineVersion: 1
    };
    const changed: CacheKeyInput = {
      ...base,
      postprocessParams: toCacheParams({ ...DEFAULT_CUTOUT_PARAMS, alphaMattingForegroundThreshold: 200 })
    };
    expect(computeCacheKey(changed)).not.toBe(computeCacheKey(base));
    expect(computeCacheKey({ ...base, postprocessParams: toCacheParams(DEFAULT_CUTOUT_PARAMS) })).toBe(
      computeCacheKey(base)
    );
  });
});

describe('ai/postprocess —— 成品合成', () => {
  it('产出真带 alpha 的 PNG，透明区不是白底', async () => {
    const src = await pngWithColors();
    const mask = plane(8, 4, (x) => (x < 4 ? 1 : 0));
    const out = await composeCutoutPng(src, mask);
    const meta = await sharp(out.png).metadata();
    expect(meta.channels).toBe(4);
    expect(meta.format).toBe('png');
    expect(out.didApplySigmoid).toBe(false);

    const raw = await sharp(out.png).raw().toBuffer({ resolveWithObject: true });
    expect(raw.info.channels).toBe(4);
    const alphaAt = (x: number, y: number) => raw.data[(y * raw.info.width + x) * 4 + 3];
    expect(alphaAt(0, 0)).toBe(255); // 左半不透明
    expect(alphaAt(7, 0)).toBe(0); // 右半透明
    // 保留原图 RGB，不重新着色
    expect(raw.data[0]).toBe(200);
    expect(raw.data[1]).toBe(100);
    expect(raw.data[2]).toBe(50);
  });

  it('掩码比原图小得多时先放大对齐再合成（模拟低分辨率掩码映回大图）', async () => {
    const src = await pngWithColors();
    const mask = plane(2, 1, (x) => (x === 0 ? 1 : 0));
    const out = await composeCutoutPng(src, mask);
    const raw = await sharp(out.png).raw().toBuffer({ resolveWithObject: true });
    expect(raw.info.width).toBe(8);
    expect(raw.info.height).toBe(4);
    expect(out.width).toBe(8);
    expect(out.height).toBe(4);
    expect(raw.data[3]).toBe(255);
    expect(raw.data[(4 * 7 + 3) * 4 + 3]).toBe(0);
  });

  it('A3：输出 PNG 不写方向标记（哪怕输入是带 Orientation 的 JPEG）', async () => {
    const oriented = join(process.cwd(), 'tests', 'fixtures', 'ai', 'oriented-6.jpg');
    const srcMeta = await sharp(oriented).metadata();
    expect(srcMeta.orientation).toBe(6);
    const mask = plane(20, 40, (x) => (x < 10 ? 1 : 0));
    const out = await composeCutoutPng(oriented, mask);
    const outMeta = await sharp(out.png).metadata();
    expect(outMeta.orientation).toBeUndefined();
    // 转正后是 20x40，成品必须同尺寸
    expect(outMeta.width).toBe(20);
    expect(outMeta.height).toBe(40);
  });

  it('ICC 剖面按字节透传（§4.4 宽色域不得偏色，Q19 的验证方式）', async () => {
    const src = await pngWithColors();
    const srcIcc = iccOf(await readFile(src));
    expect(srcIcc).not.toBeNull();
    const mask = plane(8, 4, () => 1);
    const out = await composeCutoutPng(src, mask);
    const outIcc = iccOf(out.png);
    expect(outIcc).not.toBeNull();
    expect(outIcc!.equals(srcIcc!)).toBe(true);
  });

  it('源图自带 alpha 时成品 alpha = 源 alpha × 掩码（锁住 joinChannel 的静默失效）', async () => {
    // 实测坑：sharp 的 joinChannel 在源图已有 alpha 时会被无声忽略，掩码完全不生效却不报错。
    // 换成 composite + dest-in 后这里必须是"左半保留源透明度、右半全透明"。
    const W = 8, H = 4;
    const px = Buffer.alloc(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      px[i * 3] = 200;
      px[i * 3 + 1] = 100;
      px[i * 3 + 2] = 50;
    }
    const src = join(tmp, 'src-alpha.png');
    await writeFile(
      src,
      await sharp(px, { raw: { width: W, height: H, channels: 3 } }).ensureAlpha(0.8).png().toBuffer()
    );
    const out = await composeCutoutPng(src, plane(W, H, (x) => (x < W / 2 ? 1 : 0)));
    const raw = await sharp(out.png).raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number) => raw.data[(y * raw.info.width + x) * 4 + 3];
    expect(alphaAt(0, 0)).toBeCloseTo(204, 0); // 源 alpha 0.8 被保住
    expect(alphaAt(W - 1, 0)).toBe(0); // 掩码透明区仍然全透明
  });

  it('全零掩码合成不崩，结果全透明', async () => {
    const src = await pngWithColors();
    const out = await composeCutoutPng(src, plane(8, 4, () => 0));
    const raw = await sharp(out.png).raw().toBuffer({ resolveWithObject: true });
    for (let i = 3; i < raw.data.length; i += 4) expect(raw.data[i]).toBe(0);
  });
});

describe('ai/postprocess —— 后处理函数注册表（D7 ②）', () => {
  it('清单里的 postprocessId 必须能取到已注册的实现', () => {
    const cap = getCapability('portrait-cutout')!;
    const fn = getPostprocessor(cap.postprocessId);
    expect(typeof fn).toBe('function');
  });

  it('未注册的 id 报可读错误，不静默返回 undefined', () => {
    expect(() => getPostprocessor('no-such-thing')).toThrow(/no-such-thing/);
  });
});
