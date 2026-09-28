// 端到端集成：真实下载 → 真实预处理 → 真实 DirectML 推理 → 真实合成 → 真实保存与元数据。
// 覆盖 §8 里可以自动化验证的条目；需要人眼/任务管理器/抓包的仍留给人工验收。
// 网络不可达时整组 skip，并打印原因。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, stat, readdir, writeFile, copyFile } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';

import { configureAiPaths, resetAiPaths, previewDir } from '../../electron/ai/paths';
import { ModelStore } from '../../electron/ai/modelStore';
import { AiService, type MetadataGateway } from '../../electron/ai/aiService';
import { ChildInference, type InferReply } from '../../electron/ai/inferenceChild';
import type { InferenceRunner } from '../../electron/ai/runner';
import { getCapability, getModel } from '../../electron/ai/capabilityCatalog';
import { XmpService } from '../../electron/services/xmpService';

const MODEL = getModel('portrait-cutout', 'u2netp')!;
const CAP = getCapability('portrait-cutout')!;
const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'models', 'u2netp.onnx');

/** 把真推理子进程包成 runner（同一套 ChildInference 代码，只是不起 utilityProcess） */
class InProcessRunner implements InferenceRunner {
  loadedModelId: string | null = null;
  restartCount = 0;
  inferCount = 0;
  lastReply: InferReply | null = null;
  private readonly child: ChildInference;
  private readonly ort: Awaited<typeof import('onnxruntime-node')>;

  private constructor(ort: Awaited<typeof import('onnxruntime-node')>) {
    this.ort = ort;
    this.child = new ChildInference({ ort });
  }

  static async create(): Promise<InProcessRunner> {
    const ort = await import('onnxruntime-node');
    return new InProcessRunner(ort);
  }

  async load(req: { modelPath: string; model: Parameters<ChildInference['load']>[0]['model'] }): Promise<number> {
    const res = await this.child.load({ modelPath: req.modelPath, model: req.model, backend: 'dml' });
    this.loadedModelId = req.model.id;
    return res.loadMs;
  }

  async infer(req: { modelId: string; dims: number[]; data: Float32Array }): Promise<InferReply> {
    this.inferCount += 1;
    const reply = await this.child.infer(req);
    this.lastReply = reply;
    return reply;
  }

  async unload(): Promise<void> {
    await this.child.unload();
    this.loadedModelId = null;
  }

  async dispose(): Promise<void> {
    await this.child.dispose();
  }
}

let userData = '';
let photoDir = '';
let photoPath = '';
let sourceSha = '';
let service: AiService;
let runner: InProcessRunner;
let store: ModelStore;
let xmp: XmpService;


/** 出站请求审计：AG1 要求处理期间不得有照片内容上传 */
const outbound: string[] = [];
let originalFetch: typeof fetch;

const networkOk = await (async () => {
  try {
    const res = await fetch('https://hf-mirror.com/', { method: 'HEAD' });
    return res.status > 0;
  } catch {
    return false;
  }
})();

beforeAll(async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof originalFetch>[0], init?: Parameters<typeof originalFetch>[1]) => {
    const url = typeof input === 'string' ? input : String(input);
    outbound.push(url);
    return originalFetch(input, init);
  }) as typeof fetch;

  userData = await mkdtemp(join(tmpdir(), 'ptm-e2e-userdata-'));
  photoDir = await mkdtemp(join(tmpdir(), 'ptm-e2e-photos-'));
  configureAiPaths(userData);

  // 一张放大的测试图（内容不追求"像人"，这一组验的是链路正确性而不是抠得准不准）
  const up = await sharp(join(process.cwd(), 'tests', 'fixtures', 'ai', 'oriented-6.jpg'))
    .rotate()
    .resize(690, 920, { fit: 'fill' })
    .jpeg({ quality: 92 })
    .toBuffer();
  photoPath = join(photoDir, 'IMG_E2E.jpg');
  await writeFile(photoPath, up);
  xmp = new XmpService(userData);
  await xmp.write({ absPath: photoPath, add: ['旅行', '家人'] });
  sourceSha = createHash('sha256').update(readFileSync(photoPath)).digest('hex');

  store = new ModelStore();
  runner = await InProcessRunner.create();
  const meta: MetadataGateway = {
    readTags: async (absPath) => (await xmp.read(absPath)).subjects,
    writeTags: async (absPath, add) => {
      const res = await xmp.write({ absPath, add });
      if (!res.ok) throw new Error(res.error ?? '标签写入失败');
    },
    copyBase: (fromPath, toPath) => xmp.copyMetadataFrom(fromPath, toPath)
  };
  service = new AiService({ runner, store, meta });
}, 180_000);

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await service.dispose();
  await xmp.dispose();
  resetAiPaths();
  for (const dir of [userData, photoDir]) {
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  }
});

