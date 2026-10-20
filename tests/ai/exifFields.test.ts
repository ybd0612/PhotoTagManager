// EXIF 字段格式换算 · **主进程侧**（2026-10-20）。
//
// 与 `exifPanel.test.tsx` 分成两个文件是因为 tsconfig 的 project 划分：
// `tests/ai/**/*.test.ts` 归 node project（能 import `electron/**`），
// `*.tsx` 归 web project（import 主进程模块会报 TS6307）。
//
// 这些换算里最容易悄悄坏掉的三条在这里钉住：曝光补偿为 0 不显示、
// 等效焦距与实际相同时不重复显示、快门只在能整除时补算小数。
import { describe, it, expect } from 'vitest';
import { describeExtended } from '../../electron/services/exifFields';

describe('exifFields · 格式换算口径', () => {
  const build = (tags: Record<string, unknown>) =>
    describeExtended('C:/p/x.jpg', tags, { mtime: new Date(0) });

  it('拍摄时间按拍摄地墙上时间显示，时区偏移不混进日期', () => {
    // EXIF 原值带 +08:00（拍摄地），界面不该把它换算成本机时区
    expect(build({ DateTimeOriginal: '2023:09:23 09:50:48.488+08:00' }).dateTimeOriginalWithOffset).toBe(
      '2023/09/23 09:50:48'
    );
  });

  it('快门分数换算出小数秒，且只在该算得清时算', () => {
    expect(build({ ShutterSpeed: '1/160' }).shutterSpeed).toBe('0.006s (1/160)');
    // 0.5 秒这类本来就直观的保持原样，不硬凑成 "0.500s"
    expect(build({ ShutterSpeed: '0.5' }).shutterSpeed).toBe('0.5s');
  });

  it('光圈统一成 f/x.y，ISO 取整', () => {
    expect(build({ FNumber: 4 }).aperture).toBe('f/4.0');
    expect(build({ FNumber: 2.8 }).aperture).toBe('f/2.8');
    expect(build({ ISO: 125 }).iso).toBe('125');
    expect(build({ ISO: 199.5 }).iso).toBe('200');
  });

  it('★ 曝光补偿为 0 时不显示（有值和「补偿了 0」是两回事）', () => {
    expect(build({ ExposureCompensation: 0 }).exposureCompensation).toBeUndefined();
    expect(build({ ExposureCompensation: 0.333 }).exposureCompensation).toBe('+0.3 EV');
    expect(build({ ExposureCompensation: -0.7 }).exposureCompensation).toBe('-0.7 EV');
  });

  it('★ 等效 35mm 与实际焦距相同时不重复显示（避免误导）', () => {
    expect(build({ FocalLength: '46.0 mm', FocalLengthIn35mmFormat: '46 mm' }).focalLength).toBe('46mm');
    // 不一致时两个都给出，让人自己判断（裁机身系数差异）
    expect(build({ FocalLength: '16.0 mm', FocalLengthIn35mmFormat: '24 mm' }).focalLength).toBe(
      '16mm（等效 35mm：24mm）'
    );
  });

  it('缺字段的键根本不会出现在返回值里', () => {
    const out = build({ Make: 'SONY' });
    expect(Object.keys(out)).toEqual(['fileName']);
  });
});