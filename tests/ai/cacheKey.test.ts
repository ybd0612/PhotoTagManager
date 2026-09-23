// cacheKey 单测：五元组缓存键（规格 D18 ③ / §5.3）。
// 这一组用例的意义在于"能失败"——把实现里任一分量拿掉，对应那条用例就该红。
import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';

import {
  computeCacheKey,
  sourceFingerprint,
  type CacheKeyInput
} from '../../electron/ai/cacheKey';

const BASE: CacheKeyInput = {
  source: { absPath: 'C:/photos/a.jpg', mtimeMs: 1_700_000_000_000, size: 2_048_000 },
  modelSha256: '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8',
  inputDims: [1, 3, 320, 320],
  postprocessParams: { alphaMatting: false, threshold: 240 },
  pipelineVersion: 1
};

function withOverrides(patch: Partial<CacheKeyInput>): CacheKeyInput {
  return { ...BASE, ...patch };
}

describe('ai/cacheKey —— 五元组', () => {
  it('原图指纹照抄缩略图约定 sha1(absPath:mtimeMs:size)', () => {
    const expected = createHash('sha1')
      .update(`${BASE.source.absPath}:${BASE.source.mtimeMs}:${BASE.source.size}`)
      .digest('hex');
    expect(sourceFingerprint(BASE.source)).toBe(expected);
  });

  it('缓存键是 40 位 sha1 十六进制', () => {
    expect(computeCacheKey(BASE)).toMatch(/^[0-9a-f]{40}$/);
  });

  it('同样的输入永远得到同一个键（纯函数）', () => {
    expect(computeCacheKey(withOverrides({}))).toBe(computeCacheKey(BASE));
  });

  it('分量 1 变：原图路径变 → 键变', () => {
    expect(computeCacheKey(withOverrides({ source: { ...BASE.source, absPath: 'C:/photos/b.jpg' } }))).not.toBe(
      computeCacheKey(BASE)
    );
  });

  it('分量 1 变：原图 mtime 变 → 键变（改图必须重跑）', () => {
    expect(computeCacheKey(withOverrides({ source: { ...BASE.source, mtimeMs: BASE.source.mtimeMs + 1 } }))).not.toBe(
      computeCacheKey(BASE)
    );
  });

  it('分量 1 变：原图 size 变 → 键变', () => {
    expect(computeCacheKey(withOverrides({ source: { ...BASE.source, size: BASE.source.size + 1 } }))).not.toBe(
      computeCacheKey(BASE)
    );
  });

  it('分量 2 变：模型指纹变 → 键变', () => {
    expect(computeCacheKey(withOverrides({ modelSha256: 'other-sha' }))).not.toBe(computeCacheKey(BASE));
  });

  it('分量 3 变：输入尺寸变 → 键变', () => {
    expect(computeCacheKey(withOverrides({ inputDims: [1, 3, 448, 448] }))).not.toBe(computeCacheKey(BASE));
  });

  it('分量 4 变：后处理参数值变 → 键变（A1 的直接防线，改参数拿到旧图是静默出错）', () => {
    expect(computeCacheKey(withOverrides({ postprocessParams: { ...BASE.postprocessParams, threshold: 200 } }))).not.toBe(
      computeCacheKey(BASE)
    );
  });

  it('分量 4 变：后处理参数增删键也变（含从 false 开成 true 这种）', () => {
    expect(computeCacheKey(withOverrides({ postprocessParams: { alphaMatting: true, threshold: 240 } }))).not.toBe(
      computeCacheKey(BASE)
    );
    expect(computeCacheKey(withOverrides({ postprocessParams: { alphaMatting: false } }))).not.toBe(
      computeCacheKey(BASE)
    );
    expect(computeCacheKey(withOverrides({ postprocessParams: {} }))).not.toBe(computeCacheKey(BASE));
  });

  it('分量 5 变：预处理管线版本变 → 键变（A4，换转码器后缓存必须整体失效）', () => {
    expect(computeCacheKey(withOverrides({ pipelineVersion: 2 }))).not.toBe(computeCacheKey(BASE));
  });

  it('参数对象的键书写顺序不影响结果', () => {
    expect(
      computeCacheKey(withOverrides({ postprocessParams: { threshold: 240, alphaMatting: false } }))
    ).toBe(computeCacheKey(BASE));
  });

  it('分量之间不会因拼接而串位：把内容在两个分量间对调必须得到不同的键', () => {
    expect(
      computeCacheKey(withOverrides({ modelSha256: '1,3,320,320', inputDims: [Number(BASE.modelSha256.slice(0, 1))] }))
    ).not.toBe(computeCacheKey(BASE));
    // 同一分量内部的分隔符也不能与跨分量的分隔符混淆
    expect(
      computeCacheKey(
        withOverrides({
          source: { absPath: 'C:/a.jpg:1:2', mtimeMs: 1, size: 2 },
          modelSha256: BASE.modelSha256
        })
      )
    ).not.toBe(computeCacheKey(withOverrides({ source: { absPath: 'C:/a.jpg', mtimeMs: 1, size: 2 } })));
  });

  it('嵌套参数结构的变化也能反映到键上（后处理实装后的形状）', () => {
    expect(
      computeCacheKey(withOverrides({ postprocessParams: { alphaMatting: { erodeSize: 10 } } }))
    ).not.toBe(
      computeCacheKey(withOverrides({ postprocessParams: { alphaMatting: { erodeSize: 11 } } }))
    );
  });
});