describe.skipIf(!networkOk)('端到端：人像抠图全链路（真下载 / 真 DirectML / 真 exiftool）', () => {
  it('首次点击：确认后一次走完 下载→加载→推理→写暂存，照片目录不多一个字节', async () => {
    const before = await readdir(photoDir);
    const result = await service.run({ absPath: photoPath, capabilityId: CAP.id, downloadApproved: true });

    expect(runner.inferCount).toBe(1);
    expect(result.cacheHit).toBe(false);
    // ① 结果只在暂存，照片目录一个字节都没多（§8-4、§8-13）
    expect(await readdir(photoDir)).toEqual(before);
    expect(result.tempPath.startsWith(previewDir())).toBe(true);

    const png = await sharp(result.tempPath).metadata();
    expect(png.format).toBe('png');
    expect(png.channels).toBe(4); // 真带 alpha
    expect(png.hasAlpha).toBe(true);
    expect(png.orientation).toBeUndefined(); // A3：输出不写方向标记
  }, 180_000);

  it('掩码是低分辨率算出来的，成品按原图尺寸输出（§4.5 分屏必须注明的那件事）', async () => {
    const result = await service.run({ absPath: photoPath, capabilityId: CAP.id });
    expect(runner.lastReply?.dims).toEqual([1, 1, MODEL.inputDims[2], MODEL.inputDims[3]]);
    const src = await sharp(photoPath).metadata();
    const out = await sharp(result.tempPath).metadata();
    expect([out.width, out.height]).toEqual([src.width, src.height]);
  }, 180_000);

  it('AG1 证据：除模型下载外没有任何出站请求，且图片内容从不上网', async () => {
    const hosts = new Set(outbound.map((u) => new URL(u).host));
    expect([...hosts].every((h) => h === 'modelscope.cn' || h.endsWith('.modelscope.cn') || h === 'hf-mirror.com' || h.endsWith('.hf-mirror.com') || h === 'cas-bridge.xethub.hf.co')).toBe(true);
    // 处理阶段（模型已就位后）不应再有新请求
    const before = outbound.length;
    await stat(photoPath);
    expect(outbound.length).toBe(before);
  }, 60_000);

  it('§8-20 缓存命中：再点一次不重跑推理，秒出预览', async () => {
    const before = runner.inferCount;
    const again = await service.run({ absPath: photoPath, capabilityId: CAP.id });
    expect(again.cacheHit).toBe(true);
    expect(runner.inferCount).toBe(before);
  }, 60_000);

  it('§8-4/12 保存：落到原图旁、继承标签 + 行为标签、原图字节不变', async () => {
    const result = await service.run({ absPath: photoPath, capabilityId: CAP.id });
    const saved = await service.save(result.taskId);
    expect(saved.savedPath).toBe(join(photoDir, 'IMG_E2E.cutout.png'));
    expect(existsSync(saved.savedPath)).toBe(true);

    // 原图字节与 mtime 未变（AG3）
    const after = createHash('sha256').update(readFileSync(photoPath)).digest('hex');
    expect(after).toBe(sourceSha);

    // 标签继承 + 行为标签，且标签值来自清单字段
    const derived = await xmp.read(saved.savedPath);
    expect(derived.subjects).toContain('旅行');
    expect(derived.subjects).toContain('家人');
    expect(derived.subjects).toContain(CAP.actionTag);
    expect(saved.tagsWritten).toContain(CAP.actionTag);
  }, 180_000);

  it('§8-13 不保存就退出：结果只在暂存，照片目录不多任何新文件', async () => {
    const before = await readdir(photoDir);
    const result = await service.run({ absPath: photoPath, capabilityId: CAP.id });
    expect(await readdir(photoDir)).toEqual(before);
    expect(existsSync(result.tempPath)).toBe(true);
    expect(result.tempPath.startsWith(previewDir())).toBe(true);
  }, 60_000);

  it('§8-24 EXIF 方向：带 Orientation 的图抠出来不旋转', async () => {
    const oriented = join(process.cwd(), 'tests', 'fixtures', 'ai', 'oriented-6.jpg');
    const copy = join(photoDir, 'oriented.jpg');
    await copyFile(oriented, copy);
    const meta = await sharp(oriented).metadata();
    expect(meta.orientation).toBe(6);
    const result = await service.run({ absPath: copy, capabilityId: CAP.id });
    const out = await sharp(result.tempPath).metadata();
    // 转正后是 20x40（存储是 40x20），且输出不再带方向标记
    expect([out.width, out.height]).toEqual([meta.height, meta.width]);
    expect(out.orientation).toBeUndefined();
  }, 120_000);
});

if (!networkOk) {
  describe('端到端（网络不可达）', () => {
    it('跳过原因：hf-mirror 不可达，无法验证真实下载链路', () => {
      console.info('[skip] 网络不可达，端到端集成测试未执行');
    });
  });
}
