import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { RootStore } from '../electron/services/rootStore';

/**
 * rootStore.test.ts —— 多根目录持久化单测（R10）。
 * 验证 add/rename/remove/list、同路径去重、跨实例持久化。
 */

describe('RootStore 多根持久化', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ptm-rootstore-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('add：生成稳定 id，别名默认取目录名', async () => {
    const store = new RootStore(tempDir);
    const entry = await store.add('C:/Photos');
    expect(entry.id).toHaveLength(8);
    expect(entry.alias).toBe('Photos');
    expect(typeof entry.addedAt).toBe('number');
    expect((await store.list()).map((r) => r.path)).toEqual(['C:/Photos']);
  });

  it('add：同路径去重（忽略大小写与尾分隔符），返回已有条目', async () => {
    const store = new RootStore(tempDir);
    const first = await store.add('C:/Photos');
    const dup = await store.add('c:\\photos\\');
    expect(dup.id).toBe(first.id);
    expect((await store.list())).toHaveLength(1);
  });

  it('rename / remove / 跨实例持久化', async () => {
    const store = new RootStore(tempDir);
    const a = await store.add('C:/A', '照片');
    const b = await store.add('C:/B', '资料');
    expect(a.alias).toBe('照片');

    const renamed = await store.rename(a.id, '相册');
    expect(renamed?.alias).toBe('相册');

    // 新实例（模拟重启）仍能读到改名后的数据
    const store2 = new RootStore(tempDir);
    expect((await store2.list()).map((r) => r.alias).sort()).toEqual(['相册', '资料']);
    expect(await store2.get(b.id)).toMatchObject({ path: 'C:/B', alias: '资料' });

    // 删除后新实例也读不到
    await store2.remove(b.id);
    const store3 = new RootStore(tempDir);
    expect((await store3.list()).map((r) => r.id)).toEqual([a.id]);
  });

  it('reorder：按给定顺序重写序号，跨实例读回同序', async () => {
    const store = new RootStore(tempDir);
    const a = await store.add('C:/A');
    const b = await store.add('C:/B');
    const c = await store.add('C:/C');

    expect(await store.reorder([c.id, a.id, b.id])).toBe(true);
    expect((await store.list()).map((r) => r.id)).toEqual([c.id, a.id, b.id]);

    // 重启后顺序仍在（这才是拖拽排序的意义：不是一次性视觉顺序）
    const store2 = new RootStore(tempDir);
    expect((await store2.list()).map((r) => r.id)).toEqual([c.id, a.id, b.id]);
  });

  it('reorder：顺序未变返回 false（不产生一次无谓写盘）', async () => {
    const store = new RootStore(tempDir);
    const a = await store.add('C:/A');
    const b = await store.add('C:/B');
    expect(await store.reorder([a.id, b.id])).toBe(false);
    expect(await store.reorder([b.id, a.id])).toBe(true);
    expect(await store.reorder([b.id, a.id])).toBe(false);
  });

  it('reorder：未知 id 被忽略，不会顶掉已存在的根', async () => {
    const store = new RootStore(tempDir);
    const a = await store.add('C:/A');
    const b = await store.add('C:/B');
    await store.reorder([b.id, 'nope', a.id]);
    expect((await store.list()).map((r) => r.id)).toEqual([b.id, a.id]);
  });

  it('老数据没有 sortOrder：按添加时间兜底，加载后新根仍落在末尾', async () => {
    const legacy = [
      { id: 'r1', path: 'C:/A', alias: 'A', addedAt: 100 },
      { id: 'r2', path: 'C:/B', alias: 'B', addedAt: 200 }
    ];
    await writeFile(join(tempDir, 'roots.json'), JSON.stringify(legacy), 'utf-8');

    const store = new RootStore(tempDir);
    expect((await store.list()).map((r) => r.id)).toEqual(['r1', 'r2']);

    // 老条目都没序号，新根的序号要落在它们之后，否则新根会插到最前面
    const added = await store.add('C:/C');
    expect((await store.list()).map((r) => r.id)).toEqual(['r1', 'r2', added.id]);
  });
});
