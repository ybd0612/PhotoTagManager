// 真 Electron utilityProcess 探针：验证打包后的 aiChild.js 能被 fork、
// 走 process.parentPort 协议、在子进程里建 DirectML 会话并回传掩码。
const { app, utilityProcess } = require('electron');
const path = require('path');

const ROOT = 'C:/Users/ybd06/Documents/project/PhotoTagManager';
const CHILD = path.join(ROOT, 'out/main/aiChild.js');
const MODEL = path.join(ROOT, 'tests/fixtures/models/u2netp.onnx');
const model = {
  id: 'u2netp', displayName: 'U2Netp',
  downloadUrl: 'https://hf-mirror.com/BritishWerewolf/U-2-Netp/resolve/main/onnx/model.onnx',
  fileName: 'u2netp.onnx', sizeBytes: 4574861,
  sha256: '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8',
  verified: true, inputName: 'input.1', inputDims: [1, 3, 320, 320],
  outputNameIndex: 0, normalize: { rescale: 1 / 255, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] }
};

app.whenReady().then(() => {
  const t0 = Date.now();
  const child = utilityProcess.fork(CHILD);
  let seq = 0;
  const pending = new Map();
  child.on('message', (msg) => {
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p(msg); }
  });
  child.on('exit', (code) => { console.log('[probe] child exit code=' + code); process.exit(0); });
  const send = (type, payload) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    child.postMessage({ id, type, payload });
  });
  (async () => {
    const load = await send('load', { modelPath: MODEL, model, backend: 'dml' });
    console.log('[probe] load reply ok=' + load.ok + ' ' + JSON.stringify(load.ok ? load.data : load.message).slice(0, 120));
    const dims = model.inputDims;
    const data = new Float32Array(dims[0] * dims[1] * dims[2] * dims[3]);
    const infer = await send('infer', { modelId: model.id, dims, data });
    if (infer.ok) {
      const d = infer.data;
      let min = Infinity, max = -Infinity;
      for (let i = 0; i < d.data.length; i++) { if (d.data[i] < min) min = d.data[i]; if (d.data[i] > max) max = d.data[i]; }
      console.log('[probe] infer ok len=' + d.data.length + ' dims=' + d.dims.join('x') + ' out=' + d.outputName + ' inferMs=' + d.inferMs + ' range=[' + min.toFixed(3) + ',' + max.toFixed(3) + ']');
    } else {
      console.log('[probe] infer FAILED: ' + infer.message);
    }
    const bad = await send('bogus', {});
    console.log('[probe] 未知类型回 ok=' + bad.ok + ' msg=' + (bad.message || ''));
    console.log('[probe] 总耗时 ' + (Date.now() - t0) + 'ms');
    child.kill();
  })();
});
