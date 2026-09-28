import { useState } from 'react';
import type { CSSProperties } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { call, getApi, toFileUrl } from '../api';
import { HOLD_TO_COMPARE } from '../utils/strings';
import { useAiStore, type AiCompareMode } from '../store/useAiStore';
import type { AiDonePayload, AiSaveResult } from '../../shared/types';

/**
 * 对比视图（§4.5 / D15）。**舞台在大图区、动作在底栏**，两者共享 store 里的
 * `compareMode` / `holdingOriginal`。
 *
 * 三条实现取舍：
 * - **结果原位替换大图区那张图**，同位同尺寸由构造保证（同一个 `<img>` 换 src），
 *   不是叠两层再对齐——两层是这套界面之前"看着乱"的来源之一。
 * - **棋盘格画在 img 自身的 CSS 背景上**：`object-contain` 的 img 元素盒子等于绘制区，
 *   透明像素正好把背景透出来。既不用测量图片显示尺寸，也不会把底纹漏到照片以外。
 * - **分屏只当次要模式**，且必须注明掩码尺寸（数值取自清单，不硬编码）：低分辨率掩码
 *   放大回来必然偏软，不注明用户会判成"程序坏了"。
 *
 * 动作只有 **保存 / 不保存**：D18 之后"不保存就是丢弃"，没有丢弃按钮；
 * 也永远不提供"替换原图"（AG3）。
 *
 * 批次3 G9：底栏分两段（左=怎么看、右=要不要留），「按住看原图」不再是按钮——
 * 触发挪到大图区按住 + 空格按住，并在图上给一条浮层说明。D15 口径一个字没改：
 * 默认看结果，按住才看原图。
 */

const CHECKER_SIZE = 16;
const CHECKERBOARD = 'repeating-conic-gradient(#c9ced6 0% 25%, #ffffff 0% 50%)';
const checkerBg: CSSProperties = {
  backgroundImage: CHECKERBOARD,
  backgroundSize: `${CHECKER_SIZE}px ${CHECKER_SIZE}px`
};

/**
 * 预览层（近黑底 rgb(2,6,23)）上的对比 token，批次3 G10 单点在此。
 * 原先 0.55 / 0.7 / 0.8 三档手写值散在两个组件的 sx 里，同一层界面调一次对比要改五处。
 * 由本文件导出、宿主 PreviewOverlay 复用，两边读的是同一份。
 */
export const OVERLAY = {
  /** 压在照片上的浮层文字（按住提示、缩放读数） */
  textStrong: 'rgba(255,255,255,0.88)',
  /** 次级说明文字（掩码尺寸注明、元数据） */
  mid: 'rgba(255,255,255,0.72)',
  /** 最弱一档（元数据里的尺寸/大小），再低就在暗底上读不出了 */
  dim: 'rgba(255,255,255,0.55)',
  /** 暗底输入框描边：0.25 在近黑底上基本读不出边界 */
  fieldBorder: 'rgba(255,255,255,0.35)',
  /** placeholder：0.45 会连"这里能输入"都提示不出来 */
  fieldPlaceholder: 'rgba(255,255,255,0.6)',
  /** focus 态描边，取主题 primary.light */
  focus: '#818cf8'
} as const;

/** 结果只属于它那张照片：翻到下一张不该继续显示上一张的对比 */
export function useCompareResult(absPath: string | undefined): AiDonePayload | null {
  const result = useAiStore((s) => s.result);
  if (!result || !absPath) return null;
  return result.sourceAbsPath === absPath ? result : null;
}

interface StageProps {
  /** 当前预览的照片绝对路径；与结果的 sourceAbsPath 对不上时什么都不画 */
  absPath: string;
  alt: string;
  onError: () => void;
  /** 大图区的缩放/平移样式，由宿主传入，保证换图后缩放不跳 */
  viewStyle?: CSSProperties;
}

