import { create } from 'zustand';
import { call, getApi } from '../api';
import type {
  AiBackend,
  AiBgColorId,
  AiCapabilityView,
  AiCatalogResult,
  AiDonePayload,
  AiErrorPayload,
  AiMaskEditRequest,
  AiPhase,
  AiProgressPayload,
  AiSaveResult,
  AiStorageStats
} from '../../shared/types';

/**
 * AI 状态独立分桶（附录 A.3）：预览层组件已 394 行，AI 的进度/结果/确认态
 * 再塞进 useAppStore 会让两个不相干的关注点互相牵制。
 */

/** 对比模式：hold = 原位替换 + 按住看原图（默认）；split = 左右双栏（次要） */
export type AiCompareMode = 'hold' | 'split';

/** 结果离场或重新发起处理时的视图复位：下一张不该继承上一张的模式与按住态 */
const COMPARE_RESET = { compareMode: 'hold' as AiCompareMode, holdingOriginal: false };

/** 实测下载速率区间 0.39~1.27 MB/s，粗估取偏慢的一档，宁可报长不报短 */
const CONSERVATIVE_RATE_BYTES_PER_SEC = 0.45 * 1024 * 1024;

export function formatMb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

/**
 * 只在"下载前问一句"时用的一次性粗估（AG2）。
 * 注意这与"进度条按固定速率外推剩余时间"是两件事——后者被明确禁止，
 * 因为实测速率波动达 3 倍，任何实时 ETA 都是假信息。
 */
export function describeDownloadCost(sizeBytes: number): string {
  const seconds = Math.max(1, Math.round(sizeBytes / CONSERVATIVE_RATE_BYTES_PER_SEC));
  return `${formatMb(sizeBytes)}，约 ${seconds} 秒`;
}

export interface AiTask {
  taskId: string;
  absPath: string;
  capabilityId: string;
  phase: AiPhase;
  percent: number;
}

export interface AiPendingConfirm {
  absPath: string;
  capabilityId: string;
  modelId: string;
  sizeBytes: number;
}

interface AiState {
  catalog: AiCatalogResult | null;
  /** 设置页只读统计（模型占用 / 可用磁盘 / 整卡显存 / 暂存条目） */
  stats: AiStorageStats | null;
  /**
   * 用户显式选择的推理后端。默认 GPU；切 CPU 只能由人勾选（D12 禁止无声降级），
   * 所以它是渲染层的模式状态，每次 ai:run 都带上，不持久化——重启回 GPU。
   */
  backend: AiBackend;
  /**
   * 抠图底色（详情页参数面板第一版唯一的参数）。与 backend 同一条口径：**会话内记住、
   * 重启回默认**，不写进 settings.json（方案 §6 裁定 2）——它是"我正在处理这张图"的现场
   * 设置，不是全局偏好，所以也不进设置页（§3 表格里那条零输入控件的断言仍然成立）。
   */
  bgcolor: AiBgColorId;
  /**
   * 对比模式与按住态。舞台在大图区、动作在底栏，是两个组件共享同一份状态，
   * 所以放这里而不是留在某个组件的 local state（放组件里就得把它们再合并回去）。
   */
  compareMode: AiCompareMode;
  holdingOriginal: boolean;
  task: AiTask | null;
  result: AiDonePayload | null;
  maskEditing: boolean;
  error: AiErrorPayload | null;
  pendingConfirm: AiPendingConfirm | null;
  init: () => void;
  loadStats: () => Promise<void>;
  ensureCatalog: () => Promise<void>;
  refreshCatalog: () => Promise<void>;
  usableCapabilities: () => AiCapabilityView[];
  /** 主按钮文案：恒定取清单里的行为名，不随内部状态变（D13） */
  primaryLabel: (capabilityId?: string) => string;
  setBackend: (backend: AiBackend) => void;
  /** 面板选底色：写入状态后对**当前这张图**重跑一次处理（走掩码缓存，不重推理）。 */
  setBgColor: (bgcolor: AiBgColorId, absPath?: string, capabilityId?: string) => Promise<void>;
  setCompareMode: (mode: AiCompareMode) => void;
  setHoldingOriginal: (holding: boolean) => void;
  requestRun: (absPath: string, capabilityId?: string) => Promise<void>;
  startRun: (absPath: string, capabilityId?: string, downloadApproved?: boolean) => Promise<void>;
  approveDownload: () => Promise<void>;
  dismissConfirm: () => void;
  cancelRun: () => Promise<void>;
  saveResult: () => Promise<AiSaveResult | null>;
  editMask: (request: AiMaskEditRequest) => Promise<void>;
  clearResult: () => void;
  modelAction: (modelId: string, action: 'download' | 'unload' | 'delete' | 'set-default') => Promise<void>;
  dismissError(): void;
}

