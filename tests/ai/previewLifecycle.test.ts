// T9 · 保存与暂存清理。
// save：移入原图旁 + 命名递增 + 元数据继承 + 原图字节不变 + 失败可重试；
// cleanup：保留期与容量双条件 LRU，且删除前必须校验路径在 ai-preview 内。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir, utimes, stat, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';

import { configureAiPaths, resetAiPaths, previewDir, previewFile, modelDir } from '../../electron/ai/paths';
import { AiService, type InferenceRunner, type ModelGateway, type MetadataGateway, type RunResult } from '../../electron/ai/aiService';
import { getCapability } from '../../electron/ai/capabilityCatalog';

class FakeRunner implements InferenceRunner {
  loadedModelId: string | null = null;
  restartCount = 0;
  async load(): Promise<number> {
    this.loadedModelId = 'u2netp';
    return 1;
  }
  async infer(req: { dims: number[] }): Promise<{ data: Float32Array; dims: number[]; outputName: string; inferMs: number }> {
    const [, , h, w] = req.dims;
    return { data: new Float32Array(w * h).fill(1), dims: [1, 1, h, w], outputName: 'o', inferMs: 1 };
  }
  async unload(): Promise<void> {
    this.loadedModelId = null;
  }
  async dispose(): Promise<void> {}
}

class FakeStore implements ModelGateway {
  /** 与真实 ModelStore 同语义：目录里有非 .part 文件才算 present，假件不许凭空说"已就位" */
  async status(modelId: string): Promise<'absent' | 'downloading' | 'present'> {
    try {
      const files = await readdir(modelDir(modelId));
      return files.some((f) => !f.endsWith('.part')) ? ('present' as const) : ('absent' as const);
    } catch {
      return 'absent' as const;
    }
  }
  async download(spec: { id: string; fileName: string }): Promise<{ path: string }> {
    await mkdir(modelDir(spec.id), { recursive: true });
    const p = join(modelDir(spec.id), spec.fileName);
    await writeFile(p, 'weights');
    return { path: p };
  }
  async remove(): Promise<void> {}
}

/** 记录调用的假元数据通道（与 tests/xmp.test.ts 一样不真起 exiftool） */
class FakeMeta implements MetadataGateway {
  calls: { op: string; absPath: string; add?: string[]; from?: string }[] = [];
  sourceTags = ['旅行', '2024'];
  failWrite = false;

  async readTags(absPath: string): Promise<string[]> {
    this.calls.push({ op: 'read', absPath });
    return [...this.sourceTags];
  }
  async writeTags(absPath: string, add: string[]): Promise<void> {
    this.calls.push({ op: 'write', absPath, add });
    if (this.failWrite) throw new Error('XMP 写入失败：只读');
  }
  async copyBase(fromPath: string, toPath: string): Promise<void> {
    this.calls.push({ op: 'copy', absPath: toPath, from: fromPath });
  }
}

let userData = '';
let photoDir = '';
let photoPath = '';
let service: AiService;
let store: FakeStore;
let meta: FakeMeta;
const actionTag = getCapability('portrait-cutout')!.actionTag;

