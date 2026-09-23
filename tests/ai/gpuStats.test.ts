// gpuStats 属主进程模块（用 child_process），放在 node 环境测，不让渲染层测试 import 它。
import { describe, it, expect } from 'vitest';

import { parseNvidiaSmiMiB } from '../../electron/ai/gpuStats';

describe('ai/gpuStats —— 整卡显存解析（§5.2 口径）', () => {
  it('解析 used,total 两列（带 MiB 单位与纯数字两种形态都要能吃下）', () => {
    expect(parseNvidiaSmiMiB('1178 MiB, 8151 MiB')).toEqual({ usedMiB: 1178, totalMiB: 8151 });
    expect(parseNvidiaSmiMiB('1178, 8151')).toEqual({ usedMiB: 1178, totalMiB: 8151 });
  });

  it('拿不到数据时回 null，界面显示未知而不是编一个 0', () => {
    expect(parseNvidiaSmiMiB('')).toBeNull();
    expect(parseNvidiaSmiMiB('[N/A], [N/A]')).toBeNull();
    expect(parseNvidiaSmiMiB('error: driver not loaded')).toBeNull();
    // 只有一个数就不能当"已用/总量"
    expect(parseNvidiaSmiMiB('8151')).toBeNull();
  });
});
