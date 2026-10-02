/**
 * 生成应用图标：build/icon.ico（打包用）+ electron/appIcon.ts（运行时用）。
 *
 * 为什么要脚本化：electron-builder 缺 icon 时**静默用 Electron 默认图标**，只在日志里留一行
 * `default Electron icon is used`——不报错，所以每次出包都在悄悄发那张蓝方块。
 *
 * 为什么手写 ICO 容器：本机 sharp@0.35.4 的 typings 里没有 ico 输出选项，指望它不如自己封。
 * ICO 是 Vista+ 允许内嵌 PNG 的简单容器，封完再**反解一遍数条目**，
 * 尺寸少一个就直接失败——不许把"看着生成了"当成生成对了。
 *
 * 为什么还要生成 appIcon.ts：exe 里那张 ICO 只管得到"装出来的包"。开发态跑的是 electron.exe，
 * 窗口没传 icon 就落回 Electron 默认图标；托盘又另贴过一张占位图——于是同一款软件四张脸。
 * 把窗口和托盘要用的 PNG 以 data URL 形式从**同一张 SVG** 生成、由主进程 import，
 * 它会跟着 out/main/index.js 一起被打包，开发态与安装包读到的是同一份字节，
 * 不必往 asar 里额外塞图片文件（塞了还得改 build.files 白名单，漏一项就是托盘变空白）。
 *
 * 用法：node scripts/make-icon.cjs
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const OUT = path.resolve(__dirname, '..', 'build', 'icon.ico');
const OUT_MODULE = path.resolve(__dirname, '..', 'electron', 'appIcon.ts');
/** 品牌图的唯一来源：界面（src/components/BrandLogo.tsx）import 的也是这个文件 */
const BRAND_SVG = path.resolve(__dirname, '..', 'shared', 'brand-mark.svg');
/** 窗口图标在高 DPI 下会被系统放大，取 64 留足余量；托盘沿用原先的 32 */
const RUNTIME = { window: 64, tray: 32 };

/**
 * 品牌 indigo（与 src/App.tsx 的 primary.main 同色）：圆角方底 + 一张照片 + 一枚标签。
 * 从 shared/brand-mark.svg 读，不写在这里——渲染进程顶栏那颗（src/components/BrandLogo.tsx）
 * import 的是同一个文件，两处各存一份必然漂移成两张图。
 */
const SVG = fs.readFileSync(BRAND_SVG, 'utf8');

async function pngAt(size) {
  return sharp(Buffer.from(SVG), { density: 300 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

/** 组 ICO：ICONDIR + n×ICONDIRENTRY + 各 PNG 原样拼接（256 在目录里记 0） */
function buildIco(images) {
  const count = images.length;
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // 类型 1 = icon
  head.writeUInt16LE(count, 4);
  const entrySize = 16;
  const offsetOfData = 6 + entrySize * count;
  const entries = Buffer.alloc(entrySize * count);
  let cursor = offsetOfData;
  images.forEach((img, i) => {
    const off = i * entrySize;
    const s = img.size;
    entries[off] = s >= 256 ? 0 : s; // 宽
    entries[off + 1] = s >= 256 ? 0 : s; // 高
    entries[off + 2] = 0; // 调色板色数
    entries[off + 3] = 0;
    entries.writeUInt16LE(1, off + 4); // planes
    entries.writeUInt16LE(32, off + 6); // bitCount
    entries.writeUInt32LE(img.buf.length, off + 8);
    entries.writeUInt32LE(cursor, off + 12);
    cursor += img.buf.length;
  });
  return Buffer.concat([head, entries, ...images.map((x) => x.buf)]);
}

/** 取 PNG 的 IHDR 宽高；签名不对返回 null，让调用方判失败 */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

(async () => {
  const images = [];
  for (const size of SIZES) {
    images.push({ size, buf: await pngAt(size) });
  }
  const ico = buildIco(images);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, ico);

  // 反解自证：类型、条目数、每个尺寸、每段是不是 PNG
  const type = ico.readUInt16LE(2);
  const count = ico.readUInt16LE(4);
  const got = [];
  let pngOk = true;
  for (let i = 0; i < count; i += 1) {
    const off = 6 + i * 16;
    const w = ico[off] === 0 ? 256 : ico[off];
    const dataOff = ico.readUInt32LE(off + 12);
    const isPng = ico.readUInt32BE(dataOff) === 0x89504e47;
    if (!isPng) pngOk = false;
    got.push(w);
  }
  const missing = SIZES.filter((s) => !got.includes(s));
  console.log(`${OUT}  ${ico.length} 字节  type=${type} 条目=${count} 尺寸=${got.sort((a, b) => a - b).join(',')}`);
  if (type !== 1 || missing.length > 0 || !pngOk) {
    console.error(`FAIL 缺尺寸=${missing.join(',') || '无'} 类型应为 1 实为 ${type} PNG 签名=${pngOk}`);
    process.exit(1);
  }
  console.log('PASS ICO 七档齐备且每段是合法 PNG');

  // 运行时图标：直接复用上面渲染好的同一批 PNG，不重新画一遍
  const windowPng = images.find((x) => x.size === RUNTIME.window).buf;
  const trayPng = images.find((x) => x.size === RUNTIME.tray).buf;
  const moduleSrc = `/**
 * 由 scripts/make-icon.cjs 生成（npm run icon），请勿手改。
 * 画稿唯一来源是 shared/brand-mark.svg，与 build/icon.ico 及界面顶栏那颗（src/components/BrandLogo.tsx）同源，
 * 让安装包 exe、开发态窗口/任务栏、系统托盘和界面是同一张图。
 */
export const APP_ICON_WINDOW_DATA_URL = 'data:image/png;base64,${windowPng.toString('base64')}';
export const APP_ICON_TRAY_DATA_URL = 'data:image/png;base64,${trayPng.toString('base64')}';
`;
  fs.writeFileSync(OUT_MODULE, moduleSrc);

  // 反解自证：常量在不在、base64 能不能解回 PNG、尺寸对不对
  const written = fs.readFileSync(OUT_MODULE, 'utf8');
  const readBack = (name) => {
    const m = written.match(new RegExp(`export const ${name} = 'data:image/png;base64,([A-Za-z0-9+/=]*)'`));
    return m ? pngSize(Buffer.from(m[1], 'base64')) : null;
  };
  const win = readBack('APP_ICON_WINDOW_DATA_URL');
  const tray = readBack('APP_ICON_TRAY_DATA_URL');
  console.log(`${OUT_MODULE}  窗口=${win ? `${win.w}x${win.h}` : '缺失'} 托盘=${tray ? `${tray.w}x${tray.h}` : '缺失'}`);
  if (
    !win || !tray ||
    win.w !== RUNTIME.window || win.h !== RUNTIME.window ||
    tray.w !== RUNTIME.tray || tray.h !== RUNTIME.tray
  ) {
    console.error(`FAIL 运行时图标应为 窗口 ${RUNTIME.window} 托盘 ${RUNTIME.tray}，实为 ${JSON.stringify({ win, tray })}`);
    process.exit(1);
  }
  console.log('PASS 运行时图标模块与 ICO 同源，两档尺寸齐备');
})();
