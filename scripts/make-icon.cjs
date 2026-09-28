/**
 * 生成应用图标 build/icon.ico。
 *
 * 为什么要脚本化：electron-builder 缺 icon 时**静默用 Electron 默认图标**，只在日志里留一行
 * `default Electron icon is used`——不报错，所以每次出包都在悄悄发那张蓝方块。
 *
 * 为什么手写 ICO 容器：本机 sharp@0.35.4 的 typings 里没有 ico 输出选项，指望它不如自己封。
 * ICO 是 Vista+ 允许内嵌 PNG 的简单容器，封完再**反解一遍数条目**，
 * 尺寸少一个就直接失败——不许把"看着生成了"当成生成对了。
 *
 * 用法：node scripts/make-icon.cjs
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const OUT = path.resolve(__dirname, '..', 'build', 'icon.ico');

/** 品牌 indigo（与 src/App.tsx 的 primary.main 同色）：圆角方底 + 一张照片 + 一枚标签 */
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#4f46e5"/><stop offset="1" stop-color="#4338ca"/>
  </linearGradient></defs>
  <rect x="8" y="8" width="240" height="240" rx="52" fill="url(#g)"/>
  <rect x="56" y="62" width="144" height="108" rx="14" fill="#ffffff" opacity="0.95"/>
  <circle cx="95" cy="99" r="13" fill="#818cf8"/>
  <path d="M62 162l46-48 33 33 27-25 30 40H62z" fill="#4f46e5"/>
  <path d="M146 148h60a12 12 0 0 1 12 12v46a12 12 0 0 1-12 12h-60l-26-35 26-35z" fill="#0ea5e9"/>
  <circle cx="188" cy="196" r="9" fill="#ffffff"/>
</svg>`;

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
})();
