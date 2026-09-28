/**
 * 批次4 · 显卡可解释性（规格 §6 + §8-17）的纯函数用例。
 * 两条判据方向相反，都得钉住：认得出显卡问题，且**认不出时不许硬编成显卡问题**。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { classifyGpuError, isUnloadActionable } from '../../electron/ai/gpuErrorText';
import {
  classifyAdapters,
  parseFakeGpuEnv,
  activeFakeGpu,
  readGpuCapability,
  resetGpuCapabilityCache
} from '../../electron/ai/gpuCapability';

describe('classifyGpuError —— 显卡类错误的人话化', () => {
  it('显存不足：给出 GPU_MEMORY_LOW 与人话，且人话里带着"怎么办"', () => {
    const r = classifyGpuError('CUDA failure 2 : out of memory');
    expect(r?.code).toBe('GPU_MEMORY_LOW');
    expect(r?.message).toContain('显存不够');
    expect(r?.message).toContain('CPU 慢速模式');
  });

  it('DirectML 建会话就崩（实测 BiRefNet 的 DmlFusedNode 形态）：归到设备不可用', () => {
    const r = classifyGpuError('[onnxruntime] DmlFusedNode_19_64 Non-zero status: 80070057');
    expect(r?.code).toBe('GPU_DEVICE_UNAVAILABLE');
    expect(r?.message).toContain('显卡加速用不了');
  });

  it('给人看的消息里不许再夹内部术语与原始堆栈', () => {
    for (const raw of ['DmlFusedNode_19_64 Non-zero status', 'out of memory in DML allocator']) {
      const msg = classifyGpuError(raw)?.message ?? '';
      expect(msg).not.toMatch(/DmlFusedNode|onnxruntime|allocator|0x[0-9a-f]+/i);
    }
  });

  it('反面腿：与显卡无关的错误一律返回 null，让上层保留原文与原码', () => {
    for (const raw of [
      'ENOENT: no such file or directory, open C:/p/a.jpg',
      '读不出这张图片的信息：可能是本应用不支持的格式',
      '用户取消了任务',
      ''
    ]) {
      expect(classifyGpuError(raw), `不该把「${raw}」说成显卡问题`).toBeNull();
    }
  });

  it('只有显存不足这一类给"一键卸载"（卸载对设备不可用没有任何帮助）', () => {
    expect(isUnloadActionable('GPU_MEMORY_LOW')).toBe(true);
    expect(isUnloadActionable('GPU_DEVICE_UNAVAILABLE')).toBe(false);
    expect(isUnloadActionable('DECODE_FAILED')).toBe(false);
  });
});

describe('classifyAdapters —— 有没有能用的 GPU', () => {
  it('枚举到真实显卡就是 ok（带显存字节数）', () => {
    expect(classifyAdapters(['NVIDIA GeForce RTX 5060 Laptop GPU|8151000000'])).toBe('ok');
  });

  it('只有 Microsoft Basic Render Driver（远程桌面/无头常见）判为不可用', () => {
    expect(classifyAdapters(['Microsoft Basic Render Driver|0'])).toBe('unavailable');
  });

  it('混合情况下有真卡就 ok，不被 Basic 拖累', () => {
    expect(classifyAdapters(['Microsoft Basic Render Driver|0', 'Intel(R) UHD Graphics|134217728'])).toBe('ok');
  });

  it('反面腿：探测失败/输出为空/认不出名字一律 unknown，绝不能报"不可用"', () => {
    expect(classifyAdapters([])).toBe('unknown');
    expect(classifyAdapters(['   ', ''])).toBe('unknown');
    // 名字既不是 Basic 也认不出厂商、显存字段又读不到：没有证据说这台机器跑不动
    expect(classifyAdapters(['Some Virtual Device|'])).toBe('unknown');
  });
});

describe('PTM_FAKE_GPU 本地调试开关', () => {
  afterEach(() => {
    delete process.env.PTM_FAKE_GPU;
    resetGpuCapabilityCache();
  });

  it('认得 none 与 oom，别名与大小写/空格也认', () => {
    expect(parseFakeGpuEnv('none')).toBe('none');
    expect(parseFakeGpuEnv(' No-GPU ')).toBe('none');
    expect(parseFakeGpuEnv('UNAVAILABLE')).toBe('none');
    expect(parseFakeGpuEnv('oom')).toBe('oom');
    expect(parseFakeGpuEnv('VRAM')).toBe('oom');
  });

  it('反面腿：空值、拼错的值、0 一律当没设过——一个错别字不该改掉真机判断', () => {
    for (const v of ['', '   ', 'flase', 'nope', '0', 'false', 'yes']) {
      expect(parseFakeGpuEnv(v), `「${v}」不该被当成有效开关`).toBeNull();
    }
  });

  it('设成 none 时探测直接短路成 unavailable，且没去起 nvidia-smi', async () => {
    process.env.PTM_FAKE_GPU = 'none';
    const t0 = Date.now();
    expect(await readGpuCapability()).toBe('unavailable');
    // 真探测要起一次外部命令（本机实测 3 秒超时上限）；短路路径不该有这种耗时
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('oom 档只被识别成 oom（它作用在推理那一步，不参与能力判断）', () => {
    process.env.PTM_FAKE_GPU = 'oom';
    expect(activeFakeGpu()).toBe('oom');
  });
});