export function AiCompareStage({ absPath, alt, onError, viewStyle }: StageProps) {
  const result = useCompareResult(absPath);
  const mode = useAiStore((s) => s.compareMode);
  const holding = useAiStore((s) => s.holdingOriginal);
  if (!result) return null;

  const originalSrc = toFileUrl(result.sourceAbsPath);
  const resultSrc = toFileUrl(result.tempPath);

  if (mode === 'split') {
    return (
      <>
        <Stack
          direction="row"
          data-testid="ai-split-pair"
          spacing={2}
          sx={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', minWidth: 0 }}
        >
          <img
            data-testid="ai-original"
            src={originalSrc}
            alt="原图"
            draggable={false}
            onError={onError}
            className="min-w-0 max-h-full w-1/2 object-contain"
            style={viewStyle}
          />
          <img
            data-testid="ai-result"
            src={resultSrc}
            alt="抠图结果"
            draggable={false}
            onError={onError}
            className="min-w-0 max-h-full w-1/2 object-contain"
            style={{ ...viewStyle, ...checkerBg }}
          />
        </Stack>
        <Typography
          data-testid="ai-mask-note"
          variant="caption"
          className="pointer-events-none absolute bottom-2 left-3"
          sx={{ color: OVERLAY.mid }}
        >
          掩码在 {result.maskWidth}×{result.maskHeight} 下计算，右侧结果放大后偏软，属正常
        </Typography>
      </>
    );
  }

  // 默认：看到的就是抠好的图；按住大图或按住空格才切回原图
  return (
    <>
      <img
        data-testid="ai-compare-img"
        src={holding ? originalSrc : resultSrc}
        alt={holding ? '原图' : alt}
        draggable={false}
        onError={onError}
        className="max-h-full max-w-full object-contain"
        style={{ ...viewStyle, ...(holding ? {} : checkerBg) }}
      />
      {/* 触发方式从按钮挪到图上，所以说明也得跟着挪；分屏不用它（原图本来就同屏） */}
      <Typography
        data-testid="ai-hold-hint"
        variant="caption"
        className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2"
        sx={{
          color: OVERLAY.textStrong,
          bgcolor: 'rgba(2,6,23,0.62)',
          px: 1.25,
          py: 0.5,
          borderRadius: 1.5
        }}
      >
        {HOLD_TO_COMPARE}
      </Typography>
    </>
  );
}

export function AiCompareActions({
  absPath,
  onSaved
}: {
  absPath?: string;
  onSaved?: (r: AiSaveResult) => void;
}) {
  const result = useCompareResult(absPath);
  const mode = useAiStore((s) => s.compareMode);
  const setCompareMode = useAiStore((s) => s.setCompareMode);
  const clearResult = useAiStore((s) => s.clearResult);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  if (!result) return null;

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await call(getApi().aiSave(result.taskId));
      clearResult();
      onSaved?.(saved);
    } catch (err) {
      // 保存失败不能把结果弄丢：预览留着，用户可以直接重试（§6 / A5）
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      data-testid="ai-compare-root"
      sx={{ flexWrap: 'nowrap', minWidth: 0 }}
    >
      {/* 左段：怎么看。CDP 实测过——左段一旦可收缩（min-w-0），MUI ToggleButtonGroup
          默认的 flexWrap: wrap 会把两个模式按钮叠成竖排（高 107px），所以这里不收缩、
          并在按钮组上显式 nowrap */}
      <Stack direction="row" alignItems="center" data-testid="ai-mode-group" className="shrink-0">
        <ToggleButtonGroup
          size="small"
          exclusive
          value={mode}
          onChange={(_, next) => next && setCompareMode(next as AiCompareMode)}
          // 深色底栏上不用主题 primary（indigo 压在近黑底上对比不足），三态配色显式给
          sx={{
            textTransform: 'none',
            flexWrap: 'nowrap',
            '& .MuiToggleButton-root': {
              px: 1.5,
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
          <ToggleButton value="hold">原位对比</ToggleButton>
          <ToggleButton value="split">左右双栏</ToggleButton>
        </ToggleButtonGroup>
      </Stack>
      <Box
        data-testid="ai-actions-divider"
        aria-hidden
        sx={{ width: 1, alignSelf: 'stretch', bgcolor: 'rgba(255,255,255,0.18)', mx: 0.5 }}
      />
      {/* 右段：要不要留 */}
      <Stack direction="row" alignItems="center" spacing={1} data-testid="ai-commit-group" className="shrink-0">
        <Button
          size="small"
          variant="contained"
          disabled={saving}
          onClick={() => void save()}
          sx={{ textTransform: 'none' }}
        >
          {saving ? '保存中…' : '保存'}
        </Button>
        {/* 不保存 ≠ 删除：文件留在暂存由清理策略回收，所以没有「丢弃」按钮 */}
        <Button size="small" color="inherit" onClick={() => clearResult()} sx={{ textTransform: 'none' }}>
          不保存
        </Button>
      </Stack>
      {saveError && (
        <Typography data-testid="ai-compare-error" variant="caption" sx={{ color: 'error.light' }}>
          {saveError}
        </Typography>
      )}
    </Stack>
  );
}
