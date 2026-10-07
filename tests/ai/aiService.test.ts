// aiService 编排单测：一次点击串完 下载→加载→推理→写暂存，缓存命中不重跑。
// 全部注入假 runner / 假下载器，不碰原生推理（真机链路在 inference.integration 与 T14）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, readdir, utimes, writeFile, stat, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';

import { configureAiPaths, resetAiPaths, previewDir, previewFile, modelDir } from '../../electron/ai/paths';
import { AiService, resolveModel, type AiProgress, type InferenceRunner, type ModelGateway } from '../../electron/ai/aiService';
import { getModel, getCapability } from '../../electron/ai/capabilityCatalog';
import type { InferFeedsReply, InferFeedsRequest } from '../../electron/ai/inferenceChild';
import { MOBILE_SAM_PAIR } from '../../electron/ai/mobileSam';
import type { CapabilitySpec } from '../../electron/ai/capabilityCatalog';

class FakeRunner implements InferenceRunner {
  loadCalls: string[] = [];
  /** 每次 load 请求实际带来的后端：backend 切换必须体现在这里（§8-16） */
  loadBackends: Array<string | undefined> = [];
  inferCalls = 0;
  liveInfer = 0;
  maxLiveInfer = 0;
  inferError: Error | null = null;
  inferDelayMs = 0;
  /** 注入掩码内容（默认整幅为 1）；底色类断言需要背景区真的透明 */
  maskOf: ((w: number, h: number) => Float32Array) | null = null;
  lastDims: number[] | null = null;
  loadedModelId: string | null = null;
  unloadCalls = 0;
  restartCount = 0;

  async load(req: { model: { id: string }; backend?: string }): Promise<number> {
    this.loadCalls.push(req.model.id);
    this.loadBackends.push(req.backend);
    this.loadedModelId = req.model.id;
    return 5;
  }

  async infer(req: { dims: number[] }): Promise<{ data: Float32Array; dims: number[]; outputName: string; inferMs: number }> {
    this.lastDims = req.dims;
    this.inferCalls += 1;
    this.liveInfer += 1;
    this.maxLiveInfer = Math.max(this.maxLiveInfer, this.liveInfer);
    try {
      if (this.inferDelayMs) await new Promise((r) => setTimeout(r, this.inferDelayMs));
      if (this.inferError) throw this.inferError;
      const [, , h, w] = req.dims;
      // 默认整幅为 1（成品全不透明）；底色那条断言要"背景区真的透明"才读得出像素差
      const data = this.maskOf ? this.maskOf(w, h) : new Float32Array(w * h).fill(1);
      return { data, dims: [1, 1, h, w], outputName: 'fake-out', inferMs: 1 };
    } finally {
      this.liveInfer -= 1;
    }
  }

  async unload(): Promise<void> {
    this.unloadCalls += 1;
    this.loadedModelId = null;
  }

  async loadNamed(): Promise<number> { return 1; }
  async unloadNamed(): Promise<void> {}
  async inferFeeds(req: InferFeedsRequest): Promise<InferFeedsReply> {
    if (req.sessionKey.endsWith('encoder')) return { outputs: { image_embeddings: { type: 'float32', dims: [1, 256, 64, 64], data: new Float32Array(256 * 64 * 64) } }, inferMs: 1 };
    const labels = req.feeds.point_labels?.data as Float32Array;
    const mask = new Float32Array(3 * 4 * 8);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) mask[y * 8 + x] = 1;
    if (labels.at(-1) === 0) mask[8] = 0;
    if (labels.at(-1) === 1) mask.fill(1, 0, 32);
    return { outputs: { masks: { type: 'float32', dims: [1, 3, 4, 8], data: mask }, iou_predictions: { type: 'float32', dims: [1, 3], data: new Float32Array([0.9, 0.5, 0.2]) } }, inferMs: 1 };
  }

  async dispose(): Promise<void> {
    this.loadedModelId = null;
  }
}

class FakeStore implements ModelGateway {
  state: 'absent' | 'present' = 'absent';
  downloadCalls = 0;
  downloadDelayMs = 0;
  downloadError: Error | null = null;

  async status(): Promise<'absent' | 'downloading' | 'present'> {
    return this.state;
  }

  async verify(): Promise<boolean> { return this.state === 'present'; }

