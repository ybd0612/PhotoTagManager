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

/**
 * 无 3D 能力的占位适配器名（大小写不敏感）。
 * ⚠️ 这条**只作兜底**：真实机器上的 Microsoft Basic Render Driver 一行足够，
 * 但它拦不住国产远控的虚拟显示器（见 SOFTWARE_ADAPTER），所以别把它当主判据。
 */
const BASIC_ADAPTER = /basic render|basic display|microsoft basic/i;
/** 明确带 GPU 能力的厂商关键字 */
const REAL_ADAPTER = /nvidia|geforce|quadro|rtx|gtx|radeon|amd radar|intel.*(hd|uhd|arc|iris|graphics)|aspeed|matrox/i;

/**
 * **没有实体硬件**的适配器（远程控制 / 虚拟显示器）。本机实测枚举到的三条全属此类：
 *
 * ```
 * [OrayIddDriver Device]              ← 向日葵
 * [Todesk Virtual Display Adapter]
 * [GameViewer Virtual Display Adapter]
 * ```
 *
 * 它们 `AdapterRAM` 为空，但**名字里没有 basic**，所以原先的过滤放它们过了，
 * 于是「只有核显 + 装了远控」的机器被判成 `ok`，清单全亮、点下去才报显存不足。
 *
 * **为什么不继续加厂商名**：静态名单永远追不上国产远控驱动，改一个漏一个。
 * 判据改成**总线类型**——`ROOT\DISPLAY\...` 是软件创建设备，没有真实硬件总线；
 * 真实适配器一律是 `PCI\VEN_xxxx&DEV_xxxx` 形态。这条跟着 Windows 的枚举语义走，
 * 不依赖任何一家的名字。
 *
 * 附带收益：这三类虚拟适配器会互相冲突（同时装两个远控就抢显示），
 * 它们的存在不代表有任何 3D 能力。
 */
const SOFTWARE_ADAPTER = /virtual display|virtual monitor|idddriver|indirect display|idd/i;
/** `Win32_VideoController.PNPDeviceID`：实体硬件走 PCI 总线，软件设备走 ROOT\DISPLAY */
const BUS_PREFIX = /^PCI\\/i;

/**
 * 纯函数：把 `Get-CimInstance Win32_VideoController` 的每行判成三态。
 *
 * 入参格式 `Name|PNPDeviceID|AdapterRAM`（第三段可缺，缺按读不到处理）。
 * 拆出来是为了能单测——真机上要么有卡要么没有，判错的代价是整条功能对用户消失。
 *
 * 判定顺序刻意如此，**不能调换**：
 * 1. 先剔软件设备（虚拟显示器 / Basic），它们一定没有 3D 能力；
 * 2. 再看剩下的是否有**实体总线**（`PCI\...`）；
 * 3. 最后才退到厂商关键字 —— 只在这一步认，是为了兼容拿不到 PNPDeviceID 的环境。
 *
 * 第2 步是主力判据。若只看第 3 步，「核显 + 远控」会被判ok（远控名字里没有厂商关键字，
 * 但也不会否决整体），这正是 §1.5 记的那个漏判。
 */
export function classifyAdapters(lines: string[]): GpuCapability {
  const rows = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, pnp, ram] = line.split('|');
      return {
        name: (name ?? '').trim(),
        pnpId: (pnp ?? '').trim(),
        ramBytes: Number((ram ?? '').trim())
      };
    });
  if (rows.length === 0) return 'unknown';

  const candidates = rows.filter((r) => r.name && !BASIC_ADAPTER.test(r.name) && !SOFTWARE_ADAPTER.test(r.name));
  if (candidates.length === 0) return 'unavailable';

  // 有实体总线就是真硬件 —— 这一条不依赖厂商名单，也不依赖 AdapterRAM 是否读得到
  if (candidates.some((r) => BUS_PREFIX.test(r.pnpId))) return 'ok';

  // 拿不到 PNPDeviceID 的环境（老系统、非英文）退到厂商关键字 + 显存读数
  return candidates.some((r) => REAL_ADAPTER.test(r.name)) ||
    candidates.some((r) => Number.isFinite(r.ramBytes) && r.ramBytes > 0)
    ? 'ok'
    : 'unknown';
}

const QUERY =
  'Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name)|$($_.PNPDeviceID)|$($_.AdapterRAM)" }';

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

/** 本地调试开关的取值（见 parseFakeGpuEnv） */
export type FakeGpu = 'none' | 'oom';

/**
 * 解析 `PTM_FAKE_GPU`。**非法值一律返回 null（当没设过）**——
 * 一个拼错的环境变量不该把真机的 GPU 判断改掉，那会让"我这台机器到底行不行"变成不可知。
 * 纯函数拆出来是为了单测能覆盖到"垃圾值必须无效"这条。
 */
export function parseFakeGpuEnv(raw: string | undefined): FakeGpu | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'none' || v === 'no-gpu' || v === 'unavailable') return 'none';
  if (v === 'oom' || v === 'memory' || v === 'vram') return 'oom';
  return null;
}

/** 当前生效的模拟档位；没设或设错都是 null（真实行为） */
export function activeFakeGpu(): FakeGpu | null {
  return parseFakeGpuEnv(process.env.PTM_FAKE_GPU);
}

/**
 * 一次会话内缓存。nvidia-smi 命中就直接 ok（它比适配器枚举更硬：驱动装了且能查询到显存），
 * 否则退到 CIM 枚举。`PTM_FAKE_GPU=none` 时短路成 unavailable（`oom` 不改能力判断，
 * 它作用在加载那一步，见 main.ts 的挂钩）。
 */
export async function readGpuCapability(): Promise<GpuCapability> {
  if (activeFakeGpu() === 'none') return 'unavailable';
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
