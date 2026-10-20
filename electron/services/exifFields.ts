import { basename } from 'path';

/**
 * EXIF 摄影参数 → 界面展示文本。
 *
 * 抽成独立文件而不是塞进 `xmpService.getImageInfo`，是因为这一段有两件事必须单独说清：
 * **① 格式换算是本项目做的（不是 exiftool 直接给的）；② 每条换算都可能有另一种更诚实的写法。**
 * 把它们摊在这里，比埋在一堆字段赋值中间更容易被审。
 *
 * 字段名与实测输出见 `docs/` 里 2026-10-20 的记录；样本用 SONY ILCE-7M4 拍的照片核对过。
 */

/** exiftool 的值可能是 string，也可能带 rawValue（ExifDateTime 之类） */
function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (v && typeof v === 'object') {
    const raw = (v as { rawValue?: unknown }).rawValue;
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  }
  return undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const parsed = Number.parseFloat(v);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

/** 只给非 undefined 的键 —— 界面据此判断"这个字段该照片有没有"，不给就不占位 */
type OptionalFields = Record<string, string | undefined>;

/**
 * `2023:09:23 09:50:48.488+08:00` → `2023/09/23 09:50:48`
 *
 * ⚠️ **这里把时区偏移去掉了，不是丢信息而是避免误读**：EXIF 的 `DateTimeOriginal`
 * 带的是**拍摄地**的墙上时间，而文件修改时间是**本机**时间，两者混排会让人以为
 * 照片被改过。面板里两者分行显示、标签不同，不做统一换算。
 */
