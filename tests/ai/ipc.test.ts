// T10 · 跨进程契约测试。
// "三处一次改齐"（shared/types.ts / electron/ipc.ts / electron/preload.ts）里，
// preload↔types 由编译保证；ipc↔preload 对不上是运行时才暴露的洞，在这里钉死。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const { handlers, sent, sendMock } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  sent: [] as Array<{ channel: string; payload: unknown }>,
  sendMock: vi.fn((channel: string, payload: unknown) => {
    sent.push({ channel, payload });
  })
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, fn);
    }
  },
  app: { getPath: () => '/tmp/userData', getVersion: () => '0.1.3' },
  clipboard: { writeBuffer: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() }
}));

import { registerIpc, type IpcDeps, type AiServiceView, type AiStoreView, type AiRunnerView } from '../../electron/ipc';
import { usableCapabilities } from '../../electron/ai/capabilityCatalog';
import type { AiEvent, RunRequest, RunResult } from '../../electron/ai/aiService';
import type { ModelDownloadSpec } from '../../electron/ai/modelStore';

const root = process.cwd();
const typesSrc = readFileSync(join(root, 'shared', 'types.ts'), 'utf8');
const preloadSrc = readFileSync(join(root, 'electron', 'preload.ts'), 'utf8');
const ipcSrc = readFileSync(join(root, 'electron', 'ipc.ts'), 'utf8');

/** channel → PhotoTagApi 方法名。三处都必须出现。 */
const AI_INVOKE: Array<[string, string]> = [
  ['ai:catalog', 'aiCatalog'],
  ['ai:run', 'aiRun'],
  ['ai:cancel', 'aiCancel'],
  ['ai:save', 'aiSave'],
  ['ai:model-download', 'aiModelDownload'],
  ['ai:model-delete', 'aiModelDelete'],
  ['ai:model-unload', 'aiModelUnload'],
  ['ai:model-set-default', 'aiModelSetDefault'],
  ['ai:storage-stats', 'aiStorageStats']
];
const AI_EVENTS: Array<[string, string]> = [
  ['ai:progress', 'onAiProgress'],
  ['ai:done', 'onAiDone'],
  ['ai:error', 'onAiError']
];

/** 按 AiServiceView 形状实现的假件：编译期就要求方法齐备，不用 as unknown 绕过 */
class FakeAiService implements AiServiceView {
  requests: RunRequest[] = [];
  savedTaskIds: string[] = [];
  defaults = new Map<string, string>();
  saveError: Error | null = null;
  private listeners = new Set<(e: AiEvent) => void>();

  startRun(req: RunRequest) {
    this.requests.push(req);
    const taskId = `ai-${this.requests.length}`;
    return { taskId, promise: Promise.resolve(this.resultFor(taskId, req)) };
  }

  private resultFor(taskId: string, req: RunRequest): RunResult {
    return {
      taskId,
      tempPath: `C:/userData/ai-preview/00000000000000000000000000000000000000aa.png`,
      sourceAbsPath: req.absPath,
      cacheHit: false,
      didApplySigmoid: false,
      maskWidth: 320,
      maskHeight: 320,
      capabilityId: req.capabilityId,
      modelId: 'u2netp',
      actionTag: usableCapabilities()[0].actionTag
    };
  }

  cancel(taskId: string): boolean {
    this.fire({ type: 'error', payload: { taskId, code: 'CANCELLED', message: '任务已取消' } });
    return true;
  }

  async save(taskId: string) {
    if (this.saveError) throw this.saveError;
    this.savedTaskIds.push(taskId);
    return { savedPath: `C:/p/IMG_0001.cutout.png`, targetName: 'IMG_0001.cutout.png', renamed: false, tagsWritten: [] };
  }

  async previewStats() {
    return { entries: 2, totalBytes: 3000 };
  }

