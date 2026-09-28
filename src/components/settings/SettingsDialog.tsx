import { useEffect, useState } from 'react';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Tab from '@mui/material/Tab';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableRow from '@mui/material/TableRow';
import TableHead from '@mui/material/TableHead';
import Tabs from '@mui/material/Tabs';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { AiSettingsPane } from './AiSettingsPane';
import { useAppStore } from '../../store/useAppStore';
import { SHORTCUTS } from '../../utils/shortcuts';
import type { SortKey, ThumbSize } from '../../../shared/types';

/**
 * 常规分区（批次3 G8）：只放**真的接上行为**的偏好。
 * 三个控件都直接读写 useAppStore，改值即落盘 settings.json；
 * 加一个不生效的开关等于把批次1 立的那条防线拆掉，所以宁可少放。
 */
function GeneralPane(): JSX.Element {
  const sortKey = useAppStore((s) => s.sortKey);
  const sortDir = useAppStore((s) => s.sortDir);
  const thumbSize = useAppStore((s) => s.thumbSize);
  const scanDoneToast = useAppStore((s) => s.scanDoneToast);
  const setSort = useAppStore((s) => s.setSort);
  const setThumbSize = useAppStore((s) => s.setThumbSize);
  const setScanDoneToast = useAppStore((s) => s.setScanDoneToast);

  return (
    <Stack spacing={2} data-testid="settings-general">
      <Stack direction="row" spacing={1.5} alignItems="center">
        <Typography variant="body2" sx={{ width: 96 }} className="shrink-0">
          默认排序
        </Typography>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={sortKey}
          onChange={(_e, value: SortKey | null) => value && setSort(value)}
        >
          <ToggleButton value="name">名称</ToggleButton>
          <ToggleButton value="time">时间</ToggleButton>
          <ToggleButton value="size">大小</ToggleButton>
        </ToggleButtonGroup>
        <Button
          size="small"
          color="inherit"
          aria-label="切换排序方向"
          onClick={() => setSort(sortKey)}
          sx={{ minWidth: 0, px: 1 }}
        >
          {sortDir === 'asc' ? '↑ 升序' : '↓ 降序'}
        </Button>
      </Stack>
      <Divider />

      <Stack direction="row" spacing={1.5} alignItems="center">
        <Typography variant="body2" sx={{ width: 96 }} className="shrink-0">
          缩略图
        </Typography>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={thumbSize}
          onChange={(_e, value: ThumbSize | null) => value && setThumbSize(value)}
        >
          <ToggleButton value="small">小</ToggleButton>
          <ToggleButton value="medium">中</ToggleButton>
          <ToggleButton value="large">大</ToggleButton>
        </ToggleButtonGroup>
        <Typography variant="caption" color="text.secondary">
          和首页工具条是同一个设置，改完立即生效
        </Typography>
      </Stack>
      <Divider />

      <Stack direction="row" spacing={1.5} alignItems="center">
        <Typography variant="body2" sx={{ width: 96 }} className="shrink-0">
          扫描完成
        </Typography>
        <FormControlLabel
          control={
            <Switch
              checked={scanDoneToast}
              onChange={(e) => setScanDoneToast(e.target.checked)}
              inputProps={{ 'aria-label': '扫描完成后弹出提示' }}
            />
          }
          label="扫描完成后弹出提示"
        />
        <Typography variant="caption" color="text.secondary">
          默认关闭：状态栏已常驻「已扫描 N 个文件」，不重复播报
        </Typography>
      </Stack>
    </Stack>
  );
}

/**
 * 快捷键分区（批次3 G11）：整表读 utils/shortcuts 的 SHORTCUTS，界面不各写一份。
 * 只列已实现的键位——那条口径守在数据源里，不在这里补"看起来该有"的条目。
 */
function ShortcutPane(): JSX.Element {
  return (
    <TableContainer data-testid="shortcut-list">
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>键位</TableCell>
            <TableCell>作用</TableCell>
            <TableCell>生效范围</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {SHORTCUTS.map((s) => (
            <TableRow key={s.keys}>
              <TableCell sx={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{s.keys}</TableCell>
              <TableCell>{s.action}</TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>{s.scope}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

/**
 * 应用级设置总入口（D16）。
 *
 * 为什么要有这个弹窗而不是 AI 专属弹窗：应用原先只有「关于」「标签管理」两个弹窗，
 * 任何全局偏好都没有落脚的地方。AI 需要一个能长期生长的位置，所以补总入口，
 * 而不是给 AI 单开一个以后还得再搬一次的弹窗。
 */
export function SettingsDialog({
  open,
  onClose,
  initialTab
}: {
  open: boolean;
  onClose: () => void;
  /** 打开时停在哪个分区；全局 `?` 用它直接把对话框开到「快捷键」上 */
  initialTab?: 'general' | 'ai' | 'shortcuts';
}): JSX.Element {
  const [tab, setTab] = useState<string>(initialTab ?? 'general');

  // 对话框在 AppLayout 里常驻挂载，只有 open 在变；不这条 effect 的话第二次 ? 会停在上次看的分区
  useEffect(() => {
    if (open && initialTab) setTab(initialTab);
  }, [open, initialTab]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="settings-title">
      <DialogTitle id="settings-title">设置</DialogTitle>
      <Tabs value={tab} onChange={(_e, v: string) => setTab(v)} aria-label="设置分区">
        <Tab value="general" label="常规" />
        <Tab value="ai" label="AI 处理" />
        <Tab value="shortcuts" label="快捷键" />
      </Tabs>
      {/* 批次1 之前只有两行说明，看起来像半成品；给最小高度让分区站得住 */}
      <DialogContent dividers sx={{ minHeight: 300 }}>
        {tab === 'general' ? <GeneralPane /> : tab === 'shortcuts' ? <ShortcutPane /> : <AiSettingsPane />}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>关闭</Button>
      </DialogActions>
    </Dialog>
  );
}
