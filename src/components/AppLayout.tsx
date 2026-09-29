import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Divider,
  IconButton,
  LinearProgress,
  ListItemIcon,
  Menu,
  MenuItem,
  Paper,
  Snackbar,
  Stack,
  Tooltip,
  Typography
} from '@mui/material';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import RefreshIcon from '@mui/icons-material/Refresh';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import PhotoLibraryIcon from '@mui/icons-material/PhotoLibrary';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import SettingsIcon from '@mui/icons-material/Settings';
import ViewSidebarIcon from '@mui/icons-material/ViewSidebar';
import { call, getApi } from '../api';
import { useAppStore } from '../store/useAppStore';
import { cancelScan, rescan } from '../hooks/useScan';
import { useRootActions } from '../hooks/useRootActions';
import { collectDirAndDescendants } from '../utils/folders';
import { countImagesInDirs } from '../utils/treeRows';
import { scanProgressPercent, scanStatusLabel } from '../utils/scanStatus';
import { FolderTree } from './FolderTree';
import { HiddenFoldersButton } from './HiddenFoldersButton';
import { TagFilterBar } from './TagFilterBar';
import { ThumbnailGrid } from './ThumbnailGrid';
import { PreviewOverlay } from './PreviewOverlay';
import { UpdateDialog } from './UpdateDialog';
import { AboutDialog } from './AboutDialog';
import { SettingsDialog } from './settings/SettingsDialog';
import type { UpdateStatus } from '../../shared/types';

/**
 * 三栏布局容器 + 顶部工具栏 + 底部状态栏（PRD §3.3 线框图，多根 R10）。
 * 批次2 起：左栏是一棵「根 + 子目录」合并树（G5），顶栏只留主操作与设置、
 * 检查更新与关于收进溢出菜单（G6），状态栏扫描文案只播一次（G7）。
 */
