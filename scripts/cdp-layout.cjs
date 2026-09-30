/**
 * cdp:layout —— 连进真实运行的应用量布局，不靠猜也不靠肉眼往返。
 *
 * 用法：npm run cdp:up && npm run cdp:layout
 * 它做四件事：① 打开预览 ② 跑一次抠图拿到对比动作条（首次可能要等下载）
 * ③ 量 ai-bar 里各段是否真在同一行、底栏吃掉多少高度 ④ 把视口压到 860×600
 * 量网格工具行的「缩略图」标签与档位按钮有没有断句、有没有横向溢出。
 *
 * 每条 CDP 命令都带超时：窗口不可见时 captureScreenshot 会不出帧，
 * 无超时的写法会把整个会话挂死（这条是被实测过的坑）。
 */
const fs = require('fs');
const OUT_DIR = 'C:/Users/ybd06/temp/ptm-check';
const PORT = process.env.PTM_CDP_PORT || '9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const target = list.find((t) => t.type === 'page' && /index\.html/i.test(t.url)) ?? list.find((t) => t.type === 'page');
  if (!target) {
    console.error('没有 page 目标——先 npm run cdp:up');
    process.exit(1);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await Promise.race([
    new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('ws 连接失败'));
    }),
    sleep(8000).then(() => {
      throw new Error('ws 连接超时');
    })
  ]);

  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const w = waiting.get(msg.id);
    if (w) {
      waiting.delete(msg.id);
      w(msg.error ? { err: msg.error } : { ok: msg.result });
    }
  };
  const cmd = (method, params = {}, timeoutMs = 10000) =>
    new Promise((resolve) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve({ err: { message: `${method} 超时 ${timeoutMs}ms` } });
      }, timeoutMs);
      waiting.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  /** 在页面里跑一段表达式，返回值（JSON 可序列化） */
  const evalJs = async (expression) => {
    const r = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.err) return { __err: r.err.message ?? JSON.stringify(r.err) };
    return r.ok?.result?.value;
  };

  await cmd('Runtime.enable');
  await cmd('Page.enable');
  await cmd('Page.bringToFront', {}, 5000);

  const report = { port: PORT, at: new Date().toISOString(), steps: [] };

  // ① 打开预览
  let hasStage = await evalJs(`!!document.querySelector('[data-testid="preview-stage"]')`);
  if (!hasStage) {
    report.steps.push(
      await evalJs(`(() => { const c = document.querySelector('[aria-label^="打开图片预览："]');
        if (!c) return '网格里没有可点的卡片（根目录是否已扫描完成？）'; c.click(); return 'clicked'; })()`)
    );
    await sleep(1200);
    hasStage = await evalJs(`!!document.querySelector('[data-testid="preview-stage"]')`);
  }
  report.previewOpen = hasStage;
  if (!hasStage) {
    console.log(JSON.stringify(report, null, 2));
    ws.close();
    return;
  }

  // ② 跑一次抠图，拿到底栏的对比动作条
  let hasActions = await evalJs(`!!document.querySelector('[data-testid="ai-mode-group"]')`);
  if (!hasActions) {
    report.steps.push(
      await evalJs(`(() => { const wrap = document.querySelector('[data-testid="ai-split-button"]');
        if (!wrap) return '没有 ai-split-button';
        const b = wrap.querySelector('button[aria-busy]');
        if (!b) return '主按钮没找到'; b.click(); return 'clicked'; })()`)
    );
    for (let i = 0; i < 90; i += 1) {
      await sleep(1000);
      hasActions = await evalJs(`!!document.querySelector('[data-testid="ai-mode-group"]')`);
      if (hasActions) break;
    }
  }
  report.aiResultReady = hasActions;

  // ③ 量底栏：各段是否同一行、吃掉多少高度
  report.layout = await evalJs(`(() => {
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), height: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right) }; };
    const bar = document.querySelector('[data-testid="ai-bar"]');
    const stage = document.querySelector('[data-testid="preview-stage"]');
    const parts = {
      splitButton: rect(document.querySelector('[data-testid="ai-split-button"]')),
      modeGroup: rect(document.querySelector('[data-testid="ai-mode-group"]')),
      commitGroup: rect(document.querySelector('[data-testid="ai-commit-group"]')),
      meta: rect(document.querySelector('[data-testid="preview-meta"]'))
    };
    const centers = Object.values(parts).filter(Boolean).map((p) => p.top + p.height / 2);
    return {
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      stage: rect(stage),
      bar: rect(bar),
      parts,
      // 判"同一行"比中心线：标签与按钮组高度不同，垂直居中后 top 天然差几像素，
      // 拿 top 比会把同一行误判成 false（这版尺子自己就先错过一次，实测 4px 差被判两行）
      sameLine: centers.length > 1 ? Math.max(...centers) - Math.min(...centers) <= 8 : null,
      centerSpreadPx: centers.length > 1 ? Math.round(Math.max(...centers) - Math.min(...centers)) : null,
      tallestPartPx: centers.length ? Math.max(...Object.values(parts).filter(Boolean).map((p) => p.height)) : null,
      // 底栏整块（含标签行）吃掉的高度 = 视口高 - 大图区底边
      bottomPanelHeight: stage ? Math.round(innerHeight - stage.getBoundingClientRect().bottom) : null
    };
  })()`);

  // 顺带取一张图（窗口不可见时会超时，不作为失败）
  const shot = await cmd('Page.captureScreenshot', { format: 'png' }, 9000);
  if (shot.ok?.data) {
    const p = `${OUT_DIR}/layout-preview.png`;
    fs.writeFileSync(p, Buffer.from(shot.ok.data, 'base64'));
    report.screenshot = p;
  } else {
    report.screenshot = `拿不到帧（${shot.err?.message ?? '窗口不可见'}）——数值仍可用`;
  }

  // ④ 关掉预览，压到 860×600 量网格工具行的断句与溢出
  await evalJs(`(() => { const b = document.querySelector('[aria-label="关闭预览"]'); if (b) b.click(); return 'closed'; })()`);
  await sleep(600);
  await cmd('Emulation.setDeviceMetricsOverride', { width: 860, height: 600, deviceScaleFactor: 1, mobile: false });
  await sleep(900);
  report.narrow = await evalJs(`(() => {
    const labelOf = (text) => [...document.querySelectorAll('p,span,div')].find((e) => e.childElementCount === 0 && e.textContent.trim() === text);
    const rowOf = (el) => { let n = el; while (n && n.parentElement && getComputedStyle(n.parentElement).flexWrap === 'wrap') n = n.parentElement; return n; };
    const pair = (text) => { const lab = labelOf(text); if (!lab) return { text, found: false };
      const group = lab.parentElement.querySelector('[role="group"]');
      const a = lab.getBoundingClientRect(); const b = group ? group.getBoundingClientRect() : null;
      return { text, found: true, labelTop: Math.round(a.top), groupTop: b ? Math.round(b.top) : null,
        labelCenter: Math.round(a.top + a.height / 2), groupCenter: b ? Math.round(b.top + b.height / 2) : null,
        sameLine: b ? Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) <= 8 : null }; };
    return { viewport: { w: innerWidth, h: innerHeight },
      bodyOverflowX: document.body.scrollWidth - document.body.clientWidth,
      htmlOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      groups: [pair('排序'), pair('缩略图')] };
  })()`);
  const shotN = await cmd('Page.captureScreenshot', { format: 'png' }, 9000);
  if (shotN.ok?.data) {
    const p = `${OUT_DIR}/layout-narrow.png`;
    fs.writeFileSync(p, Buffer.from(shotN.ok.data, 'base64'));
    report.narrowScreenshot = p;
  }
  await cmd('Emulation.clearDeviceMetricsOverride');

  console.log(JSON.stringify(report, null, 2));
  const outFile = `${OUT_DIR}/layout-${Date.now()}.json`;
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\n落盘：${outFile}`);
  ws.close();
}

main().catch((e) => {
  console.error('跑挂了：', e.message ?? e);
  process.exit(1);
});
