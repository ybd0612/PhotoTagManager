// @vitest-environment node
// 守卫检查清单：U4（userData 目录名）、U6（原生菜单不许回来）、UiPrefs 落盘白名单、
// 窗口控件自绘、品牌图唯一来源。
// 共同点：这些事在真机上都"看不见"——目录换了只是数据凭空消失、字段读错只是界面少个数字、
// 菜单回来了只是按 Alt 多一排按钮。不在测试里钉死，下次改动就会静默复发。
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join, sep } from 'path';

import { USER_DATA_DIR_NAME, legacyUserDataDirFor, userDataDirFor } from '../electron/userDataDir';

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('U4 userData 目录名钉死', () => {
  it('在用目录名就是 photo-tag-manager，且与安装器用的 PhotoTagManager 不是一回事', () => {
    expect(USER_DATA_DIR_NAME).toBe('photo-tag-manager');
    expect(userDataDirFor(join('C:', 'Users', 'x', 'AppData', 'Roaming')))
      .toBe(join('C:', 'Users', 'x', 'AppData', 'Roaming', 'photo-tag-manager'));
    // 遗留目录名与在用名只差大小写——正是这种"看着一样"最容易让人顺手改
    expect(legacyUserDataDirFor('X')).not.toBe(join('X', USER_DATA_DIR_NAME));
  });

  it('主进程必须显式钉死名字，不能靠 Electron 从 package.json 猜', () => {
    const src = read(join('electron', 'main.ts'));
    expect(src).toContain('app.setName(USER_DATA_DIR_NAME)');
    expect(src).toContain("app.setPath('userData'");
  });
});