async function sha256Of(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function makeService(
  opts: { retentionDays?: number; maxBytes?: number; moveFile?: (from: string, to: string) => Promise<void> } = {}
): Promise<void> {
  meta = new FakeMeta();
  store = new FakeStore();
  service = new AiService({
    runner: new FakeRunner(),
    store,
    meta,
    moveFile: opts.moveFile,
    previewRetention: { now: () => Date.now(), retentionDays: opts.retentionDays, maxBytes: opts.maxBytes }
  });
}

async function newPreview(): Promise<RunResult> {
  return service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
}

beforeEach(async () => {
  resetAiPaths();
  userData = await mkdtemp(join(tmpdir(), 'ptm-preview-'));
  configureAiPaths(userData);
  photoDir = await mkdtemp(join(tmpdir(), 'ptm-photos-t9-'));
  photoPath = join(photoDir, 'IMG_0001.jpg');
  const px = Buffer.alloc(8 * 4 * 3, 180);
  await writeFile(photoPath, await sharp(px, { raw: { width: 8, height: 4, channels: 3 } }).jpeg().toBuffer());
  await makeService();
  await store.download({ id: 'u2netp', fileName: 'u2netp.onnx' }); // 权重落盘，"已就位"必须是真的
});

afterEach(async () => {
  resetAiPaths();
  await rm(userData, { recursive: true, force: true, maxRetries: 5 });
  await rm(photoDir, { recursive: true, force: true, maxRetries: 5 });
});

describe('ai/aiService.save —— 移入原图旁', () => {
  it('① 命名 原名.cutout.png（后缀与扩展名都取自清单）', async () => {
    const result = await newPreview();
    const saved = await service.save(result.taskId);
    expect(saved.savedPath).toBe(join(photoDir, 'IMG_0001.cutout.png'));
    expect(existsSync(saved.savedPath)).toBe(true);
    expect(saved.targetName).toBe('IMG_0001.cutout.png');
  });

  it('① 冲突不覆盖，递增 .cutout.2.png / .cutout.3.png，并告知用的哪个', async () => {
    const cap = getCapability('portrait-cutout')!;
    await writeFile(join(photoDir, `IMG_0001.${cap.outputSuffix}${cap.outputExt}`), 'existing');
    const first = await service.save((await newPreview()).taskId);
    expect(first.savedPath).toBe(join(photoDir, 'IMG_0001.cutout.2.png'));
    expect(first.renamed).toBe(true);

    // 第二个也冲突 → .3
    const second = await service.save((await newPreview()).taskId);
    expect(second.savedPath).toBe(join(photoDir, 'IMG_0001.cutout.3.png'));
    // 已存在的那个文件没被动过
    expect((await readFile(join(photoDir, 'IMG_0001.cutout.png'), 'utf8')).trim()).toBe('existing');
  });

  it('② 元数据：先读原图标签，再往派生文件写「继承的标签 + 清单里的行为标签」', async () => {
    const saved = await service.save((await newPreview()).taskId);
    const write = meta.calls.find((c) => c.op === 'write');
    expect(meta.calls.some((c) => c.op === 'read')).toBe(true);
    expect(write?.absPath).toBe(saved.savedPath);
    expect(write?.add).toEqual(['旅行', '2024', actionTag]);
    // 行为标签必须来自清单字段，而不是测试或实现里的字面量
    expect(actionTag).toBe('AI人像抠图');
    // 顺序钉死：copyBase 会把 XMP-ptm:Tags 从源图刷回去，必须早于写标签，
    // 否则刚追加的行为标签被覆盖（端到端实测到过这个 bug）
    const copyIdx = meta.calls.findIndex((c) => c.op === 'copy');
    const writeIdx = meta.calls.findIndex((c) => c.op === 'write');
    expect(copyIdx).toBeGreaterThanOrEqual(0);
    expect(copyIdx).toBeLessThan(writeIdx);
  });

  it('② 保留 EXIF/ICC：把原图元数据复制进派生文件', async () => {
    const saved = await service.save((await newPreview()).taskId);
    expect(meta.calls.some((c) => c.op === 'copy' && c.absPath === saved.savedPath && c.from === photoPath)).toBe(true);
  });

  it('③ 原图字节与 mtime 都不能变（AG3：不做任何不可逆操作）', async () => {
    const before = { sha: await sha256Of(photoPath), mtime: (await stat(photoPath)).mtimeMs };
    const touch = new Date(before.mtime - 60000);
    await utimes(photoPath, touch, touch);
    const beforeMtime = (await stat(photoPath)).mtimeMs;

    await service.save((await newPreview()).taskId);

    expect(await sha256Of(photoPath)).toBe(before.sha);
    expect((await stat(photoPath)).mtimeMs).toBe(beforeMtime);
  });

  it('④ 保存失败（目标被占用）→ 报可读原因，且暂存结果保留可直接重试', async () => {
    let occupied = true;
    await makeService({
      moveFile: async (from, to) => {
        if (occupied) {
          occupied = false;
          throw new Error('EPERM: operation not permitted, rename（文件正被其他程序使用）');
        }
        await rename(from, to);
      }
    });
    const result = await newPreview();

    await expect(service.save(result.taskId)).rejects.toMatchObject({
      code: 'SAVE_FAILED',
      message: expect.stringMatching(/可直接重试/)
    });
    expect(existsSync(result.tempPath)).toBe(true);
    expect(existsSync(join(photoDir, 'IMG_0001.cutout.png'))).toBe(false);

    const retried = await service.save(result.taskId);
    expect(existsSync(retried.savedPath)).toBe(true);
    expect(existsSync(result.tempPath)).toBe(false);
  });

  it('④ 元数据写入失败：文件已在目录里，报错但不谎称保存成功', async () => {
    meta.failWrite = true;
    const result = await newPreview();
    await expect(service.save(result.taskId)).rejects.toMatchObject({ code: 'METADATA_WRITE_FAILED' });
  });

  it('① 保存成功后同一任务不能重复保存（避免把已移走的暂存再报错）', async () => {
    const result = await newPreview();
    await service.save(result.taskId);
    await expect(service.save(result.taskId)).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
  });

  it('⑤ 保存后成品从暂存与索引里消失——清理逻辑碰不到已保存成果', async () => {
    const result = await newPreview();
    await service.save(result.taskId);
    const files = (await readdir(previewDir())).filter((f) => f.endsWith('.png'));
    expect(files).toEqual([]);
    // 掩码级缓存与成品共用同一份索引：保存只移走成品，掩码必须留着给下次换底色复用
    // （方案 §6 裁定 3）。所以这里断言的是"没有成品条目"，不是"索引空了"。
    const index = JSON.parse(await readFile(previewFile('index.json'), 'utf8')) as {
      entries: Record<string, { fileName: string; kind?: string }>;
    };
    const remaining = Object.values(index.entries);
    expect(remaining.filter((e) => e.fileName.endsWith('.png'))).toEqual([]);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.kind).toBe('mask');
    expect(await service.previewStats()).toMatchObject({ entries: 1 });
  });
});