let subscribed = false;

export const useAiStore = create<AiState>((set, get) => ({
  catalog: null,
  stats: null,
  backend: 'dml',
  bgcolor: 'transparent',
  compareMode: 'hold',
  holdingOriginal: false,
  task: null,
  result: null,
  maskEditing: false,
  error: null,
  pendingConfirm: null,

  init: () => {
    void get().ensureCatalog();
    if (subscribed) return;
    subscribed = true;
    const api = getApi();
    api.onAiProgress((p: AiProgressPayload) => {
      const task = get().task;
      if (!task || task.taskId !== p.taskId) return;
      set({ task: { ...task, phase: p.phase, percent: p.percent ?? task.percent } });
    });
    api.onAiDone((payload) => {
      // 完成后清进行中标记，但保留结果给对比视图
      set({ task: null, result: payload, maskEditing: false, bgcolor: payload.cutout?.bgcolor ?? get().bgcolor, error: null });
      // 驻留状态是清单里从主进程取来的快照：不重取，跑完这一次也显示不出"已加载"。
      // 缓存命中同样要刷——那时驻留可能早被用户点卸载改掉了
      void get().refreshCatalog();
    });
    api.onAiError((err) => {
      set({ task: null, error: err });
      // 失败后必须刷新清单：推理崩时模型常常已经驻留（load 成功、infer 失败），
      // 而错误条上那颗「卸载已加载的模型」的判据正是 catalog 里的 loaded——不刷就永远不出现
      void get().refreshCatalog();
    });
  },

  ensureCatalog: async () => {
    if (get().catalog) return;
    await get().refreshCatalog();
  },

  refreshCatalog: async () => {
    try {
      const catalog = await call(getApi().aiCatalog());
      set({ catalog });
    } catch (err) {
      set({ catalog: { capabilities: [] }, error: { taskId: '', code: 'CATALOG_FAILED', message: String(err) } });
    }
  },

  loadStats: async () => {
    try {
      set({ stats: await call(getApi().aiStorageStats()) });
    } catch {
      set({ stats: null }); // 读不到就显示"未知"，不许显示 0
    }
  },

  usableCapabilities: () => {
    // §4.3：未实测跑通的行为与模型不进 UI，而不是灰着显示
    return (get().catalog?.capabilities ?? [])
      .map((cap) => ({ ...cap, models: cap.models.filter((m) => m.verified) }))
      .filter((cap) => cap.models.length > 0);
  },

  primaryLabel: (capabilityId) => {
    const caps = get().usableCapabilities();
    const cap = capabilityId ? caps.find((c) => c.id === capabilityId) : caps[0];
    return cap?.label ?? '人像抠图';
  },

  setBackend: (backend) => set({ backend }),

  /**
   * 选底色 = 写状态 + 对当前这张图重跑一次处理。
   *
   * "重跑"听着像又要等 GPU，其实不会：成品缓存键含参数所以拿不到旧图（这是对的），
   * 而掩码缓存键**不含**参数，于是主进程直接复用现成掩码，只重算合成那一段。
   * 这条口径要靠集成测试的推理次数钉住（方案 §8-1），不能靠"感觉变快了"。
   */
  setBgColor: async (bgcolor, absPath, capabilityId) => {
    if (get().maskEditing) return;
    set({ bgcolor });
    const target = absPath ?? get().result?.sourceAbsPath;
    if (!target) return; // 还没有结果可选底色：面板此时也不会出现
    await get().startRun(target, capabilityId ?? get().result?.capabilityId);
  },

  setCompareMode: (compareMode) => set({ compareMode }),

  setHoldingOriginal: (holdingOriginal) => set({ holdingOriginal }),

  requestRun: async (absPath, capabilityId) => {
    if (get().maskEditing) return;
    // 清单可能还没回来（首帧就点了）：先自愈，不能静默什么都不做
    await get().ensureCatalog();
    if (get().maskEditing) return;
    const caps = get().usableCapabilities();
    const cap = capabilityId ? caps.find((c) => c.id === capabilityId) : caps[0];
    if (!cap) return;
    const modelId = cap.defaultModelId;
    const model = cap.models.find((m) => m.id === modelId) ?? cap.models[0];
    if (model.status === 'absent') {
      // 唯一保留的一次询问（AG2）；已下载时不问，直接走完
      set({
        pendingConfirm: { absPath, capabilityId: cap.id, modelId: model.id, sizeBytes: model.sizeBytes }
      });
      return;
    }
    await get().startRun(absPath, cap.id);
  },

  startRun: async (absPath, capabilityId, downloadApproved) => {
    if (get().maskEditing) return;
    await get().ensureCatalog();
    if (get().maskEditing) return;
    const caps = get().usableCapabilities();
    const cap = capabilityId ? caps.find((c) => c.id === capabilityId) : caps[0];
    if (!cap) return;
    // 同一张图重跑（换底色走的就是这条路）时保留上一次结果：清掉会让大图区从抠图结果
    // 闪回原图、浮层面板跟着消失，用户选完一个颜色就找不到第二个颜色的入口。换图才复位。
    const prev = get().result;
    set({ result: prev?.sourceAbsPath === absPath ? prev : null, error: null, ...COMPARE_RESET });
    try {
      const ack = await call(
        getApi().aiRun({
          absPath,
          capabilityId: cap.id,
          downloadApproved,
          backend: get().backend,
          cutout: { bgcolor: get().bgcolor }
        })
      );
      set({ task: { taskId: ack.taskId, absPath, capabilityId: cap.id, phase: 'load', percent: 0 } });
    } catch (err) {
      set({ error: { taskId: '', code: 'RUN_FAILED', message: String(err) } });
    }
  },

  approveDownload: async () => {
    const pending = get().pendingConfirm;
    set({ pendingConfirm: null });
    if (!pending) return;
    await get().startRun(pending.absPath, pending.capabilityId, true);
  },

  dismissConfirm: () => set({ pendingConfirm: null }),

  cancelRun: async () => {
    const task = get().task;
    if (!task) return;
    set({ task: null });
    try {
      await call(getApi().aiCancel(task.taskId));
    } catch {
      // 取消失败不需要额外提示：任务已不在进行中
    }
  },

  saveResult: async () => {
    const result = get().result;
    if (!result || get().maskEditing) return null;
    set({ maskEditing: true });
    try {
      const saved = await call(getApi().aiSave(result.taskId));
      if (get().result?.taskId === result.taskId) set({ result: null, maskEditing: false, ...COMPARE_RESET });
      return saved;
    } finally {
      if (get().result?.taskId === result.taskId) set({ maskEditing: false });
    }
  },

  editMask: async (request) => {
    const { result, maskEditing } = get();
    if (!result?.maskEditable || maskEditing) return;
    set({ maskEditing: true, error: null });
    try {
      const edited = await call(getApi().aiMaskEdit(result.taskId, request));
      if (get().result?.taskId !== result.taskId) return;
      set({ result: { ...result, tempPath: edited.tempPath, maskCanUndo: edited.maskCanUndo, maskCanRedo: edited.maskCanRedo } });
    } catch (err) {
      set({ error: { taskId: result.taskId, code: 'MASK_EDIT_FAILED', message: err instanceof Error ? err.message : String(err) } });
    } finally {
      if (get().result?.taskId === result.taskId) set({ maskEditing: false });
    }
  },

  clearResult: () => {
    if (get().maskEditing) return;
    set({ result: null, error: null, ...COMPARE_RESET });
  },

  /** 只关错误条：不能顺手清掉 result，用户可能正看着上一次抠出来的图 */
  dismissError: () => set({ error: null }),

  modelAction: async (modelId, action) => {
    const api = getApi();
    const cap = get().usableCapabilities()[0];
    try {
      if (action === 'download') await call(api.aiModelDownload(modelId));
      if (action === 'unload') await call(api.aiModelUnload(modelId));
      if (action === 'delete') await call(api.aiModelDelete(modelId));
      if (action === 'set-default' && cap) await call(api.aiModelSetDefault(cap.id, modelId));
      await get().refreshCatalog();
    } catch (err) {
      set({ error: { taskId: '', code: 'MODEL_OP_FAILED', message: String(err) } });
    }
  }
}));
