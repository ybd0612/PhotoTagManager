// 界面机制的绊线：这几条钉的都是"改回去也照样能跑、但用户会立刻看出不对"的东西。
// 全部读文件文本判定，不起渲染，所以便宜且不会随组件重构漂移。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (...p: string[]): string => readFileSync(join(...p), 'utf8');

/** 去掉注释后再看字面量，免得把代码注释里提到的旧词也算成"界面上还有" */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('树行操作图标的显示机制', () => {
  const tree = read('src', 'components', 'FolderTree.tsx');
  const css = read('src', 'styles', 'index.css');

  it('不许再用 group-focus-within——点一下树行就让 treeitem 拿到焦点，图标会一直赖着不走', () => {
    expect(tree).not.toContain('group-focus-within');
  });

  it('两颗行内操作按钮都挂 ptm-row-actions，且树行带 ptm-tree-row（CSS 靠这两个类命中）', () => {
    expect(tree.split('ptm-row-actions').length - 1).toBeGreaterThanOrEqual(2);
    expect(tree).toContain('ptm-tree-row');
  });

  it('MUI 的 sx 里不许出现无单位的 height/width/borderRadius 数字 1（会被当成 100% 与主题倍数）', () => {
    const offenders: string[] = [];
    for (const f of ['src/components/FolderTree.tsx', 'src/components/TagFilterBar.tsx', 'src/components/ThumbnailGrid.tsx', 'src/components/AppLayout.tsx']) {
      const src = withoutComments(read(...f.split('/')));
      // 这里刻意不用词首断言转义写法：它在本文件里曾被写成退格控制符，判据会静默失效（反证时才发现）
      for (const m of src.matchAll(/(^|[^A-Za-z])(height|width|borderRadius):\s*1\s*[,}]/g)) {
        offenders.push(`${f}: ${m[2]}: 1`);
      }
    }
    expect(offenders, '这些值在 MUI sx 里不是 1px：' + offenders.join(' | ')).toEqual([]);
  });

  it('CSS 里悬停与键盘聚焦两条规则都在，缺一条就会退回"常驻"或"键盘够不着"', () => {
    expect(css).toMatch(/\.ptm-tree-row:hover \.ptm-row-actions/);
    expect(css).toMatch(/\.ptm-tree-row:has\(:focus-visible\) \.ptm-row-actions/);
  });
});

describe('顶栏高度两处必须同值', () => {
  const css = read('src', 'styles', 'index.css');
  const layout = read('src', 'components', 'AppLayout.tsx');

  it('--ptm-header-height 是 44px（自绘窗口控件的高度由它派生）', () => {
    expect(css).toMatch(/--ptm-header-height:\s*44px/);
  });

  it('顶栏那条 Paper 用 h-11（=44px），与上面的变量一致；两处不一致就会错位', () => {
    // 必须锚定 className：文件里更早还有一行注释提到 .ptm-titlebar，不锚定就会命中注释
    const m = layout.match(/className="ptm-titlebar[^"]*"/);
    expect(m).toBeTruthy();
    expect(m?.[0]).toContain('h-11');
    expect(m?.[0]).not.toMatch(/h-14/);
  });
});

describe('面向用户的称呼已改成「目录」', () => {
  const files = [
    join('src', 'components', 'AppLayout.tsx'),
    join('src', 'components', 'FolderTree.tsx'),
    join('src', 'hooks', 'useRootActions.tsx')
  ];

  it('字符串字面量里不许再出现「根目录」（注释与标识符不算）', () => {
    for (const f of files) {
      const src = withoutComments(read(f));
      const quoted = src.match(/'[^'\n]*'|`[^`]*`|"[^"\n]*"/g) ?? [];
      const hits = quoted.filter((t) => t.includes('根目录'));
      expect(hits, `${f} 的界面文案里还剩：${hits.join(' | ')}`).toEqual([]);
    }
  });

  it('JSX 文本节点里也不许出现（如「添加根目录」单独占一行的按钮文案）', () => {
    for (const f of files) {
      const src = withoutComments(read(f));
      const textNodes = src.split('\n').filter((l) => /^\s*[^/\s<).*].*根目录/.test(l));
      expect(textNodes, `${f} 还有：${textNodes.join(' | ')}`).toEqual([]);
    }
  });
});
