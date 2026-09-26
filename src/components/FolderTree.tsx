import { useMemo, useState } from 'react';
import { Box, Chip, Divider, IconButton, ListItemText, Menu, MenuItem, Stack, Tooltip, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CheckIcon from '@mui/icons-material/Check';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import DriveFileRenameOutlineIcon from '@mui/icons-material/DriveFileRenameOutline';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FolderIcon from '@mui/icons-material/Folder';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import PhotoLibraryIcon from '@mui/icons-material/PhotoLibrary';
import RefreshIcon from '@mui/icons-material/Refresh';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import { call, getApi } from '../api';
import { rootKey, useAppStore } from '../store/useAppStore';
import { startScan } from '../hooks/useScan';
import { buildTreeRows, type TreeRow } from '../utils/treeRows';
import type { RootActions } from '../hooks/useRootActions';

/**
 * 左栏单棵树（批次2 G5，R03/R04/R05 + 多根 R10）：
 * - 根作为顶层节点，子目录缩进在所属根下；同名根与同名子目录不再分处两块面板
 * - 展开态与隐藏集一律以 rootKey(rootId, relPath) 为键，按根分桶不互串
 * - 隐藏集收进行尾单个图标：数量在 tooltip，开关与逐项恢复在弹出菜单里
 * - 右键菜单：在资源管理器中打开 / 隐藏 / 取消隐藏 / 重新扫描（都针对该行所属根）；
 *   根行额外给改别名与删除，作为 hover 图标之外的同等入口
 */
export function FolderTree({ rootActions }: { rootActions: RootActions }): JSX.Element {
  const roots = useAppStore((s) => s.roots);
  const treesByRoot = useAppStore((s) => s.treesByRoot);
  const hiddenSet = useAppStore((s) => s.hiddenSet);
  const imagesByDir = useAppStore((s) => s.imagesByDir);
  const selectedRootId = useAppStore((s) => s.selectedRootId);
  const selectedDir = useAppStore((s) => s.selectedDir);
  const scannedRoots = useAppStore((s) => s.scannedRoots);
  const scanStateByRoot = useAppStore((s) => s.scanStateByRoot);
  const selectDir = useAppStore((s) => s.selectDir);
  const hideFolderLocal = useAppStore((s) => s.hideFolderLocal);
  const unhideFolderLocal = useAppStore((s) => s.unhideFolderLocal);
  const setSnackbar = useAppStore((s) => s.setSnackbar);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showHidden, setShowHidden] = useState(false);
  const [menu, setMenu] = useState<{ rootId: string; relPath: string; isRoot: boolean; mouseX: number; mouseY: number } | null>(null);
  const [hiddenAnchor, setHiddenAnchor] = useState<null | HTMLElement>(null);

  const rootById = useMemo(() => new Map(roots.map((root) => [root.id, root])), [roots]);

  /** 根目录直属图片不属于任何子目录节点，得单独按根数一遍给根行计数 */
  const rootDirectCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const root of roots) counts.set(root.id, imagesByDir.get(rootKey(root.id, ''))?.length ?? 0);
    return counts;
  }, [roots, imagesByDir]);

  const rows = useMemo(
    () =>
      buildTreeRows({
        roots,
        treesByRoot,
        hiddenSet,
        rootDirectCounts,
        expanded,
        selectedRootId,
        selectedDir,
        showHidden
      }),
    [roots, treesByRoot, hiddenSet, rootDirectCounts, expanded, selectedRootId, selectedDir, showHidden]
  );
  /** 跨根的隐藏目录清单，标签带根别名前缀免得分不清属于哪个根 */
  const hiddenEntries = useMemo(
    () =>
      [...hiddenSet]
        .map((key) => {
          const splitAt = key.indexOf('\u0000');
          const rootId = key.slice(0, splitAt);
          const relPath = key.slice(splitAt + 1);
          return { rootId, relPath, label: `${rootById.get(rootId)?.alias ?? rootId} / ${relPath}` };
        })
        .filter((entry) => entry.relPath !== '')
        .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN')),
    [hiddenSet, rootById]
  );

  const toggleExpand = (key: string): void => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSelectRow = async (row: TreeRow): Promise<void> => {
    const root = rootById.get(row.rootId);
    if (!root) return;
    if (row.isRoot) {
      // 已选中的根再点一次 = 回到根本身；换根交给 selectRoot（含懒扫描）
      if (row.rootId === selectedRootId) selectDir('');
      else await rootActions.selectRoot(root);
      return;
    }
    if (row.rootId !== selectedRootId) await rootActions.selectRoot(root);
    selectDir(row.relPath);
  };

  const handleHide = async (rootId: string, relPath: string): Promise<void> => {
    try {
      await call(getApi().hideFolder(rootId, relPath));
      hideFolderLocal(rootId, relPath);
    } catch {
      setSnackbar('隐藏文件夹失败');
    }
  };

  const handleUnhide = async (rootId: string, relPath: string): Promise<void> => {
    try {
      await call(getApi().unhideFolder(rootId, relPath));
      unhideFolderLocal(rootId, relPath);
    } catch {
      setSnackbar('取消隐藏失败');
    }
  };

  /** 在资源管理器中打开目录（根行 relPath='' 即根路径；子目录拼接相对路径） */
  const handleOpenInExplorer = async (rootId: string, relPath: string): Promise<void> => {
    const root = rootById.get(rootId);
    if (!root) return;
    const rootPath = root.path.replace(/[\\/]+$/, '');
    const absPath = relPath ? `${rootPath}\\${relPath.replace(/\//g, '\\')}` : rootPath;
    try {
      await call(getApi().openFolderInExplorer(absPath));
    } catch {
      setSnackbar('在资源管理器中打开失败');
    }
  };

  const handleMenuAction = (action: 'open' | 'hide' | 'unhide' | 'rescan' | 'rename' | 'remove'): void => {
    const target = menu;
    setMenu(null);
    if (!target) return;
    const root = rootById.get(target.rootId);
    if (!root) return;
    if (action === 'open') void handleOpenInExplorer(target.rootId, target.relPath);
    else if (action === 'hide') void handleHide(target.rootId, target.relPath);
    else if (action === 'unhide') void handleUnhide(target.rootId, target.relPath);
    else if (action === 'rename') rootActions.openRename(root);
    else if (action === 'remove') rootActions.openRemove(root);
    // 树上点到哪个根就重扫哪个根，不必先把选中切过去
    else void startScan(root);
  };
  return (
    <Box className="flex h-full flex-col">
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        className="shrink-0 border-b border-slate-100 px-2 py-1.5"
      >
        <Typography variant="subtitle2" color="text.secondary" className="pl-1">
          目录（{roots.length}）
        </Typography>
        <Stack direction="row" alignItems="center" spacing={0.25}>
          <Tooltip
            title={
              hiddenEntries.length === 0
                ? '没有已隐藏目录'
                : `已隐藏 ${hiddenEntries.length} 个目录${showHidden ? '（已在树中显示）' : ''}，点击管理`
            }
          >
            <IconButton
              size="small"
              color={showHidden ? 'primary' : 'default'}
              aria-label={`已隐藏 ${hiddenEntries.length} 个目录，点击管理`}
              onClick={(e) => setHiddenAnchor(e.currentTarget)}
            >
              {showHidden ? <VisibilityIcon fontSize="small" /> : <VisibilityOffIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
          <Tooltip title="添加根目录">
            <IconButton size="small" aria-label="添加根目录" onClick={() => void rootActions.addRoot()}>
              <AddIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      </Stack>

      <Box className="min-h-0 flex-1 overflow-auto py-1" role="tree" aria-label="图库目录树">
        {rows.length === 0 && (
          <Typography variant="body2" color="text.secondary" className="px-3 py-2">
            还没有根目录，点上方 + 添加
          </Typography>
        )}
        {rows.map((row) => (
          <TreeRowItem
            key={row.key}
            row={row}
            scanned={scannedRoots.has(row.rootId)}
            scanning={scanStateByRoot.get(row.rootId) === 'scanning'}
            onExpand={() => toggleExpand(row.key)}
            onSelect={() => void handleSelectRow(row)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ rootId: row.rootId, relPath: row.relPath, isRoot: row.isRoot, mouseX: e.clientX, mouseY: e.clientY });
            }}
            onRename={() => {
              const root = rootById.get(row.rootId);
              if (root) rootActions.openRename(root);
            }}
            onRemove={() => {
              const root = rootById.get(row.rootId);
              if (root) rootActions.openRemove(root);
            }}
          />
        ))}
      </Box>
      {/* 隐藏集管理：一个图标进、一个菜单出（显示开关 + 逐项恢复） */}
      <Menu
        anchorEl={hiddenAnchor}
        open={Boolean(hiddenAnchor)}
        onClose={() => setHiddenAnchor(null)}
        PaperProps={{ sx: { maxHeight: 360, width: 300 } }}
      >
        <MenuItem onClick={() => setShowHidden((v) => !v)}>
          <ListItemText primary="在树中显示已隐藏目录" />
          {showHidden && <CheckIcon fontSize="small" />}
        </MenuItem>
        <Divider />
        {hiddenEntries.length === 0 && <MenuItem disabled>暂无已隐藏目录</MenuItem>}
        {hiddenEntries.map((entry) => (
          <MenuItem
            key={entry.label}
            onClick={() => {
              setHiddenAnchor(null);
              void handleUnhide(entry.rootId, entry.relPath);
            }}
          >
            <ListItemText primary={entry.label} />
            <Chip size="small" label="恢复" color="primary" />
          </MenuItem>
        ))}
      </Menu>

      <Menu
        open={menu !== null}
        onClose={() => setMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={menu ? { top: menu.mouseY, left: menu.mouseX } : undefined}
      >
        <MenuItem onClick={() => handleMenuAction('open')}>
          <FolderOpenIcon fontSize="small" sx={{ mr: 1 }} />
          在资源管理器中打开
        </MenuItem>
        <Divider />
        <MenuItem disabled={menu?.relPath === ''} onClick={() => handleMenuAction('hide')}>
          隐藏文件夹
        </MenuItem>
        <MenuItem
          disabled={menu === null || !hiddenSet.has(rootKey(menu.rootId, menu.relPath))}
          onClick={() => handleMenuAction('unhide')}
        >
          取消隐藏
        </MenuItem>
        <Divider />
        <MenuItem onClick={() => handleMenuAction('rescan')}>
          <RefreshIcon fontSize="small" sx={{ mr: 1 }} />
          重新扫描
        </MenuItem>
        {/* 根行专属：改名与删除不只挂在 hover 上，键盘用户从菜单同样能触发 */}
        <MenuItem disabled={menu?.isRoot !== true} onClick={() => handleMenuAction('rename')}>
          改别名
        </MenuItem>
        <MenuItem disabled={menu?.isRoot !== true} color="error" onClick={() => handleMenuAction('remove')}>
          删除根目录
        </MenuItem>
      </Menu>
    </Box>
  );
}

