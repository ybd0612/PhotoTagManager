/**
 * app:go —— 改完代码后一条龙：杀掉在跑的实例 → 构建 → 打包到 dist/win-unpacked → 自动启动。
 *
 * 为什么要脚本化，而不是分三条命令手敲：
 * 1) 顺序不能错。win-unpacked 里有文件被运行中的实例占用时，electron-builder 清空输出目录会报
 *    "Access is denied"，构建直接失败——所以必须先杀后建。
 * 2) 已安装的正式版（Program Files 下那个同名进程）也要一起杀。应用有单实例锁，锁按 userData 目录算，
 *    两个安装位置共用同一份 userData；正式版在跑时，刚启动的 win-unpacked 实例只会把对方的窗口顶到
 *    前台然后自己退出，看起来"启动没反应"。
 * 3) 杀之前把要杀的进程列出来，误杀别人的东西时至少有个记录。
 *
 * 需要顺带连 CDP 做验证时：PTM_CDP_PORT=9222 npm run app:go（默认不开调试端口）。
 */
const { spawnSync } = require('child_process');
const path = require('path');

const EXE = path.resolve(__dirname, '..', 'dist', 'win-unpacked', 'PhotoTagManager.exe');
const CDP_PORT = process.env.PTM_CDP_PORT || '';

/**
 * 跑一条命令，非零退出就停在这里，不要把失败往后传。
 * 必须走 shell：npm/npx 在 Windows 上是 .cmd，而 Node 的安全补丁（CVE-2024-27982）禁止
 * 不带 shell 启动 .cmd，直接 spawnSync('npm.cmd', …) 会抛 EINVAL。
 * 这里的命令串全部是本脚本里的固定字面量，不拼任何外部输入，所以走 shell 没有注入面。
 */
function run(command, label) {
  console.log(`\n=== ${label} ===`);
  const res = spawnSync(command, { stdio: 'inherit', shell: true });
  if (res.error) {
    console.error(`${label} 起不来：${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`${label} 失败（退出码 ${res.status}），停在一条龙这一步`);
    process.exit(res.status ?? 1);
  }
}

const ps = (script) => spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });

// ① 杀掉所有在跑的实例（含已安装的正式版），并列出杀了谁
const killOut = ps(
  '$ps = Get-Process PhotoTagManager -ErrorAction SilentlyContinue; ' +
    'if ($ps) { $ps | ForEach-Object { "killed pid=$($_.Id) path=$($_.Path)" }; Stop-Process -Id $ps.Id -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 1200 } ' +
    'else { "none" }'
);
console.log('=== 杀进程 ===');
console.log((killOut.stdout || '').trim() || '(没有在跑的实例)');

// ② 构建 renderer/main/preload 到 out/
run('npm run build', '构建 out/');

// ③ 只解包不打安装器，产物落在 dist/win-unpacked
run('npx electron-builder --win dir --publish never', '打包 dist/win-unpacked');

// ④ 启动；带调试端口时不等待，让调用方自己去连
const launchArgs = CDP_PORT ? [`--remote-debugging-port=${CDP_PORT}`] : [];
// 用 PowerShell 单引号包路径：单引号串里反斜杠是字面量，不像 JSON.stringify 会转义成双反斜杠
const sq = (s) => `'${s.replace(/'/g, "''")}'`;
const launched = ps(
  `$p = Start-Process -FilePath ${sq(EXE)} -PassThru` +
    (launchArgs.length ? ` -ArgumentList ${launchArgs.map((a) => sq(a)).join(',')}` : '') +
    '; Start-Sleep -Seconds 6; "pid=$($p.Id)"'
);
const pidLine = (launched.stdout || '').trim();
console.log(`=== 启动 ===\n${pidLine || '(没拿到 pid)'}`);
if (CDP_PORT) console.log(`CDP 端口 ${CDP_PORT}（脚本已等 6 秒，进程若还在启动中请重试连接）`);