  async download(spec: { id: string; fileName: string }, signal?: AbortSignal): Promise<{ path: string }> {
    this.downloadCalls += 1;
    if (this.downloadDelayMs) await new Promise((r) => setTimeout(r, this.downloadDelayMs));
    if (signal?.aborted) throw new Error('下载已取消');
    if (this.downloadError) throw this.downloadError;
    await mkdir(modelDir(spec.id), { recursive: true });
    const path = join(modelDir(spec.id), spec.fileName);
    await writeFile(path, 'fake-weights');
    this.state = 'present';
    return { path };
  }

  async remove(): Promise<void> {
    this.state = 'absent';
  }

  // 模拟"模型已下载就位"：状态与磁盘文件必须一起成立，否则服务的存在性检查就是空转
  async markPresent(): Promise<void> {
    await this.download({ id: 'u2netp', fileName: 'u2netp.onnx' });
    this.state = 'present';
    for (const spec of MOBILE_SAM_PAIR) {
      await mkdir(modelDir(spec.id), { recursive: true });
      await writeFile(join(modelDir(spec.id), spec.fileName), 'fake-sam');
    }
    this.downloadCalls = 0; // 预置不算一次真实下载
  }
}

let userData = '';
let photoDir = '';
let photoPath = '';
let photoPath2 = '';
let photoPath3 = '';
let service: AiService;
let runner: FakeRunner;
let store: FakeStore;
let progress: AiProgress[] = [];
let done: { taskId: string; cacheHit: boolean }[] = [];
let errored: { code: string; message: string }[] = [];

function dedupe<T>(items: T[]): T[] {
  return items.filter((v, i) => i === 0 || v !== items[i - 1]);
}

