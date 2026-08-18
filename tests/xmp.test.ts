import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * xmp.test.ts —— xmpService 读写单测（mock exiftool-vendored）。
 * ExifTool 被 mock 为返回单例 mockExif，测试可控制 read 返回值并断言 write 参数。
 * 标签存储：XMP-ptm:Tags（JSON 数组）+ 清空 dc:subject；读取兼容旧 dc:subject。
 */

const { mockExif } = vi.hoisted(() => {
  const mockExif = {
    metadata: {} as Record<string, unknown>,
    writeCalls: [] as Array<{ args: Record<string, unknown>; path: string; opts: string[] }>,
    endCalls: 0,
    async read(_path: string): Promise<Record<string, unknown>> {
      return mockExif.metadata;
    },
    async write(path: string, args: Record<string, unknown>, opts: string[]): Promise<void> {
      mockExif.writeCalls.push({ args, path, opts });
    },
    async end(): Promise<void> {
      mockExif.endCalls += 1;
    }
  };
  return { mockExif };
});

vi.mock('exiftool-vendored', () => {
  return {
    ExifTool: class {
      constructor() {
        return mockExif;
      }
    }
  };
});

import { XmpService } from '../electron/services/xmpService';
import type { TagWriteRequest } from '../shared/types';

const ABS_PATH = 'C:/Photos/a.jpg';

const defaultRead = mockExif.read;
const defaultWrite = mockExif.write;

/** 构造 ptm:Tags 的 JSON 存储值 */
const tagsJson = (tags: string[]): string => JSON.stringify(tags);

describe('XmpService read', () => {
  let tempDir: string;
  let svc: XmpService;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ptm-xmp-'));
    svc = new XmpService(tempDir);
    mockExif.metadata = {};
    mockExif.writeCalls = [];
    mockExif.endCalls = 0;
    mockExif.read = defaultRead;
    mockExif.write = defaultWrite;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('读取 XMP-ptm:Tags（JSON 数组，去重合并）与 xmp:Label', async () => {
    mockExif.metadata = { Tags: tagsJson(['风光', '2024', '风光']), Label: '精选' };
    const info = await svc.read(ABS_PATH);

    expect(info.ok).toBe(true);
    expect(info.subjects).toEqual(['风光', '2024']);
    expect(info.label).toBe('精选');
  });

  it('兼容读取旧 dc:subject 数据（迁移前打的标签仍可见）', async () => {
    mockExif.metadata = { Subject: ['旧标签', '旧标签'] };
    const info = await svc.read(ABS_PATH);

    expect(info.ok).toBe(true);
    expect(info.subjects).toEqual(['旧标签']);
  });

  it('无标签时返回空数组', async () => {
    mockExif.metadata = {};
    const info = await svc.read(ABS_PATH);

    expect(info.ok).toBe(true);
    expect(info.subjects).toEqual([]);
    expect(info.label).toBeUndefined();
  });

  it('读取失败返回 ok:false + 错误码', async () => {
    mockExif.read = async () => {
      throw new Error('file not found');
    };
    const info = await svc.read(ABS_PATH);

    expect(info.ok).toBe(false);
    expect(info.error).toBe('FILE_NOT_FOUND');
  });
});

describe('XmpService write', () => {
  let tempDir: string;
  let svc: XmpService;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ptm-xmp-'));
    svc = new XmpService(tempDir);
    mockExif.metadata = {};
    mockExif.writeCalls = [];
    mockExif.endCalls = 0;
    mockExif.read = defaultRead;
    mockExif.write = defaultWrite;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('差量增删标签：写 XMP-ptm:Tags（JSON）并清空 dc:subject（Windows 标记），保留 Label', async () => {
    mockExif.metadata = { Tags: tagsJson(['a', 'b']), Label: 'L' };
    const req: TagWriteRequest = { absPath: ABS_PATH, add: ['c'], remove: ['a'], setLabel: 'M' };
    const info = await svc.write(req);

    expect(info.ok).toBe(true);
    expect(info.subjects).toEqual(['b', 'c']);
    expect(info.label).toBe('M');
    expect(mockExif.writeCalls).toHaveLength(1);
    expect(mockExif.writeCalls[0].path).toBe(ABS_PATH);
    expect(mockExif.writeCalls[0].args.Tags).toBe(tagsJson(['b', 'c']));
    expect(mockExif.writeCalls[0].args.Subject).toBe(''); // 清空标准字段
    expect(mockExif.writeCalls[0].args.Label).toBe('M');
    expect(mockExif.writeCalls[0].opts).toContain('-overwrite_original');
  });

  it('删除全部标签时写空 JSON 清空 Tags', async () => {
    mockExif.metadata = { Tags: tagsJson(['a']), Label: 'L' };
    const info = await svc.write({ absPath: ABS_PATH, remove: ['a'] });

    expect(info.ok).toBe(true);
    expect(info.subjects).toEqual([]);
    expect(mockExif.writeCalls[0].args.Tags).toBe(tagsJson([]));
    expect(mockExif.writeCalls[0].args.Subject).toBe('');
  });

  it('写失败返回 ok:false，不抛出（不阻塞队列）', async () => {
    mockExif.metadata = { Tags: tagsJson([]) };
    mockExif.write = async () => {
      throw new Error('not writable');
    };
    const info = await svc.write({ absPath: ABS_PATH, add: ['x'] });

    expect(info.ok).toBe(false);
    expect(info.error).toBe('READONLY_FILE');
  });
});

describe('XmpService readBulk / writeBatch / renameTag', () => {
  let tempDir: string;
  let svc: XmpService;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ptm-xmp-'));
    svc = new XmpService(tempDir);
    mockExif.metadata = {};
    mockExif.writeCalls = [];
    mockExif.endCalls = 0;
    mockExif.read = defaultRead;
    mockExif.write = defaultWrite;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('readBulk 逐张排队返回', async () => {
    mockExif.metadata = { Tags: tagsJson(['t1']) };
    const results = await svc.readBulk([ABS_PATH, 'C:/Photos/b.jpg']);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok && r.subjects.includes('t1'))).toBe(true);
  });

  it('writeBatch 逐个处理并回调进度', async () => {
    mockExif.metadata = { Tags: tagsJson([]) };
    const progress: Array<{ done: number; total: number }> = [];
    const result = await svc.writeBatch(
      [{ absPath: ABS_PATH, add: ['a'] }, { absPath: 'C:/Photos/b.jpg', add: ['b'] }],
      (p) => progress.push(p)
    );

    expect(result).toEqual({ okCount: 2, failCount: 0 });
    expect(progress).toEqual([
      { done: 1, total: 2 },
      { done: 2, total: 2 }
    ]);
  });

  it('renameTag 全量替换 from→to 并合并去重（P1）', async () => {
    mockExif.read = async (path: string) =>
      path === ABS_PATH ? { Tags: tagsJson(['a', 'b']) } : { Tags: tagsJson([]) };
    const renamed = await svc.renameTag('a', 'b', [ABS_PATH, 'C:/Photos/no-tag.jpg']);
    expect(renamed).toBe(1);
    // 仅含 a 的第一张被 write；a→b 后去重得到 ['b']
    const tagsWrites = mockExif.writeCalls.map((c) => c.args.Tags);
    expect(tagsWrites).toEqual([tagsJson(['b'])]);
  });
});
