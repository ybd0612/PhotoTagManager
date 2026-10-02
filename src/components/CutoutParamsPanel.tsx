import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import TuneIcon from '@mui/icons-material/Tune';
import CloseIcon from '@mui/icons-material/Close';
import { overlay } from '../theme/tokens';
import { useAiStore } from '../store/useAiStore';
import { useCompareResult } from './AiCompareView';
import type { AiBgColorId } from '../../shared/types';

/**
 * 抠图参数面板（方案 §3：**详情页右侧浮层抽屉**）。
 *
 * 四条硬约束落在实现上的位置：
 * - **浮层、不占布局**（§8-5）：`position:absolute` 挂在大图区里，展开前后大图高度不变。
 *   底栏刚从 146 px 收到 103 px，"两段各占一行白吃行高、把照片压小"已被明确判为错的，
 *   所以这里绝不能改成 flex 子项。
 * - **键盘可达**（D17 / §3-2）：触发按钮与每块色板都是真 `<button>`，Tab 得到；
 *   `Esc` 关面板并把焦点还给触发按钮，且**不冒泡成"关闭整个预览"**——一次 Esc 只退一层。
 * - **不做 hover 展开**：悬停出来的入口对键盘和触屏用户不可达，所以只由点击/Enter 打开。
 * - **始终标明"这是预览，还没保存"**（§3-3）：派生文件规则的红线，没点保存照片目录一字节不变。
 *
 * 还要挡住大图区那两个既有手势：按住=看原图、双击=复位缩放。面板是叠在它上面的浮层，
 * mousedown 若冒泡上去，选一次底色会让画面闪一下原图，看起来像程序抽风。
 *
 * 第一版只放底色四块色板（§4）。边缘三档与换模型是切片二/三，这里刻意不放。
 */

/** 面板只认 id 与给人看的名字；RGBA 的唯一事实源在主进程 BG_COLOR_PRESETS。 */
const BG_SWATCHES: Array<{ id: AiBgColorId; label: string }> = [
  { id: 'transparent', label: '透明' },
  { id: 'white', label: '白' },
  { id: 'blue', label: '蓝' },
  { id: 'red', label: '红' }
];

/** 挡住从面板冒到大图区的宿主手势。 */
const swallowHostGestures = {
  onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
  onMouseUp: (e: React.MouseEvent) => e.stopPropagation(),
  onDoubleClick: (e: React.MouseEvent) => e.stopPropagation()
};

interface Props {
  absPath: string;
}

export function CutoutParamsPanel({ absPath }: Props) {
  const result = useCompareResult(absPath);
  const bgcolor = useAiStore((s) => s.bgcolor);
  const setBgColor = useAiStore((s) => s.setBgColor);
  const task = useAiStore((s) => s.task);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const everOpened = useRef(false);

  // 焦点跟着开合走：打开进面板（键盘用户才用得上色板与 Esc），关闭还给触发按钮
  useEffect(() => {
    if (open) {
      everOpened.current = true;
      panelRef.current?.focus();
    } else if (everOpened.current) {
      triggerRef.current?.focus();
    }
  }, [open]);

  /** 没有这张图的抠图结果就没有参数可调（面板此时不该出现） */
  if (!result) return null;

  const busy = task?.absPath === absPath;

  if (!open) {
    return (
      <IconButton
        ref={triggerRef}
        size="small"
        aria-label="抠图参数"
        data-testid="cutout-panel-trigger"
        {...swallowHostGestures}
        sx={{
          position: 'absolute',
          top: 12,
          right: 12,
          zIndex: 2,
          color: overlay.textStrong,
          bgcolor: overlay.chip
        }}
        onClick={() => setOpen(true)}
      >
        <TuneIcon fontSize="small" />
      </IconButton>
    );
  }

  return (
    <Box
      ref={panelRef}
      role="dialog"
      aria-label="抠图参数"
      data-testid="cutout-panel"
      tabIndex={-1}
      {...swallowHostGestures}
      onKeyDown={(e) => {
        // 一次 Esc 只退一层：关掉面板，不让它冒泡成"关闭整个预览"
        if (e.key === 'Escape') {
          e.stopPropagation();
          setOpen(false);
        }
      }}
      sx={{
        position: 'absolute',
        top: 12,
        right: 12,
        zIndex: 2,
        width: 208,
        maxWidth: 'calc(100% - 24px)',
        p: 1.25,
        borderRadius: 1.5,
        bgcolor: overlay.captionScrim,
        border: 1,
        borderColor: overlay.fieldBorder,
        color: 'white',
        '&:focus': { outline: 'none' }
      }}
    >
      <Stack direction="row" alignItems="center" spacing={0.5}>
        <Typography variant="subtitle2" sx={{ flex: 1, minWidth: 0 }}>
          抠图参数
        </Typography>
        <IconButton
          size="small"
          aria-label="关闭参数面板"
          data-testid="cutout-panel-close"
          sx={{ color: overlay.textStrong }}
          onClick={() => setOpen(false)}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Stack>

      <Typography
        variant="caption"
        component="p"
        data-testid="cutout-panel-note"
        sx={{ display: 'block', color: overlay.mid, py: 0.75 }}
      >
        以下是预览，还没保存；点「保存」才写入照片目录。
      </Typography>

      <Typography variant="caption" component="div" sx={{ color: overlay.dim }}>
        底色
      </Typography>
      <ToggleButtonGroup
        size="small"
        exclusive
        value={bgcolor}
        // 松手才算：一次点击就是一次完整请求，不在拖动过程中反复发任务
        onChange={(_, next) => {
          if (!next) return;
          void setBgColor(next as AiBgColorId, absPath, result.capabilityId);
        }}
        aria-label="抠图底色"
        data-testid="cutout-bgcolor-group"
        sx={{
          mt: 0.5,
          width: '100%',
          textTransform: 'none',
          flexWrap: 'nowrap',
          '& .MuiToggleButton-root': {
            px: 0.5,
            py: 0.5,
            fontSize: '0.76rem',
            color: 'rgba(255,255,255,0.78)',
            borderColor: 'rgba(255,255,255,0.28)',
            '&:hover': { color: '#fff', bgcolor: 'rgba(255,255,255,0.10)' },
            '&.Mui-selected': {
              color: '#fff',
              bgcolor: 'rgba(255,255,255,0.20)',
              '&:hover': { bgcolor: 'rgba(255,255,255,0.26)' }
            }
          }
        }}
      >
        {BG_SWATCHES.map((swatch) => (
          <ToggleButton key={swatch.id} value={swatch.id} aria-label={`底色：${swatch.label}`}>
            {swatch.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>

      {/* 改完参数在算什么，给一句实话：掩码留着，只有合成那一段重算 */}
      <Typography
        variant="caption"
        component="div"
        data-testid="cutout-panel-status"
        sx={{ display: 'block', mt: 1, color: overlay.mid }}
      >
        {busy ? '正在按新底色重算预览…' : `掩码在 ${result.maskWidth}×${result.maskHeight} 下计算，改底色不会重跑`}
      </Typography>
    </Box>
  );
}
