import { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Typography
} from '@mui/material';
import { call, getApi } from '../api';
import type { UpdateStatus } from '../../shared/types';

interface UpdateDialogProps {
  open: boolean;
  onClose: () => void;
}

const IDLE_STATUS: UpdateStatus = { state: 'idle' };

/**
 * 更新状态对话框：订阅主进程推送的 'update:status' 事件并展示。
 * 状态机：checking → available / not-available → downloading → downloaded →（安装重启）。
 * 挂载即订阅而非仅在打开时订阅：启动检查的"available"事件先于对话框打开到达，需保留最新状态。
 */
export function UpdateDialog({ open, onClose }: UpdateDialogProps): JSX.Element {
  const [status, setStatus] = useState<UpdateStatus>(IDLE_STATUS);

  useEffect(() => {
    const unsubscribe = getApi().onUpdateStatus((s) => setStatus(s));
    return unsubscribe;
  }, []);

  /** 立即下载（available 状态） */
  const handleDownload = useCallback(async () => {
    try {
      const next = await call(getApi().downloadUpdate());
      setStatus(next);
    } catch (error) {
      setStatus({ state: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  /** 退出应用并安装（downloaded 状态） */
  const handleInstall = useCallback(() => {
    void getApi().installUpdate();
  }, []);

  const busy = status.state === 'checking' || status.state === 'downloading';
  const showPrimaryAction = status.state === 'available' || status.state === 'downloaded';
  const showDismiss = status.state === 'not-available' || status.state === 'dev-mode' || status.state === 'error';

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>检查更新</DialogTitle>
      <DialogContent>
        <Box className="flex min-h-[76px] flex-col items-center justify-center gap-2 py-2 text-center">
          {renderStatus(status)}
        </Box>
      </DialogContent>
      <DialogActions>
        {status.state === 'available' && (
          <Button variant="contained" disabled={busy} onClick={() => void handleDownload()}>
            立即下载
          </Button>
        )}
        {status.state === 'downloaded' && (
          <Button variant="contained" onClick={handleInstall}>
            立即安装
          </Button>
        )}
        {showDismiss && (
          <Button variant="contained" onClick={onClose}>
            知道了
          </Button>
        )}
        {!showPrimaryAction && (
          <Button onClick={onClose}>关闭</Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

/** 按状态渲染内容区 */
function renderStatus(status: UpdateStatus): JSX.Element {
  switch (status.state) {
    case 'checking':
      return (
        <>
          <CircularProgress size={28} />
          <Typography variant="body2" color="text.secondary">
            正在检查更新…
          </Typography>
        </>
      );
    case 'available':
      return <Typography variant="body1">发现新版本 v{status.version}</Typography>;
    case 'not-available':
      return (
        <Typography variant="body1" color="text.secondary">
          已是最新版本
        </Typography>
      );
    case 'downloading':
      return (
        <>
          <Typography variant="body2" color="text.secondary">
            正在下载 {status.percent ?? 0}%
          </Typography>
          <LinearProgress variant="determinate" value={status.percent ?? 0} sx={{ width: '100%', mt: 1 }} />
        </>
      );
    case 'downloaded':
      return <Typography variant="body1">下载完成，重启安装？</Typography>;
    case 'error':
      return (
        <Typography variant="body2" color="error">
          {status.message ?? '更新出错，请稍后重试'}
        </Typography>
      );
    case 'dev-mode':
      return (
        <Typography variant="body2" color="text.secondary">
          开发模式，更新不可用
        </Typography>
      );
    default:
      return (
        <Typography variant="body2" color="text.secondary">
          准备检查更新…
        </Typography>
      );
  }
}
