// §8-18 / D9 真机崩溃恢复复核。用法：npm run verify:ai-crash
//
// 三段场景，全部走 out/main/crashHarness.js 暴露的**生产** ChildRunner（不用副本，
// 否则跑绿只证明副本）：
//   B1 在途请求遇到子进程真死 → 当次任务必须以可读错误失败，不能把调用方挂住
//   A  注入必崩模型 BiRefNet-lite@DirectML（M0 实测：加载成功、一执行就 DmlFusedNode）
//   R  崩溃之后服务必须还能用：u2netp 重新加载 + 推理出正确形状的掩码
// 判定不达标就 exit 非 0；总超时 exit 3，不会像上一版那样无声挂死。
//
// 反向自检（证明这套断言真的会红）：
//   CP_ENTRY=out/main/nope.js npm run ... → 起不了子进程，探针必须非 0 退出
const { app, BrowserWindow, utilityProcess } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HARNESS = path.join(ROOT, 'out', 'main', 'crashHarness.js');
const CHILD = path.join(ROOT, 'out', 'main', 'aiChild.js');
const ENTRY = process.env.CP_ENTRY ? path.resolve(ROOT, process.env.CP_ENTRY) : CHILD;
const BIREFF = 'C:/Users/ybd06/temp/ptm-ortweb-probe/models/birefnet-lite.onnx';
const U2NETP = path.join(ROOT, 'tests', 'fixtures', 'models', 'u2netp.onnx');
const TOTAL_BUDGET_MS = Number(process.env.CP_BUDGET_MS || 300000);
const A_LOAD_MS = Number(process.env.CP_A_LOAD_MS || 120000);
const SETTLE_MS = Number(process.env.CP_SETTLE_MS || 20000);
// 实验开关：ChildRunner 只有一个 loadTimeoutMs，A 与 R 共用。用 CP_SKIP_A 单独验恢复链路，
// 不要用 CP_A_LOAD_MS=1 去"加快"实验——那会连 R 的预算一起压成 0 秒，得到假红。
const SKIP_A = process.env.CP_SKIP_A === '1';

/** 整卡已用显存（MiB）。口径与 §5.2 一致：拿不到分进程占用，只能看整卡。 */
const gpuUsed = () => {
  try {
    return Number(execSync('nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits', { timeout: 8000 }).toString().trim());
  } catch {
    return -1;
  }
};

const spec = (id, inputName, dims) => ({
  id, displayName: id, downloadUrl: '', fileName: `${id}.onnx`, sizeBytes: 1, sha256: 'x',
  verified: true, inputName, inputDims: dims, outputNameIndex: 0,
  normalize: { rescale: 1 / 255, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] }
});
// 张量名一律从实测取：u2netp=input.1 / BiRefNet-lite=input_image（2026-09-24 实测）
const U2 = spec('u2netp', 'input.1', [1, 3, 320, 320]);
const BIG = spec('birefnet-lite', 'input_image', [1, 3, 1024, 1024]);

const log = (m) => console.log('[crash-probe] ' + m);