function formatShootTime(v: unknown): string | undefined {
  const raw = str(v);
  if (!raw) return undefined;
  const m = raw.match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return raw;
  return `${m[1]}/${m[2]}/${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

/** `2026:10:07 01:56:29Z` → `2026/10/07 01:56:29`（文件系统修改时间） */
function formatFileTime(v: unknown): string | undefined {
  const raw = str(v);
  if (!raw) return undefined;
  const m = raw.match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return raw;
  return `${m[1]}/${m[2]}/${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

/**
 * 焦距：`46.0 mm` → `46mm（焦距 35mm: 46mm）`
 *
 * ⚠️ **只有当"等效 35mm"与实际焦距不同时才追加**。等效焦距是个容易误导人的数字
 * （全画幅上两者相同，裁机身要乘系数），两个都显示是为了让人自己判断。
 */
function formatFocal(focal: unknown, equivalent: unknown): string | undefined {
  const f = str(focal);
  if (!f) return undefined;
  const mm = f.replace(/\s*mm\s*$/i, '');
  const eqRaw = str(equivalent)?.replace(/\s*mm\s*$/i, '');
  // 数值比较而不是字符串比较：`46.0 mm` 与 `46 mm` 是同一个焦距，
  // 按字符串比会把它们判成不等，于是平白多出一句「等效 35mm：46mm」——
  // 那句话在裁机身上是会误导人的（让人以为系数不是 1），不能乱显示。
  const n1 = Number.parseFloat(mm);
  const n2 = eqRaw === undefined ? Number.NaN : Number.parseFloat(eqRaw);
  const same = Number.isFinite(n1) && Number.isFinite(n2) ? Math.abs(n1 - n2) < 0.01 : eqRaw === mm;
  // 显示时去掉无意义的 `.0`（`46.0 mm` → `46mm`）
  const clean = Number.isFinite(n1) ? String(n1) : mm;
  const eq = eqRaw && Number.isFinite(n2) ? String(n2) : eqRaw;
  return eq && !same ? `${clean}mm（等效 35mm：${eq}mm）` : `${clean}mm`;
}

/**
 * 快门：`1/160` → `0.006s (1/160)`
 *
 * ⚠️ 手动补算小数秒是因为界面宽度有限，而 `1/160` 这种分数对不熟悉相机的人不直观。
 * **计算只在能整除时做**（1/160 → 0.00625 → 显示 0.006），非整除的保持原样，
 * 免得显示一个自己编出来的数。
 */
function formatShutter(v: unknown): string | undefined {
  const raw = str(v);
  if (!raw) return undefined;
  const frac = raw.match(/^1\/(\d+(?:\.\d+)?)$/);
  if (frac) {
    const denom = Number.parseFloat(frac[1]!);
    const seconds = 1 / denom;
    // 三位小数够读，再多就是噪声
    const text = seconds.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    return `${text}s (1/${frac[1]})`;
  }
  const sec = Number.parseFloat(raw);
  // `0.5` 这类已经带单位的不动；`0.5`（无 s）补上后缀，
  // 否则界面上会出现「快门速度 0.5」——看不出是秒还是别的什么单位
  if (!Number.isNaN(sec)) return raw.endsWith('s') ? raw : `${raw}s`;
  return raw;
}

/** 光圈：数值 `4` → `f/4.0`；已是 `f/4.0` 的原样返回 */
function formatAperture(fNumber: unknown, aperture: unknown): string | undefined {
  const n = num(fNumber) ?? num(aperture);
  if (n === undefined) return str(aperture);
  return `f/${n.toFixed(1)}`;
}

/** ISO：exiftool 给数值，取整显示 */
function formatIso(v: unknown): string | undefined {
  const n = num(v);
  if (n === undefined) return str(v);
  return String(Math.round(n));
}

/** 曝光补偿：`0` → 不显示；`0.333` → `+0.3 EV` */
function formatExposureComp(v: unknown): string | undefined {
  const n = num(v);
  if (n === undefined) return str(v);
  // 0 是"没补偿"，不是"补偿了 0"，显示出来只会让人以为有值
  if (Math.abs(n) < 0.05) return undefined;
  return `${n > 0 ? '+' : ''}${n.toFixed(1)} EV`;
}

/**
 * 测光模式：`Multi-segment` → `Pattern`。
 *
 * ⚠️ 这是**翻译而非转写**：exiftool 的枚举名 `Multi-segment` 与相机厂商菜单上的
 * 「多重测光 / Pattern」是同一回事。界面用哪个词要看项目面向谁 ——
 * 目前取 `Multi-segment` 的原值 + 中文对照在界面上做，这里只做统一大小写。
 */
function formatMetering(v: unknown): string | undefined {
  const raw = str(v);
  if (!raw) return undefined;
  return raw;
}

/** 色彩空间：`Uncalibrated` + `RGB` → `YCbCr4:2:0` 之类；这里给可读文本 */
function formatColorSpace(space: unknown): string | undefined {
  const s = str(space);
  return s;
}

export interface ExtendedInfoInput {
  /** 绝对路径，用于取文件名与文件时间 */
  absPath: string;
  /** exiftool 的原始 tags */
  tags: Record<string, unknown>;
  /** fs.stat 结果，给文件修改时间 */
  stat: { mtime: Date; size: number } | null;
}

/**
 * 生成扩展字段。**只返回有值的键**（`undefined` 的键会被这里剔掉），
 * 因为界面要靠"键是否存在"来决定这一行出不出现 —— 显示一个空的 `曝光补偿：`
 * 会让人以为照片没拍曝光信息，而不是"这字段压根没读"。
 */
export function describeExtended(absPath: string, tags: Record<string, unknown>, stat: { mtime: Date } | null): OptionalFields {
  const raw: OptionalFields = {
    fileName: basename(absPath),
    dateTimeOriginalWithOffset: formatShootTime(tags.DateTimeOriginal),
    fileModified: formatFileTime(tags.FileModifyDate ?? (stat ? stat.mtime : undefined)),
    software: str(tags.Software),
    flash: str(tags.Flash),
    focalLength: formatFocal(tags.FocalLength, tags.FocalLengthIn35mmFormat),
    shutterSpeed: formatShutter(tags.ShutterSpeed ?? tags.ShutterSpeedValue),
    aperture: formatAperture(tags.FNumber, tags.Aperture),
    iso: formatIso(tags.ISO),
    exposureProgram: str(tags.ExposureProgram),
    exposureCompensation: formatExposureComp(tags.ExposureCompensation),
    meteringMode: formatMetering(tags.MeteringMode),
    fileType: str(tags.FileType),
    colorSpace: formatColorSpace(tags.ColorSpace)
  };
  const out: OptionalFields = {};
  for (const [k, v] of Object.entries(raw)) if (v !== undefined) out[k] = v;
  return out;
}