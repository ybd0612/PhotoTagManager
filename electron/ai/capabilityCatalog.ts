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
  /**
   * 仓库坐标：HuggingFace 风格的「命名空间/仓库名」+ 仓库内路径。
   * 不存整条 URL —— 具体地址由 modelSources 按「ModelScope 优先、hf-mirror 兜底」的顺序展开，
   * 加模型只填一次，也不会出现两个源各指一个文件。
   */
  repoId: string;
  filePath: string;
  /** 落在 models/<modelId>/ 下的权重文件名 */
  fileName: string;
  /** 下载体积（字节），用于代价告知与磁盘预检 */
  sizeBytes: number;
  /** 权重指纹，同时是缓存键的第二个分量 */
  sha256: string;
  /**
   * 上游许可的 SPDX 标识。许可与归属只写在这里，NOTICE 与界面都从这一处读
   * （规范 §5「数据源必须单一」）——在第二处再抄一遍就会开始各说各话。
   * 取值必须落在规范 §3.0 白名单内，由 tests/modelLicense.test.ts 强制。
   */
  license: string;
  /** 一手作者仓库。只作出处与归属来源，不作分发来源（§3.1 推论） */
  upstreamRepo: string;
  /** 进 NOTICE 的归属声明（Apache-2.0 第 4 条对再分发的硬性要求） */
  attribution: string;
  /**
   * 许可依据从哪来：上游仓库里有 LICENSE 文件本体，还是只有 README 里自填的 `license:` 元数据。
   * 后者必须按 §3.1 在 NOTICE 里如实披露，不能写成"已核验许可"。
   */
  licenseEvidence: 'license-file' | 'readme-claim';
  /** 权重同一性：一手作者发布的权重，还是第三方转导出的 ONNX（后者须挂 §6.1 四行已知限制记录） */
  provenanceStatus: 'first-party' | 'second-hand';
  /** `LICENSES/third-party/` 下逐字节留存的许可全文文件名。§3.1.1 第 ④ 件，不是可选项 */
  licenseFile: string;
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
    label: '人像抠图',
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
        repoId: 'BritishWerewolf/U-2-Netp',
        filePath: 'onnx/model.onnx',
        fileName: 'u2netp.onnx',
        sizeBytes: 4_574_861,
        sha256: '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8',
        license: 'Apache-2.0',
        upstreamRepo: 'xuebinqin/U-2-Net',
        attribution:
          'U²-Net: Xuebin Qin, Zichen Zhang, Chenyang Huang, Masood Dehghan, Osmar R. Zaiane, Martin Jagersand (CVPR 2020)',
        licenseEvidence: 'license-file',
        provenanceStatus: 'second-hand',
        licenseFile: 'u2netp.apache-2.0.txt',
        verified: true,
        inputName: 'input.1',
        inputDims: [1, 3, 320, 320],
        outputNameIndex: 0,
        normalize: {
          rescale: 1 / 255,
          mean: [0.485, 0.456, 0.406],
          std: [0.229, 0.224, 0.225]
        }
      },
      {
        // 人像专用：输出是连续 alpha（不是显著图），发丝一类的半透明边缘靠它。
        // 归一化与 u2netp 不同——MODNet 要的是 [-1,1]，不是 ImageNet 均值方差。
        id: 'modnet',
        displayName: 'MODNet',
        repoId: 'Xenova/modnet',
        filePath: 'onnx/model.onnx',
        fileName: 'modnet.onnx',
        sizeBytes: 25_888_640,
        sha256: '07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9',
        license: 'Apache-2.0',
        upstreamRepo: 'ZHKKKe/MODNet',
        attribution:
          'MODNet: ZHKKKe/MODNet（AAAI 2020, MODNet: Real-Time Trimap-Free Portrait Matting via Objective Decomposition）；作者名单未逐字核对原论文',
        licenseEvidence: 'license-file',
        provenanceStatus: 'second-hand',
        licenseFile: 'modnet.apache-2.0.txt',
        verified: true,
        inputName: 'input',
        inputDims: [1, 3, 512, 512],
        outputNameIndex: 0,
        normalize: {
          rescale: 1 / 255,
          mean: [0.5, 0.5, 0.5],
          std: [0.5, 0.5, 0.5]
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