describe('U6 原生菜单不许回来', () => {
  /**
   * 判代码用法，不判注释。main.ts 里为了说明"为什么不用它"，
   * 注释中原样出现过 `autoHideMenuBar: true`——不剥注释这条检查就会自己误报。
   */
  const codeOnly = (): string =>
    read(join('electron', 'main.ts'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('主进程显式去掉应用菜单', () => {
    expect(codeOnly()).toContain('Menu.setApplicationMenu(null)');
  });

  it('不许再把 autoHideMenuBar 当窗口选项用 —— 它的语义就是"按 Alt 显出来"', () => {
    expect(codeOnly()).not.toMatch(/autoHideMenuBar\s*:/);
  });
});

/**
 * 新增偏好字段时最容易漏的一步：electron/ipc.ts 的 prefs:set 是**逐字段白名单**，
 * 没写进去的字段每次落盘都被丢掉，表现是"这个开关重启就恢复默认"，且没有任何报错。
 */
describe('UiPrefs 落盘白名单不许漏字段', () => {
  it('shared/types.ts 里每个 UiPrefs 字段都要出现在 prefs:set 的 next 对象里', () => {
    const types = read(join('shared', 'types.ts'));
    const body = types.match(/export interface UiPrefs \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const fields = [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
    expect(fields.length).toBeGreaterThan(0); // 一个都没匹配到就是这条检查在空转

    const ipc = read(join('electron', 'ipc.ts'));
    const whitelist = ipc.match(/const next: UiPrefs = \{([\s\S]*?)\n\s*\};/)?.[1] ?? '';
    expect(whitelist).not.toBe(''); // 白名单写法变了，这条检查得跟着改，不许静默空转
    for (const f of fields) {
      expect(whitelist, `prefs:set 白名单漏了 ${f}，这个偏好永远存不进 ui.json`).toContain(`${f}:`);
    }
  });
});

/**
 * 右上角三个窗口控件从系统覆盖层改成了渲染层自绘，两个必须守住的性质：
 * ① 原生覆盖层不许回来——它画在网页之上，预览遮不住、对话框压不住，Windows 又没有隐藏的 API；
 * ② 层叠顺序：控件要高于 MUI 模态（1300~1600），否则开着「设置」点不到关闭；
 *    预览盖住控件用显式隐藏（见 windowControls.test.tsx），不许靠把预览层抬到控件之上——
 *    抬上去会连预览自己弹出的右键菜单和对话框一起压在下面。
 */
describe('窗口控件自绘，原生覆盖层不许回来', () => {
  /** 判代码用法，不判注释：main.ts 为了说明"为什么不用它"，注释里原样写着这两个选项名 */
  const codeOf = (p: string): string =>
    read(p)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  const codeOnly = (): string => codeOf(join('electron', 'main.ts'));

  it('主进程 frame:false，且不再声明 titleBarStyle / titleBarOverlay', () => {
    const code = codeOnly();
    expect(code).toMatch(/frame:\s*false/);
    expect(code, 'titleBarOverlay 一回来，预览右上角就盖不住了').not.toMatch(/titleBarOverlay\s*:/);
    expect(code, 'titleBarStyle 同理会带出系统覆盖层').not.toMatch(/titleBarStyle\s*:/);
  });

  it('顶栏让位的宽度就是控件的宽度（齿轮被压在关闭按钮底下的回归）', () => {
    const css = read(join('src', 'styles', 'index.css'));
    const pad = css.match(/\.ptm-titlebar\s*\{[^}]*padding-right:\s*([^;]+);/)?.[1] ?? '';
    expect(pad, '读不到顶栏的 padding-right，这条断言在空转').not.toBe('');
    expect(pad, '顶栏必须按控件整条宽度让位，不能退回固定值').toContain('--ptm-wc-width');
    expect(
      css,
      '控件宽度必须来自同一个变量，否则让位宽度和实际宽度各漂各的'
    ).toMatch(/\.ptm-window-controls button\s*\{[^}]*width:\s*var\(--ptm-wc-btn-width\)/);
  });

  it('z-index 顺序：窗口控件高于 MUI 模态带，但预览覆盖层不许高于模态带', () => {
    const css = read(join('src', 'styles', 'index.css'));
    const controls = Number(css.match(/\.ptm-window-controls\s*\{[\s\S]*?z-index:\s*(\d+)/)?.[1]);
    expect(controls, '读不到 .ptm-window-controls 的 z-index，这条断言在空转').toBeGreaterThan(0);
    expect(controls, '控件必须高于 MUI 对话框与菜单（1300~1600）').toBeGreaterThan(1600);

    /**
     * 预览覆盖层必须留在 MUI 模态带里。预览里弹出的右键菜单、回收站确认框
     * 都是 portal 挂到 body、按 theme.zIndex.modal = 1300 画的；覆盖层一旦高过这个数，
     * 就把自家弹出的浮层一起压在下面。盖住控件改用显式隐藏，见 windowControls.test.tsx。
     */
    const preview = codeOf(join('src', 'components', 'PreviewOverlay.tsx'));
    const explicit = [...preview.matchAll(/zIndex:\s*(\d+)/g)].map((m) => Number(m[1]));
    for (const z of explicit) {
      expect(z, `预览覆盖层写了 z-index ${z}，会盖住预览自己弹出的浮层（模态带是 1300）`).toBeLessThanOrEqual(1300);
    }
    expect(
      preview,
      '预览覆盖层必须挂在 MUI 模态带上（zIndex.modal），否则它和弹出浮层的先后就没人管'
    ).toMatch(/zIndex:[^\n]*\.zIndex\.modal/);
  });
});

/**
 * 品牌 mark 的画稿只有一份：shared/brand-mark.svg，生成脚本和界面都指向它。
 * 起因（2026-09-30）：顶栏左上角挂的是 MUI 通用 PhotoLibrary 图标，和任务栏/托盘/安装包那张
 * 品牌图是两张脸。"同一张图存两份"在真机上不报错，只是哪天又漂成两张，所以钉在源码里。
 */
describe('品牌图唯一来源，界面与系统图标不许分家', () => {
  /** 判代码用法，不判注释：BrandLogo.tsx 的注释里原样写着 PhotoLibrary，剥注释这条会误报 */
  const codeOnly = (p: string): string =>
    read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('画稿文件在，生成脚本与界面组件都读它', () => {
    expect(existsSync(join(root, 'shared', 'brand-mark.svg')), '画稿文件没了就是分家第一步').toBe(true);
    expect(read(join('shared', 'brand-mark.svg'))).toContain('<svg');
    expect(codeOnly(join('scripts', 'make-icon.cjs'))).toMatch(/readFileSync\(\s*BRAND_SVG/);
    expect(codeOnly(join('src', 'components', 'BrandLogo.tsx'))).toMatch(/shared\/brand-mark\.svg/);
  });

  it('画稿不许再以内联 SVG 的形式回到生成脚本里', () => {
    // 反证：把那段 <linearGradient> 字面量塞回 make-icon.cjs，这条必须红
    expect(codeOnly(join('scripts', 'make-icon.cjs'))).not.toContain('<linearGradient');
  });

  it('顶栏品牌位用 BrandLogo，不许再用 MUI 通用图标', () => {
    const layout = codeOnly(join('src', 'components', 'AppLayout.tsx'));
    expect(layout, '顶栏没挂 BrandLogo，界面和任务栏又是两张脸').toMatch(/<BrandLogo\s*\/>/);
    expect(layout, '顶栏再挂 color="primary" 的 PhotoLibrary 就是回到两张脸').not.toMatch(
      /<PhotoLibraryIcon[^>]*color="primary"/
    );
  });
});

void sep;
