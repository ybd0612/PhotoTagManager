/**
 * cdp:up —— 用调试端口启动打包产物，并等端口真的能连上。
 *
 * 为什么要脚本化：应用有单实例锁（electron/main.ts），带参数启动时若已有实例在跑，
 * 新进程只会把旧窗口顶到前台、端口根本不开，看起来"起了"其实没起。所以这里先查残留进程，
 * 再启动，再轮询 /json/version 确认可用——把这三步压成一条命令，省得每次手敲还踩空。
 *
 * 只作用于 dist/win-unpacked：dev 实例的 userData 是 %APPDATA%\Electron（没有根目录），
 * 连上去只能看到空态，量不到真界面。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PTM_CDP_PORT || '9222';
const EXE = path.resolve(__dirname, '..', 'dist', 'win-unpacked', 'PhotoTagManager.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function portReady() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

(async () => {
  if (!fs.existsSync(EXE)) {
    console.error(`找不到 ${EXE}——先跑 npm run build && npm run dist`);
    process.exit(1);
  }
  if (await portReady()) {
    console.log(`端口 ${PORT} 已在监听，应用已带调试端口跑着，不重复启动`);
    return;
  }
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { detached: true, stdio: 'ignore' });
  child.unref();
  console.log(`已启动 ${path.basename(EXE)}（pid ${child.pid}），等端口 ${PORT} ...`);
  for (let i = 0; i < 40; i += 1) {
    if (await portReady()) {
      console.log(`CDP 就绪 http://127.0.0.1:${PORT}`);
      return;
    }
    await sleep(500);
  }
  console.error(`20 秒内端口 ${PORT} 没起来。多半是还有实例在跑：npm run app:kill 后重试`);
  process.exit(1);
})();
