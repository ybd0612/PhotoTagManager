import { useState } from 'react';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import { AiSettingsPane } from './AiSettingsPane';

/**
 * 应用级设置总入口（D16）。
 *
 * 为什么要有这个弹窗而不是 AI 专属弹窗：应用原先只有「关于」「标签管理」两个弹窗，
 * 任何全局偏好都没有落脚的地方。AI 需要一个能长期生长的位置，所以补总入口，
 * 而不是给 AI 单开一个以后还得再搬一次的弹窗。
 */
export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState('general');

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="settings-title">
      <DialogTitle id="settings-title">设置</DialogTitle>
      <Tabs value={tab} onChange={(_e, v: string) => setTab(v)} aria-label="设置分区">
        <Tab value="general" label="常规" />
        <Tab value="ai" label="AI 处理" />
      </Tabs>
      <DialogContent dividers>
        {tab === 'general' ? (
          <Stack spacing={1}>
            <Typography variant="body2" color="text.secondary" data-testid="general-empty">
            M1 暂无常规设置项，后续的全局偏好放这里
            </Typography>
          </Stack>
        ) : (
          <AiSettingsPane />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>关闭</Button>
      </DialogActions>
    </Dialog>
  );
}
