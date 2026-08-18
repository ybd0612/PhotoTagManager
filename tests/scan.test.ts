import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Dirent } from 'fs';

/**
 * scan.test.ts —— scanWorker 统计逻辑单测（mock fs）+ folderStore 持久化单测。
 * 仅 mock readdir/stat，其余 fs 能力透传真实实现（folderStore 使用临时目录验证）。
 */

const { readdirMock, statMock, lstatMock } = vi.hoisted(() => ({
  readdirMock: vi.fn(),
  statMock: vi.fn(),
  lstatMock: vi.fn()
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    readdir: readdirMock,
    stat: statMock,
    lstat: lstatMock
  };
});

import { walkDirectory, type ScanOptions } from '../electron/services/scanWorker';
import { FolderStore } from '../electron/services/folderStore';
import type { FolderNode, ImageFile, ScanBatch } from '../shared/types';

/** 构造 Dirent 形状的假条目 */
function dirent(name: string, isDir: boolean): Dirent {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
    parentPath: ''
  } as Dirent;
}

const STAT_RESULT = { size: 2048, mtimeMs: 1700000000000, isFile: () => true, isDirectory: () => false } as never;
const LSTAT_DIR = { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => true } as never;

beforeEach(() => {
  readdirMock.mockReset();
  statMock.mockReset();
  lstatMock.mockReset();
  statMock.mockResolvedValue(STAT_RESULT);
  lstatMock.mockResolvedValue(LSTAT_DIR);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('scanWorker walkDirectory', () => {
  it('DFS 统计 directCount/totalCount，过滤非图片与空目录', async () => {
    // 目录结构：
    // C:/photos/
    //   a.jpg（直接图片）
    //   note.txt（非图片）
    //   sub/ b.png（递归图片）
    //   empty/（无图片 → 不应下发）
    readdirMock.mockImplementation((dir: string) => {
      // Windows 下 join() 产出反斜杠路径，先归一化再匹配
      const p = dir.replace(/\\/g, '/');
      if (p === 'C:/photos') {
        return [dirent('a.jpg', false), dirent('note.txt', false), dirent('sub', true), dirent('empty', true)];
      }
      if (p === 'C:/photos/sub') return [dirent('b.png', false)];
      if (p === 'C:/photos/empty') return [];
      return [];
    });

    const batches: ScanBatch[] = [];
    const stats = await walkDirectory({
      rootPath: 'C:/photos',
      onBatch: (batch) => batches.push(batch)
    });

    expect(stats.scannedFiles).toBe(3); // a.jpg + note.txt + b.png
    expect(stats.imageCount).toBe(2);
    expect(stats.done).toBe(true);
    expect(stats.totalFiles).toBe(3);

    // 合并所有批次的 folders/images
    const folders = batches.flatMap((b) => b.folders);
    const images = batches.flatMap((b) => b.images);

    // 仅 sub 目录（totalCount>0）；empty 不下发；根目录自身不下发
    expect(folders.map((f: FolderNode) => f.relPath)).toEqual(['sub']);
    const sub = folders.find((f) => f.relPath === 'sub');
    expect(sub?.directCount).toBe(1);
    expect(sub?.totalCount).toBe(1);
    expect(sub?.name).toBe('sub');

    // 图片字段
    expect(images).toHaveLength(2);
    const a = images.find((img: ImageFile) => img.name === 'a.jpg');
    const b = images.find((img: ImageFile) => img.name === 'b.png');
    expect(a?.relPath).toBe('a.jpg');
    expect(a?.dirRelPath).toBe('');
    expect(a?.ext).toBe('.jpg');
    expect(a?.size).toBe(2048);
    expect(b?.relPath).toBe('sub/b.png');
    expect(b?.dirRelPath).toBe('sub');
    expect(b?.ext).toBe('.png');
    expect(a?.id).toHaveLength(16);
    expect(a?.id).not.toBe(b?.id);
  });

  it('批量推送：超过 batchSize 图片时产生多批', async () => {
    readdirMock.mockImplementation((dir: string) => {
      if (dir === 'C:/big') {
        return Array.from({ length: 250 }, (_, i) => dirent(`img_${i}.jpg`, false));
      }
      return [];
    });

    const batches: ScanBatch[] = [];
    await walkDirectory({
      rootPath: 'C:/big',
      batchSize: 100,
      onBatch: (batch) => batches.push(batch)
    });

    // 100 + 100 + 50（最后一批 done）
    expect(batches.length).toBe(3);
    expect(batches[0].images).toHaveLength(100);
    expect(batches[1].images).toHaveLength(100);
    expect(batches[2].images).toHaveLength(50);
    expect(batches[2].stats.done).toBe(true);
    expect(batches[0].stats.done).toBe(false);
    // batchIndex 自增
    expect(batches.map((b) => b.batchIndex)).toEqual([0, 1, 2]);
  });

  it('支持取消：shouldCancel 为 true 时停止遍历，返回 done=false', async () => {
    readdirMock.mockImplementation((dir: string) => {
      if (dir === 'C:/cancel') return [dirent('x.jpg', false), dirent('y.jpg', false)];
      return [];
    });

    const stats = await walkDirectory({
      rootPath: 'C:/cancel',
      onBatch: () => undefined,
      shouldCancel: () => true
    });

    expect(stats.done).toBe(false);
  });

  it('跳过符号链接/junction 目录，避免 Windows 系统盘循环递归', async () => {
    // 目录结构：
    // C:/root/
    //   a.jpg（直接图片）
    //   loop/  → junction，指向自身（AppData\Local\Application Data 场景）
    //   real/  → 普通目录
    readdirMock.mockImplementation((dir: string) => {
      const p = dir.replace(/\\/g, '/');
      if (p === 'C:/root') return [dirent('a.jpg', false), dirent('loop', true), dirent('real', true)];
      if (p === 'C:/root/loop') return [dirent('b.jpg', false)]; // 不应被访问
      if (p === 'C:/root/real') return [dirent('c.jpg', false)];
      return [];
    });
    // loop 为 junction（isSymbolicLink=true）；real 为普通目录
    lstatMock.mockImplementation((p: string) => ({
      isSymbolicLink: () => p.replace(/\\/g, '/').endsWith('/loop'),
      isFile: () => false,
      isDirectory: () => true
    } as never));

    const batches: ScanBatch[] = [];
    const stats = await walkDirectory({
      rootPath: 'C:/root',
      onBatch: (batch) => batches.push(batch)
    });

    expect(stats.imageCount).toBe(2); // a.jpg + real/c.jpg；loop/b.jpg 被跳过
    const images = batches.flatMap((b) => b.images);
    expect(images.map((i: ImageFile) => i.name).sort()).toEqual(['a.jpg', 'c.jpg']);
    const folders = batches.flatMap((b) => b.folders);
    expect(folders.map((f: FolderNode) => f.relPath)).toEqual(['real']);
  });

  it('盘符根（C:/）保持盘符根路径，不降级为 drive-relative "C:"', async () => {
    const readDirs: string[] = [];
    readdirMock.mockImplementation((dir: string) => {
      readDirs.push(dir);
      const p = dir.replace(/\\/g, '/');
      if (p === 'C:/') return [dirent('a.jpg', false), dirent('sub', true)];
      if (p === 'C:/sub') return [dirent('b.jpg', false)];
      return [];
    });

    const batches: ScanBatch[] = [];
    const stats = await walkDirectory({
      rootPath: 'C:/',
      onBatch: (batch) => batches.push(batch)
    });

    expect(stats.imageCount).toBe(2);
    const normalized = readDirs.map((d) => d.replace(/\\/g, '/'));
    expect(normalized).toContain('C:/'); // 第一层必须是盘符根
    expect(normalized).not.toContain('C:'); // 绝不能出现裸 "C:"
  });
});

describe('FolderStore 隐藏持久化', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ptm-folderstore-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('hide/isHidden/list/unhide 往返一致，跨实例持久化，且按根隔离（R06/R10）', async () => {
    const store = new FolderStore(tempDir);
    expect(await store.isHidden('r1', '2024')).toBe(false);

    await store.hide('r1', '2024');
    await store.hide('r1', '2024/01');
    expect(await store.isHidden('r1', '2024')).toBe(true);

    // 不同根同 relPath 互不干扰
    await store.hide('r2', '2024');
    expect(await store.isHidden('r1', '2024')).toBe(true);
    expect(await store.isHidden('r2', '2024')).toBe(true);
    const listR1 = await store.list('r1');
    expect(listR1.map((r) => r.relPath).sort()).toEqual(['2024', '2024/01']);
    expect(listR1.every((r) => r.rootId === 'r1')).toBe(true);
    expect(listR1.every((r) => typeof r.hiddenAt === 'number')).toBe(true);
    expect(await store.list('r2').then((l) => l.map((r) => r.relPath))).toEqual(['2024']);

    // 新实例（模拟重启）仍能读到
    const store2 = new FolderStore(tempDir);
    expect(await store2.isHidden('r1', '2024')).toBe(true);
    expect(await store2.isHidden('r1', '2024/01')).toBe(true);

    // 取消隐藏只清除自身
    await store2.unhide('r1', '2024');
    expect(await store2.isHidden('r1', '2024')).toBe(false);
    expect(await store2.isHidden('r1', '2024/01')).toBe(true);

    const store3 = new FolderStore(tempDir);
    const list3 = await store3.list('r1');
    expect(list3.map((r) => r.relPath)).toEqual(['2024/01']);
  });
});
