import { Box, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import CloseIcon from '@mui/icons-material/Close';

import { overlay, px, tokens } from '../theme/tokens';
import type { ImageInfo } from '../../shared/types';

/**
 * 大图预览左上角的 EXIF 信息面板（2026-10-20）。
 *
 * 为什么从底栏搬上来：底栏那行信息既挤又只有 4 个字段，而摄影参数恰恰是
 * 打开一张照片时最想看的东西 —— 放在底栏右端既不显眼、也放不下。
 *
 * 三条设计约束：
 * - **字段缺就不出那一行**。显示「闪光灯：」后面空着，会让人以为照片没拍，
 *   而不是"这个字段读不到"。所以列表是**按值过滤**后渲染的，不是固定 15 行。
 * - **不透明度低、指针事件只给自己的按钮**。面板盖在照片上，
 *   `pointer-events: none` 让下面那块照片仍能拖动/缩放，
 *   否则按住照片放大时会先被面板吃掉手势。
 * - **折叠状态落盘**（`exifPanelExpanded`），默认展开 —— 用户 2026-10-20 明确要求。
 */

/**
 * 面板底色：**比 `captionScrim` 淡得多**（2026-10-20 用户两次反馈"有点黑"）。
 *
 * `overlay.captionScrim` 是 0.82 不透明度的深色 —— 那是给**缩略图底部文件名**
 * 用的，压在照片上要的就是这个深度，否则白字读不出。
 * 但 EXIF 面板有 15 行、深色面积大得多，用同一个值会糊掉大片画面。
 * 0.55 仍偏重（用户第二次要求更透），现在取 **0.38**。
 *
 * 文字可读性不靠底色深浅撑着 —— 每行都有 `textShadow`，那是双保险。
 */
const PANEL_SCRIM = 'rgba(9,12,20,0.38)';

interface Props {
  info: ImageInfo | null;
  loading: boolean;
  error: boolean;
  expanded: boolean;
  onToggle: () => void;
}

/** 一行：标签 + 值。值缺失的行不会走到这里（调用方已过滤） */
function row(label: string, value: string): JSX.Element {
  return (
    <Stack direction="row" spacing={1} alignItems="baseline" sx={{ minWidth: 0 }}>
      <Typography
        variant="caption"
        sx={{ color: overlay.dim, flexShrink: 0, minWidth: 66, textAlign: 'right' }}
      >
        {label}
      </Typography>
      <Typography variant="caption" className="ptm-selectable" sx={{ color: overlay.textStrong, minWidth: 0 }}>
        {value}
      </Typography>
    </Stack>
  );
}

/** 文件大小：字节 → 人类可读。**用 1024 进制**（与界面别处的 formatBytes 一致） */
function formatSize(bytes: number | undefined): string | undefined {
  if (bytes == null || Number.isNaN(bytes)) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 字段定义 —— 顺序即显示顺序，与用户给的参考图一致：
 * 文件信息在前、摄影参数在后，从"这是什么文件"到"怎么拍的"。
 */
const FIELDS: Array<{ label: string; get: (i: ImageInfo) => string | undefined }> = [
  { label: '文件名', get: (i) => i.fileName },
  { label: '图片大小', get: (i) => formatSize(i.sizeBytes) },
  { label: '修改日期', get: (i) => i.fileModified },
  {
    label: '图片信息',
    get: (i) => {
      if (!i.width || !i.height) return undefined;
      const parts = [`${i.width}×${i.height}`];
      if (i.fileType) parts.push(i.fileType);
      if (i.colorSpace) parts.push(i.colorSpace);
      return parts.join('，');
    }
  },
  { label: '相机制造商', get: (i) => i.make },
  { label: '相机型号', get: (i) => i.model },
  { label: '软件', get: (i) => i.software },
  { label: '拍摄日期', get: (i) => i.dateTimeOriginalWithOffset ?? i.dateTimeOriginal },
  { label: '闪光灯', get: (i) => i.flash },
  { label: '焦距', get: (i) => i.focalLength },
  { label: '快门速度', get: (i) => i.shutterSpeed },
  { label: '光圈数', get: (i) => i.aperture },
  { label: 'ISO 感光度', get: (i) => i.iso },
  { label: '曝光程序', get: (i) => i.exposureProgram },
  { label: '测光模式', get: (i) => i.meteringMode },
  { label: '曝光补偿', get: (i) => i.exposureCompensation }
];

export function ExifInfoPanel({ info, loading, error, expanded, onToggle }: Props): JSX.Element | null {
  // 折叠态也要能看到一个小入口，否则用户忘了面板存在就再也回不去
  if (!expanded) {
    return (
      <Box className="pointer-events-none absolute left-3 top-3 z-10">
        <Tooltip title="展开图片信息（EXIF）" placement="right">
          <IconButton
            data-testid="exif-expand"
            size="small"
            className="pointer-events-auto"
            onClick={onToggle}
            aria-label="展开图片信息"
            sx={{ color: 'white', bgcolor: PANEL_SCRIM, '&:hover': { bgcolor: overlay.surfaceHover } }}
          >
            <InfoOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
    );
  }

  const rows = info ? FIELDS.map((f) => ({ label: f.label, value: f.get(info) })).filter((r): r is { label: string; value: string } => !!r.value) : [];

  return (
    <Box
      data-testid="exif-panel"
      // 面板本身不吃事件，只有下面的按钮吃 —— 照片仍可正常拖动缩放
      className="pointer-events-none absolute left-3 top-3 z-10 max-h-[calc(100%-24px)] overflow-hidden"
      sx={{ bgcolor: PANEL_SCRIM, borderRadius: px(tokens.radius.sm), py: 0.75, pr: 1 }}
    >
      <Stack
        direction="row"
        spacing={0.5}
        alignItems="center"
        sx={{ mb: 0.5, pl: 1, pointerEvents: 'none' }}
      >
        <Typography variant="caption" sx={{ color: overlay.textStrong, fontWeight: 600 }}>
          EXIF
        </Typography>
        <Tooltip title="收起（记住这个选择）">
          <IconButton
            size="small"
            className="pointer-events-auto"
            onClick={onToggle}
            aria-label="收起图片信息"
            data-testid="exif-collapse"
            sx={{ color: 'white', p: 0.25 }}
          >
            <CloseIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      </Stack>
      <Stack spacing={0.15} sx={{ maxHeight: 'calc(100vh - 140px)', overflowY: 'auto', pl: 1, pr: 0.5 }}>
        {loading && !info ? (
          <Typography variant="caption" sx={{ color: overlay.mid }}>
            正在读取…
          </Typography>
        ) : error ? (
          <Typography variant="caption" sx={{ color: 'error.light' }}>
            图片信息读取失败
          </Typography>
        ) : rows.length === 0 ? (
          <Typography variant="caption" sx={{ color: overlay.mid }}>
            这张图片没有可显示的 EXIF 信息
          </Typography>
        ) : (
          rows.map((r) => (
            <Box key={r.label}>
              {row(r.label, r.value)}
            </Box>
          ))
        )}
      </Stack>
    </Box>
  );
}