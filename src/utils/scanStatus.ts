import type { ScanStats } from '../../shared/types';
import type { ScanState } from '../store/useAppStore';

/**
 * 批次2 G7：状态栏扫描文案的唯一口径。
 * 整改前「已扫描 N 个文件」与「扫描已完成（100%）」同义并列，等于同一件事播报两遍。
 */

export function scanProgressPercent(stats: ScanStats | null): number {
  if (!stats) return 0;
  if (stats.done) return 100;
  if (stats.totalFiles <= 0) return 0;
  // 未完成时封顶 99，避免进度条先到 100% 再等 done 事件
  return Math.min(99, Math.round((stats.scannedFiles / stats.totalFiles) * 100));
}

export function scanStatusLabel(state: ScanState, stats: ScanStats | null): string {
  if (state === 'error') return '扫描失败';
  if (!stats) return '';
  if (state === 'scanning') {
    return `正在扫描 ${stats.scannedFiles.toLocaleString()} / ${stats.totalFiles.toLocaleString()} 个文件 · ${scanProgressPercent(stats)}%`;
  }
  // 完成后只报入库图片数：与状态栏左侧「共 N 张」同分母，扫描遍历到的文件总数（含非图片）不再出现在文案里
  if (state === 'done') return `已扫描 ${stats.imageCount.toLocaleString()} 张图片`;
  return '';
}
