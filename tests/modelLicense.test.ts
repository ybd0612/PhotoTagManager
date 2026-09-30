// 规范 §5 第 5 项：许可与来源必须有断言守着，不能靠文档提醒。
// 判据全部设计成"能失败"：字段清空、留存文件删掉、license 标识写成白名单外、
// 改了清单没重生成 NOTICE，任意一条都会红——不是永远为真的装饰。
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { capabilities } from '../electron/ai/capabilityCatalog';

/** 与 docs/design/model-licensing-and-survey.md §3.0 白名单同口径 */
const LICENSE_WHITELIST = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC'];

/** 许可标识 → 正文里必然出现的一句话。用来抓"标识写错了但文件名没改"这类不一致 */
const LICENSE_MARKERS: Record<string, string> = {
  'Apache-2.0': 'Apache License',
  MIT: 'Permission is hereby granted, free of charge',
  'BSD-2-Clause': 'Redistributions of source code',
  'BSD-3-Clause': 'Neither the name',
  ISC: 'Permission to use'
};

const allModels = capabilities.flatMap((cap) => cap.models.map((m) => ({ cap, m })));

describe('模型许可与来源的完整性（规范 §3.0 / §3.1.1 / §5）', () => {
  it('清单里确实有条目可查（空清单会让下面所有判据空转成绿）', () => {
    expect(allModels.length).toBeGreaterThan(0);
  });

  it('每条模型的许可、归属、来源六个字段都非空', () => {
    for (const { m } of allModels) {
      for (const field of ['license', 'upstreamRepo', 'attribution', 'licenseEvidence', 'provenanceStatus', 'licenseFile'] as const) {
        const value = m[field];
        expect(typeof value, `${m.id}.${field} 必须是字符串`).toBe('string');
        expect((value as string).trim().length, `${m.id}.${field} 不得为空`).toBeGreaterThan(0);
      }
      expect(['license-file', 'readme-claim'], `${m.id}.licenseEvidence`).toContain(m.licenseEvidence);
      expect(['first-party', 'second-hand'], `${m.id}.provenanceStatus`).toContain(m.provenanceStatus);
    }
  });

  it('许可标识必须落在 §3.0 白名单内', () => {
    for (const { m } of allModels) {
      expect(LICENSE_WHITELIST, `${m.id} 的许可 ${m.license} 不在白名单`).toContain(m.license);
    }
  });

  it('licenseFile 指向的留存文件真存在、不是几行摘要，且正文与标识对得上', () => {
    for (const { m } of allModels) {
      const p = join('LICENSES', 'third-party', m.licenseFile);
      expect(existsSync(p), `${p} 必须存在（§3.1.1 第 ④ 件：许可全文由我们留存）`).toBe(true);
      const text = readFileSync(p, 'utf8');
      expect(text.length, `${p} 看着不像许可全文`).toBeGreaterThan(1000);
      const marker = LICENSE_MARKERS[m.license];
      expect(text, `${p} 的内容与标识 ${m.license} 不符`).toContain(marker);
    }
  });

  it('一手出处与分发仓必须是两个字段：不能拿镜像仓当许可出处', () => {
    for (const { m } of allModels) {
      expect(m.upstreamRepo, `${m.id} 必须写一手作者仓`).not.toBe(m.repoId);
    }
  });

  it('NOTICE 必须与清单同步：每个模型的名称、SHA-256、一手仓都出现在里面', () => {
    const notice = readFileSync('NOTICE', 'utf8');
    for (const { m } of allModels) {
      expect(notice, `NOTICE 里没有 ${m.displayName}（改完清单要跑 npm run notice）`).toContain(m.displayName);
      expect(notice, `NOTICE 里 ${m.id} 的 SHA-256 与清单不一致`).toContain(m.sha256);
      expect(notice, `NOTICE 里没有一手仓 ${m.upstreamRepo}`).toContain(m.upstreamRepo);
      expect(notice, `NOTICE 里没有留存文件 ${m.licenseFile}`).toContain(m.licenseFile);
    }
  });

  it('第三方转导出的条目，NOTICE 必须写明"系第三方转导出，非上游一手发布"（§2 裁定三）', () => {
    const notice = readFileSync('NOTICE', 'utf8');
    const secondHand = allModels.filter(({ m }) => m.provenanceStatus === 'second-hand');
    // 反向腿：若将来全部换成一手权重，这条不该硬要求文案存在
    if (secondHand.length === 0) return;
    expect(notice).toContain('系第三方转导出的 ONNX，非上游一手发布');
    for (const { m } of secondHand) {
      const from = notice.indexOf(`（标识 ${m.id}，`);
      expect(from, `NOTICE 里找不到 ${m.id} 的分节`).toBeGreaterThan(-1);
      const next = notice.indexOf('（标识 ', from + 1);
      const section = notice.slice(from, next === -1 ? notice.length : next);
      expect(section, `${m.id} 的分节里缺"第三方转导出"披露`).toContain('第三方转导出');
      expect(section).toContain('非上游一手发布');
    }
  });

  it('镜像仓没有 LICENSE 本体的事实要在 NOTICE 里说清，不得写成"已核验上游许可"', () => {
    const notice = readFileSync('NOTICE', 'utf8');
    const claims = allModels.filter(({ m }) => m.licenseEvidence === 'readme-claim');
    if (claims.length === 0) {
      // 当前两条都靠一手仓的 LICENSE 本体，那 NOTICE 仍须交代镜像仓没有本体这件事
      expect(notice).toContain('仓库内没有 LICENSE 文件本体');
    }
    expect(notice).not.toContain('已核验上游许可');
  });

  it('本项目自己的许可是 MIT 正文，且各表面口径不与它打架', () => {
    const license = readFileSync('LICENSE', 'utf8');
    expect(license).toContain('MIT License');
    expect(license).toContain('Copyright (c) 2026 Ybond');
    expect(license).toContain('Permission is hereby granted, free of charge');
    expect(license).toContain('and/or sell copies of the Software');
    expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    // 占位符必须都填掉，否则发出去的是模板不是许可
    expect(license).not.toContain('<year>');
    expect(license).not.toContain('<copyright holders>');

    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.license).toBe('MIT');
    expect(pkg.author).toBe('Ybond');
    // 承诺随包发的东西，files 白名单里就得真有
    expect(pkg.build.files).toContain('LICENSE');
    expect(pkg.build.files).toContain('NOTICE');
    expect(pkg.build.files).toContain('LICENSES/**');

    // MIT 明文允许商用与再分发。下面这些措辞与许可正文相互矛盾，任何一处出现都算口径分裂
    const surfaces: Record<string, string> = {
      'README.md': readFileSync('README.md', 'utf8'),
      NOTICE: readFileSync('NOTICE', 'utf8'),
      '设置·关于与更新': readFileSync(join('src', 'components', 'settings', 'AboutUpdatePane.tsx'), 'utf8')
    };
    const banned = ['严禁用于商业用途', '24 小时之内删除', '仅供学习交流使用', '源码公开非商业使用许可'];
    for (const [name, text] of Object.entries(surfaces)) {
      for (const phrase of banned) {
        expect(text, `${name} 里还留着与 MIT 冲突的「${phrase}」`).not.toContain(phrase);
      }
    }
  });
});
