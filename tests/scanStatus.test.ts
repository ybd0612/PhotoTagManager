import { describe, expect, it } from 'vitest';
import { scanProgressPercent, scanStatusLabel } from '../src/utils/scanStatus';
import type { ScanStats } from '../shared/types';

/**
 * 批次2 G7：状态栏扫描文案去重。
 * 整改前「已扫描 N 个文件」和「扫描已完成（100%）」同义并列，这里定死一条口径：
 * 扫描中显示进度，完成后只报一次文件数，不再重复播报。
 */

function stats(scannedFiles: number, totalFiles: number, done: boolean): ScanStats {
  return { scannedFiles, imageCount: scannedFiles, totalFiles, done };
}

describe('scanStatusLabel', () => {
  it('idle 与无统计时不给文案（状态栏右侧留空）', () => {
    expect(scanStatusLabel('idle', null)).toBe('');
    expect(scanStatusLabel('done', null)).toBe('');
  });

  it('扫描中给已完成/总数与百分比', () => {
    expect(scanStatusLabel('scanning', stats(12, 40, false))).toBe('正在扫描 12 / 40 个文件 · 30%');
  });

  it('完成后只报文件数并写明含非图片，不再出现「扫描已完成」和 100%', () => {
    const label = scanStatusLabel('done', stats(40, 40, true));
    expect(label).toBe('已扫描 40 个文件（含非图片）');
    expect(label).not.toMatch(/完成|100%/);
  });

  it('失败只报失败本身，重试交给旁边的按钮（不在文字里再催一遍）', () => {
    expect(scanStatusLabel('error', stats(7, 40, false))).toBe('扫描失败');
  });
});

describe('scanProgressPercent', () => {
  it('完成即 100，未完成最多 99，总数未知按 0', () => {
    expect(scanProgressPercent(stats(40, 40, true))).toBe(100);
    expect(scanProgressPercent(stats(12, 40, false))).toBe(30);
    expect(scanProgressPercent(stats(39, 40, false))).toBe(98);
    expect(scanProgressPercent(stats(0, 0, false))).toBe(0);
    expect(scanProgressPercent(null)).toBe(0);
  });
});