async function jpegOf(width: number, height: number, value: number): Promise<Buffer> {
  const px = Buffer.alloc(width * height * 3, value);
  return sharp(px, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();
}

/** 用更短的空闲阈值重建服务（默认 5 分钟在测试里等不起），其余注入与 beforeEach 一致 */
function makeService(idleUnloadMs: number): AiService {
  return new AiService({
    runner,
    store,
    idleUnloadMs,
    onProgress: (p) => progress.push(p),
    onDone: (d) => done.push({ taskId: d.taskId, cacheHit: d.cacheHit }),
    onError: (e) => errored.push(e)
  });
}

beforeEach(async () => {
  resetAiPaths();
  userData = await mkdtemp(join(tmpdir(), 'ptm-ai-service-'));
  configureAiPaths(userData);
  photoDir = await mkdtemp(join(tmpdir(), 'ptm-photos-'));
  photoPath = join(photoDir, 'IMG_0001.jpg');
  photoPath2 = join(photoDir, 'IMG_0002.jpg');
  photoPath3 = join(photoDir, 'IMG_0003.jpg');
  await writeFile(photoPath, await jpegOf(8, 4, 200));
  await writeFile(photoPath2, await jpegOf(6, 6, 90));
  await writeFile(photoPath3, await jpegOf(10, 5, 140));

  runner = new FakeRunner();
  store = new FakeStore();
  progress = [];
  done = [];
  errored = [];
  service = new AiService({
    runner,
    store,
    onProgress: (p) => progress.push(p),
    onDone: (d) => done.push({ taskId: d.taskId, cacheHit: d.cacheHit }),
    onError: (e) => errored.push(e)
  });
});

afterEach(async () => {
  resetAiPaths();
  await rm(userData, { recursive: true, force: true, maxRetries: 5 });
  await rm(photoDir, { recursive: true, force: true, maxRetries: 5 });
});

describe('ai/aiService —— 一次点击走完 下载→加载→推理→写暂存', () => {
  it('① 未下载：确认后一次调用串完整条链，中途不再要求第二次调用', async () => {
    const result = await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout', downloadApproved: true });
    expect(store.downloadCalls).toBe(1);
    expect(runner.loadCalls).toEqual(['u2netp']);
    expect(runner.inferCalls).toBe(1);
    expect(result.cacheHit).toBe(false);
    expect(existsSync(result.tempPath)).toBe(true);
    expect(done.length).toBe(1);
    expect(done[0].cacheHit).toBe(false);
  });

  it('① 未下载且未确认：不下载不推理，返回可读的代价说明', async () => {
    await expect(service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' })).rejects.toMatchObject({
      code: 'DOWNLOAD_NEEDS_CONSENT'
    });
    expect(store.downloadCalls).toBe(0);
    expect(runner.inferCalls).toBe(0);
    expect(errored[0]?.code).toBe('DOWNLOAD_NEEDS_CONSENT');
  });

  it('已下载时不问：不需要 downloadApproved 也能走完', async () => {
    await store.markPresent();
    await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    expect(store.downloadCalls).toBe(0);
    expect(runner.inferCalls).toBe(1);
  });

  it('② 缓存命中：第二次调用不调 runner，结果标 cacheHit', async () => {
    await store.markPresent();
    await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    runner.inferCalls = 0;
    runner.loadCalls = [];

    const again = await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    expect(again.cacheHit).toBe(true);
    expect(runner.inferCalls).toBe(0);
    expect(runner.loadCalls).toEqual([]);
    expect(done.at(-1)?.cacheHit).toBe(true);
  });

  it('② 改动原图（mtime/size 变）必须重跑，不得复用旧结果', async () => {
    await store.markPresent();
    const first = await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    const before = await readdir(previewDir());

    // mtimeMs 是原图指纹的分量：触碰它等价于"这张图被改过"
    const touched = new Date(Date.now() + 5000);
    await utimes(photoPath, touched, touched);
    runner.inferCalls = 0;
    const second = await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });

    expect(second.cacheHit).toBe(false);
    expect(second.tempPath).not.toBe(first.tempPath);
    expect(runner.inferCalls).toBe(1);
    expect(await readdir(previewDir())).toHaveLength(before.length + 1);
  });

  it('③ 全程发进度，phase 只允许 download|load|infer|encode', async () => {
    await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout', downloadApproved: true });
    expect(dedupe(progress.map((p) => p.phase))).toEqual(['download', 'load', 'infer', 'encode']);
    for (const p of progress) {
      expect(['download', 'load', 'infer', 'encode']).toContain(p.phase);
      expect(typeof p.taskId).toBe('string');
    }
    // 下载阶段必须带可画的进度值（按钮靠背景填充表达，不置灰）
    const downloads = progress.filter((p) => p.phase === 'download');
    expect(downloads.length).toBeGreaterThanOrEqual(1);
    expect(downloads.every((p) => typeof p.percent === 'number')).toBe(true);
  });

  it('③ 模型已就绪时没有 download 阶段', async () => {
    await store.markPresent();
    await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    expect(dedupe(progress.map((p) => p.phase))).toEqual(['load', 'infer', 'encode']);
  });

  it('④ 同一时刻只允许一个推理，第二个排队不并发', async () => {
    await store.markPresent();
    runner.inferDelayMs = 40;
    await Promise.all([
      service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' }),
      service.run({ absPath: photoPath2, capabilityId: 'portrait-cutout' })
    ]);
    expect(runner.inferCalls).toBe(2);
    expect(runner.maxLiveInfer).toBe(1);
  });

  it('⑤ cancel 能中断含下载在内的整条链', async () => {
    store.downloadDelayMs = 300;
    const handle = service.startRun({ absPath: photoPath, capabilityId: 'portrait-cutout', downloadApproved: true });
    expect(service.cancel(handle.taskId)).toBe(true);
    await expect(handle.promise).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(store.state).toBe('absent');
    expect(runner.inferCalls).toBe(0);
    expect(await readdir(previewDir())).toEqual([]);
    expect(done.length).toBe(0);
  });

  it('⑤ 取消一个任务不影响后续任务', async () => {
    await store.markPresent();
    runner.inferDelayMs = 300;
    const handle = service.startRun({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    service.cancel(handle.taskId);
    await expect(handle.promise).rejects.toMatchObject({ code: 'CANCELLED' });
    runner.inferDelayMs = 0;
    await expect(service.run({ absPath: photoPath2, capabilityId: 'portrait-cutout' })).resolves.toBeTruthy();
  });

  it('⑥ 子进程崩溃：当次任务报可读错误，服务继续存活', async () => {
    await store.markPresent();
    runner.inferError = new Error('推理子进程已退出（code=139）。当次任务未完成，可直接重试');
    await expect(service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' })).rejects.toMatchObject({
      code: 'INFERENCE_FAILED',
      message: expect.stringMatching(/子进程已退出/)
    });
    expect(errored.length).toBe(1);
    runner.inferError = null;
    await expect(service.run({ absPath: photoPath2, capabilityId: 'portrait-cutout' })).resolves.toBeTruthy();
  });

  it('红线：结果只落 userData/ai-preview，照片目录一个字节都不许多', async () => {
    await store.markPresent();
    const before = await readdir(photoDir);
    const original = await stat(photoPath);
    await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    expect(await readdir(photoDir)).toEqual(before);
    const pngs = (await readdir(previewDir())).filter((f) => f.endsWith('.png'));
    expect(pngs).toHaveLength(1);
    expect(pngs[0]).toMatch(/^[0-9a-f]{40}\.png$/);
    expect(before.some((f) => f.endsWith('.png'))).toBe(false);

    // 换底色同样只是往暂存里再写一张成品 + 留一份掩码，照片目录依旧一字节不动（§8-6）
    await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout', cutout: { bgcolor: 'white' } });
    expect(await readdir(photoDir)).toEqual(before);
    expect((await readdir(previewDir())).filter((f) => f.endsWith('.png'))).toHaveLength(2);
    // 原图本体也没被就地改过：任何一次写入都会动 mtime 或 size
    const after = await stat(photoPath);
    expect(after.size).toBe(original.size);
    expect(after.mtimeMs).toBe(original.mtimeMs);
  });

  it('推理输入形状取自清单，服务侧不写死', async () => {
    await store.markPresent();
    await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    expect(runner.lastDims).toEqual(getModel('portrait-cutout', 'u2netp')!.inputDims);
  });

  it('缓存文件名就是五元组键，同一条件重复请求命中同一文件', async () => {
    await store.markPresent();
    const first = await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    const again = await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    expect(again.tempPath).toBe(first.tempPath);
    expect(first.tempPath.startsWith(previewDir())).toBe(true);
  });

  it('§8-16 未指定后端时显式按 dml 传给子进程，不依赖对方的默认值', async () => {
    await store.markPresent();
    await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    expect(runner.loadBackends).toEqual(['dml']);
  });

  it('§8-16 用户切到 CPU 必须重建会话：同后端不同图不重建，切后端必重建', async () => {
    await store.markPresent();
    await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    await service.run({ absPath: photoPath2, capabilityId: 'portrait-cutout' });
    expect(runner.loadBackends).toEqual(['dml']); // 会话仍可复用

    await service.run({ absPath: photoPath3, capabilityId: 'portrait-cutout', backend: 'cpu' });
    expect(runner.loadBackends).toEqual(['dml', 'cpu']);

    // 会话被外部回收（卸载 / 子进程崩溃）后，同后端也必须重建：
    // 该判据与"模型 id 是否仍驻留"是 AND 关系，单拎后端判断会漏掉这条
    runner.loadedModelId = null;
    const touched = new Date(Date.now() + 60_000);
    await utimes(photoPath, touched, touched);
    await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout', backend: 'cpu' });
    expect(runner.loadBackends).toEqual(['dml', 'cpu', 'cpu']);
  });

  it('未知行为报 CAPABILITY_UNAVAILABLE', async () => {
    await expect(service.run({ absPath: photoPath, capabilityId: 'no-such' })).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE'
    });
  });
});

