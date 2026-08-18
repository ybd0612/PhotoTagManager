import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
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
});
