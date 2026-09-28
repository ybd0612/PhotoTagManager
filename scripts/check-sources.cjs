/**
 * 检查能力清单里每个模型在两个下载源上的可用性与内容一致性。
 *
 * 用法：
 *   node scripts/check-sources.cjs          快速：每个源发一次请求，比状态码与 content-length
 *   node scripts/check-sources.cjs --full   完整：两个源各下一份全文，算 sha256 并与清单比对
 *
 * 两点设计说明：
 * - 模型清单是 TypeScript，这里**解析源码取字面量**，不另建一份 JSON 清单——
 *   第二份事实源迟早和 capabilityCatalog.ts 漂移，那正是这批整改一直在消灭的东西。
 * - 用 Node 全局 fetch 直连，不走代理：要测的就是"一台没配代理的机器上，这个源能不能用"。
 *
 * 快速模式只比大小，它**不等于**内容一致：同一仓库在两个源上可能是不同时间的导出版本，
 * 大小相同而字节不同完全可能。加新模型必须跑一次 --full，否则清单里那一份 sha256
 * 迟早把正常下载判成"内容损坏"。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FULL = process.argv.includes('--full');
const CATALOG = path.resolve(__dirname, '..', 'electron', 'ai', 'capabilityCatalog.ts');
const HOSTS = { modelscope: 'https://modelscope.cn', 'hf-mirror': 'https://hf-mirror.com' };

/** 从清单源码里抠出模型条目（只认字面量字段，不执行 TS） */
function readModels(src) {
  const out = [];
  const re = /id:\s*'([^']+)',[\s\S]*?repoId:\s*'([^']+)',\s*filePath:\s*'([^']+)',\s*fileName:\s*'([^']+)',\s*sizeBytes:\s*([\d_]+),\s*sha256:\s*'([a-f0-9]{64})'/g;
  let m;
  while ((m = re.exec(src))) {
    out.push({
      id: m[1],
      repoId: m[2],
      filePath: m[3],
      fileName: m[4],
      sizeBytes: Number(m[5].replace(/_/g, '')),
      sha256: m[6]
    });
  }
  return out;
}

function urlFor(source, model) {
  return source === 'modelscope'
    ? `${HOSTS.modelscope}/models/${model.repoId}/resolve/master/${model.filePath}`
    : `${HOSTS['hf-mirror']}/${model.repoId}/resolve/main/${model.filePath}`;
}

async function head(url) {
  const t = Date.now();
  try {
    const r = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(20000) });
    // ModelScope 对 Range 返回 206 并带 x-total-components/Content-Range，能拿到总大小
    const cr = r.headers.get('content-range') || '';
    const total = Number((cr.match(/\/(\d+)$/) || [])[1] || 0);
    await r.body?.cancel?.();
    return { status: r.status, ms: Date.now() - t, total };
  } catch (e) {
    return { status: 0, ms: Date.now() - t, error: e.message, total: 0 };
  }
}

async function fullSha(url) {
  const t = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(300000) });
    if (!r.ok) return { status: r.status, error: `HTTP ${r.status}` };
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, ms: Date.now() - t, size: buf.length, sha: crypto.createHash('sha256').update(buf).digest('hex') };
  } catch (e) {
    return { status: 0, error: e.message };
  }
}

(async () => {
  const models = readModels(fs.readFileSync(CATALOG, 'utf8'));
  if (models.length === 0) {
    console.error('没从清单里解析出任何模型——多半是字段顺序变了，请改本脚本的正则，不要跳过检查');
    process.exit(1);
  }
  console.log(`模式：${FULL ? '--full（两源各下一份全文，算 sha256）' : '快速（只比状态码与总大小，不等于内容一致）'}\n`);
  let problems = 0;
  for (const m of models) {
    console.log(`● ${m.id}  ${m.repoId}/${m.filePath}  清单大小 ${m.sizeBytes}`);
    const results = {};
    for (const source of ['modelscope', 'hf-mirror']) {
      const url = urlFor(source, m);
      if (FULL) {
        const r = await fullSha(url);
        results[source] = r;
        const verdict = r.error ? `失败 ${r.error}` : `${r.status} ${(r.size / 1048576).toFixed(1)}MB ${r.ms}ms sha=${r.sha.slice(0, 12)}`;
        console.log(`   ${source.padEnd(11)} ${verdict}`);
      } else {
        const r = await head(url);
        results[source] = r;
        const verdict = r.error ? `失败 ${r.error}` : `${r.status} 总大小 ${r.total || '未给出'} ${r.ms}ms`;
        console.log(`   ${source.padEnd(11)} ${verdict}`);
      }
    }
    if (FULL) {
      const oks = Object.entries(results).filter(([, r]) => r.sha);
      for (const [, r] of oks) if (r.sha !== m.sha256) {
        console.log(`   ✗ sha256 与清单不一致（清单 ${m.sha256.slice(0, 12)}… 实得 ${r.sha.slice(0, 12)}…）`);
        problems += 1;
      }
      if (oks.length === 2 && oks[0][1].sha !== oks[1][1].sha) {
        console.log('   ✗ 两个源的字节不一致：不能共用一份 sha256，要么各自记录，要么换模型');
        problems += 1;
      }
      if (oks.length === 0) console.log('   （两个源都没取到内容，无法判定一致性）');
    } else {
      const totals = Object.values(results).map((r) => r.total).filter((n) => n > 0);
      if (totals.some((t) => t !== m.sizeBytes)) {
        console.log(`   ! 有源的总大小与清单不符（清单 ${m.sizeBytes}）`);
        problems += 1;
      }
    }
  }
  console.log(FULL ? `\n完整校验${problems ? `：${problems} 处不一致` : '：全部一致'}` : `\n快速检查发现 ${problems} 处可疑（加 --full 才能判定内容一致）`);
  process.exit(FULL && problems ? 1 : 0);
})();
