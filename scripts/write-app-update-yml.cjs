/**
 * 给 `--win dir` 的解包产物补写 `resources/app-update.yml`。
 *
 * 为什么需要这个脚本：electron-builder 只在 **nsis 目标**的 afterPack 里写这份更新源配置
 * （`app-builder-lib/out/publish/PublishManager.js` 的 `isSuitableWindowsTarget` 只认 nsis/nsis-*）。
 * `npm run app:go` 走的是 `--win dir`，它会清空重建 `dist/win-unpacked`，把上一次 `npm run dist`
 * 生成的这份文件一并删掉——于是这份副本点「检查更新」必报
 * `ENOENT: ... resources\app-update.yml`，且点「重试」永远好不了（缺的是文件，不是网络）。
 *
 * 内容必须和 electron-builder 写出来的一致，所以两个来源都不硬编码：
 * 坐标取自 `package.json` 的 `build.publish`，`updaterCacheDirName` 按上游规则
 * `sanitizeFileName(name).toLowerCase() + "-updater"` 推导（仓库名是纯小写 slug，净化是空操作，
 * 因此这里对 name 做了字符集校验，不满足就报错而不是猜）。
 *
 * 单独跑：`node scripts/write-app-update-yml.cjs [resources 目录]`
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/**
 * 生成 app-update.yml 的正文。
 * @param {any} pkg 已解析的 package.json
 * @param {string} [cacheDirNameOverride] 仅单测用于覆盖推导结果
 * @returns {string} YAML 文本（键顺序与上游一致：publish 各字段在前，updaterCacheDirName 末尾）
 */
function buildAppUpdateYml(pkg, cacheDirNameOverride) {
  const publish = pkg && pkg.build && pkg.build.publish;
  const entry = Array.isArray(publish) ? publish[0] : publish;
  if (!entry || typeof entry !== 'object') {
    throw new Error('package.json 的 build.publish 缺失或不是坐标对象，无法生成 app-update.yml');
  }
  const name = pkg.name;
  // 上游净化会把文件系统非法字符替换掉；出现这类字符说明推导规则不再等价，宁可停下
  if (typeof name !== 'string' || !/^[a-z0-9._-]+$/.test(name)) {
    throw new Error(`包名 "${name}" 含大小写或文件系统非法字符，无法按上游规则推导 updaterCacheDirName`);
  }

  /** @type {Record<string, string|number|boolean>} */
  const config = { ...entry, updaterCacheDirName: cacheDirNameOverride ?? `${name.toLowerCase()}-updater` };
  return Object.entries(config)
    .map(([key, value]) => {
      if (value === null || typeof value === 'object') {
        throw new Error(`build.publish.${key} 是嵌套结构，app-update.yml 只支持标量字段`);
      }
      return `${key}: ${value}\n`;
    })
    .join('');
}

/**
 * 写入解包产物的 resources 目录。
 * @param {string} resourcesDir 形如 dist/win-unpacked/resources
 * @param {string} yaml 正文
 */
function writeAppUpdateYml(resourcesDir, yaml) {
  if (!fs.existsSync(resourcesDir)) {
    throw new Error(`目标目录不存在：${resourcesDir}（请先完成 electron-builder 解包）`);
  }
  const file = path.join(resourcesDir, 'app-update.yml');
  fs.writeFileSync(file, yaml, 'utf8');
  return file;
}

module.exports = { buildAppUpdateYml, writeAppUpdateYml };

if (require.main === module) {
  const pkg = require(path.join(ROOT, 'package.json'));
  const outDir = (pkg.build && pkg.build.directories && pkg.build.directories.output) || 'dist';
  const resourcesDir = process.argv[2] || path.join(ROOT, outDir, 'win-unpacked', 'resources');
  try {
    const yaml = buildAppUpdateYml(pkg);
    const file = writeAppUpdateYml(resourcesDir, yaml);
    console.log(`已写入 ${file}\n${yaml.trimEnd()}`);
  } catch (err) {
    console.error(`补写 app-update.yml 失败：${err.message}`);
    process.exit(1);
  }
}
