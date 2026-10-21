/**
 * 发版前资产核验（对齐 v0.1.5 的验收标准）。
 *
 * 上次发版的教训写进了卷宗：「`latest.yml` / `exe` / `blockmap` 三件必须齐，
 * 缺 `latest.yml` 自动更新直接失效」。所以不能只看文件在不在，
 * 要核对 `latest.yml` 里声明的 size / sha512 与 exe 实测值**对得上** ——
 * 对不上，用户点了更新会下到一个损坏的包，且报错难懂。
 */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const DIST = 'dist';
const ymlPath = path.join(DIST, 'latest.yml');
const yml = fs.readFileSync(ymlPath, 'utf8');

const pick = (re) => (re.exec(yml) || [])[1];
const declaredVersion = pick(/version:\s*(\S+)/);
const declaredPath = pick(/path:\s*(\S+)/);
const declaredSize = pick(/size:\s*(\d+)/);
const declaredSha = pick(/sha512:\s*(\S+)/);

console.log('=== latest.yml 声明 ===');
console.log('  version =', declaredVersion);
console.log('  path    =', declaredPath);

const exeName = String(declaredPath).replace(/^\//, '');
const exePath = path.join(DIST, exeName);
const blockmapPath = `${exePath}.blockmap`;

if (!fs.existsSync(exePath)) {
  console.error('❌ latest.yml 指向的 exe 不存在:', exePath);
  process.exit(1);
}

const buf = fs.readFileSync(exePath);
const realSize = buf.length;
const realSha = 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64');

console.log('\n=== ① size 对账 ===');
console.log('  声明 =', declaredSize);
console.log('  实测 =', realSize);
const sizeOk = String(realSize) === declaredSize;
console.log('  →', sizeOk ? '✅ 一致' : '❌ 不一致');

console.log('\n=== ② sha512 对账 ===');
/**
 * ⚠️ `latest.yml` 里的值**不带 `sha512-` 前缀**（只有裸 base64），
 * 而 node 计算出来带前缀。直接比会误判成「不一致」——
 * 这是本次核验脚本第一次跑就踩到的假阴性。
 */
const realShaBare = crypto.createHash('sha512').update(buf).digest('base64');
const declaredShaBare = String(declaredSha).replace(/^sha512-/, '');
const shaOk = declaredShaBare === realShaBare;
console.log('  →', shaOk ? '✅ 与 exe 实测一致' : '❌ 与 exe 实测不一致');
if (!shaOk) {
  console.log('    声明 =', declaredShaBare.slice(0, 40), '...');
  console.log('    实测 =', realShaBare.slice(0, 40), '...');
}

console.log('\n=== ③ blockmap ===');
const bmOk = fs.existsSync(blockmapPath);
console.log('  ', blockmapPath);
console.log('  →', bmOk ? '✅ 存在' : '❌ 缺失（差分更新会失效）');

console.log('\n=== ④ 版本号一致性 ===');
// 相对路径基于脚本所在目录（scripts/），不是 cwd —— 这里必须用绝对路径回溯
const pkgVersion = require(path.join(__dirname, '..', 'package.json')).version;
const verOk = declaredVersion === pkgVersion;
console.log('  package.json =', pkgVersion, '| latest.yml =', declaredVersion);
console.log('  →', verOk ? '✅ 一致' : '❌ 不一致（自动更新会认错版本）');

console.log('\n=== 结论 ===');
const all = [sizeOk, shaOk, bmOk, verOk].every(Boolean);
console.log(all ? '✅ 四项全过，可以发布' : '❌ 有不通过项，不要发布');
process.exit(all ? 0 : 1);