describe('ai/aiService —— 模型可用性判定（§4.3）', () => {
  const realCap = getCapability('portrait-cutout')!;

  // message 是给人看的，不含错误码；断言读 e.code
  function codeOf(fn: () => unknown): string {
    try {
      fn();
      return 'NO_THROW';
    } catch (e) {
      return (e as { code?: string }).code ?? 'NO_CODE';
    }
  }

  it('清单里没有的模型报 MODEL_UNAVAILABLE', () => {
    expect(codeOf(() => resolveModel([realCap], 'portrait-cutout', 'ghost'))).toBe('MODEL_UNAVAILABLE');
  });

  it('存在但未实测跑通的模型报 MODEL_NOT_VERIFIED，绝不允许被执行', () => {
    const unverified = { ...realCap, models: realCap.models.map((m) => ({ ...m, verified: false })) };
    expect(codeOf(() => resolveModel([unverified], 'portrait-cutout', 'u2netp'))).toBe('MODEL_NOT_VERIFIED');
  });

  it('正常路径返回清单里的模型规格', () => {
    expect(resolveModel([realCap], 'portrait-cutout', 'u2netp').sha256).toBe(
      getModel('portrait-cutout', 'u2netp')!.sha256
    );
  });

  it('行为本身不在清单里报 CAPABILITY_UNAVAILABLE', () => {
    expect(codeOf(() => resolveModel([realCap], 'no-such', 'u2netp'))).toBe('CAPABILITY_UNAVAILABLE');
  });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ai/aiService —— 连续空闲自动释放驻留模型（§5.2 末条）', () => {
  it('超过阈值没再动它：会话被释放，显存还回来', async () => {
    await store.markPresent();
    service = makeService(150);
    await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    expect(runner.loadedModelId).toBe('u2netp');
    await wait(450);
    expect(runner.loadedModelId).toBeNull();
    expect(runner.unloadCalls).toBe(1);
    await service.dispose();
  });

  it('阈值内又来一次：从最后一次活动重新计时，不会在连续处理中把会话抽走', async () => {
    await store.markPresent();
    service = makeService(400);
    await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    await wait(250);
    await service.run({ absPath: photoPath2, capabilityId: 'portrait-cutout' });
    await wait(250); // 距第一次早已超过 400，距第二次只有 250
    expect(runner.loadedModelId).toBe('u2netp');
    expect(runner.unloadCalls).toBe(0);
    await wait(500);
    expect(runner.loadedModelId).toBeNull();
    await service.dispose();
  });

  it('任务还在跑就撞到了计时点：不抽走在用会话，等它结束再重新计', async () => {
    await store.markPresent();
    runner.inferDelayMs = 260;
    service = makeService(80);
    const pending = service.startRun({ absPath: photoPath, capabilityId: 'portrait-cutout' }).promise;
    await wait(160); // 计时点早已到，但任务在途
    expect(runner.unloadCalls).toBe(0);
    expect(runner.loadedModelId).toBe('u2netp');
    await pending;
    await wait(300); // 从任务结束起算才满 80ms
    expect(runner.unloadCalls).toBe(1);
    await service.dispose();
  });

  it('到点时本来就没有驻留模型：不去敲一个空会话', async () => {
    service = makeService(100);
    // 未下载且没确认 → 在加载之前就失败，清单里没有任何驻留
    await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' }).catch(() => undefined);
    expect(runner.loadedModelId).toBeNull();
    await wait(350);
    expect(runner.unloadCalls).toBe(0);
    await service.dispose();
  });

  it('自动释放之后再点一次：自己重新加载，用户不需要任何手动步骤', async () => {
    await store.markPresent();
    service = makeService(150);
    await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    expect(runner.loadCalls).toEqual(['u2netp']);
    await wait(450);
    expect(runner.loadedModelId).toBeNull();
    await service.run({ absPath: photoPath3, capabilityId: 'portrait-cutout' });
    expect(runner.loadCalls).toEqual(['u2netp', 'u2netp']);
    expect(runner.loadedModelId).toBe('u2netp');
    await service.dispose();
  });
});

