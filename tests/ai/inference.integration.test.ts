// T7 · 推理子进程与主进程管家。
// 分两层：协议/生命周期用假件验（不需要原生），真 DirectML 会话用 u2netp 夹具验。
// 夹具缺失时自动 skip 并打印获取命令——集成测试不该在没模型时才红。
import { describe, it, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';

import {
  buildSessionOptions,
  createMessageHandler,
  ChildInference,
  DEFAULT_INTRA_OP_THREADS,
  DEFAULT_LOAD_TIMEOUT_MS,
  loadTimeoutMsFor,
  type ChildReply,
  type ChildRequest
} from '../../electron/ai/inferenceChild';
import {
  ChildRunner,
  ChildNotRespondingError,
  makeUtilityProcessSpawner,
  type SpawnedChild,
  type ChildListener,
  type UtilityProcessLike
} from '../../electron/ai/runner';
import { getModel } from '../../electron/ai/capabilityCatalog';

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'models', 'u2netp.onnx');
const FIXTURE_NOTE =
  `缺少模型夹具 tests/fixtures/models/u2netp.onnx，跳过原生推理用例。\n` +
  `  获取：cp "C:/Users/ybd06/temp/ptm-ortweb-probe/models/u2netp.onnx" tests/fixtures/models/u2netp.onnx`;

