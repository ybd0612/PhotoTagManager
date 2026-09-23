import { create } from 'zustand';
import { call, getApi } from '../api';
import type {
  AiCapabilityView,
  AiCatalogResult,
  AiDonePayload,
  AiErrorPayload,
  AiPhase,
  AiProgressPayload,
  AiSaveResult,
  AiStorageStats
} from '../../shared/types';

/**
 * AI 状态独立分桶（附录 A.3）：预览层组件已 394 行，AI 的进度/结果/确认态
 * 再塞进 useAppStore 会让两个不相干的关注点互相牵制。
 */

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
  task: AiTask | null;
  result: AiDonePayload | null;
  error: AiErrorPayload | null;
  pendingConfirm: AiPendingConfirm | null;
  init: () => void;
  loadStats: () => Promise<void>;
  ensureCatalog: () => Promise<void>;
  refreshCatalog: () => Promise<void>;
  usableCapabilities: () => AiCapabilityView[];
  /** 主按钮文案：恒定取清单里的行为名，不随内部状态变（D13） */
  primaryLabel: (capabilityId?: string) => string;
  requestRun: (absPath: string, capabilityId?: string) => Promise<void>;
  startRun: (absPath: string, capabilityId?: string, downloadApproved?: boolean) => Promise<void>;
  approveDownload: () => Promise<void>;
  dismissConfirm: () => void;
  cancelRun: () => Promise<void>;
  saveResult: () => Promise<AiSaveResult | null>;
  clearResult: () => void;
  modelAction: (modelId: string, action: 'download' | 'unload' | 'delete' | 'set-default') => Promise<void>;
}

let subscribed = false;

export const useAiStore = create<AiState>((set, get) => ({
  catalog: null,
  stats: null,
  task: null,
  result: null,
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
      set({ task: null, result: payload, error: null });
    });
    api.onAiError((err) => {
      set({ task: null, error: err });
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
    return cap?.label ?? '抠图';
  },

  requestRun: async (absPath, capabilityId) => {
    // 清单可能还没回来（首帧就点了）：先自愈，不能静默什么都不做
    await get().ensureCatalog();
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
    await get().ensureCatalog();
    const caps = get().usableCapabilities();
    const cap = capabilityId ? caps.find((c) => c.id === capabilityId) : caps[0];
    if (!cap) return;
    set({ result: null, error: null });
    try {
      const ack = await call(getApi().aiRun({ absPath, capabilityId: cap.id, downloadApproved }));
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
    if (!result) return null;
    const saved = await call(getApi().aiSave(result.taskId));
    set({ result: null });
    return saved;
  },

  clearResult: () => set({ result: null, error: null }),

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
