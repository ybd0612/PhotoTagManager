// capabilityCatalog 单测：行为 → 模型 的清单是 D10 的单一事实源。
// 重点是两条防线：① 全仓不得硬编码行为标签字符串；② 只有实测跑通的条目才允许进 UI。
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

import {
  capabilities,
  getCapability,
  getModel,
  isCapabilityRenderable,
  usableCapabilities
} from '../../electron/ai/capabilityCatalog';
import { ALLOWED_SOURCE_HOSTS, sourceTargets } from '../../electron/ai/modelSources';

/** 2026-09-23 实测的 u2netp 事实，清单必须与之一字不差 */
const U2NETP_SHA256 = '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8';
const U2NETP_SIZE = 4_574_861;
const U2NETP_URL = 'https://hf-mirror.com/BritishWerewolf/U-2-Netp/resolve/main/onnx/model.onnx';

/** 递归列出目录下所有源码文件 */
function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSources(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('ai/capabilityCatalog —— 单一事实源', () => {
  it('portrait-cutout 行为带齐 D6/D10 要求的落盘字段', () => {
    const cap = getCapability('portrait-cutout');
    expect(cap).toBeDefined();
    expect(cap?.actionTag).toBe('AI人像抠图');
    expect(cap?.outputExt).toBe('.png');
    expect(cap?.outputSuffix).toBe('cutout');
    // 主按钮文案与面向用户的说法，都必须是清单数据而不是组件里的字面量
    expect(cap?.label).toBeTruthy();
    expect(cap?.description).toBeTruthy();
    // D7 ②：加行为 = 加清单条目 + 一个后处理函数，靠 id 关联
    expect(cap?.postprocessId).toBeTruthy();
  });

  it('u2netp 条目带真实的下载源 / 体积 / sha256 / 张量规格，且标记为已实测', () => {
    const model = getModel('portrait-cutout', 'u2netp');
    // 换成仓库坐标后，实际地址必须仍然等于当初那个 hf-mirror URL（改结构不许改语义）
    expect(model?.repoId).toBe('BritishWerewolf/U-2-Netp');
    expect(model?.filePath).toBe('onnx/model.onnx');
    expect(
      sourceTargets({ repoId: model?.repoId ?? '', filePath: model?.filePath ?? '' }).map((s) => s.url)
    ).toContain(U2NETP_URL);
    expect(model?.sizeBytes).toBe(U2NETP_SIZE);
    expect(model?.sha256).toBe(U2NETP_SHA256);
    expect(model?.inputName).toBe('input.1');
    expect(model?.inputDims).toEqual([1, 3, 320, 320]);
    expect(model?.verified).toBe(true);
  });

  it('归一化参数是清单数据（ImageNet mean/std + 1/255），不进通用代码路径', () => {
    const model = getModel('portrait-cutout', 'u2netp');
    expect(model?.normalize).toEqual({
      rescale: 1 / 255,
      mean: [0.485, 0.456, 0.406],
      std: [0.229, 0.224, 0.225]
    });
  });

  it('输出张量选择方式也是数据：u2netp 有 7 个输出，取首输出', () => {
    const model = getModel('portrait-cutout', 'u2netp');
    expect(model?.outputNameIndex).toBe(0);
  });

  /** 2026-09-29 本机实测的 MODNet 事实：真图跑通 + 双源 sha256 逐字节一致 */
  const MODNET_SHA256 = '07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9';
  const MODNET_SIZE = 25_888_640;

  it('modnet 条目带实测的下载源 / 体积 / sha256 / 张量规格', () => {
    const model = getModel('portrait-cutout', 'modnet');
    expect(model?.repoId).toBe('Xenova/modnet');
    expect(model?.filePath).toBe('onnx/model.onnx');
    expect(model?.sizeBytes).toBe(MODNET_SIZE);
    expect(model?.sha256).toBe(MODNET_SHA256);
    expect(model?.inputName).toBe('input');
    expect(model?.inputDims).toEqual([1, 3, 512, 512]);
    expect(model?.outputNameIndex).toBe(0);
    expect(model?.verified).toBe(true);
  });

  it('modnet 的归一化是 [-1,1]（mean/std 各 0.5），不得被误抄成 u2netp 的 ImageNet 参数', () => {
    const model = getModel('portrait-cutout', 'modnet');
    expect(model?.normalize).toEqual({ rescale: 1 / 255, mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5] });
    expect(model?.normalize).not.toEqual(getModel('portrait-cutout', 'u2netp')?.normalize);
  });

  it('modnet 两个下载源都在（u2netp 只有单源，这条是当初不替换 hf-mirror 的原因）', () => {
    const model = getModel('portrait-cutout', 'modnet');
    const targets = sourceTargets({ repoId: model?.repoId ?? '', filePath: model?.filePath ?? '' });
    expect(targets.map((s) => s.source)).toEqual(['modelscope', 'hf-mirror']);
    expect(targets.map((s) => s.url)).toEqual([
      'https://modelscope.cn/models/Xenova/modnet/resolve/master/onnx/model.onnx',
      'https://hf-mirror.com/Xenova/modnet/resolve/main/onnx/model.onnx'
    ]);
  });

  it('展开出来的每个下载地址都只能落在白名单域名内（huggingface.co 直连超时）', () => {
    const offenders: string[] = [];
    for (const cap of capabilities) {
      for (const m of cap.models) {
        for (const s of sourceTargets(m)) {
          const host = new URL(s.url).hostname;
          if (!ALLOWED_SOURCE_HOSTS.some((a) => host === a || host.endsWith(`.${a}`))) {
            offenders.push(`${m.id}: ${s.source} → ${host}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('源顺序就是优先级：ModelScope 在前、hf-mirror 兜底', () => {
    const order = sourceTargets({ repoId: 'a/b', filePath: 'c.onnx' }).map((s) => s.source);
    expect(order).toEqual(['modelscope', 'hf-mirror']);
  });

  it('每个行为都指向清单内已存在的默认模型', () => {
    for (const cap of capabilities) {
      expect(cap.models.some((m) => m.id === cap.defaultModelId)).toBe(true);
      expect(cap.models.length).toBeGreaterThan(0);
    }
  });

  it('未实测跑通的条目不得出现在可渲染清单里（§4.3 硬规则）', () => {
    const base = getCapability('portrait-cutout');
    const u2netp = getModel('portrait-cutout', 'u2netp');
    expect(base && u2netp).toBeTruthy();

    // 全部模型未验证 → 整个行为不进 UI
    expect(isCapabilityRenderable({ ...base!, models: [{ ...u2netp!, verified: false }] })).toBe(false);
    // 混合 → 可渲染，但可渲染的模型只剩已验证那条
    expect(isCapabilityRenderable({ ...base!, models: [...base!.models, { ...u2netp!, id: 'other', verified: false }] })).toBe(true);
    // 一个模型都没有 → 不进 UI
    expect(isCapabilityRenderable({ ...base!, models: [] })).toBe(false);
    // 当前真实清单必须全部可渲染（M1 只带已跑通的 u2netp）
    expect(usableCapabilities().map((c) => c.id)).toEqual(capabilities.map((c) => c.id));
  });

  it('D10 防线：全仓 src/ 与 electron/ 内除清单本身外不得出现硬编码的行为标签', () => {
    const catalogFile = join('electron', 'ai', 'capabilityCatalog.ts');
    const scanned = ['src', 'electron'].flatMap(listSources);
    expect(scanned.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of scanned) {
      const rel = relative(process.cwd(), file).replace(/\\/g, '/');
      if (rel === catalogFile.replace(/\\/g, '/')) continue;
      const text = readFileSync(file, 'utf8');
      if (text.includes("'AI人像抠图'") || text.includes('"AI人像抠图"')) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
