/**
 * 显卡类错误的人话化（规格 §6「显存不足」行 + §8-17）。
 *
 * 两条硬约束：
 * - **只改文案与错误码，绝不改行为**：分到一个 GPU 类码不等于自动退回 CPU 跑。
 *   D12 明令禁止无声降级——用户必须自己勾「CPU 慢速模式」。
 * - **宁可漏判不可误判**：认不出来就返回 null，让上层保留原始消息与原码，
 *   至少排查时看得到真东西；把一条普通 IO 错误说成"显存不足"比不说更糟。
 */

export type GpuErrorCode = 'GPU_MEMORY_LOW' | 'GPU_DEVICE_UNAVAILABLE';

export interface GpuErrorClass {
  code: GpuErrorCode;
  message: string;
}

/** 显存不够：DirectML / CUDA 侧的分配失败在 ORT 里有一串不同写法，实测与文档里都见过 */
const MEMORY_PATTERNS = [
  /out of memory/i,
  /not enough memory/i,
  /E_OUTOFMEMORY/i,
  /D3DERR_OUTOFVIDEOMEMORY/i,
  /bad_allocation/i,
  /insufficient memory/i,
  /CUDA failure 2\b/i,
  /failed to allocate \d/i
];

/** 设备本身不可用 / 驱动不支持：DmlFusedNode 是 BiRefNet 在本机崩掉时的真实形态 */
const DEVICE_PATTERNS = [
  /DmlFusedNode/i,
  /device removed|DXGI_ERROR_DEVICE/i,
  /no adapter|adapter not|unsupported adapter/i,
  /DirectML/i,
  /D3D11|DML/i,
  /execution provider.*(fail|not available|unavailable)/i,
  /gpu.*(not|unavailable|missing)/i
];

export function classifyGpuError(raw: string): GpuErrorClass | null {
  if (!raw) return null;
  if (MEMORY_PATTERNS.some((re) => re.test(raw))) {
    return {
      code: 'GPU_MEMORY_LOW',
      message:
        '显存不够，没能完成这次处理。可以先卸载已加载的模型，或在下拉里勾选「CPU 慢速模式」（约慢一个数量级，但不吃显存）。'
    };
  }
  if (DEVICE_PATTERNS.some((re) => re.test(raw))) {
    return {
      code: 'GPU_DEVICE_UNAVAILABLE',
      message:
        '这台机器的显卡加速用不了（驱动或设备不支持）。可以在下拉里勾选「CPU 慢速模式」，速度约慢一个数量级，但能出结果。'
    };
  }
  return null;
}

/** 这个码要不要在界面上给「卸载已加载的模型后重试」这颗按钮 */
export function isUnloadActionable(code: string): boolean {
  return code === 'GPU_MEMORY_LOW';
}
