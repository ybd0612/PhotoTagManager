#!/usr/bin/env node
/**
 * gen-notice —— 从能力清单生成仓库根 NOTICE。
 *
 * 为什么是生成而不是手写：许可与归属的唯一事实源是 `electron/ai/capabilityCatalog.ts`
 * （规范 §5「数据源必须单一」）。手写 NOTICE 就是给同一个事实开第二份副本，
 * 加一个模型时忘了改，界面与 NOTICE 就会各说各话。
 *
 * 用法：
 *   node scripts/gen-notice.cjs          重新生成 NOTICE
 *   node scripts/gen-notice.cjs --check  只比对，不一致就退出码 1（测试与 CI 用这条路）
 *
 * Node 24 能直接 import 那个 .ts（它是纯数据、不 import electron/fs），
 * 所以这里不需要额外装 ts-node / tsx 之类的依赖。
 */
const fs = require('node:fs');
const path = require('node:path');

const CHECK = process.argv.includes('--check');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'NOTICE');

/** 与规范 §3.0 白名单同口径；实际强制在 tests/modelLicense.test.ts */
const LICENSE_TEXT_DIR = 'LICENSES/third-party';

function fmtBytes(n) {
  return n.toLocaleString('en-US');
}

async function build() {
  const mod = await import(pathToFileUrl(path.join(ROOT, 'electron/ai/capabilityCatalog.ts')));
  const caps = mod.capabilities;
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;

  const L = [];
  L.push('PhotoTagManager（图片管家）— 第三方组件许可与归属声明（NOTICE）');
  L.push('');
  L.push(`本文件由 scripts/gen-notice.cjs 从 electron/ai/capabilityCatalog.ts 生成，请勿手改。`);
  L.push(`生成日期：${stamp}`);
  L.push('');
  L.push('1. 本项目自己的代码');
  L.push('');
  L.push('   源代码与可执行程序按仓库根 LICENSE 文件所列的「源码公开非商业使用许可 v1.0」提供：');
  L.push('   仅供个人学习与非商业使用，禁止用于商业用途。该许可不覆盖下面列出的第三方组件。');
  L.push('');
  L.push('2. 代码依赖（React、Material UI、Electron、electron-builder、electron-updater、');
  L.push('   exiftool-vendored、onnxruntime-node、sharp 等）');
  L.push('');
  L.push('   这些组件保持各自的原始许可，其许可正文随发行包内的 node_modules/<包名>/LICENSE');
  L.push('   一同分发，本文件不重复抄录（抄第二遍就会与原件漂移）。');
  L.push('   本项目的代码许可不改变、也不收紧它们授予你的权利。');
  L.push('');
  L.push('3. 模型权重');
  L.push('');
  L.push('   权重**不在安装包里**：应用按清单指定的公开模型源在你本机下载，落到配置目录');
  L.push('   (%APPDATA%\\photo-tag-manager)。下列每个模型的许可全文已按字节逐字留存于');
  L.push(`   ${LICENSE_TEXT_DIR}/，取源方式与校验值见该目录下的 README.md。`);
  L.push('');
  L.push('   关于"许可依据"的一个事实，按规范 §3.1 必须写明：清单里用于取权重的那个仓库');
  L.push('   （下面每个模型的「分发仓库」）**都不是许可全文的出处**——它们是第三方镜像，');
  L.push('   仓库内没有 LICENSE 文件本体，只有一个 README 里自填的 `license:` 元数据（自填值，非核验值）。');
  L.push('   本项目因此改从上面「一手出处」那个仓库逐字留存许可全文，见下一节每个模型的「许可依据」。');
  L.push('');
  L.push('   每个模型都附两条如实披露，请不要跳过：');
  L.push('     · 许可依据来自哪个仓库（一手仓的 LICENSE 文件本体，还是镜像仓 README 自填标识）；');
  L.push('     · 权重是否由上游作者本人发布。本项目当前全部为第三方转导出的 ONNX。');
  L.push('');

  for (const cap of caps) {
    for (const m of cap.models) {
      L.push('─'.repeat(78));
      L.push(`${m.displayName}（标识 ${m.id}，用于「${cap.label}」）`);
      L.push('─'.repeat(78));
      L.push(`  许可：        ${m.license}`);
      L.push(`  许可全文：    ${LICENSE_TEXT_DIR}/${m.licenseFile}`);
      const evidenceText =
        m.licenseEvidence === 'license-file'
          ? `一手仓库 ${m.upstreamRepo} 仓库内有 LICENSE 文件本体，本文件留存的即该文件逐字节副本`
          : `一手仓库未找到 LICENSE 文件本体，许可依据为上游 README 自填的 license 元数据（自填值，非核验值）`;
      L.push(`  许可依据：    ${evidenceText}`);
      L.push(`  归属：        ${m.attribution}`);
      L.push(`  一手出处：    ${m.upstreamRepo}（仅作出处与归属来源，不作分发来源）`);
      L.push(`  分发仓库：    ${m.repoId} → ${m.filePath}`);
      L.push(`  文件名：      ${m.fileName}`);
      L.push(`  体积：        ${fmtBytes(m.sizeBytes)} 字节`);
      L.push(`  SHA-256：     ${m.sha256}`);
      L.push(
        `  权重同一性：  ${
          m.provenanceStatus === 'second-hand'
            ? '⚠ 系第三方转导出的 ONNX，非上游一手发布。本项目校验 SHA-256 只保证"下载到的就是清单写的那份"，不保证"那份来自原作者"。已知限制记录见 docs/design/model-licensing-and-survey.md §6.1。'
            : '上游作者本人发布的权重'
        }`
      );
      L.push('');
    }
  }

  L.push('─'.repeat(78));
  L.push('U²-Net 与 MODNet 的论文与代码版权归原作者；本文件只作许可与来源的披露，不代任何上游作出担保。');
  L.push('');
  return L.join('\n');
}

function pathToFileUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/');
}

(async () => {
  const text = await build();
  if (CHECK) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    // 生成日期每天在变，比对时把它剔掉，否则 --check 每天都会红
    const norm = (s) => s.replace(/生成日期：\d{4}-\d{2}-\d{2}/g, '生成日期：—');
    if (norm(cur) !== norm(text)) {
      console.error('NOTICE 与清单不一致，请运行：node scripts/gen-notice.cjs');
      process.exit(1);
    }
    console.log('NOTICE 与清单一致');
    return;
  }
  fs.writeFileSync(OUT, text, 'utf8');
  console.log(`已生成 NOTICE（${text.split('\n').length} 行）`);
})().catch((e) => {
  console.error('gen-notice 失败：', e);
  process.exit(1);
});