// ── 一、会话参数：D12 的硬检查项 ───────────────────────────────────────────
describe('ai/inferenceChild —— 会话参数必须显式限线程（D12）', () => {
  it('dml 与 cpu 两条路都必须带显式的 intraOpNumThreads / interOpNumThreads', () => {
    for (const backend of ['dml', 'cpu'] as const) {
      const opts = buildSessionOptions(backend);
      expect(typeof opts.intraOpNumThreads).toBe('number');
      expect(typeof opts.interOpNumThreads).toBe('number');
      expect(opts.intraOpNumThreads).toBeGreaterThan(0);
      // 探针那次不限线程吃满 32 核把机器压到无响应，默认值必须是小常数
      expect(opts.intraOpNumThreads).toBeLessThanOrEqual(4);
      expect(opts.interOpNumThreads).toBeGreaterThan(0);
    }
  });

  it('默认线程数是 2 / 1，且调用方可以显式覆盖', () => {
    expect(DEFAULT_INTRA_OP_THREADS).toBe(2);
    expect(buildSessionOptions('dml').intraOpNumThreads).toBe(2);
    expect(buildSessionOptions('cpu', { intraOpNumThreads: 4, interOpNumThreads: 2 })).toMatchObject({
      intraOpNumThreads: 4,
      interOpNumThreads: 2
    });
  });

  it('dml 优先、cpu 兜底；cpu 后端不再挂 dml', () => {
    expect(buildSessionOptions('dml').executionProviders[0]).toBe('dml');
    expect(buildSessionOptions('cpu').executionProviders).toEqual(['cpu']);
  });

  it('D7 ③ 防线：通用代码路径里不得出现模型专有形状或张量名', () => {
    for (const file of ['electron/ai/runner.ts', 'electron/ai/inferenceChild.ts']) {
      const src = readFileSync(join(process.cwd(), file), 'utf8');
      for (const forbidden of ['320', 'input.1', 'u2netp', '1959']) {
        expect(src, `${file} 不应写死 ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  /**
   * 加载超时必须跟着体积走。实测 200MB 级模型光读元数据 CPU 侧就要 17.1s，
   * 固定 30s 会把「模型大一点」误报成「加载超时」——用户看到的是超时而不是真实原因。
   */
  describe('loadTimeoutMsFor —— 超时按体积算', () => {
    const MB = 1024 * 1024;

    it('体积读不到时退回兜底值，不返回 NaN 或 0', () => {
      expect(loadTimeoutMsFor(undefined)).toBe(DEFAULT_LOAD_TIMEOUT_MS);
      expect(loadTimeoutMsFor(0)).toBe(DEFAULT_LOAD_TIMEOUT_MS);
      expect(loadTimeoutMsFor(Number.NaN)).toBe(DEFAULT_LOAD_TIMEOUT_MS);
      expect(loadTimeoutMsFor(-1)).toBe(DEFAULT_LOAD_TIMEOUT_MS);
    });

    it('小模型不被无谓地等（几 MB 就给到下限附近）', () => {
      // 4.4MB 向上取整成 5s 斜率 + 30s 固定开销 = 35s，仍在「感觉不到等待」的量级
      expect(loadTimeoutMsFor(4.4 * MB)).toBe(35_000);
      expect(loadTimeoutMsFor(4.4 * MB)).toBeLessThan(60_000);
    });

    it('模型越大超时越长，且严格递增（这是改动的核心）', () => {
      const small = loadTimeoutMsFor(20 * MB);
      const mid = loadTimeoutMsFor(100 * MB);
      const large = loadTimeoutMsFor(300 * MB);
      expect(small).toBeGreaterThan(DEFAULT_LOAD_TIMEOUT_MS);
      expect(mid).toBeGreaterThan(small);
      expect(large).toBeGreaterThan(mid);
    });

    it('214MB 级模型给到数分钟量级，够装下实测的 17.1s 元数据读取还有余量', () => {
      expect(loadTimeoutMsFor(214 * MB)).toBe(244_000);
    });

    it('曲线在上限前仍有区分度（斜率不能太陡，否则分级等于没做）', () => {
      // 40MB 与 100MB 必须给出不同的值，否则「按体积分级」这个目的没达成
      expect(loadTimeoutMsFor(40 * MB)).not.toBe(loadTimeoutMsFor(100 * MB));
      expect(loadTimeoutMsFor(100 * MB)).toBeLessThan(480_000);
    });

    it('再大的模型也不无限等：封顶 8 分钟（超过就不是「模型大」而是卡死）', () => {
      expect(loadTimeoutMsFor(10_000 * MB)).toBe(480_000);
      expect(loadTimeoutMsFor(100_000 * MB)).toBe(480_000);
    });

    it('全是整数毫秒（setTimeout 传小数会被截断成偏小的值）', () => {
      for (const bytes of [1, 4.4 * MB, 33.3 * MB, 214 * MB, 999 * MB]) {
        expect(Number.isInteger(loadTimeoutMsFor(bytes))).toBe(true);
      }
    });
  });
});

// ── 二、协议层：错误必须变成可读答复 ──────────────────────────────────────
function fakeInference(behavior: Partial<{ load: Error; infer: Error }> = {}) {
  const calls: string[] = [];
  const child = {
    get currentModelId() {
      return calls.includes('load') ? 'm1' : null;
    },
    async load(req: { model: { id: string } }) {
      calls.push('load');
      if (behavior.load) throw behavior.load;
      return { modelId: req.model.id, loadMs: 1, outputNames: ['out'] };
    },
    async infer() {
      calls.push('infer');
      if (behavior.infer) throw behavior.infer;
      return { data: new Float32Array(4), dims: [1, 1, 2, 2], outputName: 'out', inferMs: 1 };
    },
    async unload() {
      calls.push('unload');
    }
  };
  return { child: child as unknown as ChildInference, calls };
}

describe('ai/inferenceChild —— 消息协议', () => {
  test('原生层报错（如实测的 DmlFusedNode）要变成 ok:false 的可读答复，而不是把进程带崩', async () => {
    const boom = new Error('Non-zero status code returned while running DmlFusedNode_19_64');
    const { child } = fakeInference({ infer: boom });
    const reply = (await createMessageHandler(child)({
      id: 7,
      type: 'infer',
      payload: { modelId: 'm1', dims: [1, 3, 2, 2], data: new Float32Array(12) }
    })) as ChildReply;
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.message).toContain('DmlFusedNode');
    expect(reply.id).toBe(7);
  });

  test('未知请求类型也被捕获成错误答复', async () => {
    const { child } = fakeInference();
    const reply = (await createMessageHandler(child)({ id: 1, type: 'bogus' } as unknown as ChildRequest)) as ChildReply;
    expect(reply.ok).toBe(false);
  });

  test('load / infer / unload 都正常回话', async () => {
    const { child, calls } = fakeInference();
    const handle = createMessageHandler(child);
    const model = getModel('portrait-cutout', 'u2netp')!;
    expect((await handle({ id: 1, type: 'load', payload: { modelPath: 'p', model } })).ok).toBe(true);
    expect((await handle({ id: 2, type: 'infer', payload: { modelId: 'u2netp', dims: [1, 3, 2, 2], data: new Float32Array(12) } })).ok).toBe(true);
    expect((await handle({ id: 3, type: 'unload' })).ok).toBe(true);
    expect(calls).toEqual(['load', 'infer', 'unload']);
  });
});

// ── 三、ChildRunner：崩溃与超时的恢复语义 ─────────────────────────────────
class FakeChild implements SpawnedChild {
  sent: ChildRequest[] = [];
  killed = 0;
  autoReply = true;
  private listener: ChildListener | null = null;
  onMessage(listener: ChildListener): void {
    this.listener = listener;
  }
  postMessage(msg: ChildRequest): void {
    this.sent.push(msg);
    if (!this.autoReply) return;
    queueMicrotask(() => {
      if (msg.type === 'load') this.reply({ id: msg.id, ok: true, data: { loadMs: 3 } });
      else if (msg.type === 'infer')
        this.reply({
          id: msg.id,
          ok: true,
          data: { data: new Float32Array(4), dims: [1, 1, 2, 2], outputName: 'out', inferMs: 2 }
        });
      else this.reply({ id: msg.id, ok: true, data: null });
    });
  }
  reply(payload: ChildReply): void {
    this.listener?.({ type: 'message', payload });
  }
  crash(code: number | null = 1): void {
    this.listener?.({ type: 'exit', code });
  }
  kill(): void {
    this.killed += 1;
  }
}

function makeRunner(opts: { autoReply?: boolean; loadTimeoutMs?: number } = {}) {
  const spawned: FakeChild[] = [];
  const runner = new ChildRunner({
    spawn: () => {
      const child = new FakeChild();
      child.autoReply = opts.autoReply ?? true;
      spawned.push(child);
      return child;
    },
    entry: 'aiChild.js',
    loadTimeoutMs: opts.loadTimeoutMs ?? 40
  });
  return { runner, spawned };
}

const modelSpec = () => getModel('portrait-cutout', 'u2netp')!;

describe('ai/runner —— 子进程生死与重启（D9）', () => {
  test('正常一次：load 后 infer 拿到掩码数据', async () => {
    const { runner, spawned } = makeRunner();
    await runner.load({ modelPath: 'p', model: modelSpec() });
    const out = await runner.infer({ modelId: 'u2netp', dims: [1, 3, 2, 2], data: new Float32Array(12) });
    expect(out.data).toBeInstanceOf(Float32Array);
    expect(out.data.length).toBe(4);
    expect(spawned.length).toBe(1);
    await runner.dispose();
  });

  test('子进程 exit：当次任务以可读错误失败，下一次请求自动拉起新进程', async () => {
    const { runner, spawned } = makeRunner();
    await runner.load({ modelPath: 'p', model: modelSpec() });
    const pending = runner.infer({ modelId: 'u2netp', dims: [1, 3, 2, 2], data: new Float32Array(12) });
    spawned[0].crash(139);
    await expect(pending).rejects.toThrow(/子进程已退出/);
    expect(runner.loadedModelId).toBeNull();
    expect(runner.restartCount).toBe(1);

    // 调用方没死：重新加载后再推理应成功
    await runner.load({ modelPath: 'p', model: modelSpec() });
    const out = await runner.infer({ modelId: 'u2netp', dims: [1, 3, 2, 2], data: new Float32Array(12) });
    expect(out.data.length).toBe(4);
    expect(spawned.length).toBe(2);
    await runner.dispose();
  });

  test('子进程无响应：会话创建有硬超时，不允许无限等待（探针的 WebGPU 死锁就是这么发现的）', async () => {
    const { runner, spawned } = makeRunner({ autoReply: false, loadTimeoutMs: 40 });
    const startedAt = Date.now();
    await expect(runner.load({ modelPath: 'p', model: modelSpec() })).rejects.toBeInstanceOf(ChildNotRespondingError);
    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect(spawned[0].killed).toBe(1);
    await runner.dispose();
  });

  test('超时后服务仍可用：下一次请求会拉起新子进程', async () => {
    let firstSilent = true;
    const spawned: FakeChild[] = [];
    const runner = new ChildRunner({
      spawn: () => {
        const child = new FakeChild();
        child.autoReply = !firstSilent;
        spawned.push(child);
        return child;
      },
      entry: 'aiChild.js',
      loadTimeoutMs: 40
    });
    await expect(runner.load({ modelPath: 'p', model: modelSpec() })).rejects.toThrow(/超时/);
    firstSilent = false;
    await runner.load({ modelPath: 'p', model: modelSpec() });
    expect(spawned.length).toBe(2);
    await runner.dispose();
  });

  test('回收旧子进程后，它迟到的 exit 事件不得打死新子进程在途的请求', async () => {
    // 真机崩溃探针实测到的竞态：超时 → runner 回收 child#1 → 立刻拉起 child#2 发请求 →
    // child#1 的 exit(code=0) 这时才到，把它自己的退出误算到 child#2 的在途请求上。
    let firstSilent = true;
    const spawned: FakeChild[] = [];
    const runner = new ChildRunner({
      spawn: () => {
        const child = new FakeChild();
        child.autoReply = !firstSilent;
        spawned.push(child);
        return child;
      },
      entry: 'aiChild.js',
      loadTimeoutMs: 40
    });
    await expect(runner.load({ modelPath: 'p', model: modelSpec() })).rejects.toThrow(/超时/);
    firstSilent = false;

    const pending = runner.load({ modelPath: 'p', model: modelSpec() });
    await new Promise((r) => setTimeout(r, 5));
    spawned[0].crash(0);

    expect(typeof (await pending)).toBe('number');
    expect(runner.loadedModelId).toBe('u2netp');
    expect(runner.restartCount).toBe(1);
    await runner.dispose();
  });

  test('子进程回 ok:false 时错误原文透传给调用方', async () => {
    const { runner, spawned } = makeRunner({ autoReply: false });
    const pending = runner.load({ modelPath: 'p', model: modelSpec() });
    spawned[0].reply({ id: 1, ok: false, message: '显存不足，请先卸载 XX' });
    await expect(pending).rejects.toThrow('显存不足，请先卸载 XX');
    await runner.dispose();
  });

  test('dispose 会杀掉子进程，未完成的请求可读失败', async () => {
    const { runner, spawned } = makeRunner({ autoReply: false });
    const pending = runner.load({ modelPath: 'p', model: modelSpec() });
    await runner.dispose();
    await expect(pending).rejects.toThrow(/已关闭/);
    expect(spawned[0].killed).toBe(1);
  });
});

// ── 三点五、适配器必须跟 Electron 的载荷形状对齐 ─────────────────────────
describe('ai/runner —— utilityProcess 适配器载荷形状（真机探针实测到的 bug）', () => {
  it('Electron 父进程把消息本体直接交给监听器（不套 data 信封），在途请求必须能结算', async () => {
    // 真机表现：所有 load / infer 都只能等到超时。原因就在适配器按 MessagePort 的
    // 惯例读 message.data —— Electron 的 utilityProcess 'message' 给的是消息本体，
    // 于是 reply.id 是 undefined，pending 永不命中。node 假件讲的是内部 ChildEvent
    // 形状，所以两百多个用例全绿也照不出来。
    const replyListeners: Array<(payload: unknown) => void> = [];
    const exitListeners: Array<(code: number | null) => void> = [];
    const fakeUtilityProcess = {
      fork: () => ({
        pid: 4242,
        postMessage: (msg: { id: number }) => {
          // 模拟 Electron：答复原样交给监听器，没有 { data: ... } 这一层
          setTimeout(() => replyListeners.forEach((l) => l({ id: msg.id, ok: true, data: { loadMs: 7, outputNames: ['x'] } })), 0);
        },
        kill: () => {},
        on: (event: string, cb: (arg: never) => void) => {
          if (event === 'message') replyListeners.push(cb as (payload: unknown) => void);
          if (event === 'exit') exitListeners.push(cb as unknown as (code: number | null) => void);
        }
      })
    };
    const runner = new ChildRunner({
      spawn: makeUtilityProcessSpawner(fakeUtilityProcess as unknown as UtilityProcessLike),
      entry: 'aiChild.js',
      loadTimeoutMs: 500
    });
    await expect(runner.load({ modelPath: 'p', model: modelSpec() })).resolves.toBe(7);
    await runner.dispose();
  });
});

// ── 四、真 DirectML 集成（夹具缺失则 skip）───────────────────────────────
const haveFixture = existsSync(FIXTURE);
describe.skipIf(!haveFixture)('ai/inferenceChild —— 真 DirectML 推理（集成）', () => {
  it('夹具指纹必须与能力清单一致', () => {
    const buf = readFileSync(FIXTURE);
    const model = getModel('portrait-cutout', 'u2netp')!;
    expect(buf.length).toBe(model.sizeBytes);
    expect(createHash('sha256').update(buf).digest('hex')).toBe(model.sha256);
  });

  it('用清单给的形状建 dml 会话并跑一次，返回掩码平面', async () => {
    const ort = await import('onnxruntime-node');
    const model = getModel('portrait-cutout', 'u2netp')!;
    const child = new ChildInference({ ort });
    const dims = model.inputDims.map((n) => n);
    const loaded = await child.load({ modelPath: FIXTURE, model, backend: 'dml' });
    expect(loaded.modelId).toBe(model.id);
    expect(loaded.outputNames.length).toBeGreaterThan(0);

    const out = await child.infer({
      modelId: model.id,
      dims,
      data: new Float32Array(dims.reduce((a, b) => a * b, 1))
    });
    expect(out.data).toBeInstanceOf(Float32Array);
    expect(out.data.length).toBe(dims[2] * dims[3]);
    expect(out.dims.slice(1)).toEqual([1, dims[2], dims[3]]);
    expect(out.outputName).toBe(loaded.outputNames[model.outputNameIndex]);
    console.info(
      `[integration] DirectML 加载 ${loaded.loadMs}ms、推理 ${out.inferMs}ms、输出 ${out.dims.join('x')} 名 ${out.outputName}`
    );
    await child.dispose();
  }, 120_000);

  it('cpu 后端也跑得通，且同样带线程上限（供无 GPU 环境的显式慢速模式）', async () => {
    const ort = await import('onnxruntime-node');
    const model = getModel('portrait-cutout', 'u2netp')!;
    const child = new ChildInference({ ort });
    const dims = model.inputDims.map((n) => n);
    await child.load({ modelPath: FIXTURE, model, backend: 'cpu' });
    const out = await child.infer({
      modelId: model.id,
      dims,
      data: new Float32Array(dims.reduce((a, b) => a * b, 1))
    });
    expect(out.data.length).toBe(dims[2] * dims[3]);
    await child.dispose();
  }, 120_000);
});

if (!haveFixture) {
  test(`夹具缺失：${FIXTURE_NOTE}`, () => {
    console.info(FIXTURE_NOTE);
  });
}
