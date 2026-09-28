import { execFile } from 'child_process';
import { readWholeGpuMemory } from './gpuStats';

/**
 * 本机有没有"能用的 GPU 加速设备"。规格 §6 要求无 GPU 时清单条目转「不可用」并说明原因，
 * 这条判据决定那个状态怎么来。
 *
 * 三态而不是两态，因为**误报"不可用"会把能用的机器挡在门外**：
 * - `ok`：nvidia-smi 读得到卡，或枚举到一块像样的显示适配器；
 * - `unavailable`：只枚举到「Microsoft Basic Render Driver」这类无 3D 的假适配器（远程桌面/无头环境常见）；
 * - `unknown`：命令失败、输出解析不了、字段缺失——一律按"能用"处理（不标不可用），
 *   真跑不动时由推理阶段的 GPU 错误分类给出人话（见 gpuErrorText）。
 */
export type GpuCapability = 'ok' | 'unavailable' | 'unknown';

/** 无 3D 能力的占位适配器名（大小写不敏感） */
const BASIC_ADAPTER = /basic render|basic display|microsoft basic/i;
/** 明确带 GPU 能力的厂商关键字 */
const REAL_ADAPTER = /nvidia|geforce|quadro|rtx|gtx|radeon|amd radar|intel.*(hd|uhd|arc|iris|graphics)|aspeed|matrox/i;

/**
 * 纯函数：把 `Get-CimInstance Win32_VideoController` 的每行（"Name|AdapterRAM"）判成三态。
 * 拆出来是为了能单测——真机上要么有卡要么没有，判错的代价是整条功能对用户消失。
 */
export function classifyAdapters(lines: string[]): GpuCapability {
  const rows = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, ram] = line.split('|');
      return { name: (name ?? '').trim(), ramBytes: Number((ram ?? '').trim()) };
    });
  if (rows.length === 0) return 'unknown';
  const real = rows.filter((r) => r.name && !BASIC_ADAPTER.test(r.name));
  if (real.length === 0) return 'unavailable';
  // 有非 Basic 的适配器就认 ok；显存字段读不到（0/NaN）也不否决——虚拟机的取值经常不可信
  return real.some((r) => Number.isFinite(r.ramBytes) && r.ramBytes > 0) || real.some((r) => REAL_ADAPTER.test(r.name))
    ? 'ok'
    : 'unknown';
}

const QUERY =
  'Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name)|$($_.AdapterRAM)" }';

/** 枚举显示适配器。任何一步不顺利都回 unknown，绝不因为"探测失败"就把功能标成不可用。 */
export function probeAdaptersViaCim(): Promise<GpuCapability> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', QUERY],
      { timeout: 6000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve('unknown');
        resolve(classifyAdapters(stdout.split(/\r?\n/)));
      }
    );
  });
}

let cached: GpuCapability | null = null;

/**
 * 一次会话内缓存。nvidia-smi 命中就直接 ok（它比适配器枚举更硬：驱动装了且能查询到显存），
 * 否则退到 CIM 枚举。
 */
export async function readGpuCapability(): Promise<GpuCapability> {
  if (cached) return cached;
  const mem = await readWholeGpuMemory();
  cached = mem ? 'ok' : await probeAdaptersViaCim();
  return cached;
}

/** 测试用：清掉缓存，避免用例之间互相粘住上一次探测结果 */
export function resetGpuCapabilityCache(): void {
  cached = null;
}

/** 不可用时给人看的解释（下拉每一行都挂这句，所以要说清"怎么办"而不是只说"不行"） */
export const GPU_UNAVAILABLE_REASON =
  '这台机器上没有检测到可用的显卡加速设备。想试的话，在下拉里勾选「CPU 慢速模式」，速度约慢一个数量级。';
