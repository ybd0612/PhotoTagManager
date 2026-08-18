/**
 * 图片扩展名白名单（主进程 / Worker / 渲染进程共用）。
 * 通过 exiftool-vendored 支持 JPG/PNG/WebP/RAW/HEIC/TIFF 等常见格式（R11）。
 */

export const IMAGE_EXTENSIONS: readonly string[] = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
  '.tif',
  '.tiff',
  '.heic',
  '.heif',
  '.raw',
  '.cr2',
  '.cr3',
  '.nef',
  '.arw',
  '.dng',
  '.orf',
  '.rw2'
];

/**
 * 判断文件名是否为受支持的图片文件（扩展名小写匹配）。
 * @param fileName 文件名（含扩展名）
 */
export function isImageFile(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return false;
  const ext = fileName.slice(dot).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
}
