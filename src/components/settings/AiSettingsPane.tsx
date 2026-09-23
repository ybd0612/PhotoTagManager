import { useEffect } from 'react';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { formatMb, useAiStore } from '../../store/useAiStore';

/**
 * 设置页的 AI 分区（D16 / D17）。
 *
 * **只有三样东西**：只读统计、后处理参数（M1 为空）、暂存与缓存配置。
 * 模型的下载 / 卸载 / 删除 / 设为默认**一律不在这里**——那些操作的唯一入口是
 * 预览底栏组合按钮的下拉。同一份状态在两处 UI 可改，迟早会不一致。
 *
 * 显存那行必须写"整卡已用"：分进程显存拿不到（nvidia-smi 的 compute-apps 在本机
 * 驱动返回 [N/A]），写成"AI 占用多少"就是谎报（§5.2）。
 */

function formatGb(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes)) return '未知';
  const gb = bytes / 1073741824;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)}GB`;
  return formatMb(bytes);
}

export function AiSettingsPane() {
  const stats = useAiStore((s) => s.stats);
  const loadStats = useAiStore((s) => s.loadStats);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const modelBytes = stats?.models.reduce((sum, m) => sum + m.sizeBytes, 0) ?? null;

  return (
    <Stack spacing={1.5} data-testid="ai-settings-pane" sx={{ pt: 1 }}>
      <Typography variant="subtitle2">存储与显存</Typography>
      <Typography variant="body2" data-testid="ai-stats-loaded">
        模型占用 {formatGb(modelBytes)} · 可用磁盘 {formatGb(stats?.freeDiskBytes ?? null)} · 预览暂存{' '}
        {stats ? `${stats.preview.entries} 条 / ${formatGb(stats.preview.totalBytes)}` : '未知'}
      </Typography>
      <Typography variant="body2" data-testid="ai-gpu-line" color="text.secondary">
        {stats?.gpu
          ? `整卡已用 ${stats.gpu.usedMiB} MiB / ${stats.gpu.totalMiB} MiB（整卡口径，含其他程序的占用；分进程显存读不到）`
          : '整卡显存：未知（没有可用的 NVIDIA 查询）'}
      </Typography>

      <Typography variant="subtitle2">预览暂存</Typography>
      <Typography variant="body2" data-testid="ai-retention-line">
        保留 {stats?.retention.retentionDays ?? '—'} 天 · 总量上限{' '}
        {formatGb(stats?.retention.maxBytes ?? null)}；超任一条件按最久未用淘汰，已保存的成果不受影响
      </Typography>

      <Typography variant="subtitle2">后处理参数</Typography>
      {/* M1 不实装任何参数：调了没反应的假控件比空着一栏更糟（D16） */}
      <Typography variant="body2" color="text.secondary" data-testid="ai-params-empty">
        暂无可调参数
      </Typography>
    </Stack>
  );
}
