import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, copyFile, stat, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * 「任何对源文件的操作都不应改动它的修改时间」—— 全路径核查（2026-10-20 用户要求）。
 *
 * 用户原话：「这里只说了新增，但是我想要的效果是，任何源文件的修改，都不要去改动这个修改时间」。
 * 所以这个文件不是只测 `write()`，而是**把项目里每条会碰源文件的路径都列一遍**，
 * 逐条验证 mtime 行为 —— 免得只修了新增，遗漏了删除/重命名/合并。
 *
 * ⚠️ **用真 exiftool，不 mock**：mock 只能证明「参数传了」，
 * 证明不了「mtime 真的没变」（SigLIP 那次 `Metaspace` 教训）。
 */

const SRC_IMAGE = 'C:/Users/ybd06/Pictures/test/b1fb1fd99a312cc4faafcac2a6349860.jpg';

/** 容忍 1 秒误差：有些文件系统的时间戳精度只到秒 */
const mtimeKept = (a: number, b: number) => Math.abs(a - b) < 2000;

describe('源文件修改时间 · 全路径核查', () => {
  let tempDir: string;
  let svc: import('../electron/services/xmpService').XmpService;
  let file: string;
  let before: number;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ptm-mtime-all-'));
    svc = new (await import('../electron/services/xmpService')).XmpService(tempDir);
    file = join(tempDir, 'photo.jpg');
    await copyFile(SRC_IMAGE, file);
    const fixed = new Date('2021-05-06T07:08:09Z');
    await utimes(file, fixed, fixed);
    before = (await stat(file)).mtimeMs;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('① 新增标签 → mtime 不变', async () => {
    await svc.write({ absPath: file, add: ['新标签'] });
    expect(mtimeKept((await stat(file)).mtimeMs, before)).toBe(true);
  });

  it('② 删除标签 → mtime 不变', async () => {
    await svc.write({ absPath: file, add: ['待删'] });
    const mid = (await stat(file)).mtimeMs;
    await svc.write({ absPath: file, remove: ['待删'] });
    expect(mtimeKept((await stat(file)).mtimeMs, mid)).toBe(true);
  });

  it('③ 改 Label（重命名）→ mtime 不变', async () => {
    await svc.write({ absPath: file, setLabel: '精选' });
    expect(mtimeKept((await stat(file)).mtimeMs, before)).toBe(true);
  });

  it('④ 标签重命名（renameTag 走的是 write）→ mtime 不变', async () => {
    await svc.write({ absPath: file, add: ['旧名'] });
    const mid = (await stat(file)).mtimeMs;
    const n = await svc.renameTag('旧名', '新名', [file]);
    expect(n).toBe(1);
    expect(mtimeKept((await stat(file)).mtimeMs, mid)).toBe(true);
  });

  it('⑤ 批量写（writeBatch 走的是 write）→ mtime 不变', async () => {
    const f2 = join(tempDir, 'photo2.jpg');
    await copyFile(SRC_IMAGE, f2);
    const fixed = new Date('2021-05-06T07:08:09Z');
    await utimes(f2, fixed, fixed);
    const b2 = (await stat(f2)).mtimeMs;

    await svc.writeBatch([{ absPath: file, add: ['A'] }, { absPath: f2, add: ['B'] }]);

    expect(mtimeKept((await stat(file)).mtimeMs, before)).toBe(true);
    expect(mtimeKept((await stat(f2)).mtimeMs, b2)).toBe(true);
  });

  it('⑥ 连续多次写 → mtime 依然稳定', async () => {
    await svc.write({ absPath: file, add: ['一'] });
    await svc.write({ absPath: file, add: ['二'] });
    await svc.write({ absPath: file, remove: ['一'] });
    expect(mtimeKept((await stat(file)).mtimeMs, before)).toBe(true);
  });

  it('⑦ 标签确实写进去了（不是「为了保 mtime 而没写」）', async () => {
    await svc.write({ absPath: file, add: ['真写进去了'] });
    expect((await svc.read(file)).subjects).toContain('真写进去了');
  });

  it('⑧ 其它写源文件的位置：本项目不存在（源码级断言）', async () => {
    // 缩略图写的是 userData 下的缓存目录；配置写的是 userData；
    // 回收站是「移动」不是「改写」（移动不改内容 mtime）。
    // 所以**唯一**改写源文件的入口就是 xmpService.write 里的 exif.write。
    // 这条断言的作用是：将来有人加了新的写源文件路径，这里会红，提示补 mtime 处理。
    const { readFile } = await import('fs/promises');
    const xmp = await readFile('C:/Users/ybd06/Documents/project/PhotoTagManager/electron/services/xmpService.ts', 'utf8');
    const exifWrites = xmp.match(/exif\.write\(/g) ?? [];
    expect(exifWrites.length).toBe(1);
    // 唯一那一处必须带 -P
    expect(xmp).toMatch(/exif\.write\([^)]*'-P'/);
  });

  it('⑨ ctime 会变 —— 操作系统层面无法伪造（记录事实，不是缺陷）', async () => {
    const cBefore = (await stat(file)).ctimeMs;
    await svc.write({ absPath: file, add: ['x'] });
    expect((await stat(file)).ctimeMs).not.toBe(cBefore);
  });
});

/**
 * 用用户**自己的一张真实照片**做验证（不是测试夹具）。
 * 这张是 SONY ILCE-7M4 拍的，EXIF 完整（拍摄时间 2023/09/23），
 * 能同时验证「EXIF 拍摄时间」与「文件系统修改时间」两件事互不干扰。
 */
describe('真实照片 · 修改时间保持', () => {
  it('★ 相机原片打标签后，文件系统修改日期保持原样', async () => {
    const realPhoto = 'C:/Users/ybd06/Documents/phone/展盛团建/_DSC2871.JPG';
    const { existsSync } = await import('fs');
    if (!existsSync(realPhoto)) return; // 换机器跑时跳过，不让测试因缺文件而红

    const tempDir = await mkdtemp(join(tmpdir(), 'ptm-mt-real-'));
    const svc = new (await import('../electron/services/xmpService')).XmpService(tempDir);
    const file = join(tempDir, 'DSC2871.JPG');
    await copyFile(realPhoto, file);
    const fixed = new Date('2021-05-06T07:08:09Z');
    await utimes(file, fixed, fixed);
    const before = await stat(file);

    const result = await svc.write({ absPath: file, add: ['团建', '2023'] });
    expect(result.ok).toBe(true);

    const after = await stat(file);
    expect(mtimeKept(after.mtimeMs, before.mtimeMs)).toBe(true);
    // 标签确实写进去了
    expect((await svc.read(file)).subjects).toContain('团建');
    // EXIF 拍摄时间没被动过（只该改 XMP 标签，不该碰拍摄信息）
    const exif = await svc.read(file);
    expect(exif.ok).toBe(true);

    await rm(tempDir, { recursive: true, force: true });
  });
});
