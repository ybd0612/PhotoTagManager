import { useState } from 'react';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { call, getApi, toFileUrl } from '../api';
import { useAiStore } from '../store/useAiStore';
import type { AiSaveResult } from '../../shared/types';

/**
 * 抠完不是弹个"成功"就结束，而是进对比视图（§4.5）。
 *
 * - **默认按住对比**：按住看原图、松开看结果，两张图同位同尺寸精确叠加。
 *   这样对齐精确、能直接看边缘质量，也不需要用户来回挪视线。
 * - **棋盘格底纹是硬性要求**：透明区若直接铺窗口会被渲染成白底或黑底，
 *   分不清"抠干净"还是"渲染错"（探针里就是这么差点被骗过去）。
 * - **分屏只当次要模式**：掩码是在低分辨率上算的，放大回原图必然比左边糊，
 *   并排看会让用户第一眼判定"程序坏了/效果变差"，所以切过去必须注明掩码尺寸。
 *   尺寸数字取自清单，不在这里写死。
 * - 动作只有两个：**保存** / **不保存**。D18 之后没有"丢弃"这个动作，
 *   不保存就是让文件留在暂存由清理策略回收。也**不提供替换原图**（AG3）。
 */

type CompareMode = 'hold' | 'split';

const CHECKER_SIZE = 16;

/** 两层 45° 重复渐变叠出棋盘格；写成内联样式以便样式断言能直接读到 */
const CHECKERBOARD = [
  `repeating-conic-gradient(#c9ced6 0% 25%, #ffffff 0% 50%)`,
  `linear-gradient(45deg, rgba(0,0,0,0.04) 25%, transparent 25%)`
].join(', ');

export function AiCompareView({ onSaved }: { onSaved?: (r: AiSaveResult) => void } = {}) {
  const result = useAiStore((s) => s.result);
  const clearResult = useAiStore((s) => s.clearResult);
  const [mode, setMode] = useState<CompareMode>('hold');
  const [holding, setHolding] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!result) return null;

  const originalSrc = toFileUrl(result.sourceAbsPath);
  const resultSrc = toFileUrl(result.tempPath);
  const showOriginal = mode === 'hold' && holding;

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
    <Stack direction="row" spacing={2} alignItems="center" data-testid="ai-compare-root">
      <div
        data-testid="ai-compare-stage"
        style={{ position: 'relative', width: 320, height: 240, overflow: 'hidden' }}
      >
        {/* 底纹层：永远在最下面，透明区露出棋盘格而不是纯白/纯黑 */}
        <div
          data-testid="ai-checkerboard"
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage: CHECKERBOARD,
            backgroundSize: `${CHECKER_SIZE}px ${CHECKER_SIZE}px, ${CHECKER_SIZE}px ${CHECKER_SIZE}px`
          }}
        />
        {mode === 'hold' ? (
          <>
            <img
              data-testid="ai-original"
              src={originalSrc}
              alt="原图"
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                opacity: holding ? 1 : 0
              }}
            />
            <img
              data-testid="ai-result"
              src={resultSrc}
              alt="抠图结果"
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                opacity: holding ? 0 : 1
              }}
            />
          </>
        ) : (
          <Stack direction="row" data-testid="ai-split-pair" sx={{ position: 'absolute', inset: 0 }}>
            <img
              data-testid="ai-original"
              src={originalSrc}
              alt="原图"
              style={{ width: '50%', height: '100%', objectFit: 'contain', opacity: 1 }}
            />
            <img
              data-testid="ai-result"
              src={resultSrc}
              alt="抠图结果"
              style={{ width: '50%', height: '100%', objectFit: 'contain', opacity: 1 }}
            />
          </Stack>
        )}
        {mode === 'split' && (
          <Typography
            data-testid="ai-mask-note"
            variant="caption"
            sx={{ position: 'absolute', left: 8, bottom: 6, bgcolor: 'rgba(255,255,255,0.86)', px: 0.75 }}
          >
            掩码在 {result.inputWidth}×{result.inputHeight} 下计算，右图放大后偏软是预期的
          </Typography>
        )}
      </div>

      <Stack spacing={1}>
        <Stack direction="row" spacing={1}>
          <Button
            size="small"
            variant={mode === 'hold' ? 'outlined' : 'text'}
            aria-pressed={mode === 'hold'}
            onClick={() => setMode('hold')}
          >
            按住看原图
          </Button>
          <Button
            size="small"
            variant={mode === 'split' ? 'outlined' : 'text'}
            aria-pressed={mode === 'split'}
            onClick={() => setMode('split')}
          >
            分屏对比
          </Button>
        </Stack>
        <div>
          <Button
            size="small"
            disabled={mode !== 'hold'}
            onMouseDown={() => mode === 'hold' && setHolding(true)}
            onMouseUp={() => setHolding(false)}
            onMouseLeave={() => setHolding(false)}
            onTouchStart={() => mode === 'hold' && setHolding(true)}
            onTouchEnd={() => setHolding(false)}
          >
            按住对比
          </Button>
        </div>
        <Stack direction="row" spacing={1}>
          <Button size="small" variant="contained" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
          {/* 不保存 ≠ 删除：文件留在暂存由清理策略回收，所以没有「丢弃」按钮 */}
          <Button size="small" onClick={() => clearResult()}>
            不保存
          </Button>
        </Stack>
        {saveError && (
          <Typography data-testid="ai-compare-error" variant="caption" color="error">
            {saveError}
          </Typography>
        )}
      </Stack>
    </Stack>
  );
}
