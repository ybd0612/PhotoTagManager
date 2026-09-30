// 更新区的"状态 → 文案 → 唯一主动作"派生，是设置分区和右下角通知卡共用的那一层。
// 它出错不会崩溃，只会让某一行既没文案也没按钮（用户看着一片空白），所以在这儿钉死。
import { describe, it, expect } from 'vitest';
import { updateActionLabel, updatePrimaryAction, updateStatusLabel } from '../src/utils/updateStatus';
import type { UpdateStatus } from '../shared/types';

const ALL_STATES: UpdateStatus[] = [
  { state: 'idle' },
  { state: 'checking' },
  { state: 'available', version: '0.2.0' },
  { state: 'not-available' },
  { state: 'downloading', percent: 42 },
  { state: 'downloaded', version: '0.2.0', percent: 100 },
  { state: 'error', message: '更新失败：网络不通' },
  { state: 'dev-mode' }
];

describe('更新状态派生', () => {
  it('每个状态都有非空文案', () => {
    for (const s of ALL_STATES) {
      expect(updateStatusLabel(s).trim().length, `state=${s.state}`).toBeGreaterThan(0);
    }
  });

  it('正在跑的和没有更新可查的状态不给动作，其余恰好一个', () => {
    for (const s of ALL_STATES) {
      const action = updatePrimaryAction(s);
      if (s.state === 'checking' || s.state === 'downloading' || s.state === 'dev-mode') {
        expect(action, `state=${s.state}`).toBeNull();
      } else {
        expect(action, `state=${s.state}`).not.toBeNull();
      }
    }
  });

  it('动作措辞按状态走：发现新版叫下载、下完叫安装、出错那一次叫重试', () => {
    expect(updateActionLabel('download', { state: 'available', version: '0.2.0' })).toBe('立即下载');
    expect(updateActionLabel('install', { state: 'downloaded' })).toBe('立即安装');
    expect(updateActionLabel('check', { state: 'idle' })).toBe('检查更新');
    expect(updateActionLabel('check', { state: 'error' })).toBe('重试');
  });

  it('错误文案原样透出主进程给的原因，不吞掉', () => {
    expect(updateStatusLabel({ state: 'error', message: '更新失败：ENOENT app-update.yml' })).toContain(
      'ENOENT'
    );
  });
});
