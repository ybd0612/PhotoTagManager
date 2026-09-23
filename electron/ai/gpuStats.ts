import { execFile } from 'child_process';

/**
 * 整卡显存读取。
 *
 * 口径必须诚实：探针实测本机驱动下 `nvidia-smi --query-compute-apps` 返回 `[N/A]`，
 * **分进程显存拿不到**，能拿到的只有整卡 memory.used（一次 u2netp 推理 Δ325 MiB，
 * 但那 325 里含机器上其他 GPU 进程）。所以界面只能写"整卡已用"，
 * 不能写成"AI 占用了多少"——那是谎报（§5.2）。
 */

export interface GpuMemoryMiB {
  usedMiB: number;
  totalMiB: number;
  /** 明确标注口径：整卡，不是本应用独占 */
  scope: 'whole-gpu';
}

/** 解析 `--query-gpu=memory.used,memory.total --format=csv,noheader,nounits` 的一行 */
export function parseNvidiaSmiMiB(text: string): { usedMiB: number; totalMiB: number } | null {
  const matches = [...text.matchAll(/(\d+)\s*MiB/gi)];
  const cells = matches.length >= 2 ? matches.map((m) => Number(m[1])) : text.split(/[,;]/).map((c) => Number(c.trim()));
  const usedMiB = cells[0];
  const totalMiB = cells[1];
  if (!Number.isFinite(usedMiB) || !Number.isFinite(totalMiB) || totalMiB <= 0) return null;
  return { usedMiB, totalMiB };
}

export function readWholeGpuMemory(): Promise<GpuMemoryMiB | null> {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 3000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null); // 没有 NVIDIA 驱动 / 命令不存在
        const parsed = parseNvidiaSmiMiB(stdout);
        resolve(parsed ? { ...parsed, scope: 'whole-gpu' } : null);
      }
    );
  });
}
