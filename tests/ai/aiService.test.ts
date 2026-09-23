// aiService 编排单测：一次点击串完 下载→加载→推理→写暂存，缓存命中不重跑。
// 全部注入假 runner / 假下载器，不碰原生推理（真机链路在 inference.integration 与 T14）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, readdir, utimes, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';

import { configureAiPaths, resetAiPaths, previewDir, modelDir } from '../../electron/ai/paths';
import { AiService, resolveModel, type AiProgress, type InferenceRunner, type ModelGateway } from '../../electron/ai/aiService';
import { getModel, getCapability } from '../../electron/ai/capabilityCatalog';
import type { CapabilitySpec } from '../../electron/ai/capabilityCatalog';

class FakeRunner implements InferenceRunner {
  loadCalls: string[] = [];
  inferCalls = 0;
  liveInfer = 0;
  maxLiveInfer = 0;
  inferError: Error | null = null;
  inferDelayMs = 0;
  lastDims: number[] | null = null;
  loadedModelId: string | null = null;
  restartCount = 0;

  async load(req: { model: { id: string } }): Promise<number> {
    this.loadCalls.push(req.model.id);
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
      return { data: new Float32Array(w * h).fill(1), dims: [1, 1, h, w], outputName: 'fake-out', inferMs: 1 };
    } finally {
      this.liveInfer -= 1;
    }
  }

  async unload(): Promise<void> {
    this.loadedModelId = null;
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
    this.downloadCalls = 0; // 预置不算一次真实下载
  }
}

let userData = '';
let photoDir = '';
let photoPath = '';
let photoPath2 = '';
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

beforeEach(async () => {
  resetAiPaths();
  userData = await mkdtemp(join(tmpdir(), 'ptm-ai-service-'));
  configureAiPaths(userData);
  photoDir = await mkdtemp(join(tmpdir(), 'ptm-photos-'));
  photoPath = join(photoDir, 'IMG_0001.jpg');
  photoPath2 = join(photoDir, 'IMG_0002.jpg');
  await writeFile(photoPath, await jpegOf(8, 4, 200));
  await writeFile(photoPath2, await jpegOf(6, 6, 90));

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
    await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    expect(await readdir(photoDir)).toEqual(before);
    const out = await readdir(previewDir());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^[0-9a-f]{40}\.png$/);
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
