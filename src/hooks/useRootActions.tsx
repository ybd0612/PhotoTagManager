import { useCallback, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  TextField
} from '@mui/material';
import { call, getApi } from '../api';
import { useAppStore } from '../store/useAppStore';
import { startScan } from '../hooks/useScan';
import type { RootEntry } from '../../shared/types';

/** 根目录动作集合：顶栏与左栏合并树共用，实现只有一份 */
export interface RootActions {
  addRoot(): Promise<void>;
  selectRoot(root: RootEntry): Promise<void>;
  openRename(root: RootEntry): void;
  openRemove(root: RootEntry): void;
}

/**
 * 根目录增删改 + 懒扫描（R10）。
 * 别名与删除两个确认对话框只在 AppLayout 渲染一次，左栏树通过 actions 触发。
 */
export function useRootActions(): { actions: RootActions; dialogs: JSX.Element } {
  const setSnackbar = useAppStore((s) => s.setSnackbar);
  const [renameTarget, setRenameTarget] = useState<RootEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [removeTarget, setRemoveTarget] = useState<RootEntry | null>(null);

  /** 添加根目录：选目录 → 持久化 → 选中 → 懒扫描（新根必未扫） */
  const addRoot = useCallback(async (): Promise<void> => {
    try {
      const path = await call(getApi().pickDirectory());
      if (!path) return;
      const entry = await call(getApi().addRoot(path));
      const store = useAppStore.getState();
      const existed = store.roots.some((root) => root.id === entry.id);
      store.addRootLocal(entry);
      store.selectRoot(entry.id);
      if (!existed || !store.scannedRoots.has(entry.id)) await startScan(entry);
    } catch (error) {
      setSnackbar(`添加根目录失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [setSnackbar]);

  /** 切换根：未扫过的根自动触发扫描；正在后台扫描的根不重启 */
  const selectRoot = useCallback(async (root: RootEntry): Promise<void> => {
    const store = useAppStore.getState();
    store.selectRoot(root.id);
    const state = store.scanStateByRoot.get(root.id) ?? 'idle';
    if (!store.scannedRoots.has(root.id) && state !== 'scanning') {
      await startScan(root);
    }
  }, []);

  const handleRenameConfirm = useCallback(async (): Promise<void> => {
    const target = renameTarget;
    setRenameTarget(null);
    if (!target || !renameValue.trim()) return;
    try {
      const entry = await call(getApi().renameRoot(target.id, renameValue.trim()));
      if (entry) useAppStore.getState().renameRootLocal(target.id, entry.alias);
    } catch (error) {
      setSnackbar(`改名失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [renameTarget, renameValue, setSnackbar]);

  const handleRemoveConfirm = useCallback(async (): Promise<void> => {
    const target = removeTarget;
    setRemoveTarget(null);
    if (!target) return;
    try {
      await call(getApi().removeRoot(target.id));
      useAppStore.getState().removeRootLocal(target.id);
    } catch (error) {
      setSnackbar(`删除根目录失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [removeTarget, setSnackbar]);

  const dialogs = (
    <>
      <Dialog open={renameTarget !== null} onClose={() => setRenameTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>修改根目录别名</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label="别名"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleRenameConfirm();
            }}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenameTarget(null)}>取消</Button>
          <Button variant="contained" onClick={() => void handleRenameConfirm()}>
            保存
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={removeTarget !== null} onClose={() => setRemoveTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>删除根目录？</DialogTitle>
        <DialogContent>
          <DialogContentText>
            删除「{removeTarget?.alias}」（{removeTarget?.path}）？仅移除列表与扫描数据，不会删除磁盘文件。
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRemoveTarget(null)}>取消</Button>
          <Button color="error" variant="contained" onClick={() => void handleRemoveConfirm()}>
            删除
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );

  return {
    actions: {
      addRoot,
      selectRoot,
      openRename: (root) => {
        setRenameValue(root.alias);
        setRenameTarget(root);
      },
      openRemove: (root) => setRemoveTarget(root)
    },
    dialogs
  };
}