  subscribe(listener: (e: AiEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  fire(event: AiEvent): void {
    for (const l of Array.from(this.listeners)) l(event);
  }

  usableCatalog() {
    return usableCapabilities();
  }

  async defaultModelFor(capabilityId: string): Promise<string> {
    return this.defaults.get(capabilityId) ?? 'u2netp';
  }

  async setDefaultModel(capabilityId: string, modelId: string): Promise<void> {
    this.defaults.set(capabilityId, modelId);
  }

  findModelSpec(modelId: string) {
    for (const cap of usableCapabilities()) {
      const m = cap.models.find((x) => x.id === modelId);
      if (!m) continue;
      const spec: ModelDownloadSpec = {
        id: m.id,
        downloadUrl: m.downloadUrl,
        fileName: m.fileName,
        sizeBytes: m.sizeBytes,
        sha256: m.sha256
      };
      return { capabilityId: cap.id, spec };
    }
    return null;
  }
}

class FakeStore implements AiStoreView {
  removed: string[] = [];
  downloaded: string[] = [];
  async status(): Promise<'present'> {
    return 'present';
  }
  async download(spec: ModelDownloadSpec) {
    this.downloaded.push(spec.id);
    return { path: `C:/userData/models/${spec.id}/${spec.fileName}` };
  }
  async remove(modelId: string) {
    this.removed.push(modelId);
  }
  async installedModels() {
    return { u2netp: { sha256: 's', sizeBytes: 4574861, path: 'C:/m/u2netp.onnx', installedAt: 'now' } };
  }
}

class FakeRunner implements AiRunnerView {
  unloaded = 0;
  loadedModelId: string | null = 'u2netp';
  async unload(): Promise<void> {
    this.unloaded += 1;
    this.loadedModelId = null;
  }
}

let service: FakeAiService;
let store: FakeStore;
let runner: FakeRunner;

function fakeDeps(): IpcDeps {
  service = new FakeAiService();
  store = new FakeStore();
  runner = new FakeRunner();
  return {
    scan: {} as never,
    xmp: {} as never,
    thumb: {} as never,
    folders: {} as never,
    roots: {} as never,
    updater: {} as never,
    getWindow: () => ({ webContents: { send: sendMock }, isDestroyed: () => false }) as never,
    ai: {
      service,
      store,
      runner,
      freeDiskBytes: async () => 123456,
      gpuStats: async () => ({ usedMiB: 1178, totalMiB: 8151, scope: 'whole-gpu' as const }),
      retention: { retentionDays: 30, maxBytes: 1024 * 1024 * 1024 }
    }
  };
}

beforeEach(() => {
  handlers.clear();
  sent.length = 0;
  sendMock.mockClear();
  registerIpc(fakeDeps());
});

async function invoke(channel: string, ...args: unknown[]): Promise<Record<string, unknown>> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`通道未注册：${channel}`);
  return (await fn(null, ...args)) as Record<string, unknown>;
}

