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
  /** 每次 load 请求实际带来的后端：backend 切换必须体现在这里（§8-16） */
  loadBackends: Array<string | undefined> = [];
  inferCalls = 0;
  liveInfer = 0;
  maxLiveInfer = 0;
  inferError: Error | null = null;
  inferDelayMs = 0;
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
      return { data: new Float32Array(w * h).fill(1), dims: [1, 1, h, w], outputName: 'fake-out', inferMs: 1 };
    } finally {
      this.liveInfer -= 1;
    }
  }

  async unload(): Promise<void> {
    this.unloadCalls += 1;
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
    await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    expect(await readdir(photoDir)).toEqual(before);
    const pngs = (await readdir(previewDir())).filter((f) => f.endsWith('.png'));
    expect(pngs).toHaveLength(1);
    expect(pngs[0]).toMatch(/^[0-9a-f]{40}\.png$/);
    expect(before.some((f) => f.endsWith('.png'))).toBe(false);
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
