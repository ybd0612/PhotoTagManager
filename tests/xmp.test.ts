import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * xmp.test.ts —— xmpService 读写单测（mock exiftool-vendored）。
 * ExifTool 被 mock 为返回单例 mockExif，测试可控制 read 返回值并断言 write 参数。
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

beforeEach(() => {
  mockExif.metadata = {};
  mockExif.writeCalls = [];
  mockExif.endCalls = 0;
  mockExif.read = defaultRead;
  mockExif.write = defaultWrite;
});

describe('XmpService read', () => {
  it('读取 dc:subject（去重合并）与 xmp:Label', async () => {
    mockExif.metadata = { Subject: ['风光', '2024', '风光'], Label: '精选' };
    const svc = new XmpService();
    const info = await svc.read(ABS_PATH);

    expect(info.ok).toBe(true);
    expect(info.subjects).toEqual(['风光', '2024']);
    expect(info.label).toBe('精选');
  });

  it('无标签时返回空数组', async () => {
    mockExif.metadata = {};
    const svc = new XmpService();
    const info = await svc.read(ABS_PATH);

    expect(info.ok).toBe(true);
    expect(info.subjects).toEqual([]);
    expect(info.label).toBeUndefined();
  });

  it('读取失败返回 ok:false + 错误码', async () => {
    mockExif.read = async () => {
      throw new Error('file not found');
    };
    const svc = new XmpService();
    const info = await svc.read(ABS_PATH);

    expect(info.ok).toBe(false);
    expect(info.error).toBe('FILE_NOT_FOUND');
  });
});

describe('XmpService write', () => {
  it('差量增删标签并写回，保留其他字段（D3）', async () => {
    mockExif.metadata = { Subject: ['a', 'b'], Label: 'L' };
    const svc = new XmpService();
    const req: TagWriteRequest = { absPath: ABS_PATH, add: ['c'], remove: ['a'], setLabel: 'M' };
    const info = await svc.write(req);

    expect(info.ok).toBe(true);
    expect(info.subjects).toEqual(['b', 'c']);
    expect(info.label).toBe('M');
    expect(mockExif.writeCalls).toHaveLength(1);
    expect(mockExif.writeCalls[0].path).toBe(ABS_PATH);
    expect(mockExif.writeCalls[0].args.Subject).toEqual(['b', 'c']);
    expect(mockExif.writeCalls[0].args.Label).toBe('M');
    expect(mockExif.writeCalls[0].opts).toContain('-overwrite_original');
  });

  it('删除全部标签时写空 Subject 清空', async () => {
    mockExif.metadata = { Subject: ['a'], Label: 'L' };
    const svc = new XmpService();
    const info = await svc.write({ absPath: ABS_PATH, remove: ['a'] });

    expect(info.ok).toBe(true);
    expect(info.subjects).toEqual([]);
    expect(mockExif.writeCalls[0].args.Subject).toBe('');
  });

  it('写失败返回 ok:false，不抛出（不阻塞队列）', async () => {
    mockExif.metadata = { Subject: [] };
    mockExif.write = async () => {
      throw new Error('not writable');
    };
    const svc = new XmpService();
    const info = await svc.write({ absPath: ABS_PATH, add: ['x'] });

    expect(info.ok).toBe(false);
    expect(info.error).toBe('READONLY_FILE');
  });
});

describe('XmpService readBulk / writeBatch / renameTag', () => {
  it('readBulk 逐张排队返回', async () => {
    mockExif.metadata = { Subject: ['t1'] };
    const svc = new XmpService();
    const results = await svc.readBulk([ABS_PATH, 'C:/Photos/b.jpg']);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok && r.subjects.includes('t1'))).toBe(true);
  });

  it('writeBatch 逐个处理并回调进度', async () => {
    mockExif.metadata = { Subject: [] };
    const svc = new XmpService();
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
      path === ABS_PATH ? { Subject: ['a', 'b'] } : { Subject: [] };
    const svc = new XmpService();
    const renamed = await svc.renameTag('a', 'b', [ABS_PATH, 'C:/Photos/no-tag.jpg']);
    expect(renamed).toBe(1);
    // 仅含 a 的第一张被 write；a→b 后去重得到 ['b']
    const subjectWrites = mockExif.writeCalls.map((c) => c.args.Subject);
    expect(subjectWrites).toEqual([['b']]);
  });
});
