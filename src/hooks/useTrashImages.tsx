import { useState } from 'react';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import { call, getApi } from '../api';
import { useAppStore } from '../store/useAppStore';
import type { TrashResult } from '../../shared/types';

/**
 * 「移到回收站」的确认框与执行，网格与预览详情共用一份。
 *
 * 删用户照片是不可逆动作里最轻的一档（进系统回收站，可找回），但仍然要：
 * - **一次显式确认**，取消时一个请求都不发；
 * - **部分失败不静默**：主进程逐条给原因，这里把失败的条数与第一条原因说给人听；
 * - 只有真的进了回收站的路径才从内存账目里移除，失败的那些仍留在列表里（否则用户
 *   会以为它们也被删了）。
 */
export function useTrashImages(): {
  /** 传入要删的绝对路径；空数组不会弹框 */
  askTrash: (absPaths: string[]) => void;
  /** 由调用方渲染到树上 */
  dialog: JSX.Element;
} {
  const [pending, setPending] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const removeImagesLocal = useAppStore((s) => s.removeImagesLocal);
  const setSnackbar = useAppStore((s) => s.setSnackbar);

  const askTrash = (absPaths: string[]): void => {
    const paths = absPaths.filter(Boolean);
    if (paths.length === 0) return;
    setPending(paths);
  };

  const confirm = async (): Promise<void> => {
    const paths = pending ?? [];
    if (paths.length === 0) return;
    setBusy(true);
    try {
      const result: TrashResult = await call(getApi().trashFiles(paths));
      removeImagesLocal(result.trashed);
      if (result.failed.length === 0) {
        setSnackbar(`已把 ${result.trashed.length} 个文件移到回收站，可从系统回收站找回`);
      } else {
        setSnackbar(
          `已移到回收站 ${result.trashed.length} 个，失败 ${result.failed.length} 个：${result.failed[0].reason}`
        );
      }
      setPending(null);
    } catch (err) {
      setSnackbar(`移到回收站失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const count = pending?.length ?? 0;
  const dialog = (
    <Dialog open={pending !== null} onClose={() => !busy && setPending(null)} aria-labelledby="trash-confirm-title">
      <DialogTitle id="trash-confirm-title">
        {count === 1 ? '把这个文件移到回收站？' : `把这 ${count} 个文件移到回收站？`}
      </DialogTitle>
      <DialogContent>
        <DialogContentText>
          文件会移到系统回收站，可以随时从回收站找回；标签只写在图片文件自身里，删这一个不影响其它文件。
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setPending(null)} disabled={busy} autoFocus sx={{ textTransform: 'none' }}>
          取消
        </Button>
        <Button color="error" onClick={() => void confirm()} disabled={busy} sx={{ textTransform: 'none' }}>
          {busy ? '处理中…' : '移到回收站'}
        </Button>
      </DialogActions>
    </Dialog>
  );

  return { askTrash, dialog };
}
