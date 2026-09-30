import type { UpdateStatus } from '../../shared/types';

/** 更新区唯一的主动作。由状态推导，不把一组可能动作平铺 */
export type UpdateAction = 'check' | 'download' | 'install';

/** 状态文案。设置分区与右下角通知卡共用，避免同一状态两处各写一遍 */
export function updateStatusLabel(status: UpdateStatus): string {
  switch (status.state) {
    case 'checking':
      return '正在检查更新…';
    case 'available':
      return `发现新版本 v${status.version}`;
    case 'not-available':
      return '已是最新版本';
    case 'downloading':
      return `正在下载 ${status.percent ?? 0}%`;
    case 'downloaded':
      return status.version ? `v${status.version} 下载完成，重启即可安装` : '下载完成，重启即可安装';
    case 'error':
      return status.message ?? '更新出错，请稍后重试';
    case 'dev-mode':
      return '当前为开发版，不检查更新';
    default:
      return '尚未检查';
  }
}

/**
 * 该状态下用户唯一能做的事。
 * checking / downloading 返回 null 是因为动作已经在跑，再给一颗按钮就是重复触发；
 * dev-mode 返回 null 是因为主进程根本不发更新请求。
 */
export function updatePrimaryAction(status: UpdateStatus): UpdateAction | null {
  switch (status.state) {
    case 'available':
      return 'download';
    case 'downloaded':
      return 'install';
    case 'error':
      return 'check';
    case 'checking':
    case 'downloading':
    case 'dev-mode':
      return null;
    default:
      return 'check';
  }
}

/** 同一个动作在不同状态下的说法：出错后点它叫「重试」，平时叫「检查更新」 */
export function updateActionLabel(action: UpdateAction, status: UpdateStatus): string {
  if (action === 'download') return '立即下载';
  if (action === 'install') return '立即安装';
  return status.state === 'error' ? '重试' : '检查更新';
}
