import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import {
  Box,
  Button,
  ButtonBase,
  Divider,
  IconButton,
  LinearProgress,
  Paper,
  Snackbar,
  Stack,
  Tooltip,
  Typography
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import PhotoLibraryIcon from '@mui/icons-material/PhotoLibrary';
import SettingsIcon from '@mui/icons-material/Settings';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { useAppStore } from '../store/useAppStore';
import { call, getApi } from '../api';
import { cancelScan, rescan } from '../hooks/useScan';
import { useRootActions } from '../hooks/useRootActions';
import { collectDirAndDescendants } from '../utils/folders';
import { countImagesInDirs } from '../utils/treeRows';
import { scanProgressPercent, scanStatusLabel } from '../utils/scanStatus';
import { BrandLogo } from './BrandLogo';
import { FolderTree } from './FolderTree';
import { TagFilterBar } from './TagFilterBar';
import { ThumbnailGrid } from './ThumbnailGrid';
import { PreviewOverlay } from './PreviewOverlay';
import { useUpdate } from '../hooks/useUpdate';
import { updateActionLabel, updatePrimaryAction, updateStatusLabel } from '../utils/updateStatus';
import { SettingsDialog } from './settings/SettingsDialog';
import { tokens } from '../theme/tokens';

/**
 * 折叠把手的唤出带与滞留带（相对分界线的横向距离，px）。
 * 把手本体压在分界线上、左右各 13px，左半正好盖住左栏那条 8px 滚动条，因此：
 * - 唤出只认内容区一侧 6..26px：判定带一旦伸进滚动条，鼠标一碰滚动条把手就送到指针底下，滚动条再也拖不动；
 * - 滞留放宽到 -14..34px：否则指针往把手左半挪一点就掉出唤出带，把手自己把自己藏掉，看着在眼前却点不着。
 */
const TREE_HANDLE_SHOW_FROM = 6;
const TREE_HANDLE_SHOW_TO = 26;
const TREE_HANDLE_KEEP_FROM = -14;
const TREE_HANDLE_KEEP_TO = 34;

/** 状态栏路径最多显示的字符数，超出后中段省略（完整路径在悬停 Tooltip 里） */
const STATUS_PATH_MAX_CHARS = 56;

/**
 * 路径中段省略：`C:\Users\ybd06\Pictures\PixPinAutoSave\2024\01` → `C:\Users\ybd06\Pictures\…\PixPinAutoSave\2024\01`。
 * 不用 CSS 的 `text-overflow: ellipsis`：那只掐尾巴，而路径最有信息量的正是尾巴（末级目录与其父级）；
 * 也不换行——状态栏只有 28px 高，一换行就把右侧扫描状态挤没了。
 */
function truncatePathMiddle(path: string, maxChars: number): string {
  if (path.length <= maxChars) return path;
  // 头 6 成尾 4 成：尾部至少留 12 字符，否则末级目录名会被省略号吃掉
  const tailChars = Math.max(12, Math.floor(maxChars * 0.4));
  const headChars = maxChars - tailChars - 1;
  return `${path.slice(0, headChars)}…${path.slice(path.length - tailChars)}`;
}

/**
 * 三栏布局容器 + 顶部工具栏 + 底部状态栏（PRD §3.3 线框图，多根 R10）。
 * 批次2 起：左栏是一棵「根 + 子目录」合并树（G5），状态栏扫描文案只播一次（G7）。
 * 批次4 起：添加根目录与重新扫描都归到左栏树头，顶栏只剩标题区、扫描中的「取消」和设置入口。
 * 检查更新与关于（原 G6 的溢出菜单）现收在设置弹窗的「关于与更新」分区，顶栏不再有次操作菜单。
 * 「当前目录」一条信息（目录名 + 绝对路径 + 张数）只说一次，统一落在底部状态栏左侧，
 * 路径可点击复制；顶栏不再挂路径 chip（顶栏是窗口拖拽区，在里面放可点元素要在拖拽区上挖洞）。
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
  /**
   * 折叠把手只在鼠标贴近左栏右缘时出现。判定用坐标而不是铺一层 `:hover` 热区：
   * 热区层会盖住树右缘的 8px 滚动条和网格左缘，把这两处的点击吞掉。
   * 显隐分唤出带与滞留带两档，理由见 TREE_HANDLE_SHOW_FROM 那组常量。
   * 用 mousemove 而不是 pointermove：本机只有鼠标这一种指针，而 jsdom 造的 PointerEvent 不带 clientX。
   */
  const treePaneRef = useRef<HTMLDivElement>(null);
  const [treeHandleVisible, setTreeHandleVisible] = useState(false);
  const handleBodyMouseMove = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const edge = treePaneRef.current?.getBoundingClientRect().right ?? 0;
    const offset = e.clientX - edge;
    if (treeHandleVisible) {
      if (offset < TREE_HANDLE_KEEP_FROM || offset > TREE_HANDLE_KEEP_TO) setTreeHandleVisible(false);
    } else if (offset >= TREE_HANDLE_SHOW_FROM && offset <= TREE_HANDLE_SHOW_TO) {
      setTreeHandleVisible(true);
    }
  };
  /** 整应用唯一一份更新状态订阅：右下角通知卡与设置「关于与更新」分区共用 */
  const update = useUpdate();

  const selectedRoot = roots.find((r) => r.id === selectedRootId) ?? null;

  // 当前选中目录的绝对路径（选中根时即根路径；选中子目录时拼接）
  const selectedDirAbs = useMemo(() => {
    if (!selectedRoot || selectedDir === null) return null;
    if (selectedDir === '') return selectedRoot.path;
    return `${selectedRoot.path.replace(/[\\/]+$/, '')}\\${selectedDir.replace(/\//g, '\\')}`;
  }, [selectedRoot, selectedDir]);

  /** 状态栏左侧目录名：选中根本身时用根别名（与左栏树行同一口径），否则取末级目录名 */
  const selectedDirLabel = useMemo(() => {
    if (!selectedRoot) return '';
    if (selectedDir === null || selectedDir === '') return selectedRoot.alias;
    const normalized = selectedDir.replace(/[\\/]+$/, '').replace(/\\/g, '/');
    return normalized.split('/').filter(Boolean).pop() ?? selectedRoot.alias;
  }, [selectedRoot, selectedDir]);

  /** 按目录集合累计可见图片数（隐藏子树已被 collectDirAndDescendants 剪掉） */
  const imageCountOf = useCallback(
    (dir: string) => {
      if (!selectedRootId) return 0;
      return countImagesInDirs(imagesByDir, selectedRootId, collectDirAndDescendants(tree, dir));
    },
    [selectedRootId, imagesByDir, tree]
  );

  // 当前目录（含子树）张数给状态栏「当前」，本根总数给「共」，两个数不再同名不同义
  const currentDirImageCount = imageCountOf(selectedDir ?? '');
  const currentRootImageCount = imageCountOf('');
  // 选中根本身时两个数必然相等，只报「共」一次
  const isBrowsingRoot = selectedDir === null || selectedDir === '';

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

  /** 点状态栏路径 = 复制当前目录绝对路径（走纯文本通道，不是复制文件那条） */
  const handleCopyDirPath = useCallback(async (): Promise<void> => {
    if (!selectedDirAbs) return;
    try {
      await call(getApi().copyTextToClipboard(selectedDirAbs));
      setSnackbar('已复制路径');
    } catch {
      setSnackbar('复制路径失败');
    }
  }, [selectedDirAbs, setSnackbar]);

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
    <Box className="flex h-full flex-col bg-canvas">
      {/* 顶部工具栏：同时是窗口标题栏（拖拽区与右侧控件避让见 index.css 的 .ptm-titlebar） */}
      <Paper
        component="header"
        className="ptm-titlebar flex h-14 shrink-0 items-center justify-between border-b border-hairline bg-chrome pl-4"
        // 通栏与上下板块相接，四角必须直；写在 sx 里才压得住 MUI Paper 的默认圆角
        sx={{ bgcolor: 'var(--ptm-chrome-bg)', borderRadius: 0 }}
      >
        <Stack direction="row" spacing={1.5} alignItems="center" className="min-w-0">
          {/* 品牌位：与任务栏/托盘/安装包同源的那张图，不用 MUI 通用图标 */}
          <BrandLogo />
          <Typography variant="h6" sx={{ fontWeight: 700 }} className="shrink-0">
            <Box component="span">
              图片管家
              <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.75 }}>
                PhotoTagManager
              </Typography>
            </Box>
          </Typography>
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
        <Box
          className="relative flex min-h-0 flex-1"
          onMouseMove={handleBodyMouseMove}
          onMouseLeave={() => setTreeHandleVisible(false)}
        >
          {/*
            折叠改成宽度过渡（样式见 styles/index.css 的 .ptm-tree-pane），不再用 display:none 硬切。
            必须分两层：外层只负责裁剪与动画，内层 .ptm-tree-inner 定宽——否则树里几十行文字
            每帧都要重新换行测量，动画本身就成了卡顿的来源。宽度只在 CSS 变量里声明一次。
            FolderTree 始终挂载，展开态要活过一次折叠。
          */}
          {/* 折叠后对读屏不可达：CSS 的 visibility:hidden 是运行时那一半，aria-hidden 是不依赖样式表的另一半 */}
          <div
            ref={treePaneRef}
            className={treeCollapsed ? 'ptm-tree-pane ptm-tree-pane--collapsed' : 'ptm-tree-pane'}
            aria-hidden={treeCollapsed || undefined}
          >
            <Paper
              className="ptm-tree-inner flex h-full flex-col overflow-hidden border-r border-hairline bg-chrome"
              // 通栏与上下板块相接，四角必须直；写在 sx 里才压得住 MUI Paper 的默认圆角
        sx={{ bgcolor: 'var(--ptm-chrome-bg)', borderRadius: 0 }}
            >
              <FolderTree rootActions={rootActions} />
            </Paper>
          </div>

          {/*
            折叠把手：压在左栏右缘的分界线上，鼠标贴近才淡入（判定见 handleBodyMouseMove）。
            顶栏那颗常驻按钮撤掉后，这里是唯一的鼠标出口，Ctrl + B 是键盘出口；
            收起态左栏宽度归 0，把手跟着贴到窗口左缘，整棵树不会没有出口。
          */}
          <Tooltip title={treeCollapsed ? '展开目录树（Ctrl + B）' : '收起目录树（Ctrl + B）'}>
            <Box
              className={`ptm-tree-handle${treeCollapsed ? ' ptm-tree-handle--collapsed' : ''}${
                treeHandleVisible ? ' ptm-tree-handle--visible' : ''
              }`}
            >
              <IconButton
                size="small"
                aria-label={treeCollapsed ? '展开侧栏' : '折叠侧栏'}
                onClick={toggleTreeCollapsed}
                sx={{
                  width: 24,
                  height: 24,
                  border: '1px solid',
                  borderColor: 'divider',
                  bgcolor: 'background.paper',
                  color: 'text.secondary',
                  boxShadow: 1,
                  '&:hover': { bgcolor: 'action.hover', color: 'text.primary' }
                }}
              >
                {treeCollapsed ? <ChevronRightIcon fontSize="small" /> : <ChevronLeftIcon fontSize="small" />}
              </IconButton>
            </Box>
          </Tooltip>

          <Box className="flex min-w-0 flex-1 flex-col">
            <TagFilterBar />
            <Box className="min-h-0 flex-1">
              <ThumbnailGrid />
            </Box>
          </Box>
        </Box>
      )}

      {/* 底部状态栏：当前目录（名称 + 可复制的绝对路径）与浏览统计在左，扫描状态只播一次（G7） */}
      <Paper
        className="flex h-7 shrink-0 items-center justify-between border-t border-hairline bg-chrome px-3"
        // 通栏与上下板块相接，四角必须直；写在 sx 里才压得住 MUI Paper 的默认圆角
        sx={{ bgcolor: 'var(--ptm-chrome-bg)', borderRadius: 0 }}
      >
        <Stack direction="row" spacing={1} alignItems="center" className="min-w-0">
          {selectedDirAbs && (
            <>
              <Typography
                variant="caption"
                data-testid="status-dir-name"
                className="min-w-0"
                sx={{ fontWeight: 600 }}
                noWrap
              >
                {selectedDirLabel}
              </Typography>
              <span className="shrink-0 text-ink-3">|</span>
              <Tooltip title={`点击复制绝对路径：${selectedDirAbs}`} placement="top-start">
                <ButtonBase
                  aria-label="复制当前目录路径"
                  onClick={() => void handleCopyDirPath()}
                  sx={{
                    minWidth: 0,
                    maxWidth: 460,
                    px: 0.75,
                    py: 0,
                    borderRadius: tokens.radius.sm,
                    color: 'text.secondary',
                    '&:hover': { bgcolor: 'action.hover', color: 'text.primary' }
                  }}
                >
                  <Stack direction="row" spacing={0.5} alignItems="center" className="min-w-0">
                    <Typography variant="caption" className="min-w-0" noWrap sx={{ color: 'inherit' }}>
                      {truncatePathMiddle(selectedDirAbs, STATUS_PATH_MAX_CHARS)}
                    </Typography>
                    <ContentCopyIcon sx={{ fontSize: 12, flexShrink: 0 }} />
                  </Stack>
                </ButtonBase>
              </Tooltip>
              <span className="shrink-0 text-ink-3">|</span>
            </>
          )}
          <Typography variant="caption" color="text.secondary" noWrap>
            {!isBrowsingRoot && (
              <>
                当前 {currentDirImageCount.toLocaleString()} 张
                <span className="mx-2 text-ink-3">|</span>
              </>
            )}
            共 {currentRootImageCount.toLocaleString()} 张
            <span className="mx-2 text-ink-3">|</span>
            已选 {selectedImages.size} 张
          </Typography>
        </Stack>
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