interface TreeRowItemProps {
  row: TreeRow;
  scanned: boolean;
  scanning: boolean;
  onExpand: () => void;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onRename: () => void;
  onRemove: () => void;
}

/** 树里的一行：根行显示别名 + 扫描状态 + 改名/删除，目录行只有名字与计数 */
function TreeRowItem({ row, scanned, scanning, onExpand, onSelect, onContextMenu, onRename, onRemove }: TreeRowItemProps): JSX.Element {
  const ariaLabel = row.isRoot
    ? scanned
      ? `根目录 ${row.name}，共 ${row.totalCount} 张图片`
      : `根目录 ${row.name}，未扫描`
    : `${row.name}，${row.totalCount} 张图片`;
  return (
    <Box
      className="group flex cursor-pointer items-center gap-1 rounded-md py-1 pr-1.5"
      style={{ paddingLeft: 6 + row.depth * 14 }}
      role="treeitem"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-selected={row.selected}
      aria-expanded={row.hasChildren ? row.expanded : undefined}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        } else if (row.hasChildren && event.key === 'ArrowRight' && !row.expanded) {
          event.preventDefault();
          onExpand();
        } else if (row.hasChildren && event.key === 'ArrowLeft' && row.expanded) {
          event.preventDefault();
          onExpand();
        }
      }}
      onContextMenu={onContextMenu}
      sx={
        row.selected
          ? { bgcolor: 'primary.light', color: 'primary.contrastText' }
          : {
              '&:hover': { bgcolor: 'action.hover' },
              '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' },
              ...(row.rootSelected ? { bgcolor: 'action.selected' } : {}),
              ...(row.hidden ? { opacity: 0.55 } : {})
            }
      }
    >
      {row.hasChildren ? (
        <IconButton
          size="small"
          className="p-0.5"
          aria-label={row.expanded ? `收起${row.name}` : `展开${row.name}`}
          aria-expanded={row.expanded}
          onClick={(e) => {
            e.stopPropagation();
            onExpand();
          }}
        >
          {row.expanded ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
        </IconButton>
      ) : (
        <Box className="w-6 shrink-0" />
      )}
      {row.isRoot ? (
        <PhotoLibraryIcon fontSize="small" className="shrink-0" />
      ) : row.hidden ? (
        <VisibilityOffIcon fontSize="small" className="shrink-0" />
      ) : (
        <FolderIcon fontSize="small" className="shrink-0" />
      )}
      <Box className="min-w-0 flex-1">
        <Typography noWrap variant="body2" sx={row.isRoot ? { fontWeight: 600 } : undefined} title={row.name}>
          {row.name}
        </Typography>
        {row.isRoot && !scanned && !scanning && (
          <Typography noWrap variant="caption" sx={{ opacity: 0.65, display: 'block' }} title={ariaLabel}>
            尚未扫描
          </Typography>
        )}
      </Box>
      {scanning && <Box className="h-2 w-2 shrink-0 animate-pulse self-center rounded-full bg-amber-400" />}
      {row.isRoot && (
        <>
          <IconButton
            size="small"
            className="!p-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
            aria-label={`修改根目录别名：${row.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onRename();
            }}
          >
            <DriveFileRenameOutlineIcon fontSize="small" />
          </IconButton>
          <IconButton
            size="small"
            className="!p-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
            aria-label={`删除根目录：${row.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          >
            <DeleteOutlineIcon fontSize="small" />
          </IconButton>
        </>
      )}
      {(!row.isRoot || scanned) && (
        <Chip
          size="small"
          label={row.totalCount.toLocaleString()}
          variant="outlined"
          sx={{ height: 18, fontSize: 11, '& .MuiChip-label': { px: 0.6 } }}
        />
      )}
    </Box>
  );
}
