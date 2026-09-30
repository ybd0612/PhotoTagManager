import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Divider,
  IconButton,
  LinearProgress,
  Paper,
  Snackbar,
  Stack,
  Tooltip,
  Typography
} from '@mui/material';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import PhotoLibraryIcon from '@mui/icons-material/PhotoLibrary';
import SettingsIcon from '@mui/icons-material/Settings';
import ViewSidebarIcon from '@mui/icons-material/ViewSidebar';
import { useAppStore } from '../store/useAppStore';
import { cancelScan, rescan } from '../hooks/useScan';
import { useRootActions } from '../hooks/useRootActions';
import { collectDirAndDescendants } from '../utils/folders';
import { countImagesInDirs } from '../utils/treeRows';
import { scanProgressPercent, scanStatusLabel } from '../utils/scanStatus';
import { FolderTree } from './FolderTree';
import { TagFilterBar } from './TagFilterBar';
import { ThumbnailGrid } from './ThumbnailGrid';
import { PreviewOverlay } from './PreviewOverlay';
import { useUpdate } from '../hooks/useUpdate';
import { updateActionLabel, updatePrimaryAction, updateStatusLabel } from '../utils/updateStatus';
import { SettingsDialog } from './settings/SettingsDialog';

/**
 * 三栏布局容器 + 顶部工具栏 + 底部状态栏（PRD §3.3 线框图，多根 R10）。
 * 批次2 起：左栏是一棵「根 + 子目录」合并树（G5），状态栏扫描文案只播一次（G7）。
 * 批次4 起：添加根目录与重新扫描都归到左栏树头，顶栏只剩标题区、扫描中的「取消」和设置入口。
 * 检查更新与关于（原 G6 的溢出菜单）现收在设置弹窗的「关于与更新」分区，顶栏不再有次操作菜单。
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 打开设置时停在哪个分区：工具栏按钮进「常规」，`?` 直接进「快捷键」（批次3 G11） */
  const [settingsTab, setSettingsTab] = useState<'general' | 'ai' | 'shortcuts'>('general');
  /** 整应用唯一一份更新状态订阅：右下角通知卡与设置「关于与更新」分区共用 */
  const update = useUpdate();

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

  // 启动静默检查一次：结果只进右下角通知卡，不再弹模态
  useEffect(() => {
    void update.check();
  }, [update.check]);

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

  const scanning = currentRootScanState === 'scanning';
  const hasRoot = roots.length > 0 && selectedRootId !== null;
  // 通知卡只在需要用户有所动作、或正在跑的时候出现；not-available 这类"没什么可说"的静默
  const updateNoticeVisible =
    update.status.state === 'available' ||
    update.status.state === 'downloading' ||
    update.status.state === 'downloaded';
  const updateNoticeAction = updatePrimaryAction(update.status);
  return (
    <Box className="flex h-full flex-col bg-slate-50">
      {/* 顶部工具栏：同时是窗口标题栏（拖拽区与右侧控件避让见 index.css 的 .ptm-titlebar） */}
      <Paper
        component="header"
        className="ptm-titlebar flex h-14 shrink-0 items-center justify-between rounded-none border-b border-slate-200 pl-4"
      >
        <Stack direction="row" spacing={1.5} alignItems="center" className="min-w-0">
          {/* 侧栏开关：左栏收起后必须还在，否则整棵树没有出口 */}
          {hasRoot && (
            <Tooltip title={treeCollapsed ? '展开目录树（Ctrl + B）' : '收起目录树（Ctrl + B）'}>
              <IconButton size="small" aria-label={treeCollapsed ? '展开侧栏' : '折叠侧栏'} onClick={toggleTreeCollapsed} className="shrink-0">
                <ViewSidebarIcon />
              </IconButton>
            </Tooltip>
          )}
          <PhotoLibraryIcon color="primary" className="shrink-0" />
          <Typography variant="h6" sx={{ fontWeight: 700 }} className="shrink-0">
            <Box component="span">
              图片管家
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

        {/* 次操作区：扫描中才出现「取消」，分隔线随之只在需要它时渲染 */}
        <Stack direction="row" spacing={1} alignItems="center" className="shrink-0">
          {scanning && (
            <>
              <Button variant="text" color="error" startIcon={<StopCircleIcon />} onClick={handleCancel}>
                取消
              </Button>
              <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
            </>
          )}
          <Tooltip title="设置">
            <IconButton onClick={() => { setSettingsTab('general'); setSettingsOpen(true); }} aria-label="设置">
              <SettingsIcon />
            </IconButton>
          </Tooltip>
        </Stack>
      </Paper>
      {/* 主体：左单棵树 + 右网格 */}
      {!hasRoot ? (
        <EmptyState onPick={() => void rootActions.addRoot()} />
      ) : (
        <Box className="flex min-h-0 flex-1">
          {/*
            折叠改成宽度过渡（样式见 styles/index.css 的 .ptm-tree-pane），不再用 display:none 硬切。
            必须分两层：外层只负责裁剪与动画，内层 .ptm-tree-inner 定宽——否则树里几十行文字
            每帧都要重新换行测量，动画本身就成了卡顿的来源。宽度只在 CSS 变量里声明一次。
            FolderTree 始终挂载，展开态要活过一次折叠。
          */}
          {/* 折叠后对读屏不可达：CSS 的 visibility:hidden 是运行时那一半，aria-hidden 是不依赖样式表的另一半 */}
          <div
            className={treeCollapsed ? 'ptm-tree-pane ptm-tree-pane--collapsed' : 'ptm-tree-pane'}
            aria-hidden={treeCollapsed || undefined}
          >
            <Paper className="ptm-tree-inner flex h-full flex-col overflow-hidden rounded-none border-r border-slate-200">
              <FolderTree rootActions={rootActions} />
            </Paper>
          </div>

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

      {/* 固定位置的非阻塞更新提示：文案与动作跟设置分区用同一套派生，两处永远一致 */}
      {updateNoticeVisible && (
        <Paper
          elevation={3}
          data-testid="update-notice"
          sx={{ position: 'fixed', right: 20, bottom: 44, zIndex: (theme) => theme.zIndex.snackbar, minWidth: 240, px: 2, py: 1 }}
        >
          <Typography variant="caption" display="block">
            {updateStatusLabel(update.status)}
          </Typography>
          {update.status.state === 'downloading' && (
            <LinearProgress variant="determinate" value={update.status.percent ?? 0} sx={{ mt: 0.5 }} />
          )}
          {updateNoticeAction && (
            <Button
              size="small"
              data-testid="update-notice-action"
              onClick={update.runPrimary}
              sx={{ mt: 0.5, textTransform: 'none' }}
            >
              {updateActionLabel(updateNoticeAction, update.status)}
            </Button>
          )}
        </Paper>
      )}

      {/* 应用级设置总入口（D16）：更新在「关于与更新」分区就地完成，不再另开对话框 */}
      <SettingsDialog
        open={settingsOpen}
        initialTab={settingsTab}
        onClose={() => setSettingsOpen(false)}
        update={update}
      />
      {rootDialogs}

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