app.whenReady().then(async () => {
  const t0 = Date.now();
  let aborted = false;
  const done = [];
  const fails = [];
  const watchdog = setTimeout(() => {
    aborted = true;
    log(`FAIL 总超时 ${TOTAL_BUDGET_MS}ms，已完成：${done.join(' | ')}`);
    app.exit(3);
  }, TOTAL_BUDGET_MS);

  const check = (name, ok, detail) => {
    if (aborted) {
      log(`SKIP ${name}（探针自身已因总超时退出，不计入产品判定）${detail ? ' — ' + detail : ''}`);
      return;
    }
    done.push(`${name}=${ok ? 'PASS' : 'FAIL'}${detail ? ' ' + detail : ''}`);
    if (!ok) fails.push(name);
    log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  };
  const stamp = (label) => log(`采样 ${label}：t=${Date.now() - t0}ms 整卡已用显存=${gpuUsed()}MiB`);

  if (!fs.existsSync(HARNESS)) { log('FAIL 缺 crashHarness.js，先跑 npm run build'); app.exit(4); return; }
  if (!fs.existsSync(BIREFF)) { log('FAIL 缺 BiRefNet 模型：' + BIREFF); app.exit(4); return; }
  if (!fs.existsSync(ENTRY)) log(`提示 入口不存在（反向自检用）：${ENTRY}`);

  const { ChildRunner, makeUtilityProcessSpawner } = require(HARNESS);
  const live = [];
  const prodSpawn = makeUtilityProcessSpawner({
    fork: (p) => { const c = utilityProcess.fork(p); live.push(c); return c; }
  });
  const runner = new ChildRunner({
    spawn: prodSpawn, entry: ENTRY,
    loadTimeoutMs: A_LOAD_MS,  // 224MB 模型：CPU 读元数据实测 17.1s；DirectML 首轮实测 240s 仍不返回
    requestTimeoutMs: 120000   // BiRefNet 1024² 的失败形态可能是长时间无响应而不是立即抛错
  });

  const win = new BrowserWindow({ show: false, width: 200, height: 100 });
  await new Promise((r) => setTimeout(r, 300));
  check('窗口已创建', !win.isDestroyed());

  // ---- B1：在途请求遇到子进程真死 ----
  let b1Err = null;
  const inflight = runner.load({ modelPath: U2NETP, model: U2, backend: 'dml' }).catch((e) => { b1Err = e; });
  await new Promise((r) => setTimeout(r, 400));
  const pid0 = live.length ? live[live.length - 1].pid : null;
  if (pid0) process.kill(pid0);
  const b1Started = Date.now();
  await inflight;
  check('B1 在途任务以错误失败（未静默成功）', !!b1Err, b1Err ? String(b1Err.message).slice(0, 70) : '居然成功了');
  check('B1 未把调用方挂住（<60s 返回）', Date.now() - b1Started < 60000, `${Date.now() - b1Started}ms`);
  check('B1 错误可读（提到子进程退出）', !!b1Err && /退出|超时/.test(b1Err.message));
  check('B1 主进程存活', process.uptime() > 0, `${Math.round(process.uptime()) * 1000}ms`);
  check('B1 窗口未被带崩', !win.isDestroyed());
  const restartsAfterB1 = runner.restartCount;
  stamp('B1 之后');

  // ---- A：注入必崩模型 ----
  let form = 'unknown', aDetail = '';
  stamp('A 之前');
  if (SKIP_A) {
    form = 'skipped';
    log('提示 CP_SKIP_A=1：跳过必崩模型注入，只验"真·进程被杀后的恢复"');
  } else {
    try {
      const l = await runner.load({ modelPath: BIREFF, model: BIG, backend: 'dml' });
      aDetail = `load ${l}ms`;
      const r = await runner.infer({ modelId: BIG.id, dims: BIG.inputDims, data: new Float32Array(3 * 1024 * 1024) });
      form = 'no-crash';
      aDetail += ` / infer ${r.inferMs}ms dims=${r.dims.join('x')}（未崩，需换注入方式）`;
    } catch (err) {
      form = /退出/.test(err.message) ? 'child-died' : /超时/.test(err.message) ? 'hang-timeout' : 'caught-in-child';
      aDetail += ' / ' + String(err.message).slice(0, 110);
    }
  }
  check('A 必崩模型未拖垮主进程', true, `崩溃形态=${form}${aDetail}`);
  check('A 窗口仍存活', !win.isDestroyed());
  check('A 主进程仍存活', process.uptime() > 0);
  stamp('A 中止之后');

  // ---- R：崩溃后服务必须还能用 ----
  // 静置 SETTLE_MS 是为了把"驱动侧回收慢"和"服务永久不可用"分开：
  // 静置后仍失败 = 恢复链路本身有问题；静置后成功 = 只是需要退避重试。
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  stamp(`R 之前（已静置 ${SETTLE_MS}ms）`);
  let rec = null, recErr = null;
  const rStart = Date.now();
  // CP_R_BACKEND=cpu 用来判别"卡住的是 DML 设备创建还是整个子进程"
  const rBackend = process.env.CP_R_BACKEND === 'cpu' ? 'cpu' : 'dml';
  try {
    await runner.load({ modelPath: U2NETP, model: U2, backend: rBackend });
    rec = await runner.infer({ modelId: U2.id, dims: U2.inputDims, data: new Float32Array(3 * 320 * 320) });
  } catch (err) { recErr = err; }
  const rCost = Date.now() - rStart;
  const forkInfo = `forks=${live.length} pids=${live.map((c) => c.pid).join(',')}`;
  check('R 恢复后 u2netp 推理成功', !recErr && !!rec, `backend=${rBackend} 用时 ${rCost}ms ${forkInfo}；${recErr ? String(recErr.message).slice(0, 90) : 'ok'}`);
  check('R 掩码形状正确', !!rec && rec.data.length === 102400 && rec.dims.join('x') === '1x1x320x320',
    rec ? `len=${rec.data.length} dims=${rec.dims.join('x')} out=${rec.outputName}` : '');
  check('R 自动重启确实发生过', runner.restartCount > restartsAfterB1, `restartCount=${runner.restartCount}`);
  check('R 窗口最终存活', !win.isDestroyed());

  clearTimeout(watchdog);
  await runner.dispose().catch(() => {});
  if (aborted) {
    log(`结论：ABORTED（探针总超时 ${TOTAL_BUDGET_MS}ms，产品判定未完成，剩余项记为 SKIP）崩溃形态=${form} 重启=${runner.restartCount} 次`);
    app.exit(3);
  } else if (fails.length) {
    log(`结论：FAIL（${fails.length} 条未过）→ ${fails.join(', ')}`);
    app.exit(1);
  } else {
    log(`结论：PASS 崩溃形态=${form} 重启=${runner.restartCount} 次 总耗时=${Date.now() - t0}ms`);
    app.exit(0);
  }
});
