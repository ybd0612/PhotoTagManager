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
  const evalJs = async (expression) => {
    const r = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.err) return { __err: r.err.message ?? JSON.stringify(r.err) };
    return r.ok?.result?.value;
  };

  await cmd('Runtime.enable');
  await cmd('Page.enable');
  await cmd('Page.bringToFront', {}, 5000);
  const report = { port: PORT, at: new Date().toISOString(), steps: [] };

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
  if (hasStage) {
    report.preview = await evalJs(`(() => {
      const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), height: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right) }; };
      const stage = document.querySelector('[data-testid="preview-stage"]');
      const panel = document.querySelector('[data-testid="exif-panel"]');
      return { viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
        stage: rect(stage), exifPanel: rect(panel),
        bottomPanelHeight: stage ? Math.round(innerHeight - stage.getBoundingClientRect().bottom) : null };
    })()`);
    const shot = await cmd('Page.captureScreenshot', { format: 'png' }, 9000);
    if (shot.ok?.data) {
      const p = `${OUT_DIR}/preview-layout.png`;
      fs.writeFileSync(p, Buffer.from(shot.ok.data, 'base64'));
      report.screenshot = p;
    } else {
      report.screenshot = `拿不到帧（${shot.err?.message ?? '窗口不可见'}）——数值仍可用`;
    }
  }

  await evalJs(`(() => { const b = document.querySelector('[aria-label="关闭预览"]'); if (b) b.click(); return 'closed'; })()`);
  await sleep(600);
  await cmd('Emulation.setDeviceMetricsOverride', { width: 860, height: 600, deviceScaleFactor: 1, mobile: false });
  await sleep(900);
  report.narrow = await evalJs(`(() => {
    const labelOf = (text) => [...document.querySelectorAll('p,span,div')].find((e) => e.childElementCount === 0 && e.textContent.trim() === text);
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
