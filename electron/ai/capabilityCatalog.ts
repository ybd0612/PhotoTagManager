/**
 * 行为 → 模型 的能力清单（规格 D7 三层分离的中间层，D10 行为标签的单一事实源）。
 *
 * 这里是**纯数据**：不 import electron、不 import fs、不含任何算法。
 * 三层分离的三条验收约束都靠它兜住：
 *  ① 加一个模型 = 往 models 里加一条数据，不改 UI 组件、不改 IPC 通道；
 *  ② 加一个行为 = 加一条 CapabilitySpec + 一个后处理函数（靠 postprocessId 关联）；
 *  ③ 320×320 / input.1 / ImageNet 均值方差这类具体形状只允许出现在这里，
 *     通用代码路径（preprocess / inferenceChild / runner / aiService）一律从这里取。
 */

export interface NormalizeSpec {
  /** 像素缩放系数，例如 1/255 */
  rescale: number;
  /** CHW 三通道均值 */
  mean: number[];
  /** CHW 三通道标准差 */
  std: number[];
}

export interface ModelSpec {
  id: string;
  /** 下拉里给人看的名字 */
  displayName: string;
  /** 只允许 hf-mirror.com：huggingface.co 直连超时 */
  downloadUrl: string;
  /** 落在 models/<modelId>/ 下的权重文件名 */
  fileName: string;
  /** 下载体积（字节），用于代价告知与磁盘预检 */
  sizeBytes: number;
  /** 权重指纹，同时是缓存键的第二个分量 */
  sha256: string;
  /** 是否在本引擎（DirectML）上真图跑通过。false 的条目一律不进 UI（§4.3 硬规则） */
  verified: boolean;
  inputName: string;
  inputDims: number[];
  /** 模型可能有多个输出，取第几个作为掩码 */
  outputNameIndex: number;
  normalize: NormalizeSpec;
}

export interface CapabilitySpec {
  id: string;
  /** 组合按钮主按钮文案，语义恒定不随内部状态变化（D13） */
  label: string;
  /** 面向用户的说法，不得承诺超出实测的能力 */
  description: string;
  /** 派生文件要追加的行为标签（D10）；UI / 写入 / 筛选都取这个字段 */
  actionTag: string;
  /** 派生文件名 `原名.<outputSuffix><outputExt>` */
  outputSuffix: string;
  outputExt: string;
  /** 关联 postprocess.ts 里的输出后处理函数（D7 ②） */
  postprocessId: string;
  defaultModelId: string;
  models: ModelSpec[];
}

export const capabilities: CapabilitySpec[] = [
  {
    id: 'portrait-cutout',
    label: '抠图',
    description: '去除人像背景',
    actionTag: 'AI人像抠图',
    outputSuffix: 'cutout',
    outputExt: '.png',
    postprocessId: 'portrait-cutout-alpha',
    defaultModelId: 'u2netp',
    models: [
      {
        id: 'u2netp',
        displayName: 'U²-Netp',
        downloadUrl: 'https://hf-mirror.com/BritishWerewolf/U-2-Netp/resolve/main/onnx/model.onnx',
        fileName: 'u2netp.onnx',
        sizeBytes: 4_574_861,
        sha256: '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8',
        verified: true,
        inputName: 'input.1',
        inputDims: [1, 3, 320, 320],
        outputNameIndex: 0,
        normalize: {
          rescale: 1 / 255,
          mean: [0.485, 0.456, 0.406],
          std: [0.229, 0.224, 0.225]
        }
      }
    ]
  }
];

export function getCapability(capabilityId: string): CapabilitySpec | undefined {
  return capabilities.find((c) => c.id === capabilityId);
}

export function getModel(capabilityId: string, modelId: string): ModelSpec | undefined {
  return getCapability(capabilityId)?.models.find((m) => m.id === modelId);
}

/** 至少有一个实测跑通的模型，这个行为才允许出现在 UI 上。 */
export function isCapabilityRenderable(cap: CapabilitySpec): boolean {
  return cap.models.some((m) => m.verified);
}

/** 渲染层与 IPC 只允许消费这个函数的结果（§4.3 / §8 第 15 条）。 */
export function usableCapabilities(): CapabilitySpec[] {
  return capabilities.filter(isCapabilityRenderable).map((cap) => ({
    ...cap,
    models: cap.models.filter((m) => m.verified)
  }));
}