describe('ai IPC 契约 —— 三处一次改齐', () => {
  it('9 个 invoke 通道全部注册，命名符合 域:动作', () => {
    for (const [channel] of AI_INVOKE) {
      expect(handlers.has(channel), `未注册 ${channel}`).toBe(true);
    }
  });

  it('preload 白名单与 ipc 注册表互相对得上（少一边就红）', () => {
    for (const [channel] of AI_INVOKE) {
      expect(preloadSrc, `preload 少了 ${channel}`).toContain(`'${channel}'`);
    }
    const inPreload = [...preloadSrc.matchAll(/'(ai:[a-z-]+)'/g)].map((m) => m[1]);
    const events = new Set<string>(AI_EVENTS.map((e) => e[0]));
    for (const ch of inPreload) {
      expect(handlers.has(ch) || events.has(ch), `preload 引用了不存在的通道 ${ch}`).toBe(true);
    }
    for (const [channel] of AI_INVOKE) {
      expect(ipcSrc, `ipc.ts 少了 ${channel}`).toContain(`'${channel}'`);
    }
  });

  it('shared/types.ts 的 PhotoTagApi 声明了全部 ai 方法与事件订阅', () => {
    for (const [, method] of [...AI_INVOKE, ...AI_EVENTS]) {
      expect(typesSrc, `PhotoTagApi 少了 ${method}`).toContain(`${method}(`);
    }
  });

  it('D18 作废的通道不许复活（按注册用的字面量与 API 方法名判，说明性注释不算）', () => {
    for (const banned of ['ai:discard', 'ai:pending-review']) {
      // 重新注册必然写成带引号的通道字面量，所以只禁这个形态
      expect(ipcSrc, `ipc.ts 不该注册 ${banned}`).not.toContain(`'${banned}'`);
      expect(preloadSrc, `preload.ts 不该引用 ${banned}`).not.toContain(`'${banned}'`);
      expect(handlers.has(banned)).toBe(false);
    }
    // 渲染层入口也不许出现对应方法名
    for (const method of ['aiDiscard', 'aiPendingReview']) {
      expect(typesSrc, `PhotoTagApi 不该有 ${method}`).not.toContain(`${method}(`);
    }
  });

  it('M4 之前不注册批量通道', () => {
    expect(handlers.has('ai:run-batch')).toBe(false);
    expect(ipcSrc).not.toContain("'ai:run-batch'");
  });

  it('shared/types.ts 不 import electron（跨进程类型要能被子进程与渲染层共用）', () => {
    expect(typesSrc).not.toMatch(/from ['"]electron['"]/);
    expect(typesSrc).not.toMatch(/require\(['"]electron['"]\)/);
  });

  it('行为标签一律取自清单：ai 相关三处源码都不得硬编码它', () => {
    for (const [name, src] of [
      ['ipc.ts', ipcSrc],
      ['preload.ts', preloadSrc],
      ['types.ts', typesSrc]
    ] as const) {
      expect(src, `${name} 不该写死行为标签`).not.toContain('AI人像抠图');
    }
  });

  it('渲染层 api.ts 的白名单与 PhotoTagApi 同步（第四处最容易漏）', () => {
    const apiSrc = readFileSync(join(root, 'src', 'api.ts'), 'utf8');
    // src/api.ts 只做类型转发时不该出现散装 ai: 通道字面量
    const rawChannels = [...apiSrc.matchAll(/'ai:[a-z-]+'/g)].map((m) => m[0]);
    expect(rawChannels).toEqual([]);
  });
});

describe('ai IPC handler —— IpcResult 信封与转发', () => {
  it('ai:catalog 一次给全：清单 + 本机状态，且只含实测跑通的条目', async () => {
    const res = await invoke('ai:catalog');
    expect(res.ok).toBe(true);
    const data = res.data as {
      capabilities: Array<{
        id: string;
        actionTag: string;
        defaultModelId: string;
        models: Array<{ verified: boolean; status: string; loaded: boolean; isDefault: boolean; inputWidth: number; inputHeight: number }>;
      }>;
    };
    expect(data.capabilities.map((c) => c.id)).toEqual(['portrait-cutout']);
    const cap = data.capabilities[0];
    expect(cap.actionTag).toBe('AI人像抠图'); // 来自清单，不是这里写死的
    expect(cap.models.every((m) => m.verified)).toBe(true);
    expect(cap.models[0].status).toBe('present');
    expect(cap.models[0].loaded).toBe(true);
    expect(cap.models[0].isDefault).toBe(true);
    expect(cap.models[0].inputWidth).toBeGreaterThan(0);
  });

  it('ai:run 立刻回 taskId，不等服务结束（一次点击内部走完三段）', async () => {
    const res = await invoke('ai:run', { absPath: 'C:/p/a.jpg', capabilityId: 'portrait-cutout' });
    expect(res).toMatchObject({ ok: true, data: { taskId: 'ai-1' } });
    expect(service.requests.length).toBe(1);
  });

  it('service 发出的事件被原样转发成 ai:progress / ai:done / ai:error', async () => {
    await invoke('ai:run', { absPath: 'C:/p/a.jpg', capabilityId: 'portrait-cutout' });
    service.fire({ type: 'progress', payload: { taskId: 'ai-1', phase: 'download', percent: 40 } });
    service.fire({ type: 'error', payload: { taskId: 'ai-1', code: 'INFERENCE_FAILED', message: '子进程已退出' } });
    expect(sent.map((s) => s.channel)).toEqual(['ai:progress', 'ai:error']);
    expect(sent[0].payload).toMatchObject({ phase: 'download', percent: 40 });
    expect(sent[1].payload).toMatchObject({ code: 'INFERENCE_FAILED' });
  });

  it('窗口已销毁时不发送事件，也不抛', async () => {
    handlers.clear();
    const deps = fakeDeps();
    deps.getWindow = () => null;
    registerIpc(deps);
    await invoke('ai:run', { absPath: 'C:/p/a.jpg', capabilityId: 'portrait-cutout' });
    service.fire({ type: 'progress', payload: { taskId: 'ai-1', phase: 'load' } });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('handler 内部抛错一律变成 ok:false 的信封，不裸抛', async () => {
    const res = await invoke('ai:model-download', 'ghost-model');
    expect(res.ok).toBe(false);
    expect((res.error as { message: string }).message).toContain('ghost-model');
    expect(store.downloaded).toEqual([]);
  });

  it('模型管理四个通道都落到真实动作上', async () => {
    expect(await invoke('ai:model-download', 'u2netp')).toMatchObject({ ok: true });
    expect(store.downloaded).toEqual(['u2netp']);

    const unload = await invoke('ai:model-unload', 'u2netp');
    expect(unload).toMatchObject({ ok: true, data: { unloaded: true } });
    // 第二次已经没有可卸载的了，要给原因而不是静默
    const again = await invoke('ai:model-unload', 'u2netp');
    expect((again.data as { reason?: string }).reason).toContain('无需卸载');

    const del = await invoke('ai:model-delete', 'u2netp');
    expect(del).toMatchObject({ ok: true });
    expect(store.removed).toEqual(['u2netp']);

    const setDef = await invoke('ai:model-set-default', 'portrait-cutout', 'u2netp');
    expect(setDef.ok).toBe(true);
    expect((setDef.data as { capabilities: Array<{ defaultModelId: string }> }).capabilities[0].defaultModelId).toBe('u2netp');
  });

  it('ai:storage-stats 汇总暂存条目、模型占用、可用磁盘与保留配置', async () => {
    const res = await invoke('ai:storage-stats');
    const data = res.data as {
      preview: { entries: number; totalBytes: number };
      models: Array<{ id: string; sizeBytes: number }>;
      loadedModelId: string | null;
      freeDiskBytes: number | null;
      gpu: unknown;
      retention: { retentionDays: number; maxBytes: number };
    };
    expect(data.preview).toEqual({ entries: 2, totalBytes: 3000 });
    expect(data.models).toEqual([{ id: 'u2netp', sizeBytes: 4574861, status: 'present' }]);
    expect(data.loadedModelId).toBe('u2netp');
    expect(data.freeDiskBytes).toBe(123456);
    // 显存必须是整卡口径的对象，不能是 undefined
    expect(data.gpu).toEqual({ usedMiB: 1178, totalMiB: 8151, scope: 'whole-gpu' });
    expect(data.retention).toEqual({ retentionDays: 30, maxBytes: 1024 * 1024 * 1024 });
  });

  it('可用磁盘读不到时回 null，界面显示"未知"而不是 0', async () => {
    handlers.clear();
    const deps = fakeDeps();
    deps.ai!.freeDiskBytes = async () => null;
    deps.ai!.gpuStats = async () => null;
    registerIpc(deps);
    const res = await invoke('ai:storage-stats');
    expect((res.data as { freeDiskBytes: unknown; gpu: unknown }).freeDiskBytes).toBeNull();
    expect((res.data as { gpu: unknown }).gpu).toBeNull();
  });

  it('保存失败也走信封并保留错误码', async () => {
    service.saveError = Object.assign(new Error('保存到照片目录失败：结果仍保留在预览暂存中'), { code: 'SAVE_FAILED' });
    const res = await invoke('ai:save', 'ai-1');
    expect(res.ok).toBe(false);
    expect((res.error as { message: string }).message).toContain('预览暂存');
  });
});
