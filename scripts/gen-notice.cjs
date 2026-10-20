#!/usr/bin/env node
/**
 * 生成仓库根 NOTICE，避免已撤销的模型能力继续被描述为当前产品功能。
 * 模型许可正文与卷宗保留在 LICENSES/third-party 和 docs/models 中，作为历史审计记录。
 *
 * 用法：
 *   node scripts/gen-notice.cjs          重新生成 NOTICE
 *   node scripts/gen-notice.cjs --check  只比对，不一致就退出码 1
 */
const fs = require('node:fs');
const path = require('node:path');

const CHECK = process.argv.includes('--check');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'NOTICE');

function build() {
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
  return [
    'PhotoTagManager（图片管家）— 第三方组件许可与归属声明（NOTICE）',
    '',
    '本文件由 scripts/gen-notice.cjs 生成，请勿手改。',
    `生成日期：${stamp}`,
    '',
    '1. 本项目自己的代码',
    '',
    '   源代码与可执行程序按仓库根 LICENSE 文件所列的 MIT License 提供。该许可不覆盖下面',
    '   列出的第三方组件；它们各自保持原始许可。',
    '',
    '2. 代码依赖',
    '',
    '   Electron、React、Material UI、exiftool-vendored、sharp、electron-updater 等组件保持',
    '   各自的原始许可。发行包内各依赖的许可信息与正文按项目打包规则一并分发。',
    '   本项目的代码许可不改变、也不收紧它们授予你的权利。',
    '',
    '3. 历史模型许可档案',
    '',
    '   当前版本不提供模型推理、模型下载或人像抠图功能。此前评估过的模型许可全文与来源卷宗',
    '   保留在 LICENSES/third-party/ 及 docs/models/，仅作历史合规审计资料；不代表当前应用仍',
    '   分发或下载相关模型权重。',
    ''
  ].join('\n');
}

(() => {
  const text = build();
  if (CHECK) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    const normalize = (value) => value.replace(/生成日期：\d{4}-\d{2}-\d{2}/g, '生成日期：—');
    if (normalize(current) !== normalize(text)) {
      console.error('NOTICE 与生成内容不一致，请运行：node scripts/gen-notice.cjs');
      process.exit(1);
    }
    console.log('NOTICE 与生成内容一致');
    return;
  }
  fs.writeFileSync(OUT, text, 'utf8');
  console.log(`已生成 NOTICE（${text.split('\n').length} 行）`);
})();
