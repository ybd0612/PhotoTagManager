// electron/ai/paths.ts 单测：userData 下 AI 各目录的唯一解析入口。
// 对应规格 §5.0 目录布局与三条红线（暂存与缩略图分目录、都不在任何扫描根内）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  configureAiPaths,
  resetAiPaths,
  modelsDir,
  modelDir,
  indexFile,
  previewDir,
  previewFile,
  settingsFile
} from '../../electron/ai/paths';

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('ai/paths —— userData 目录布局', () => {
  let userData = '';

  beforeEach(async () => {
    resetAiPaths();
    userData = await mkdtemp(join(tmpdir(), 'ptm-ai-paths-'));
  });

  afterEach(async () => {
    resetAiPaths();
    if (userData) await rm(userData, { recursive: true, force: true });
  });

  it('未配置 userData 时访问目录抛出可读错误，而不是拼出 undefined 路径', () => {
    expect(() => modelsDir()).toThrow(/userData/i);
    expect(() => previewDir()).toThrow(/userData/i);
  });

  it('models / ai-preview / index 落在规格 §5.0 约定的子目录', () => {
    configureAiPaths(userData);
    expect(modelsDir()).toBe(join(userData, 'models'));
    expect(previewDir()).toBe(join(userData, 'ai-preview'));
    expect(indexFile()).toBe(join(userData, 'models', 'index.json'));
    expect(settingsFile()).toBe(join(userData, 'settings.json'));
  });

  it('configure 会预建 models 与 ai-preview 两个目录', async () => {
    configureAiPaths(userData);
    expect(await pathExists(join(userData, 'models'))).toBe(true);
    expect(await pathExists(join(userData, 'ai-preview'))).toBe(true);
  });

  it('modelDir 按 modelId 分子目录，首次访问时创建', async () => {
    configureAiPaths(userData);
    const dir = modelDir('u2netp');
    expect(dir).toBe(join(userData, 'models', 'u2netp'));
    expect(existsSync(dir)).toBe(false);
    expect(await pathExists(dir)).toBe(false);
    const weightFile = join(dir, 'u2netp.onnx');
    expect(modelDir('u2netp', { create: true })).toBe(dir);
    expect(await pathExists(dir)).toBe(true);
    expect(weightFile).toContain('u2netp');
  });

  it('previewFile 把结果文件名限制在暂存目录内', () => {
    configureAiPaths(userData);
    expect(previewFile('abc.png')).toBe(join(userData, 'ai-preview', 'abc.png'));
  });

  it('红线 2：暂存目录与既有缩略图缓存目录分开放，不混用', () => {
    configureAiPaths(userData);
    expect(previewDir()).not.toBe(join(userData, 'thumbnails'));
    expect(previewDir()).not.toBe(userData);
    expect(modelsDir()).not.toBe(userData);
  });

  it('重复配置到新 userData 时以最后一次为准', async () => {
    configureAiPaths(userData);
    const other = await mkdtemp(join(tmpdir(), 'ptm-ai-paths-2-'));
    try {
      configureAiPaths(other);
      expect(modelsDir()).toBe(join(other, 'models'));
      expect(previewDir()).toBe(join(other, 'ai-preview'));
      expect(existsSync(join(other, 'ai-preview'))).toBe(true);
      expect(await pathExists(join(other, 'models'))).toBe(true);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});
