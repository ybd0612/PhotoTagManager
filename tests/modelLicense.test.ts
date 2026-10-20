// 模型能力退出运行时后，历史许可材料仍需留档且不得误入当前产品声明或安装包。
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const read = (file: string): string => readFileSync(file, 'utf8');

describe('历史模型许可档案与当前发行声明', () => {
  it('保留曾评估模型的完整 Apache-2.0 许可正文作为审计资料', () => {
    for (const file of [
      'LICENSES/third-party/u2netp.apache-2.0.txt',
      'LICENSES/third-party/modnet.apache-2.0.txt',
      'LICENSES/third-party/apache-2.0.txt'
    ]) {
      expect(existsSync(file), `${file} 应作为历史审计资料留存`).toBe(true);
      expect(read(file)).toContain('Apache License');
      expect(read(file).length).toBeGreaterThan(1000);
    }
    const archiveNote = read('LICENSES/third-party/README.md');
    expect(archiveNote).toContain('历史审计资料');
    expect(archiveNote).toContain('当前产品不提供模型推理');
  });

  it('当前 NOTICE 不再宣称模型推理、下载或 ONNX 运行时', () => {
    const notice = read('NOTICE');
    expect(notice).toContain('scripts/gen-notice.cjs');
    expect(notice).toContain('当前版本不提供模型推理');
    expect(notice).not.toContain('onnxruntime-node');
    expect(notice).not.toContain('U²-Netp');
    expect(notice).not.toContain('MODNet');
    expect(notice).not.toContain('capabilityCatalog.ts');
  });

  it('项目 MIT 许可与发行包白名单保持一致', () => {
    const license = read('LICENSE');
    expect(license).toContain('MIT License');
    expect(license).toContain('Copyright (c) 2026 Ybond');
    expect(license).toContain('Permission is hereby granted, free of charge');
    expect(license).toContain('and/or sell copies of the Software');
    expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    expect(license).not.toContain('<year>');
    expect(license).not.toContain('<copyright holders>');

    const pkg = JSON.parse(read('package.json'));
    expect(pkg.license).toBe('MIT');
    expect(pkg.author).toBe('Ybond');
    expect(pkg.build.files).toContain('LICENSE');
    expect(pkg.build.files).toContain('NOTICE');
    expect(pkg.build.files).not.toContain('LICENSES/**');
    expect(pkg.build.files).not.toContain('LICENSES/third-party/README.md');

    const surfaces: Record<string, string> = {
      'README.md': read('README.md'),
      NOTICE: read('NOTICE'),
      '设置·关于与更新': read(join('src', 'components', 'settings', 'AboutUpdatePane.tsx'))
    };
    const banned = ['严禁用于商业用途', '24 小时之内删除', '仅供学习交流使用', '源码公开非商业使用许可'];
    for (const [name, text] of Object.entries(surfaces)) {
      for (const phrase of banned) {
        expect(text, `${name} 里还留着与 MIT 冲突的「${phrase}」`).not.toContain(phrase);
      }
    }
  });
});
