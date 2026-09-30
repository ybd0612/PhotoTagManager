// @vitest-environment node
// 三处守卫检查：U4（userData 目录名）、U5（界面读的字段必须在契约里）、U6（原生菜单不许回来）。
// 共同点：这三件事在真机上都"看不见"——目录换了只是数据凭空消失、字段读错只是界面少个数字、
// 菜单回来了只是按 Alt 多一排按钮。不在测试里钉死，下次改动就会静默复发。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
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

describe('U5 界面读的字段必须在契约里（假绿的根因）', () => {
  const payloadFields = (): string[] => {
    const types = read(join('shared', 'types.ts'));
    const body = types.match(/export interface AiDonePayload \{([\s\S]*?)\n\}/)?.[1] ?? '';
    return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
  };

  it('AiCompareView 里每个 result.X 都是 AiDonePayload 的字段', () => {
    const view = read(join('src', 'components', 'AiCompareView.tsx'));
    const fields = payloadFields();
    expect(fields.length).toBeGreaterThan(0);
    const read_fields = [...new Set([...view.matchAll(/result\.(\w+)/g)].map((m) => m[1]))];
    expect(read_fields.length).toBeGreaterThan(0); // 一个都没匹配到就是这条断言在空转
    for (const f of read_fields) {
      expect(fields, `界面读了契约外的字段 result.${f}`).toContain(f);
    }
  });

  it('那对别名 inputWidth/inputHeight 不许回到 AiDonePayload（生产者从来不写它）', () => {
    expect(payloadFields()).not.toContain('inputWidth');
    expect(payloadFields()).not.toContain('inputHeight');
  });

  it('掩码尺寸那句注明真的把数字打出来（防止又退回空白）', async () => {
    const view = read(join('src', 'components', 'AiCompareView.tsx'));
    expect(view).toMatch(/掩码在 \{result\.maskWidth\}×\{result\.maskHeight\} 下计算/);
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
 * ② 层叠顺序两头都要卡：控件要高于 MUI 模态（1300~1600），否则开着「设置」点不到关闭；
 *    预览覆盖层又要高于控件，否则预览时那三个还浮在上面。
 */
describe('窗口控件自绘，原生覆盖层不许回来', () => {
  /** 判代码用法，不判注释：main.ts 为了说明"为什么不用它"，注释里原样写着这两个选项名 */
  const codeOnly = (): string =>
    read(join('electron', 'main.ts'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('主进程 frame:false，且不再声明 titleBarStyle / titleBarOverlay', () => {
    const code = codeOnly();
    expect(code).toMatch(/frame:\s*false/);
    expect(code, 'titleBarOverlay 一回来，预览右上角就盖不住了').not.toMatch(/titleBarOverlay\s*:/);
    expect(code, 'titleBarStyle 同理会带出系统覆盖层').not.toMatch(/titleBarStyle\s*:/);
  });

  it('z-index 顺序：MUI 模态 < 窗口控件 < 预览覆盖层', () => {
    const css = read(join('src', 'styles', 'index.css'));
    const controls = Number(css.match(/\.ptm-window-controls\s*\{[\s\S]*?z-index:\s*(\d+)/)?.[1]);
    expect(controls, '读不到 .ptm-window-controls 的 z-index，这条断言在空转').toBeGreaterThan(0);
    expect(controls, '控件必须高于 MUI 对话框与菜单（1300~1600）').toBeGreaterThan(1600);

    const preview = read(join('src', 'components', 'PreviewOverlay.tsx'));
    const overlay = Number(preview.match(/zIndex:\s*(\d+)/)?.[1]);
    expect(overlay, '预览覆盖层没有显式 zIndex，盖不住窗口控件').toBeGreaterThan(controls);
  });
});

void sep;
