#!/usr/bin/env node
/**
 * app:win —— 在「当前会话注入了 ELECTRON_RUN_AS_NODE / GPU 进程会崩」的环境里启动已打包产物。
 *
 * 为什么不直接用 `npm run app:go`：那一条龙里的启动步骤走的是 `Start-Process`，
 * 而**注入变量是会话级的**——`env -u` 或 `$env:X=$null` 只影响自己这一层，
 * 子进程照样继承，于是 Electron 退化成纯 Node 进程（表现为 `bad option: --xxx`
 * 或窗口标题变成 "has stopped working"）。所以启动必须在一个变量已清干净、
 * 且不会被回收的独立会话里做。
 *
 * 用法：
 *   node scripts/start-windows.cjs              启动 dist/win-unpacked 产物
 *   PTM_CDP_PORT=9222 node scripts/start-windows.cjs   附带远程调试端口
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EXE = path.resolve(__dirname, '..', 'dist', 'win-unpacked', 'PhotoTagManager.exe');

if (!fs.existsSync(EXE)) {
  console.error(`找不到已打包产物：${EXE}\n请先运行 npm run app:go（或本脚本会自动提示）。`);
  process.exit(1);
}

/**
 * Electron 会把这些变量当成 Node 的。`ELECTRON_RUN_AS_NODE=1` 直接让它不启动 GUI，
 * 是「点了没反应 / 秒退 / bad option」最常见的原因。
 */
const STRIP = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'NODE_OPTIONS',
  'CODEBUDDY_SAFE_DELETE_BULK_GUARD',
  'CODEBUDDY_SAFE_DELETE_BIN_DIR'
];

/**
 * GPU 相关开关。本机 4 个虚拟显示器（向日葵 / ToDesk / GameViewer）会让 GPU 进程
 * 以 `exit_code=-1073741819` 反复崩溃，最终 `GPU process isn't usable. Goodbye.`，
 * 窗口标题变成 "has stopped working"。`--in-process-gpu` 让它退回软件渲染。
 *
 * ⚠️ 这只影响**界面合成**，不影响 AI 推理后端（推理走 onnxruntime 的 DirectML/CPU，
 * 与 Chromium 的 GPU 进程无关）——项目里 `PTM_DISABLE_GPU` 也是这个口径。
 */
const GPU_FLAGS = ['--disable-gpu', '--disable-gpu-compositing', '--in-process-gpu'];

const env = { ...process.env };
for (const key of STRIP) delete env[key];

const args = [...GPU_FLAGS];
if (process.env.PTM_CDP_PORT) args.push(`--remote-debugging-port=${process.env.PTM_CDP_PORT}`);

console.log('启动：', EXE);
console.log('已清除会话注入的变量：', STRIP.join(', '));
if (process.env.PTM_CDP_PORT) console.log(`CDP 端口：${process.env.PTM_CDP_PORT}`);

const child = spawn(EXE, args, {
  env,
  detached: true,
  stdio: 'inherit'
});

child.unref();
console.log(`已启动 pid=${child.pid}（独立进程，不随本脚本退出而结束）`);