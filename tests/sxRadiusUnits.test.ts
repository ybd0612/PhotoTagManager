// @vitest-environment node
/**
 * 守卫：交给 MUI 的 sx.borderRadius 必须带单位。
 *
 * 起因（2026-09-30）：模型下拉写着 borderRadius: tokens.radius.sm（=8），MUI 的 sx 把裸数字当成
 * theme.shape.borderRadius（本项目 12）的**倍率**，实测算成 96px——一个 300×109 的面板四角各 96px，
 * 看着就不是"方框带圆角"了。同一条写法还散在别的组件上，所以扫源码钉住，而不是只修眼前这一处。
 *
 * 只管 src/components：App.tsx 的 styleOverrides 里数字就是普通 CSS 值（emotion 会补 px），
 * 那一边写 radius.sm 是对的，不在这条的射程里。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const root = process.cwd();

const tsxFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsxFiles(join(dir, e.name)) : e.name.endsWith('.tsx') ? [join(dir, e.name)] : []
  );

/** 判代码不判注释：注释里会原样写"borderRadius: 8"这种反面例子 */
const codeOf = (abs: string): string =>
  readFileSync(abs, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('sx 里的圆角必须带单位，不吃 MUI 的倍乘', () => {
  it('src/components 下没有 borderRadius: <裸数字或裸 token>', () => {
    const offenders: string[] = [];
    for (const abs of tsxFiles(join(root, 'src', 'components'))) {
      for (const m of codeOf(abs).matchAll(/borderRadius:\s*([^,\n}]+)/g)) {
        const v = m[1].trim();
        if (v === '0') continue; // 0 乘任何倍率还是 0，通栏相接边就这么写
        if (/^['"`]/.test(v) || /\bpx\(/.test(v) || /var\(/.test(v)) continue;
        offenders.push(`${abs.replace(root + '\\', '')}: borderRadius: ${v}`);
      }
    }
    expect(offenders, '这些圆角会被 MUI 当成倍率乘出 96px 这类值，改成 px(tokens.radius.x)').toEqual([]);
  });
});

/**
 * 输入框字号只许有一个来源（App.tsx 主题的 MuiInputBase）。
 * 起因（2026-09-30）：搜索框当年被单独压到 13px，其余输入框仍吃 MUI 默认的 body1 = 15px，
 * 于是同一行里输入框比旁边的控件（实测 12.07px）大一档，用户报"只要是个输入框都偏大"。
 * 各组件再各写一遍 fontSize，就是这种分裂的成因，所以扫源码钉住。
 */
describe('输入框字号单一来源', () => {
  const srcFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? srcFiles(join(dir, e.name))
        : /\.(tsx|ts)$/.test(e.name)
          ? [join(dir, e.name)]
          : []
    );

  it('组件里不许再出现 .MuiInputBase-input 的 fontSize（改主题那一个来源）', () => {
    const offenders: string[] = [];
    for (const abs of [...srcFiles(join(root, 'src', 'components')), ...srcFiles(join(root, 'src', 'hooks'))]) {
      for (const m of codeOf(abs).matchAll(/MuiInputBase-input['"]?\s*:\s*\{([^}]*)\}/g)) {
        if (/fontSize/.test(m[1])) offenders.push(`${abs.replace(root + '\\', '')}: ${m[0].slice(0, 60)}`);
      }
    }
    expect(offenders, '输入框字号散在各组件里会各自漂量，收进 App.tsx 的 MuiInputBase 主题').toEqual([]);
  });
});
