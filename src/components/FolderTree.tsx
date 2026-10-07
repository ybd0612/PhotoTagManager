import { useCallback, useMemo, useState } from 'react';
import { Box, Chip, Divider, IconButton, ListSubheader, Menu, MenuItem, Stack, Tooltip, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import DriveFileRenameOutlineIcon from '@mui/icons-material/DriveFileRenameOutline';
import FolderIcon from '@mui/icons-material/Folder';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import PhotoLibraryIcon from '@mui/icons-material/PhotoLibrary';
import RefreshIcon from '@mui/icons-material/Refresh';
import { call, getApi } from '../api';
import { rootKey, useAppStore } from '../store/useAppStore';
import { startScan } from '../hooks/useScan';
import { buildTreeRows, listHiddenUnder, type TreeRow } from '../utils/treeRows';
import { moveRootByOffset, reorderRootsByDrop, sameOrder, type DropPosition } from '../utils/rootOrder';
import type { RootActions } from '../hooks/useRootActions';

/**
 * 左栏单棵树（批次2 G5，R03/R04/R05 + 多根 R10）：
 * - 根作为顶层节点，子目录缩进在所属根下；同名根与同名子目录不再分处两块面板
 * - 展开态与隐藏集一律以 rootKey(rootId, relPath) 为键，按根分桶不互串
 * - 隐藏与恢复全部在右键菜单里：树不显示隐藏目录（没有查看开关），右键某行就列出它子树内的隐藏项
 * - 树头只留「添加根目录」；重新扫描由每行右键菜单发起，对那一行所属的根生效
 * - 右键菜单按行类型渲染，不给点不到的灰项：根行没有「隐藏文件夹」，目录行没有「改别名」「删除根目录」
 * - 「取消隐藏」按子树实际隐藏项渲染：0 项整块不出现（旧版是永久灰掉的哑项——能右键到的行必然不在
 *   隐藏集里）、1 项单行、≥2 项平铺成「全部恢复（N）」+ 逐项
 * - 根目录可拖拽排序（只排顶层根，子目录随根整体搬家）：HTML5 draggable，落点按指针在目标行的
 *   上/下半区决定插前还是插后，行缘画插入指示线；子目录行不可拖、也不接受落点（排序只作用于根）
 * - 拖拽对键盘用户不可用，根行右键补「上移/下移」等价入口，与菜单里其它可达项保持一致
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
  const setHiddenSet = useAppStore((s) => s.setHiddenSet);
  const reorderRootsLocal = useAppStore((s) => s.reorderRootsLocal);
  const setSnackbar = useAppStore((s) => s.setSnackbar);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ rootId: string; relPath: string; isRoot: boolean; mouseX: number; mouseY: number } | null>(null);
  /** 正在拖的根id；null = 没在拖。子目录行永不进入这里 */
  const [dragRootId, setDragRootId] = useState<string | null>(null);
  /** 当前落点提示：插到哪个根的前/后；null = 无落点 */
  const [dropHint, setDropHint] = useState<{ rootId: string; position: DropPosition } | null>(null);

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
        selectedDir
      }),
    [roots, treesByRoot, hiddenSet, rootDirectCounts, expanded, selectedRootId, selectedDir]
  );

  /** 右键那行的子树内被单独隐藏的目录（浅→深）；决定菜单里「取消隐藏」这一区怎么渲染 */
  const unhideTargets = useMemo(
    () => (menu === null ? [] : listHiddenUnder(hiddenSet, menu.rootId, menu.relPath)),
    [menu, hiddenSet]
  );

  /** 右键行在根列表里的位置：上移/下移据此判断是否已到边界（边界项给 disabled，不给点不到的动作） */
  const menuRootIndex = useMemo(
    () => (menu === null ? -1 : roots.findIndex((root) => root.id === menu.rootId)),
    [menu, roots]
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

  /**
   * 批量恢复：持久层只有单条 unhide（folderStore 无批量接口），逐条串行调用；
   * 全部做完再用 setHiddenSet 一次性写回该根剩余隐藏项——逐项调 unhideFolderLocal 会把目录树重建 N 次。
   * 失败项保留在隐藏集里（只恢复真正成功的那些），菜单不因此谎报已恢复。
   */
  const handleUnhideMany = async (rootId: string, relPaths: string[]): Promise<void> => {
    const done = new Set<string>();
    for (const relPath of relPaths) {
      try {
        await call(getApi().unhideFolder(rootId, relPath));
        done.add(relPath);
      } catch {
        /* 单条失败不中断整批 */
      }
    }
    const failed = relPaths.length - done.size;
    if (done.size > 0) {
      setHiddenSet(
        rootId,
        listHiddenUnder(hiddenSet, rootId, '').filter((path) => !done.has(path))
      );
    }
    if (failed > 0) setSnackbar(`已恢复 ${done.size} 个，${failed} 个失败`);
    setMenu(null);
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

  const handleMenuAction = (action: 'open' | 'hide' | 'rescan' | 'rename' | 'remove'): void => {
    const target = menu;
    setMenu(null);
    if (!target) return;
    const root = rootById.get(target.rootId);
    if (!root) return;
    if (action === 'open') void handleOpenInExplorer(target.rootId, target.relPath);
    else if (action === 'hide') void handleHide(target.rootId, target.relPath);
    else if (action === 'rename') rootActions.openRename(root);
    else if (action === 'remove') rootActions.openRemove(root);
    // 树上点到哪个根就重扫哪个根，不必先把选中切过去
    else void startScan(root);
  };

  /**
   * 应用新的根顺序：先本地重排（树立刻跟着动，不等IPC），再落盘。
   * 顺序没变就整段跳过——拖回原位不该产生一次写盘。
   * 落盘失败只提示，不回滚界面：内存顺序已经是用户看到的样子，回滚反而更让人困惑。
   */
  const applyRootOrder = useCallback(
    async (orderedIds: string[]): Promise<void> => {
      const current = useAppStore.getState().roots.map((root) => root.id);
      if (sameOrder(current, orderedIds)) return;
      reorderRootsLocal(orderedIds);
      try {
        await call(getApi().reorderRoots(orderedIds));
      } catch {
        setSnackbar('目录顺序保存失败，重启后会恢复');
      }
    },
    [reorderRootsLocal, setSnackbar]
  );

  /** 开始拖：只有根行可拖，draggable 与 onDragStart 都按isRoot 收口 */
  const handleDragStart = (rootId: string) => (event: React.DragEvent) => {
    setDragRootId(rootId);
    event.dataTransfer.effectAllowed = 'move';
    // Firefox/Electron 不给 draggable 元素设数据就不会启动拖拽，必须写一个载荷
    event.dataTransfer.setData('text/plain', rootId);
  };

  /**
   * 悬停算落点：按指针在目标行内的相对位置取上/下半区。
   * 非根行不接受落点（排序只作用于顶层根），自己那一行也直接放行——拖过自己时不闪提示线。
   */
  const handleDragOver = (row: TreeRow) => (event: React.DragEvent<HTMLElement>) => {
    if (dragRootId === null || !row.isRoot || row.rootId === dragRootId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    const position: DropPosition = event.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
    setDropHint((prev) =>
      prev && prev.rootId === row.rootId && prev.position === position ? prev : { rootId: row.rootId, position }
    );
  };

  const handleDragLeave = (row: TreeRow) => (): void => {
    setDropHint((prev) => (prev && prev.rootId === row.rootId ? null : prev));
  };

  const handleDrop = (row: TreeRow) => (event: React.DragEvent<HTMLElement>): void => {
    if (dragRootId === null || !row.isRoot) return;
    event.preventDefault();
    const fromId = dragRootId;
    // 落点优先用提示线算出的结果；提示线没画出来（指针压边）时退回按位置推算
    const position =
      dropHint && dropHint.rootId === row.rootId
        ? dropHint.position
        : (() => {
            const rect = event.currentTarget.getBoundingClientRect();
            return event.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
          })();
    setDragRootId(null);
    setDropHint(null);
    void applyRootOrder(reorderRootsByDrop(roots, fromId, row.rootId, position));
  };

  /** 拖拽收尾：dragend 在任何路径都会来（含落在树外被取消），统一清干净，别留残影 */
  const handleDragEnd = (): void => {
    setDragRootId(null);
    setDropHint(null);
  };

  /** 菜单里的上移/下移：拖拽的键盘等价物，边界位返回原顺序，这里自然无操作 */
  const handleMoveRoot = async (rootId: string, delta: -1 | 1): Promise<void> => {
    setMenu(null);
    await applyRootOrder(moveRootByOffset(roots, rootId, delta));
  };

  /** 菜单里的隐藏项标签：相对右键目录显示，免得列出一串重复的祖先路径 */
  const hiddenItemLabel = (path: string): string =>
    menu === null || menu.relPath === '' ? path : path.slice(menu.relPath.length + 1);
  return (
    <Box className="flex h-full flex-col">
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        className="ptm-band-row shrink-0 px-2 py-2"
      >
        <Typography variant="subtitle2" color="text.secondary" className="pl-1">
          图库 · {roots.length} 个目录
        </Typography>
        <Stack direction="row" alignItems="center" spacing={0.25}>
          {/* 拖拽排序没有明显把手，靠一次说明让用户知道目录行能拖；只有一个目录时排了也看不出差别，不提示 */}
          {roots.length > 1 && (
            <Tooltip title="拖动目录行可调整顺序">
              <Typography variant="caption" color="text.secondary" className="cursor-help">
                可拖动排序
              </Typography>
            </Tooltip>
          )}
          <Tooltip title="添加目录">
            <IconButton size="small" aria-label="添加目录" onClick={() => void rootActions.addRoot()}>
              <AddIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      </Stack>

      {/*
       * 标题与树之间只放一条又窄又居中的分割线。原先是通栏 border-b：它要和右边那条线对齐才好看，
       * 而两行内容高度不同，对齐不上就成了两根错位的长线（用户就是这么报的）。
       * 居中的窄线不声称"整行到此为止"，所以不参与跨栏对齐，怎么都不会打架。
       */}
      <Box className="flex shrink-0 justify-center" sx={{ height: 11 }}>
        {/**
         * 尺寸必须带单位。MUI 的 sx 里 `height: 1` / `width: 1` 不是 1px，而是"占父级的 100%"，
         * `borderRadius: 1` 也不是 1px，而是主题 shape 圆角的 1 倍（本项目 = 12px）。
         * 上一版这么写，量出来是 20×11px、圆角 12px 的一个粗块——用户说"不是这个意思，是很窄的线"
         * 说的就是它。jsdom 量不到，是活窗口 CDP 实测发现的。
         */}
        <Box sx={{ width: 20, height: '1px', borderRadius: 0, bgcolor: 'var(--ptm-hairline)' }} />
      </Box>

      <Box className="min-h-0 flex-1 overflow-auto py-1" role="tree" aria-label="图库目录树">
        {rows.length === 0 && (
          <Typography variant="body2" color="text.secondary" className="px-3 py-2">
            还没有目录，点上方「添加目录」
          </Typography>
        )}
        {rows.map((row) => (
          <TreeRowItem
            key={row.key}
            row={row}
            scanned={scannedRoots.has(row.rootId)}
            scanning={scanStateByRoot.get(row.rootId) === 'scanning'}
            dragging={dragRootId === row.rootId}
            dropHint={dropHint && dropHint.rootId === row.rootId ? dropHint.position : null}
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
            onDragStart={handleDragStart(row.rootId)}
            onDragOver={handleDragOver(row)}
            onDragLeave={handleDragLeave(row)}
            onDrop={handleDrop(row)}
            onDragEnd={handleDragEnd}
          />
        ))}
      </Box>
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
        {(menu !== null && (!menu.isRoot || unhideTargets.length > 0)) && (
          <>
            <Divider />
            {menu !== null && !menu.isRoot && (
              <MenuItem onClick={() => handleMenuAction('hide')}>隐藏文件夹</MenuItem>
            )}
            {menu !== null && unhideTargets.length === 1 && (
              <MenuItem onClick={() => void handleUnhide(menu.rootId, unhideTargets[0])}>取消隐藏</MenuItem>
            )}
            {menu !== null && unhideTargets.length >= 2 && (
              <>
                <MenuItem color="primary" onClick={() => void handleUnhideMany(menu.rootId, unhideTargets)}>
                  全部恢复（{unhideTargets.length} 个）
                </MenuItem>
                <ListSubheader component="div" sx={{ lineHeight: '24px', fontSize: 12, fontWeight: 600 }}>
                  已隐藏
                </ListSubheader>
                {unhideTargets.map((path) => (
                  <MenuItem key={path} sx={{ pl: 3 }} onClick={() => void handleUnhide(menu.rootId, path)}>
                    {hiddenItemLabel(path)}
                  </MenuItem>
                ))}
              </>
            )}
          </>
        )}
        <Divider />
        <MenuItem onClick={() => handleMenuAction('rescan')}>
          <RefreshIcon fontSize="small" sx={{ mr: 1 }} />
          重新扫描
        </MenuItem>
        {/* 根行专属：改名、删除、排序都不只挂在 hover 上，键盘用户从菜单同样能触发；目录行整条不出现，不给点不到的灰项 */}
        {menu !== null && menu.isRoot && (
          <>
            <MenuItem onClick={() => handleMenuAction('rename')}>改别名</MenuItem>
            {/* 拖拽排序的键盘等价入口：已在顶/底时 moveRootByOffset 原样返回，点了不报错也不写盘 */}
            <MenuItem disabled={menuRootIndex === 0} onClick={() => void handleMoveRoot(menu.rootId, -1)}>
              <ArrowUpwardIcon fontSize="small" sx={{ mr: 1 }} />
              上移
            </MenuItem>
            <MenuItem disabled={menuRootIndex === roots.length - 1} onClick={() => void handleMoveRoot(menu.rootId, 1)}>
              <ArrowDownwardIcon fontSize="small" sx={{ mr: 1 }} />
              下移
            </MenuItem>
            <MenuItem color="error" onClick={() => handleMenuAction('remove')}>
              删除目录
            </MenuItem>
          </>
        )}
      </Menu>
    </Box>
  );
}

interface TreeRowItemProps {
  row: TreeRow;
  scanned: boolean;
  scanning: boolean;
  /** 正被拖起（半透明 + 禁止原位点击） */
  dragging: boolean;
  /** 落点提示线画在这一行的上缘还是下缘；null = 不画 */
  dropHint: DropPosition | null;
  onExpand: () => void;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onRename: () => void;
  onRemove: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent<HTMLElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}

/** 树里的一行：根行显示别名 + 扫描状态 + 改名/删除，目录行只有名字与计数 */
function TreeRowItem({
  row,
  scanned,
  scanning,
  dragging,
  dropHint,
  onExpand,
  onSelect,
  onContextMenu,
  onRename,
  onRemove,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd
}: TreeRowItemProps): JSX.Element {
  const ariaLabel = row.isRoot
    ? scanned
      ? `目录 ${row.name}，共 ${row.totalCount} 张图片`
      : `目录 ${row.name}，未扫描`
    : `${row.name}，${row.totalCount} 张图片`;
  return (
    <Box
      className="ptm-tree-row group relative flex cursor-pointer items-center gap-1 rounded-md py-1 pr-1.5"
      style={{ paddingLeft: 6 + row.depth * 14, opacity: dragging ? 0.4 : 1 }}
      role="treeitem"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-selected={row.selected}
      aria-expanded={row.hasChildren ? row.expanded : undefined}
      // 只有根行可拖：draggable 给到子目录行会让整棵树都能被拖起来，排序却只对根生效
      draggable={row.isRoot}
      onDragStart={row.isRoot ? onDragStart : undefined}
      onDragOver={row.isRoot ? onDragOver : undefined}
      onDragLeave={row.isRoot ? onDragLeave : undefined}
      onDrop={row.isRoot ? onDrop : undefined}
      onDragEnd={row.isRoot ? onDragEnd : undefined}
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
              ...(row.rootSelected ? { bgcolor: 'action.selected' } : {})
            }
      }
    >
      {row.hasChildren ? (
        <IconButton
          size="small"
          // 展开态必须一直可见（否则收不回去）；折叠态与行内操作同一套显示规则：
          // 只认悬停与键盘聚焦，不认鼠标点选带来的焦点
          className={`!min-w-0 shrink-0 ${row.expanded ? 'opacity-100' : 'ptm-row-actions'}`}
          sx={{ width: 26, height: 26, padding: 1, transform: row.expanded ? 'rotate(90deg)' : undefined, transition: 'opacity 120ms, transform 120ms' }}
          aria-label={row.expanded ? `收起${row.name}` : `展开${row.name}`}
          aria-expanded={row.expanded}
          onClick={(e) => {
            e.stopPropagation();
            onExpand();
          }}
        >
          <ChevronRightIcon fontSize="small" />
        </IconButton>
      ) : (
        <Box className="shrink-0" sx={{ width: 26 }} />
      )}
      {row.isRoot ? <PhotoLibraryIcon fontSize="small" className="shrink-0" /> : <FolderIcon fontSize="small" className="shrink-0" />}
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
      {scanning && <Box className="h-2 w-2 shrink-0 animate-pulse self-center rounded-full bg-warning" />}
      {row.isRoot && (
        <>
          <IconButton
            size="small"
            className="ptm-row-actions !p-0.5"
            aria-label={`修改目录别名：${row.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onRename();
            }}
          >
            <DriveFileRenameOutlineIcon fontSize="small" />
          </IconButton>
          <IconButton
            size="small"
            className="ptm-row-actions !p-0.5"
            aria-label={`删除目录：${row.name}`}
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
      {/*
       * 落点提示线：画在目标行的上缘或下缘，2px 主色横线加两个端点小圆点，
       * 宽度跟着行走（absolute 定位在 relative 的行盒里，不额外占布局高度）。
       */}
      {dropHint !== null && (
        <Box
          data-testid={`drop-hint-${row.rootId}`}
          className="pointer-events-none absolute left-1 right-1 z-10 flex items-center"
          sx={{ [dropHint === 'before' ? 'top' : 'bottom']: -1, height: 2 }}
        >
          <Box sx={{ width: 5, height: 5, borderRadius: '50%', bgcolor: 'primary.main', ml: -0.5 }} />
          <Box className="flex-1" sx={{ height: 2, bgcolor: 'primary.main' }} />
          <Box sx={{ width: 5, height: 5, borderRadius: '50%', bgcolor: 'primary.main', mr: -0.5 }} />
        </Box>
      )}
    </Box>
  );
}
