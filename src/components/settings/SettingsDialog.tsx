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
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { sanitizeProxyRules } from '../../../shared/proxyRule';
import { AboutUpdatePane } from './AboutUpdatePane';
import { AiSettingsPane } from './AiSettingsPane';
import { Hint } from '../Hint';
import { useAppStore } from '../../store/useAppStore';
import { SHORTCUTS } from '../../utils/shortcuts';
import type { UpdateController } from '../../hooks/useUpdate';

/**
 * 常规分区（批次3 G8）：只放**真的接上行为**的偏好。
 * 两个控件都直接读写 useAppStore，改值即落盘 settings.json；
 * 加一个不生效的开关等于把批次1 立的那条防线拆掉，所以宁可少放。
 * 排序与缩略图不在这里重复——主界面工具条上就是同一套控件、同一个偏好，
 * 同一事实说两遍只会让人怀疑两边是否同步。
 */
function GeneralPane(): JSX.Element {
  const scanDoneToast = useAppStore((s) => s.scanDoneToast);
  const setScanDoneToast = useAppStore((s) => s.setScanDoneToast);

  return (
    <Stack spacing={2} data-testid="settings-general">
      <Stack direction="row" spacing={1.5} alignItems="center">
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ width: 96, flexShrink: 0 }}>
          <Typography variant="body2">扫描完成</Typography>
          <Hint text="默认关闭：状态栏已常驻「已扫描 N 个文件」，打开它只是再弹一条 snackbar 播报同一个数字，不改变扫描行为。" />
        </Stack>
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
      </Stack>
      <Divider />
      <ProxyRow />
    </Stack>
  );
}

/**
 * 网络代理设置。
 * 两个刻意的设计：
 * - 改动要点「应用」才生效——每敲一个字就 setProxy 一次会让会话反复重建连接；
 * - 地址不合法就地说明原因，而不是静默存个空值（那等于用户以为设置了，实际没走代理）。
 */
function ProxyRow(): JSX.Element {
  const saved = useAppStore((s) => s.proxyRules);
  const setProxyRules = useAppStore((s) => s.setProxyRules);
  const [draft, setDraft] = useState(saved);
  const checked = sanitizeProxyRules(draft);
  const dirty = checked.ok && checked.value !== saved;

  return (
    <Stack direction="row" spacing={1.5} alignItems="flex-start">
      <Stack
        direction="row"
        spacing={0.5}
        alignItems="center"
        sx={{ width: 96, flexShrink: 0 }}
      >
        <Typography variant="body2" sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
          网络代理
        </Typography>
        <Hint text="只影响「模型下载」与「检查更新」两件事；照片始终不出本机，本应用没有任何上传照片的请求。不支持带账号密码的代理地址（那会明文存在配置文件里）。" />
      </Stack>
      <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <TextField
            size="small"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="留空 = 不覆盖；例如 127.0.0.1:7890"
            inputProps={{ 'aria-label': '网络代理地址' }}
            error={!checked.ok}
            sx={{ width: 300 }}
          />
          <Button
            size="small"
            variant="outlined"
            disabled={!dirty}
            onClick={() => setProxyRules(checked.value)}
            sx={{ textTransform: 'none' }}
          >
            应用
          </Button>
        </Stack>
        <Typography variant="caption" data-testid="proxy-hint" color={checked.ok ? 'text.secondary' : 'error'}>
          {!checked.ok
            ? checked.message
            : draft.trim() === ''
              ? '未覆盖，跟随系统默认设置'
              : `将使用代理 ${checked.value}`}
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
  initialTab,
  update
}: {
  open: boolean;
  onClose: () => void;
  /** 打开时停在哪个分区；全局 `?` 用它直接把对话框开到「快捷键」上 */
  initialTab?: 'general' | 'ai' | 'shortcuts' | 'about';
  /** 「关于与更新」分区就地用的更新控制器，由 AppLayout 挂载的唯一一份传入 */
  update: UpdateController;
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
        <Tab value="about" label="关于与更新" />
      </Tabs>
      {/* 批次1 之前只有两行说明，看起来像半成品；给最小高度让分区站得住 */}
      <DialogContent dividers sx={{ minHeight: 300 }}>
        {tab === 'general' ? (
          <GeneralPane />
        ) : tab === 'ai' ? (
          <AiSettingsPane />
        ) : tab === 'shortcuts' ? (
          <ShortcutPane />
        ) : (
          <AboutUpdatePane update={update} />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>关闭</Button>
      </DialogActions>
    </Dialog>
  );
}
