import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { call, getApi, toFileUrl } from '../api';
import { HOLD_TO_COMPARE } from '../utils/strings';
import { overlay, px, tokens } from '../theme/tokens';
import { useAiStore, type AiCompareMode } from '../store/useAiStore';
import type { AiDonePayload, AiMaskPointPrompt, AiSaveResult } from '../../shared/types';

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
  const maskPromptMode = useAiStore((s) => s.maskPromptMode);
  const task = useAiStore((s) => s.task);
  const [prompts, setPrompts] = useState<AiMaskPointPrompt[]>([]);
  const [promptCursor, setPromptCursor] = useState(0);
  const [samConsent, setSamConsent] = useState(false);
  const [samInstalling, setSamInstalling] = useState(false);
  const [samChecking, setSamChecking] = useState(false);
  const [stageSize, setStageSize] = useState({ width: 1, height: 1 });
  const [imageAspect, setImageAspect] = useState(result?.maskWidth && result.maskHeight ? result.maskWidth / result.maskHeight : 1);
  const resultImage = useRef<HTMLImageElement>(null);
  const brushOverlay = useRef<SVGSVGElement>(null);
  const stageView = useRef<HTMLDivElement>(null);
  const promptCheckInFlight = useRef(false);
  useEffect(() => { setPrompts([]); setPromptCursor(0); }, [result?.taskId]);
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
  // 点提示要显式进入模式才生效：它得独占右键（图上右键 = 标背景点，