describe('ai/aiService —— 掩码级缓存 + 底色（切片一，方案 §8-1/2/3）', () => {
  /** 左 40% 前景、其余透明的掩码：底色要读得出像素差，整幅填 1 的默认假掩码读不出 */
  function halfForeground(w: number, h: number): Float32Array {
    const d = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) d[y * w + x] = x < w * 0.4 ? 1 : 0;
    }
    return d;
  }

  /** 成品右下角像素（带着通道数一起返回，通道数本身就是"alpha 有没有被铺掉"的读数） */
  async function cornerPixel(path: string): Promise<number[]> {
    const raw = await sharp(await readFile(path)).raw().toBuffer({ resolveWithObject: true });
    const i = (raw.info.width * raw.info.height - 1) * raw.info.channels;
    return Array.from(raw.data.subarray(i, i + raw.info.channels));
  }

  async function alphaAt(path: string, x: number, y: number): Promise<number> {
    const { data, info } = await sharp(await readFile(path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return data[(y * info.width + x) * info.channels + info.channels - 1];
  }

  it('笔刷修改掩码后可撤销/重做，保存的 PNG 使用重做后的 alpha', async () => {
    await store.markPresent();
    runner.maskOf = halfForeground;
    const result = await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    expect(await alphaAt(result.tempPath, 0, 1)).toBeGreaterThan(240);

    const erased = await service.editMask(result.taskId, {
      action: 'prompt',
      prompt: { x: 0.0625, y: 0.375, label: 0 }
    });
    expect(await alphaAt(erased.tempPath, 0, 1)).toBeLessThan(16);
    expect(await alphaAt(erased.tempPath, 2, 0)).toBeGreaterThan(240);
    expect(erased.maskCanUndo).toBe(true);

    await service.editMask(result.taskId, { action: 'undo' });
    const redone = await service.editMask(result.taskId, { action: 'redo' });
    expect(await alphaAt(redone.tempPath, 0, 1)).toBeLessThan(16);
  });

  it('笔刷可以恢复背景像素为前景，并撤销恢复', async () => {
    await store.markPresent();
    runner.maskOf = halfForeground;
    const result = await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    expect((await cornerPixel(result.tempPath)).at(-1)).toBeLessThan(16);

    const restored = await service.editMask(result.taskId, {
      action: 'prompt',
      prompt: { x: 0.9, y: 0.9, label: 1 }
    });
    expect((await cornerPixel(restored.tempPath)).at(-1)).toBeGreaterThan(240);
    await service.editMask(result.taskId, { action: 'undo' });
    // Returning to zero prompts must preserve the original automatic result exactly.
    const current = await service.editMask(result.taskId, { action: 'redo' });
    expect((await cornerPixel(current.tempPath)).at(-1)).toBeGreaterThan(240);
  });

  it('① 改底色不重跑推理：第一次 infer=1，换白底后 infer 仍是 1', async () => {
    await store.markPresent();
    const first = await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    expect(runner.inferCalls).toBe(1);

    const white = await service.run({
      absPath: photoPath,
      capabilityId: 'portrait-cutout',
      cutout: { bgcolor: 'white' }
    });
    expect(runner.inferCalls).toBe(1);
    expect(white.cacheHit).toBe(false); // 不是拿旧图：成品键含参数（§8-3）
    expect(white.tempPath).not.toBe(first.tempPath);
    expect(existsSync(white.tempPath)).toBe(true);

    // 掩码确实**落盘**在 ai-preview/masks 内，不是只活在内存里的一次性对象
    const masks = await readdir(join(previewDir(), 'masks'));
    expect(masks).toHaveLength(1);
    expect(masks[0]).toMatch(/^[0-9a-f]{40}\.mask\.bin$/);
    // 头部 8 字节写宽高，其余是 float32 逐点数据。尺寸取本次结果报回的那对数：
    // 形状不在这里写死（红线 2），且裁掉补边后的掩码随图片长宽比变
    expect(white.maskWidth).toBeGreaterThan(0);
    expect(white.maskHeight).toBeGreaterThan(0);
    expect((await stat(join(previewDir(), 'masks', masks[0]!))).size).toBe(
      8 + white.maskWidth * white.maskHeight * 4
    );

    // 再换一个底色仍然不重跑；同一份参数第二次直接命中成品缓存
    await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout', cutout: { bgcolor: 'blue' } });
    expect(runner.inferCalls).toBe(1);
    const again = await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout', cutout: { bgcolor: 'blue' } });
    expect(again.cacheHit).toBe(true);
    expect(runner.inferCalls).toBe(1);
  });

  it('① 掩码缓存是"每张图"的，不是全局旁路：换一张图仍然要真推理', async () => {
    await store.markPresent();
    await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    expect(runner.inferCalls).toBe(1);
    await service.run({ absPath: photoPath2, capabilityId: 'portrait-cutout' });
    expect(runner.inferCalls).toBe(2);
    await service.run({ absPath: photoPath2, capabilityId: 'portrait-cutout', cutout: { bgcolor: 'red' } });
    expect(runner.inferCalls).toBe(2); // 这张图的掩码已经在了
    expect(await readdir(join(previewDir(), 'masks'))).toHaveLength(2);
  });

  it('② 底色真的改变成品像素（读回文件，不是读 store）', async () => {
    await store.markPresent();
    runner.maskOf = halfForeground;
    const transparent = await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    const white = await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout', cutout: { bgcolor: 'white' } });
    expect(runner.inferCalls).toBe(1); // 两张图之间只推理过一次

    // 背景区：透明底留着 alpha=0；白底被铺成纯白且 alpha 通道整个消失（4 通道 → 3 通道）
    expect((await cornerPixel(transparent.tempPath)).at(-1)).toBe(0);
    expect(await cornerPixel(white.tempPath)).toEqual([255, 255, 255]);

    // 前景区不受底色污染：两种底的同一颗像素 rgb 相同
    const raw = await sharp(await readFile(white.tempPath)).raw().toBuffer({ resolveWithObject: true });
    const fg = Array.from(raw.data.subarray(0, 3));
    const tRaw = await sharp(await readFile(transparent.tempPath)).raw().toBuffer({ resolveWithObject: true });
    expect(Array.from(tRaw.data.subarray(0, 3))).toEqual(fg);
  });

  it('② 原图被改过，掩码缓存必须失效（不许拿旧掩码套新图）', async () => {
    await store.markPresent();
    await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout', cutout: { bgcolor: 'white' } });
    expect(runner.inferCalls).toBe(1);
    const touched = new Date(Date.now() + 5000);
    await utimes(photoPath, touched, touched);
    await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    expect(runner.inferCalls).toBe(2);
    expect(await readdir(join(previewDir(), 'masks'))).toHaveLength(2);
  });

  it('界面那句掩码尺寸：命中成品缓存也要报裁边后的真实值，不是输入形状', async () => {
    const inputDims = getModel('portrait-cutout', 'u2netp')!.inputDims;
    await store.markPresent();
    const first = await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    // 8×4 的原图在方形输入里要裁掉上下补边，真实掩码必然矮于输入形状
    expect(first.maskHeight).toBeLessThan(first.maskWidth);

    const again = await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    expect(again.cacheHit).toBe(true);
    expect(again.maskWidth).toBe(first.maskWidth);
    expect(again.maskHeight).toBe(first.maskHeight);
    // 命中分支若退回"拿 inputDims 充数"的旧写法，高度会变成方形输入的 320（这张图真实是 160）
    expect(again.maskHeight).not.toBe(inputDims[2]);
  });

  it('成品条目里真的记下本次掩码尺寸（界面那句注明的来源）', async () => {
    await store.markPresent();
    const first = await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    const index = JSON.parse(await readFile(join(previewDir(), 'index.json'), 'utf8')) as {
      entries: Record<string, { kind?: string; maskWidth?: number; maskHeight?: number }>;
    };
    const resultEntry = Object.values(index.entries).find((e) => (e.kind ?? 'result') === 'result');
    expect(resultEntry, '成品条目没进索引').toBeDefined();
    expect([resultEntry!.maskWidth, resultEntry!.maskHeight]).toEqual([first.maskWidth, first.maskHeight]);
  });

  it('掩码文件被 LRU 淘汰、成品还在时：宁可重推理一次，也要给出可编辑的真实尺寸', async () => {
    await store.markPresent();
    const first = await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    for (const f of await readdir(join(previewDir(), 'masks'))) {
      await rm(join(previewDir(), 'masks', f), { force: true });
    }
    const before = runner.inferCalls;
    const again = await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    // 旧契约曾让这条走成品缓存（cacheHit=true）——于是笔刷悄悄不可用，真机 2026-07-31 翻车。
    // 新契约：掩码不在就不命中，重推理；真实裁边尺寸照样带回来，不靠猜。
    expect(again.cacheHit).toBe(false);
    expect(runner.inferCalls).toBe(before + 1);
    expect([again.maskWidth, again.maskHeight]).toEqual([first.maskWidth, first.maskHeight]);
    expect(again.maskHeight).toBeLessThan(getModel('portrait-cutout', 'u2netp')!.inputDims[2]);
    expect(again.maskEditable).toBe(true);
  });

  it('索引和掩码都没了也只是重推理：尺寸来自本次合成，绝不报 0', async () => {
    const inputDims = getModel('portrait-cutout', 'u2netp')!.inputDims;
    await store.markPresent();
    const first = await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    await rm(previewFile('index.json'), { force: true });
    for (const f of await readdir(join(previewDir(), 'masks'))) {
      await rm(join(previewDir(), 'masks', f), { force: true });
    }
    const again = await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    expect(again.cacheHit).toBe(false);
    expect(again.maskWidth).toBe(first.maskWidth);
    expect(again.maskHeight).toBe(first.maskHeight);
    expect(again.maskHeight).toBeLessThan(inputDims[2]);
    expect(again.maskEditable).toBe(true);
  });

  it('未点保存：掩码与成品都只在暂存内，照片目录不多一个文件', async () => {
    await store.markPresent();
    const before = await readdir(photoDir);
    const white = await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout', cutout: { bgcolor: 'white' } });
    expect(white.tempPath.startsWith(previewDir())).toBe(true);
    const masks = await readdir(join(previewDir(), 'masks'));
    expect(masks.every((f) => join(previewDir(), 'masks', f).startsWith(previewDir()))).toBe(true);
    expect(await readdir(photoDir)).toEqual(before);
  });
});
