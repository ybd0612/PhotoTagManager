import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  LinearProgress,
  Paper,
  Snackbar,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import RefreshIcon from '@mui/icons-material/Refresh';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import PhotoLibraryIcon from '@mui/icons-material/PhotoLibrary';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import DriveFileRenameOutlineIcon from '@mui/icons-material/DriveFileRenameOutline';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import { call, getApi } from '../api';
import { useAppStore } from '../store/useAppStore';
import { cancelScan, rescan, startScan } from '../hooks/useScan';
import { FolderTree } from './FolderTree';
import { TagFilterBar } from './TagFilterBar';
import { ThumbnailGrid } from './ThumbnailGrid';
import { PreviewOverlay } from './PreviewOverlay';
import { UpdateDialog } from './UpdateDialog';
import type { RootEntry, UpdateStatus } from '../../shared/types';

/**
 * 三栏布局容器 + 顶部工具栏 + 底部状态栏（PRD §3.3 线框图，多根 R10）。
 * 左侧顶部为根目录列表（别名/添加/改名/删除/切换，懒扫描），下方为当前根的目录树。
 */
export function AppLayout(): JSX.Element {
  const roots = useAppStore((s) => s.roots);
  const selectedRootId = useAppStore((s) => s.selectedRootId);
  const selectedDir = useAppStore((s) => s.selectedDir);
  const scannedRoots = useAppStore((s) => s.scannedRoots);
  const scanStateByRoot = useAppStore((s) => s.scanStateByRoot);
  const scanStats = useAppStore((s) => s.scanStats);
  const scanStatsByRoot = useAppStore((s) => s.scanStatsByRoot);
  const imagesByDir = useAppStore((s) => s.imagesByDir);
  const selectedImages = useAppStore((s) => s.selectedImages);
  const snackbar = useAppStore((s) => s.snackbar);
  const setSnackbar = useAppStore((s) => s.setSnackbar);

  const [renameTarget, setRenameTarget] = useState<RootEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [removeTarget, setRemoveTarget] = useState<RootEntry | null>(null);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: 'idle' });

  const selectedRoot = roots.find((r) => r.id === selectedRootId) ?? null;

  // 当前选中目录的绝对路径（选中根时即根路径；选中子目录时拼接）
  const selectedDirAbs = useMemo(() => {
    if (!selectedRoot || selectedDir === null) return null;
    if (selectedDir === '') return selectedRoot.path;
    return `${selectedRoot.path.replace(/[\\/]+$/, '')}\\${selectedDir.replace(/\//g, '\\')}`;
  }, [selectedRoot, selectedDir]);

  // 当前选中根的图片总数（按 imagesByDir 复合 key 前缀统计）
  const currentRootImageCount = useMemo(() => {
    if (!selectedRootId) return 0;
    const prefix = `${selectedRootId}\u0000`;
    let total = 0;
    for (const [key, arr] of imagesByDir) {
      if (key.startsWith(prefix)) total += arr.length;
    }
    return total;
  }, [selectedRootId, imagesByDir]);

  // 当前选中根的扫描统计
  const currentRootScanState = selectedRootId ? (scanStateByRoot.get(selectedRootId) ?? 'idle') : 'idle';
  const currentRootScanStats = selectedRootId ? (scanStatsByRoot.get(selectedRootId) ?? null) : null;
  const scanProgress = currentRootScanStats
    ? currentRootScanStats.done
      ? 100
      : currentRootScanStats.totalFiles > 0
        ? Math.min(99, Math.round((currentRootScanStats.scannedFiles / currentRootScanStats.totalFiles) * 100))
        : 0
    : 0;

  /** 添加根目录：选目录 → 持久化 → 选中 → 懒扫描（新根必未扫） */
  const handleAddRoot = useCallback(async () => {
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

  /** 切换根：未扫过的根自动触发扫描（懒扫描） */
  const handleSelectRoot = useCallback(
    async (root: RootEntry) => {
      const store = useAppStore.getState();
      store.selectRoot(root.id);
      if (!store.scannedRoots.has(root.id)) {
        await startScan(root);
      }
    },
    []
  );

  const handleRenameConfirm = useCallback(async () => {
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

  const handleRemoveConfirm = useCallback(async () => {
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

  const handleRescan = useCallback(() => {
    void rescan();
  }, [rescan]);

  const handleCancel = useCallback(() => {
    void cancelScan();
  }, [cancelScan]);

  // 启动静默检查更新：仅发现新版本（available）时才弹出提示框
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = getApi().onUpdateStatus((s) => {
      if (cancelled) return;
      setUpdateStatus(s);
      if (s.state === 'available') setUpdateDialogOpen(true);
    });
    void getApi()
      .checkUpdate()
      .then((result) => {
        if (cancelled || !result.ok) return;
        setUpdateStatus(result.data);
        if (result.data.state === 'available') setUpdateDialogOpen(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  /** 手动检查更新：先打开对话框展示状态，再触发检查 */
  const handleCheckUpdate = useCallback(async () => {
    setUpdateDialogOpen(true);
    try {
      await call(getApi().checkUpdate());
    } catch (error) {
      setSnackbar(`检查更新失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [setSnackbar]);

  const scanning = currentRootScanState === 'scanning';
  const hasRoot = roots.length > 0 && selectedRootId !== null;

  return (
    <Box className="flex h-full flex-col bg-slate-50">
      {/* 顶部工具栏 */}
      <Paper
        component="header"
        className="flex h-14 shrink-0 items-center justify-between rounded-none border-b border-slate-200 px-4"
      >
        <Stack direction="row" spacing={1.5} alignItems="center">
          <PhotoLibraryIcon color="primary" />
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            PhotoTagManager
          </Typography>
          {selectedRoot && (
            <Chip
              size="small"
              label={selectedDirAbs ? `${selectedRoot.alias} · ${selectedDirAbs}` : `${selectedRoot.alias} · ${selectedRoot.path}`}
              variant="outlined"
              sx={{ maxWidth: 420 }}
              title={selectedDirAbs ?? selectedRoot.path}
            />
          )}
        </Stack>

        <Stack direction="row" spacing={1}>
          <Button
            variant="contained"
            startIcon={<FolderOpenIcon />}
            onClick={() => void handleAddRoot()}
          >
            添加根目录
          </Button>
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            disabled={!hasRoot || scanning}
            onClick={handleRescan}
          >
            重新扫描
          </Button>
          {scanning && (
            <Button
              variant="text"
              color="error"
              startIcon={<StopCircleIcon />}
              onClick={handleCancel}
            >
              取消
            </Button>
          )}
          <Tooltip title="检查更新">
            <IconButton onClick={() => void handleCheckUpdate()} aria-label="检查更新">
              <SystemUpdateAltIcon />
            </IconButton>
          </Tooltip>
        </Stack>
      </Paper>

      {/* 主体三栏 */}
      {!hasRoot ? (
        <EmptyState onPick={() => void handleAddRoot()} />
      ) : (
        <Box className="flex min-h-0 flex-1">
          {/* 左：根目录列表 + 当前根目录树 */}
          <Paper className="flex w-[280px] shrink-0 flex-col overflow-hidden rounded-none border-r border-slate-200">
            {/* 根目录列表（R10） */}
            <Box className="shrink-0 border-b border-slate-100">
              <Stack
                direction="row"
                alignItems="center"
                justifyContent="space-between"
                className="px-3 py-2"
              >
                <Typography variant="subtitle2" color="text.secondary">
                  根目录（{roots.length}）
                </Typography>
                <Tooltip title="添加根目录">
                  <IconButton size="small" aria-label="添加根目录" onClick={() => void handleAddRoot()}>
                    <AddIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
              <Box className="max-h-44 overflow-auto px-1 pb-1">
                {roots.map((root) => (
                  <RootRow
                    key={root.id}
                    root={root}
                    selected={root.id === selectedRootId}
                    scanning={scanning && root.id === selectedRootId}
                    scanned={scannedRoots.has(root.id)}
                    onSelect={() => void handleSelectRoot(root)}
                    onRename={() => {
                      setRenameValue(root.alias);
                      setRenameTarget(root);
                    }}
                    onRemove={() => setRemoveTarget(root)}
                  />
                ))}
              </Box>
            </Box>

            {/* 当前根的目录树 */}
            <Box className="min-h-0 flex-1">
              <FolderTree />
            </Box>
          </Paper>

          {/* 右：标签筛选条 + 缩略图网格 */}
          <Box className="flex min-w-0 flex-1 flex-col">
            <TagFilterBar />
            <Box className="min-h-0 flex-1">
              <ThumbnailGrid />
            </Box>
          </Box>
        </Box>
      )}

      {/* 底部状态栏（统计按当前选中根） */}
      <Paper className="flex h-7 shrink-0 items-center justify-between rounded-none border-t border-slate-200 px-3">
        <Typography variant="caption" color="text.secondary">
          共 {currentRootImageCount.toLocaleString()} 张
          <span className="mx-2 text-slate-300">|</span>
          已选 {selectedImages.size} 张
          <span className="mx-2 text-slate-300">|</span>
          已扫描 {currentRootScanStats?.scannedFiles.toLocaleString() ?? 0} 个文件
        </Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          {scanning && (
            <>
              <Typography variant="caption" color="text.secondary">
                扫描中… {scanProgress}%
              </Typography>
              <Box className="w-32">
                <LinearProgress variant="determinate" value={scanProgress} sx={{ height: 4 }} />
              </Box>
            </>
          )}
          {currentRootScanState === 'done' && (
            <Typography variant="caption" sx={{ color: 'success.main' }}>
              扫描完成 100%
            </Typography>
          )}
          {currentRootScanState === 'error' && (
            <Typography variant="caption" color="error">
              扫描出错
            </Typography>
          )}
        </Stack>
      </Paper>

      {/* 预览覆盖层 */}
      <PreviewOverlay />

      {/* 固定位置的非阻塞更新进度提示；关闭对话框不影响后台下载 */}
      {(updateStatus.state === 'downloading' || updateStatus.state === 'downloaded') && (
        <Paper
          elevation={3}
          sx={{ position: 'fixed', right: 20, bottom: 44, zIndex: (theme) => theme.zIndex.snackbar, minWidth: 240, px: 2, py: 1 }}
        >
          <Typography variant="caption" display="block">
            {updateStatus.state === 'downloading' ? `正在下载更新 ${updateStatus.percent ?? 0}%` : '更新下载完成，可安装'}
          </Typography>
          {updateStatus.state === 'downloading' && <LinearProgress variant="determinate" value={updateStatus.percent ?? 0} sx={{ mt: 0.5 }} />}
        </Paper>
      )}

      {/* 更新状态对话框 */}
      <UpdateDialog open={updateDialogOpen} onClose={() => setUpdateDialogOpen(false)} />

      {/* 改别名对话框 */}
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

      {/* 删除根目录确认对话框 */}
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

      {/* 全局提示 */}
      <Snackbar
        open={snackbar !== null}
        autoHideDuration={3000}
        onClose={() => setSnackbar(null)}
        message={snackbar ?? ''}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  );
}

interface RootRowProps {
  root: RootEntry;
  selected: boolean;
  scanning: boolean;
  scanned: boolean;
  onSelect: () => void;
  onRename: () => void;
  onRemove: () => void;
}

/** 根目录行：别名 + 路径；hover 显示改名/删除；未扫描的根显示"未扫描"标记 */
function RootRow({ root, selected, scanning, scanned, onSelect, onRename, onRemove }: RootRowProps): JSX.Element {
  return (
    <Box
      className="group flex cursor-pointer items-center gap-1 rounded-md px-2 py-1"
      role="button"
      tabIndex={0}
      aria-label={`选择根目录：${root.alias}`}
      aria-selected={selected}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      onClick={onSelect}
      sx={
        selected
          ? { bgcolor: 'primary.light', color: 'primary.contrastText' }
          : { '&:hover': { bgcolor: 'action.hover' }, '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' } }
      }
    >
      <PhotoLibraryIcon fontSize="small" className="shrink-0" />
      <Box className="min-w-0 flex-1">
        <Typography noWrap variant="body2" className="flex items-center gap-1">
          {root.alias}
          {scanning && (
            <Box component="span" className="ml-1 inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-400" />
          )}
        </Typography>
        <Typography
          noWrap
          variant="caption"
          sx={{ opacity: 0.7, display: 'block' }}
          title={root.path}
        >
          {root.path}
        </Typography>
      </Box>
      {!scanned && !scanning && (
        <Typography variant="caption" sx={{ opacity: 0.6, mr: 0.5 }}>
          未扫描
        </Typography>
      )}
      <IconButton
        size="small"
        className="!p-0.5 opacity-0 group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          onRename();
        }}
        title="改别名"
        aria-label={`修改根目录别名：${root.alias}`}
      >
        <DriveFileRenameOutlineIcon fontSize="small" />
      </IconButton>
      <IconButton
        size="small"
        className="!p-0.5 opacity-0 group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        title="删除"
        aria-label={`删除根目录：${root.alias}`}
      >
        <DeleteOutlineIcon fontSize="small" />
      </IconButton>
    </Box>
  );
}

function EmptyState({ onPick }: { onPick: () => void }): JSX.Element {
  return (
    <Box className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
      <PhotoLibraryIcon sx={{ fontSize: 88, color: '#c7d2fe' }} />
      <Typography variant="h6" color="text.secondary">
        添加一个或多个图片根目录，起个名字方便管理
      </Typography>
      <Typography variant="body2" color="text.disabled">
        例如：A 目录起别名「照片」，B 目录起别名「资料」；支持 JPG / PNG / WebP / RAW / HEIC / TIFF
      </Typography>
      <Button variant="contained" size="large" startIcon={<FolderOpenIcon />} onClick={onPick}>
        添加根目录
      </Button>
    </Box>
  );
}