// 而图外右键 = 移除到回收站，既有功能不能被静默夺走）。
  const canPrompt = result.maskEditable === true && maskPromptMode && !task && !maskEditing;
  const submitPrompt = (prompt: AiMaskPointPrompt): void => { setPrompts((current) => [...current.slice(0, promptCursor), prompt]); setPromptCursor((cursor) => cursor + 1); void editMask({ action: 'prompt', prompt }); };

  /**
   * 提交一个点。label=1 前景（左键），label=0 背景（右键）。
   * 坐标从overlay 的 rect 算归一化值，所以 overlay 铺在哪，坐标就相对谁——
   * 双栏模式下铺在右侧结果图容器内，点到的就是那张图的相对位置。
   */
  const commitPoint = (event: ReactMouseEvent<SVGSVGElement>, label: 0 | 1): void => {
    const svg = brushOverlay.current;
    if (!svg || !canPrompt || maskEditing || promptCheckInFlight.current) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
    if (prompts.length >= 128) return;
    promptCheckInFlight.current = true;
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    void call(getApi().aiMobileSamStatus()).then(({ statuses }) => {
      if (statuses.some((item) => item.status !== 'present')) { setSamConsent(true); return; }
      submitPrompt({ x, y, label });
    }).catch((error) => useAiStore.setState({ error: { taskId: result.taskId, code: 'SAM_STATUS_FAILED', message: String(error) } })).finally(() => { promptCheckInFlight.current = false; });
  };

  /**
   * 只认左键。守卫必须是 `!== 0` 而不是 `> 2`——右键按下同样会先发mousedown
   * （button===2），`> 2` 放它过去，于是右键先提交了 label=1，
   * 紧接着 contextmenu 那次被 inFlight 挡住，结果右键永远=「要保留」。
   */
  const addForeground = (event: ReactMouseEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    commitPoint(event, 1);
  };

  /**
   * 右键（背景点）走 contextmenu收事件，不靠 mousedown 的 button 判断。
   *
   * 为什么不能靠 mousedown：Windows 上右键按下的mousedown 早于 contextmenu，
   * mousedown 那一步就已经把「前景」提交掉了，contextmenu 只能收尾。
   * 干脆在 mousedown 里只放行左键，右键整个交给 contextmenu，时序就干净了。
   */
  const addBackground = (event: ReactMouseEvent<SVGSVGElement>): void => {
    event.preventDefault(); event.stopPropagation();
    commitPoint(event, 0);
  };

  /** 点提示的提示圈与命中层。两种模式共用同一份，只是挂载的宿主不同。 */
  const promptOverlay = (
    <svg
      ref={brushOverlay}
      data-testid="mask-brush-overlay"
      data-mask-brush="true"
      className="absolute inset-0 h-full w-full"
      viewBox="0 0 1 1" preserveAspectRatio="none"
      style={{ touchAction: 'none', pointerEvents: 'auto', cursor: 'crosshair' }}
      onMouseDown={addForeground}
      onContextMenu={addBackground}
    >
      {prompts.map((point, index) => <g key={`${index}-${point.x}-${point.y}`} style={{ display: index < promptCursor ? undefined : 'none' }}><circle cx={point.x} cy={point.y} r="0.012" fill={point.label === 1 ? '#32d583' : '#f97066'} stroke="white" strokeWidth="0.003" /><text x={point.x} y={point.y + 0.004} textAnchor="middle" fontSize="0.012" fill="#111">{point.label === 1 ? '+' : '−'}</text></g>)}
    </svg>
  );

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
          {/* 结果图要包一层 relative：overlay 用 absolute inset-0 铺满的是这一层，
              直接挂在Stack 的 grid/flex 兄弟位上会拿不到参照框，命中坐标整体偏掉。
              w-1/2 挪到这层，Stack 里的占位由它承担。 */}
          <div className="relative min-w-0 max-h-full w-1/2" style={viewStyle}>
            <img
              data-testid="ai-result"
              src={resultSrc}
              alt="抠图结果"
              draggable={false}
              onError={onError}
              className="block max-h-full w-full object-contain"
              style={checkerBg}
            />
            {canPrompt && promptOverlay}
          </div>
        </Stack>
        <Typography
          data-testid="ai-mask-note"
          variant="caption"
          className="pointer-events-none absolute bottom-2 left-3"
          sx={{ color: overlay.mid }}
        >
          掩码在 {result.maskWidth}×{result.maskHeight} 下计算，右侧结果放大后偏软，属正常
        </Typography>
        {result.maskEditable && maskPromptMode && (
          <Stack
            data-mask-brush="true"
            direction="row"
            alignItems="center"
            spacing={0.5}
            sx={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', px: 1, py: 0.5, bgcolor: 'rgba(20, 22, 26, 0.88)', borderRadius: px(tokens.radius.sm), zIndex: 3 }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <Typography variant="caption" sx={{ color: 'white', whiteSpace: 'nowrap' }}>在右图上：左键=要保留 · 右键=要去掉</Typography>
            <Button size="small" disabled={maskEditing || Boolean(task) || !result.maskCanUndo} onClick={() => { setPromptCursor((cursor) => Math.max(0, cursor - 1)); void editMask({ action: 'undo' }); }}>撤销</Button>
            <Button size="small" disabled={maskEditing || Boolean(task) || !result.maskCanRedo} onClick={() => { setPromptCursor((cursor) => Math.min(prompts.length, cursor + 1)); void editMask({ action: 'redo' }); }}>重做</Button>
            {maskEditing && <Typography variant="caption" sx={{ color: 'white', whiteSpace: 'nowrap' }}>更新中…</Typography>}
          </Stack>
        )}
      </>
    );
  }

  // 默认：看到的就是抠好的图；按住空格才切回原图（左键整个让给点提示）
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
        {canPrompt && promptOverlay}
        </Box>
      </Box>
      {result.maskEditable && maskPromptMode && (
        <Stack
          data-mask-brush="true"
          direction="row"
          alignItems="center"
          spacing={0.5}
          sx={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', px: 1, py: 0.5, bgcolor: 'rgba(20, 22, 26, 0.88)', borderRadius: px(tokens.radius.sm), zIndex: 3 }}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <Typography variant="caption" sx={{ color: 'white', whiteSpace: 'nowrap' }}>左键=要保留 · 右键=要去掉</Typography>
          <Button size="small" disabled={maskEditing || Boolean(task) || !result.maskCanUndo} onClick={() => { setPromptCursor((cursor) => Math.max(0, cursor - 1)); void editMask({ action: 'undo' }); }}>撤销</Button>
          <Button size="small" disabled={maskEditing || Boolean(task) || !result.maskCanRedo} onClick={() => { setPromptCursor((cursor) => Math.min(prompts.length, cursor + 1)); void editMask({ action: 'redo' }); }}>重做</Button>
          {maskEditing && <Typography variant="caption" sx={{ color: 'white', whiteSpace: 'nowrap' }}>更新中…</Typography>}
        </Stack>
      )}
      <Dialog open={samConsent} onClose={() => setSamConsent(false)}><DialogTitle>安装实验性 MobileSAM 点提示模型？</DialogTitle><DialogContent><Typography>需要下载两个模型文件（约 44.7 MB）。文件会先校验 SHA-256；模型来源及再分发许可尚未独立核实，推理仅走 CPU，效果尚未验证。确认后才会开始下载。</Typography></DialogContent><DialogActions><Button disabled={samInstalling} onClick={() => setSamConsent(false)}>取消</Button><Button disabled={samInstalling} onClick={async () => { setSamInstalling(true); try { await call(getApi().aiMobileSamInstall()); setSamConsent(false); } catch (error) { useAiStore.setState({ error: { taskId: result.taskId, code: 'SAM_INSTALL_FAILED', message: String(error) } }); } finally { setSamInstalling(false); } }}>{samInstalling ? '下载中…' : '同意并下载'}</Button></DialogActions></Dialog>
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
  const maskPromptMode = useAiStore((s) => s.maskPromptMode);
  const setMaskPromptMode = useAiStore((s) => s.setMaskPromptMode);
  const clearResult = useAiStore((s) => s.clearResult);
  const saveResult = useAiStore((s) => s.saveResult);
  const maskEditing = useAiStore((s) => s.maskEditing);
  const task = useAiStore((s) => s.task);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  if (!result) return null;

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await saveResult();
      if (saved) onSaved?.(saved);
      else if (useAiStore.getState().maskEditing) setSaveError('点提示编辑中，请稍后再保存');
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
        {result.maskEditable && (
          <Button
            size="small"
            variant={maskPromptMode ? 'contained' : 'outlined'}
            disabled={maskEditing || Boolean(task)}
            onClick={() => setMaskPromptMode(!maskPromptMode)}
            sx={{ textTransform: 'none', mr: 1, borderColor: overlay.fieldBorder }}
          >
            {maskPromptMode ? '点提示中 · 点击退出' : '修正抠图'}
          </Button>
        )}
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