export function AppLayout(): JSX.Element {
  const roots = useAppStore((s) => s.roots);
  const selectedRootId = useAppStore((s) => s.selectedRootId);
  const selectedDir = useAppStore((s) => s.selectedDir);
  const scanStateByRoot = useAppStore((s) => s.scanStateByRoot);
  const scanStatsByRoot = useAppStore((s) => s.scanStatsByRoot);
  const imagesByDir = useAppStore((s) => s.imagesByDir);
  const tree = useAppStore((s) => s.tree);
  const selectedImages = useAppStore((s) => s.selectedImages);
  const snackbar = useAppStore((s) => s.snackbar);
  const setSnackbar = useAppStore((s) => s.setSnackbar);
  const treeCollapsed = useAppStore((s) => s.treeCollapsed);
  const toggleTreeCollapsed = useAppStore((s) => s.toggleTreeCollapsed);

  const { actions: rootActions, dialogs: rootDialogs } = useRootActions();
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [aboutDialogOpen, setAboutDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 打开设置时停在哪个分区：工具栏按钮进「常规」，`?` 直接进「快捷键」（批次3 G11） */
  const [settingsTab, setSettingsTab] = useState<'general' | 'ai' | 'shortcuts'>('general');
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: 'idle' });
  const [moreAnchor, setMoreAnchor] = useState<null | HTMLElement>(null);

  const selectedRoot = roots.find((r) => r.id === selectedRootId) ?? null;

  // 当前选中目录的绝对路径（选中根时即根路径；选中子目录时拼接）
  const selectedDirAbs = useMemo(() => {
    if (!selectedRoot || selectedDir === null) return null;
    if (selectedDir === '') return selectedRoot.path;
    return `${selectedRoot.path.replace(/[\\/]+$/, '')}\\${selectedDir.replace(/\//g, '\\')}`;
  }, [selectedRoot, selectedDir]);

  const selectedDirLabel = useMemo(() => {
    if (!selectedRoot || selectedDir === null || selectedDir === '') return '根目录';
    const normalized = selectedDir.replace(/[\\/]+$/, '').replace(/\\/g, '/');
    return normalized.split('/').filter(Boolean).pop() ?? '根目录';
  }, [selectedRoot, selectedDir]);

  /** 按目录集合累计可见图片数（隐藏子树已被 collectDirAndDescendants 剪掉） */
  const imageCountOf = useCallback(
    (dir: string) => {
      if (!selectedRootId) return 0;
      return countImagesInDirs(imagesByDir, selectedRootId, collectDirAndDescendants(tree, dir));
    },
    [selectedRootId, imagesByDir, tree]
  );

  // 当前目录（含子树）张数给目录条，本根总数给状态栏，两个数不再同名不同义
  const currentDirImageCount = imageCountOf(selectedDir ?? '');
  const currentRootImageCount = imageCountOf('');

  const currentRootScanState = selectedRootId ? (scanStateByRoot.get(selectedRootId) ?? 'idle') : 'idle';
  const currentRootScanStats = selectedRootId ? (scanStatsByRoot.get(selectedRootId) ?? null) : null;
  const scanProgress = scanProgressPercent(currentRootScanStats);
  const statusLabel = scanStatusLabel(currentRootScanState, currentRootScanStats);
  const handleRescan = useCallback(() => {
    void rescan();
  }, []);

  const handleCancel = useCallback(() => {
    void cancelScan();
  }, []);

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

  /**
   * 全局键位：`?` 唤出快捷键列表（批次3 G11）、`Ctrl + B` 收起/展开左栏。
   * 输入框里打问号是正常输入（文件名里就有 `?`），所以先挡掉可编辑目标再响应；
   * Ctrl+B 不产生文本，输入框里按也照样切换。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleTreeCollapsed();
        return;
      }
      if (e.key !== '?') return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true)
      ) {
        return;
      }
      setSettingsTab('shortcuts');
      setSettingsOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleTreeCollapsed]);

  /** 手动检查更新：先打开对话框展示状态，再触发检查 */
  const handleCheckUpdate = useCallback(async (): Promise<void> => {
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
      {/* 顶部工具栏：同时是窗口标题栏（拖拽区与右侧控件避让见 index.css 的 .ptm-titlebar） */}
      <Paper
        component="header"
        className="ptm-titlebar flex h-14 shrink-0 items-center justify-between rounded-none border-b border-slate-200 pl-4"
      >
        <Stack direction="row" spacing={1.5} alignItems="center" className="min-w-0">
          {/* 侧栏开关与隐藏集入口：左栏收起后这两个必须还在，否则目录管理没有出口 */}
          {hasRoot && (
            <Tooltip title={treeCollapsed ? '展开目录树（Ctrl + B）' : '收起目录树（Ctrl + B）'}>
              <IconButton size="small" aria-label={treeCollapsed ? '展开侧栏' : '折叠侧栏'} onClick={toggleTreeCollapsed} className="shrink-0">
                <ViewSidebarIcon />
              </IconButton>
            </Tooltip>
          )}
          {hasRoot && <HiddenFoldersButton />}
          <PhotoLibraryIcon color="primary" className="shrink-0" />
          <Typography variant="h6" sx={{ fontWeight: 700 }} className="shrink-0">
            <Box component="span">
              照片标签管家
              <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.75 }}>
                PhotoTagManager
              </Typography>
            </Box>
          </Typography>
          {selectedRoot && (
            <Tooltip title={selectedDirAbs ?? selectedRoot.path} placement="bottom-start">
              <Box
                className="min-w-0 shrink"
                sx={{ maxWidth: 520, minWidth: 0, border: '1px solid', borderColor: 'divider', borderRadius: 1, px: 1, py: 0.25 }}
              >
                <Typography
                  variant="caption"
                  noWrap
                  component="div"
                  sx={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {selectedDirLabel} ·{' '}
                  <Box component="span" sx={{ fontWeight: 400, color: 'text.secondary' }}>
                    {selectedDirAbs ?? selectedRoot.path}
                  </Box>
                </Typography>
              </Box>
            </Tooltip>
          )}
        </Stack>

        {/* 主操作在左、次操作在右，中间分隔线划开视觉权重（G6） */}
        <Stack direction="row" spacing={1} alignItems="center" className="shrink-0">
          <Button variant="contained" startIcon={<FolderOpenIcon />} onClick={() => void rootActions.addRoot()}>
            添加根目录
          </Button>
          <Button variant="outlined" startIcon={<RefreshIcon />} disabled={!hasRoot || scanning} onClick={handleRescan}>
            重新扫描
          </Button>
          {scanning && (
            <Button variant="text" color="error" startIcon={<StopCircleIcon />} onClick={handleCancel}>
              取消
            </Button>
          )}
          <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
          <Tooltip title="设置">
            <IconButton onClick={() => { setSettingsTab('general'); setSettingsOpen(true); }} aria-label="设置">
              <SettingsIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="更多操作">
            <IconButton onClick={(e) => setMoreAnchor(e.currentTarget)} aria-label="更多操作" aria-haspopup="menu">
              <MoreVertIcon />
            </IconButton>
          </Tooltip>
        </Stack>
      </Paper>
      {/* 主体：左单棵树 + 右网格 */}
      {!hasRoot ? (
        <EmptyState onPick={() => void rootActions.addRoot()} />
      ) : (
        <Box className="flex min-h-0 flex-1">
          {/* 收起=内联 display:none 而非卸载：FolderTree 的展开态要活过一次折叠 */}
          <Paper
            className="flex w-[280px] shrink-0 flex-col overflow-hidden rounded-none border-r border-slate-200"
            style={{ display: treeCollapsed ? 'none' : undefined }}
          >
            <FolderTree rootActions={rootActions} />
          </Paper>

          <Box className="flex min-w-0 flex-1 flex-col">
            <Paper className="flex shrink-0 items-center gap-2 rounded-none border-b border-slate-100 px-3 py-1" elevation={0}>
              <Typography variant="caption" color="text.secondary" noWrap title={selectedDirAbs ?? undefined}>
                当前目录：{selectedDirLabel} · {currentDirImageCount.toLocaleString()} 张图片
              </Typography>
            </Paper>
            <TagFilterBar />
            <Box className="min-h-0 flex-1">
              <ThumbnailGrid />
            </Box>
          </Box>
        </Box>
      )}

      {/* 底部状态栏：浏览统计在左，扫描状态只播一次（G7） */}
      <Paper className="flex h-7 shrink-0 items-center justify-between rounded-none border-t border-slate-200 px-3">
        <Typography variant="caption" color="text.secondary" noWrap>
          共 {currentRootImageCount.toLocaleString()} 张
          <span className="mx-2 text-slate-300">|</span>
          已选 {selectedImages.size} 张
        </Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          {statusLabel && (
            <Stack
              direction="row"
              spacing={1}
              alignItems="center"
              role="status"
              aria-live="polite"
              aria-busy={scanning}
            >
              <Typography
                variant="caption"
                sx={{
                  color:
                    currentRootScanState === 'error'
                      ? 'error.main'
                      : currentRootScanState === 'done'
                        ? 'success.main'
                        : 'text.secondary'
                }}
              >
                {statusLabel}
              </Typography>
              {scanning && (
                <Box className="w-32">
                  <LinearProgress
                    variant="determinate"
                    value={scanProgress}
                    sx={{ height: 4 }}
                    aria-label={`扫描进度 ${scanProgress}%`}
                  />
                </Box>
              )}
              {currentRootScanState === 'error' && (
                <Button size="small" color="error" onClick={handleRescan}>
                  重试
                </Button>
              )}
            </Stack>
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

      <UpdateDialog open={updateDialogOpen} onClose={() => setUpdateDialogOpen(false)} />
      {/* 应用级设置总入口（D16） */}
      <SettingsDialog open={settingsOpen} initialTab={settingsTab} onClose={() => setSettingsOpen(false)} />
      <AboutDialog open={aboutDialogOpen} onClose={() => setAboutDialogOpen(false)} />
      {rootDialogs}

      {/* 次操作收纳处：检查更新与关于不再裸占顶栏（G6） */}
      <Menu
        anchorEl={moreAnchor}
        open={moreAnchor !== null}
        onClose={() => setMoreAnchor(null)}
        PaperProps={{ sx: { minWidth: 196 } }}
      >
        <MenuItem onClick={() => { setMoreAnchor(null); void handleCheckUpdate(); }}>
          <ListItemIcon><SystemUpdateAltIcon fontSize="small" /></ListItemIcon>
          检查更新
        </MenuItem>
        <MenuItem onClick={() => { setMoreAnchor(null); setAboutDialogOpen(true); }}>
          <ListItemIcon><InfoOutlinedIcon fontSize="small" /></ListItemIcon>
          关于照片标签管家
        </MenuItem>
      </Menu>

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
