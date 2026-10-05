import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { toFileUrl } from '../api';
import { HOLD_TO_COMPARE } from '../utils/strings';
import { overlay, px, tokens } from '../theme/tokens';
import { useAiStore, type AiCompareMode } from '../store/useAiStore';
import type { AiDonePayload, AiMaskStroke, AiSaveResult } from '../../shared/types';

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
  const editMask = useAiStore((s) => s.editMask);
  const maskEditing = useAiStore((s) => s.maskEditing);
  const task = useAiStore((s) => s.task);
  const [brushEnabled, setBrushEnabled] = useState(false);
  const [brushMode, setBrushMode] = useState<AiMaskStroke['mode']>('restore');
  const [brushSize, setBrushSize] = useState(5);
  const [draft, setDraft] = useState<{ maskPoints: AiMaskStroke['points']; viewPoints: Array<{ x: number; y: number }>; radius: number; radiusY: number } | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number; radius: number; radiusY: number } | null>(null);
  const [stageSize, setStageSize] = useState({ width: 1, height: 1 });
  const [imageAspect, setImageAspect] = useState(result?.maskWidth && result.maskHeight ? result.maskWidth / result.maskHeight : 1);
  const resultImage = useRef<HTMLImageElement>(null);
  const brushOverlay = useRef<SVGSVGElement>(null);
  const stageView = useRef<HTMLDivElement>(null);
  const draftRef = useRef<typeof draft>(null);
  useEffect(() => {
    setBrushEnabled(false);
    setDraft(null);
    draftRef.current = null;
    setCursor(null);
  }, [result?.taskId, mode, task?.taskId, holding]);
  useEffect(() => {
    setImageAspect(result?.maskWidth && result.maskHeight ? result.maskWidth / result.maskHeight : 1);
  }, [result?.taskId, result?.maskWidth, result?.maskHeight]);
  useEffect(() => {
    const stage = stageView.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const updateSize = (): void => setStageSize({ width: stage.clientWidth || 1, height: stage.clientHeight || 1 });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [result?.taskId, mode]);
  if (!result) return null;

  const originalSrc = toFileUrl(result.sourceAbsPath);
  const resultSrc = toFileUrl(result.tempPath);
  const canBrush = result.maskEditable === true && mode === 'hold' && !holding && !task;
  const maskPointAt = (clientX: number, clientY: number, clamp = false) => {
    const image = resultImage.current;
    const svg = brushOverlay.current;
    if (!image || !svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    if (!clamp && (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom)) return null;
    const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    const maskPoint = { x: Math.min(result.maskWidth - 1, x * result.maskWidth), y: Math.min(result.maskHeight - 1, y * result.maskHeight) };
    const radius = (brushSize / 100) * Math.min(rect.width, rect.height) * (result.maskWidth / rect.width);
    const radiusY = (brushSize / 100) * Math.min(rect.width, rect.height) * (result.maskHeight / rect.height);
    return { maskPoint, viewPoint: { x: x * result.maskWidth, y: y * result.maskHeight }, radius, radiusY };
  };
  const stopBrushEvent = (event: ReactPointerEvent<SVGSVGElement>): void => {
    event.preventDefault();
    event.stopPropagation();
  };
  const beginBrush = (event: ReactPointerEvent<SVGSVGElement>): void => {
    stopBrushEvent(event);
    const point = maskPointAt(event.clientX, event.clientY);
    if (!point || !canBrush || maskEditing) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const next = { maskPoints: [point.maskPoint], viewPoints: [point.viewPoint], radius: point.radius, radiusY: point.radiusY };
    draftRef.current = next;
    setDraft(next);
    setCursor({ ...point.viewPoint, radius: point.radius, radiusY: point.radiusY });
  };
  const moveBrush = (event: ReactPointerEvent<SVGSVGElement>): void => {
    stopBrushEvent(event);
    const point = maskPointAt(event.clientX, event.clientY, draftRef.current !== null);
    if (!point) return;
    setCursor({ ...point.viewPoint, radius: point.radius, radiusY: point.radiusY });
    const current = draftRef.current;
    if (!current || current.maskPoints.length >= 20000) return;
    const previous = current.maskPoints[current.maskPoints.length - 1];
    if (Math.hypot(point.maskPoint.x - previous.x, point.maskPoint.y - previous.y) < 0.5) return;
    current.maskPoints.push(point.maskPoint);
    current.viewPoints.push(point.viewPoint);
    setDraft({ ...current });
  };
  const finishBrush = (event: ReactPointerEvent<SVGSVGElement>): void => {
    stopBrushEvent(event);
    const completed = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    if (!completed?.maskPoints.length) return;
    const points = completed.maskPoints.slice();
    const end = maskPointAt(event.clientX, event.clientY, true);
    const last = points[points.length - 1];
    if (end && points.length < 20000 && Math.hypot(end.maskPoint.x - last.x, end.maskPoint.y - last.y) >= 0.5) points.push(end.maskPoint);
    void editMask({ action: 'stroke', stroke: { mode: brushMode, radius: completed.radius, radiusY: completed.radiusY, points } });
  };

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
          sx={{ color: overlay.mid }}
        >
          掩码在 {result.maskWidth}×{result.maskHeight} 下计算，右侧结果放大后偏软，属正常
        </Typography>
      </>
    );
  }

  // 默认：看到的就是抠好的图；按住大图或按住空格才切回原图
  return (
    <>
      <Box
        ref={stageView}
        data-testid="ai-stage-view"
        sx={{ position: 'absolute', inset: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'visible', pointerEvents: 'none' }}
      >
        <Box
          sx={{ position: 'relative', flex: '0 0 auto', width: Math.min(stageSize.width || 1, (stageSize.height || 1) * imageAspect), height: Math.min(stageSize.height || 1, (stageSize.width || 1) / imageAspect), transformOrigin: 'center', transform: viewStyle?.transform, transition: viewStyle?.transition, lineHeight: 0, pointerEvents: 'auto' }}
        >
        <img
          ref={resultImage}
          data-testid="ai-compare-img"
          src={holding ? originalSrc : resultSrc}
          alt={holding ? '原图' : alt}
          draggable={false}
          onLoad={(event) => {
            const image = event.currentTarget;
            if (image.naturalWidth > 0 && image.naturalHeight > 0) setImageAspect(image.naturalWidth / image.naturalHeight);
          }}
          onError={onError}
          width="100%"
          height="100%"
          className="block h-full w-full object-fill"
          style={holding ? {} : checkerBg}
        />
        {canBrush && (
          <svg
            ref={brushOverlay}
            data-testid="mask-brush-overlay"
            data-mask-brush="true"
            className="absolute inset-0 h-full w-full"
            viewBox={`0 0 ${result.maskWidth} ${result.maskHeight}`} preserveAspectRatio="none"
            style={{ touchAction: 'none', cursor: brushEnabled ? 'none' : undefined, pointerEvents: brushEnabled ? 'auto' : 'none' }}
            onPointerDown={brushEnabled ? beginBrush : undefined}
            onPointerMove={brushEnabled ? moveBrush : undefined}
            onPointerUp={brushEnabled ? finishBrush : undefined}
            onPointerCancel={brushEnabled ? (event) => {
              stopBrushEvent(event);
              draftRef.current = null;
              setDraft(null);
            } : undefined}
          >
            {draft && draft.viewPoints.length > 0 && (
              <polyline points={draft.viewPoints.map((point) => `${point.x},${point.y / (draft.radiusY / draft.radius)}`).join(' ')} fill="none" stroke={brushMode === 'restore' ? '#32d583' : '#f97066'} strokeWidth={draft.radius * 2} strokeLinecap="round" strokeLinejoin="round" opacity="0.45" transform={`scale(1 ${draft.radiusY / draft.radius})`} />
            )}
            {brushEnabled && cursor && <ellipse cx={cursor.x} cy={cursor.y} rx={cursor.radius} ry={cursor.radiusY} fill="none" stroke={brushMode === 'restore' ? '#32d583' : '#f97066'} strokeWidth="1.5" />}
          </svg>
        )}
        </Box>
      </Box>
      {result.maskEditable && (
        <Stack
          data-mask-brush="true"
          direction="row"
          alignItems="center"
          spacing={0.5}
          sx={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', px: 1, py: 0.5, bgcolor: 'rgba(20, 22, 26, 0.88)', borderRadius: px(tokens.radius.sm), zIndex: 3 }}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <Button size="small" disabled={maskEditing || Boolean(task)} color={brushMode === 'restore' ? 'success' : 'inherit'} variant={brushMode === 'restore' ? 'contained' : 'outlined'} onClick={() => { setBrushMode('restore'); setBrushEnabled(true); }}>恢复前景</Button>
          <Button size="small" disabled={maskEditing || Boolean(task)} color={brushMode === 'erase' ? 'error' : 'inherit'} variant={brushMode === 'erase' ? 'contained' : 'outlined'} onClick={() => { setBrushMode('erase'); setBrushEnabled(true); }}>擦除背景</Button>
          <Button size="small" variant={brushEnabled ? 'contained' : 'outlined'} disabled={maskEditing || Boolean(task)} onClick={() => setBrushEnabled((value) => !value)}>{brushEnabled ? '完成' : '笔刷'}</Button>
          <Button size="small" disabled={maskEditing || Boolean(task) || !result.maskCanUndo} onClick={() => void editMask({ action: 'undo' })}>撤销</Button>
          <Button size="small" disabled={maskEditing || Boolean(task) || !result.maskCanRedo} onClick={() => void editMask({ action: 'redo' })}>重做</Button>
          <Slider aria-label="笔刷大小" size="small" min={1} max={20} value={brushSize} disabled={maskEditing || Boolean(task)} onChange={(_, value) => setBrushSize(value as number)} sx={{ width: 92, color: 'white', mx: 1 }} />
          {maskEditing && <Typography variant="caption" sx={{ color: 'white', whiteSpace: 'nowrap' }}>更新中…</Typography>}
        </Stack>
      )}
      {/* 触发方式从按钮挪到图上，所以说明也得跟着挪；分屏不用它（原图本来就同屏） */}
      <Typography
        data-testid="ai-hold-hint"
        variant="caption"
        className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2"
        sx={{ color: overlay.textStrong, bgcolor: overlay.chip, px: 1.25, py: 0.5, borderRadius: px(tokens.radius.sm) }}
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
  const saveResult = useAiStore((s) => s.saveResult);
  const maskEditing = useAiStore((s) => s.maskEditing);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  if (!result) return null;

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await saveResult();
      if (saved) onSaved?.(saved);
      else if (useAiStore.getState().maskEditing) setSaveError('笔刷更新中，请稍后再保存');
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
              color: overlay.mid,
              borderColor: overlay.fieldBorder,
              '&:hover': { color: '#fff', bgcolor: overlay.surfaceHover },
              '&.Mui-selected': {
                color: '#fff',
                bgcolor: overlay.surfaceActive,
                '&:hover': { bgcolor: overlay.surfaceActive }
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
        sx={{ width: 1, alignSelf: 'stretch', bgcolor: overlay.divider, mx: 0.5 }}
      />
      {/* 右段：要不要留 */}
      <Stack direction="row" alignItems="center" spacing={1} data-testid="ai-commit-group" className="shrink-0">
        <Button
          size="small"
          variant="contained"
          disabled={saving || maskEditing}
          onClick={() => void save()}
          sx={{ textTransform: 'none' }}
        >
          {saving ? '保存中…' : '保存'}
        </Button>
        {/* 不保存 ≠ 删除：文件留在暂存由清理策略回收，所以没有「丢弃」按钮 */}
        <Button size="small" color="inherit" disabled={maskEditing} onClick={() => clearResult()} sx={{ textTransform: 'none' }}>
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
