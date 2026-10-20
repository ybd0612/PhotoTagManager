import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, copyFile, stat, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * 打标签后**文件修改时间必须保持原样**（2026-10-20 用户要求）。
 *
 * 为什么重要：备份/同步工具（OneDrive、坚果云、Time Machine）靠 mtime 判断
 * 「这个文件被改过吗」。打标签是「整理」不是「改内容」，
 * mtime 变了就会让用户的同步盘以为文件动了，产生一堆无意义的增量同步。
 *
 * ⚠️ **这个文件用真 exiftool，不 mock** —— mock 只能证明「`-P` 参数传了」，
 * 证明不了「mtime 真的没变」。2026-10-16 那次 SigLIP 的教训就是：
 * 参数传对了不等于行为对（`Metaspace` 空格规则那次）。
 */

const SRC_IMAGE = 'C:/Users/ybd06/Pictures/test/b1fb1fd99a312cc4faafcac2a6349860.jpg';

describe('XmpService 真实写入 · 修改时间保持', () => {
  let tempDir: string;
  let svc: import('../electron/services/xmpService').XmpService;
  let file: string;
  let fixed: Date;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ptm-mtime-'));
    svc = new (await import('../electron/services/xmpService')).XmpService(tempDir);
    file = join(tempDir, 'photo.jpg');
    await copyFile(SRC_IMAGE, file);
    // 设一个可辨识的过去时刻，这样「mtime 变成了现在」一眼能看出来
    fixed = new Date('2021-05-06T07:08:09Z');
    await utimes(file, fixed, fixed);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('★ 加标签后 mtime 保持原样', async () => {
    const before = await stat(file);
    const result = await svc.write({ absPath: file, add: ['真实标签'] });
    expect(result.ok).toBe(true);

    const after = await stat(file);
    // 容忍 1 秒误差：有些文件系统的时间戳精度只到秒
    expect(Math.abs(after.mtimeMs - before.mtimeMs)).toBeLessThan(2000);
  });

  it('★ 标签确实写进去了（不是「为了保 mtime 而没写」）', async () => {
    await svc.write({ absPath: file, add: ['真实标签'] });
    const readBack = await svc.read(file);
    expect(readBack.subjects).toContain('真实标签');
  });

  it('★ 连续多次写，mtime 依然稳定', async () => {
    const before = await stat(file);
    await svc.write({ absPath: file, add: ['第一个'] });
    await svc.write({ absPath: file, add: ['第二个'] });
    await svc.write({ absPath: file, remove: ['第一个'] });
    const after = await stat(file);
    expect(Math.abs(after.mtimeMs - before.mtimeMs)).toBeLessThan(2000);
  });

  it('★ 改标签（Label）也不动 mtime', async () => {
    const before = await stat(file);
    await svc.write({ absPath: file, setLabel: '精选' });
    const after = await stat(file);
    expect(Math.abs(after.mtimeMs - before.mtimeMs)).toBeLessThan(2000);
  });

  /**
   * 一条**做不到**的事，必须写下来免得下一个人去找办法：
   * `ctime`（inode 变更时间）**一定会变**，而且**操作系统层面无法伪造**。
   * 文件被写入这件事本身被记在 ctime 里，任何用户态工具都改不回去。
   * Windows 上 ctime 的语义还与 POSIX 不同（它是「创建时间」），
   * 但 NTFS 的 MFT ChangeTime 同样不可伪造。
   */
  it('ctime 会变 —— 这是操作系统层面的，改不回去（记录事实，不是缺陷）', async () => {
    const before = await stat(file);
    await svc.write({ absPath: file, add: ['x'] });
    const after = await stat(file);
    // ctime 确实会更新：文件被写入了
    expect(after.ctimeMs).not.toBe(before.ctimeMs);
  });
});
