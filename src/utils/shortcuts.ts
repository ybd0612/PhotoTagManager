/**
 * 快捷键清单（批次3 G11）的单一事实源：设置里的「快捷键」分区与 `?` 唤出都读这里。
 *
 * 一条口径：**只列已经实现的键位**。这份表不是设计稿，写进去一个没接上的组合键，
 * 用户按下去没反应，比不写更糟——它和设置页里"不许放调了没反应的假控件"是同一条防线。
 * 每条键位都有对应行为用例：预览导航见预览断言，`?` 见 shortcuts 用例。
 */
export interface Shortcut {
  /** 键位原文，按用户看到的写法 */
  keys: string;
  /** 这条键位做什么 */
  action: string;
  /** 在哪个界面按才有效 */
  scope: string;
}

export const SHORTCUTS: Shortcut[] = [
  { keys: '← / →', action: '预览中看上一张 / 下一张', scope: '预览' },
  { keys: 'Esc', action: '关闭预览、对话框或菜单', scope: '全局' },
  { keys: 'Ctrl + C', action: '把当前文件复制到剪贴板，可在资源管理器粘贴', scope: '预览' },
  { keys: 'Enter', action: '在标签输入框里确认并写入标签', scope: '预览' },
  { keys: 'Ctrl + 单击', action: '网格中多选图片（批量加标签、批量移到回收站）', scope: '网格' },
  { keys: 'Tab / ↑ ↓ / Enter', action: '键盘走到并展开模型下拉，方向键移动、Enter 选择', scope: '预览底栏' },
  { keys: 'Ctrl + B', action: '收起 / 展开左侧目录树（当前目录常驻底部状态栏）', scope: '全局' },
  { keys: '?', action: '打开设置并停在快捷键分区（即本列表）', scope: '全局 · 输入框内除外' }
];
