// D12 的直接验收：CPU 后端必须被显式限核。
// 探针那次不限线程吃满 32 核把开发机压到无响应，所以这条不能只靠"代码里写了参数"，
// 要能量出实际并行度。断言用相对值（核数比），不设绝对耗时阈值。
import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { cpus } from 'os';

import { buildSessionOptions } from '../../electron/ai/inferenceChild';

const MODEL = join(process.cwd(), 'tests', 'fixtures', 'models', 'u2netp.onnx');
const ROUNDS = 12;

async function measure(intraOpNumThreads: number): Promise<{ ratio: number; wallMs: number }> {
  const ort = await import('onnxruntime-node');
  const session = await ort.InferenceSession.create(MODEL, {
    executionProviders: ['cpu'],
    intraOpNumThreads,
    interOpNumThreads: 1,
    logSeverityLevel: 3
  } as never);
  const dims = [1, 3, 320, 320];
  const tensor = new ort.Tensor('float32', new Float32Array(3 * 320 * 320), dims);
  const cpu0 = process.cpuUsage();
  const wall0 = Date.now();
  for (let i = 0; i < ROUNDS; i++) await session.run({ 'input.1': tensor });
  const wallMs = Date.now() - wall0;
  const cpu = process.cpuUsage(cpu0);
  await session.release();
  const cpuMs = (cpu.user + cpu.system) / 1000;
  return { ratio: cpuMs / wallMs, wallMs };
}

describe.skipIf(!existsSync(MODEL))('ai/runner —— CPU 后端限核实测（D12）', () => {
  it('默认参数就是 2 线程，且实测并行度不超过它加一点余量', async () => {
    const opts = buildSessionOptions('cpu');
    expect(opts.intraOpNumThreads).toBe(2);
    expect(opts.interOpNumThreads).toBe(1);

    const { ratio, wallMs } = await measure(opts.intraOpNumThreads);
    const logical = cpus().length;
    console.info(`[dml-guard] 限 2 线程：并行度≈${ratio.toFixed(2)} 核（本机 ${logical} 逻辑核），${ROUNDS} 轮耗时 ${wallMs}ms`);
    // 限核生效时并行度应贴近 2；不限核会冲到逻辑核数
    expect(ratio).toBeLessThan(4);
    expect(ratio).toBeLessThan(logical / 2);
  }, 300_000);

  it('反证：把线程数放开，同一测量会显著变大（说明这把尺子量得到东西）', async () => {
    const loose = await measure(16);
    const limited = await measure(2);
    console.info(`[dml-guard] 16 线程并行度≈${loose.ratio.toFixed(2)}，2 线程≈${limited.ratio.toFixed(2)}`);
    expect(loose.ratio).toBeGreaterThan(limited.ratio * 1.5);
  }, 300_000);
});