describe('ai/aiService.cleanup —— 双条件 LRU 与安全边界（§5.0 红线 3）', () => {
  async function readIndex(): Promise<{
    entries: Record<string, { fileName: string; sizeBytes: number; lastAccessedAt: number; kind?: string }>;
  }> {
    return JSON.parse(await readFile(previewFile('index.json'), 'utf8'));
  }

  async function keyOf(tempPath: string): Promise<string> {
    return tempPath.split(/[\\/]/).pop()!.replace(/\.png$/, '');
  }

  async function setAged(tempPath: string, minutesAgo: number): Promise<void> {
    const index = await readIndex();
    const key = await keyOf(tempPath);
    index.entries[key].lastAccessedAt = Date.now() - minutesAgo * 60_000;
    await writeFile(previewFile('index.json'), JSON.stringify(index));
  }

  async function extraPhoto(name: string, size: number, value: number): Promise<string> {
    const p = join(photoDir, name);
    await writeFile(
      p,
      await sharp(Buffer.alloc(size * size * 3, value), { raw: { width: size, height: size, channels: 3 } })
        .jpeg()
        .toBuffer()
    );
    return p;
  }

  it('空暂存不崩', async () => {
    expect(await service.cleanup()).toMatchObject({ deleted: 0, refused: 0 });
  });

  it('未超保留期与容量上限时一个都不删', async () => {
    await newPreview();
    expect(await service.cleanup()).toMatchObject({ deleted: 0 });
    expect((await readdir(previewDir())).filter((f) => f.endsWith('.png'))).toHaveLength(1);
  });

  it('超过保留期 → 删除过期条目，未过期留下', async () => {
    await makeService({ retentionDays: 1 });
    const result = await newPreview();
    const index = await readIndex();
    const key = await keyOf(result.tempPath);
    index.entries[key].lastAccessedAt = Date.now() - 5 * 86_400_000;
    await writeFile(previewFile('index.json'), JSON.stringify(index));

    expect(await service.cleanup()).toMatchObject({ deleted: 1 });
    expect(existsSync(result.tempPath)).toBe(false);
  });

  it('容量超上限 → 淘汰的是最久未访问那条，不是按时间也不是随机', async () => {
    await makeService({ retentionDays: 3650 });
    const r1 = await service.run({ absPath: photoPath, capabilityId: 'portrait-cutout' });
    const p2 = await extraPhoto('IMG_0002.jpg', 6, 30);
    const r2 = await service.run({ absPath: p2, capabilityId: 'portrait-cutout' });
    const p3 = await extraPhoto('IMG_0003.jpg', 10, 220);
    const r3 = await service.run({ absPath: p3, capabilityId: 'portrait-cutout' });

    const size = async (p: string): Promise<number> => (await stat(p)).size;
    const [s1, s2, s3] = [await size(r1.tempPath), await size(r2.tempPath), await size(r3.tempPath)];
    // 上限给到"必须淘汰最旧一条才装得下"：索引里除三条成品还有三条掩码（同一套 LRU），
    // 所以阈值按**全部条目总字节**算，只减掉最旧那条成品的大小
    await setAged(r1.tempPath, 30); // r1 最久未访问
    await setAged(r2.tempPath, 20);
    await setAged(r3.tempPath, 10);
    const total = (await service.previewStats()).totalBytes;
    await makeService({ retentionDays: 3650, maxBytes: total - s1 });

    const report = await service.cleanup();
    expect(report.deleted).toBe(1);
    expect(existsSync(r1.tempPath)).toBe(false);
    expect(existsSync(r2.tempPath)).toBe(true);
    expect(existsSync(r3.tempPath)).toBe(true);
    expect(s1 + s2 + s3).toBeGreaterThan(s2 + s3);
    // 淘汰的是最旧的**成品**，不是刚写的掩码：掩码条目仍完好在索引里
    const afterIndex = await readIndex();
    expect(Object.values(afterIndex.entries).filter((e) => e.kind === 'mask')).toHaveLength(3);
  });

  it('安全边界：索引被篡改成指向暂存外的绝对路径 → 拒绝删除，外部文件必须还在', async () => {
    const victimDir = await mkdtemp(join(tmpdir(), 'ptm-victim-'));
    try {
      const victim = join(victimDir, 'precious.png');
      await writeFile(victim, 'do not delete me');
      const result = await newPreview();

      const index = await readIndex();
      index.entries[await keyOf(result.tempPath)].fileName = victim;
      await writeFile(previewFile('index.json'), JSON.stringify(index));

      const report = await service.cleanup({ maxBytes: 0 });
      // 被篡改那条**只清索引不删文件**：refused 1；deleted 1 是掩码条目——
      // maxBytes:0 的语义就是"把所有缓存清空"，这一条顺带证明掩码也在同一套 LRU 里管着
      expect(report).toMatchObject({ deleted: 1, refused: 1 });
      expect(existsSync(victim)).toBe(true);
      expect(existsSync(result.tempPath)).toBe(true);
    } finally {
      await rm(victimDir, { recursive: true, force: true });
    }
  });

  it('安全边界：索引里写 ../.. 逃出暂存目录的相对路径同样拒绝', async () => {
    const result = await newPreview();
    const index = await readIndex();
    index.entries[await keyOf(result.tempPath)].fileName = `../../../Windows/win.ini`;
    await writeFile(previewFile('index.json'), JSON.stringify(index));

    const report = await service.cleanup({ maxBytes: 0 });
    // 越界条目只清索引不删文件（refused 1）；deleted 1 是与它同索引的掩码条目
    expect(report).toMatchObject({ deleted: 1, refused: 1 });
    expect(existsSync(result.tempPath)).toBe(true);
  });

  it('清理只按索引走：暂存目录里没被索引的孤儿文件不动它（不误删未知用途的产物）', async () => {
    await writeFile(previewFile('stray.png'), 'stray');
    const report = await service.cleanup({ maxBytes: 0 });
    expect(report.deleted).toBe(0);
    expect(existsSync(previewFile('stray.png'))).toBe(true);
  });

  it('previewStats 报条目数与总字节，供设置页只读统计', async () => {
    await newPreview();
    const stats = await service.previewStats();
    // 一次处理留两条条目：成品 PNG + 掩码级缓存（掩码真占着磁盘，统计不许漏它）
    expect(stats.entries).toBe(2);
    expect(stats.totalBytes).toBeGreaterThan(0);
  });
});
