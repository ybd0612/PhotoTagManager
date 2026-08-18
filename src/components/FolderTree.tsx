import { useState } from 'react';
import { Box, Chip, Divider, IconButton, Menu, MenuItem, Stack, Tooltip, Typography } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FolderIcon from '@mui/icons-material/Folder';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import VisibilityIcon from '@mui/icons-material/Visibility';
import RefreshIcon from '@mui/icons-material/Refresh';
import { call, getApi } from '../api';
import { useAppStore } from '../store/useAppStore';
import { rescan } from '../hooks/useScan';
import type { FolderNode } from '../../shared/types';

/**
 * 目录树（R03/R04/R05）：
 * - 仅渲染 totalCount>0 的节点（扫描阶段已过滤）
 * - hiddenSet 剪枝；「显示已隐藏」开关下以 👁 图标弱化展示隐藏节点
 * - 右键菜单：隐藏文件夹 / 取消隐藏 / 重新扫描
 */
export function FolderTree(): JSX.Element {
  const rootPath = useAppStore((s) => s.rootPath);
  const tree = useAppStore((s) => s.tree);
  const hiddenSet = useAppStore((s) => s.hiddenSet);
  const selectedDir = useAppStore((s) => s.selectedDir);
  const selectDir = useAppStore((s) => s.selectDir);
  const hideFolderLocal = useAppStore((s) => s.hideFolderLocal);
  const unhideFolderLocal = useAppStore((s) => s.unhideFolderLocal);
  const setSnackbar = useAppStore((s) => s.setSnackbar);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({ '': true });
  const [showHidden, setShowHidden] = useState(false);
  const [menu, setMenu] = useState<{ relPath: string; mouseX: number; mouseY: number } | null>(null);

  const rootName = rootPath
    ? rootPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || rootPath
    : '根目录';

  const toggleExpand = (relPath: string): void => {
    setExpanded((prev) => ({ ...prev, [relPath]: !prev[relPath] }));
  };

  const handleHide = async (relPath: string): Promise<void> => {
    try {
      await call(getApi().hideFolder(relPath));
      hideFolderLocal(relPath);
    } catch {
      setSnackbar('隐藏文件夹失败');
    }
  };

  const handleUnhide = async (relPath: string): Promise<void> => {
    try {
      await call(getApi().unhideFolder(relPath));
      unhideFolderLocal(relPath);
    } catch {
      setSnackbar('取消隐藏失败');
    }
  };

  const handleMenuAction = (action: 'hide' | 'unhide' | 'rescan'): void => {
    const target = menu;
    setMenu(null);
    if (!target) return;
    if (action === 'hide') void handleHide(target.relPath);
    else if (action === 'unhide') void handleUnhide(target.relPath);
    else void rescan();
  };

  return (
    <Box className="flex h-full flex-col">
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        className="shrink-0 border-b border-slate-100 px-3 py-2"
      >
        <Typography variant="subtitle2" color="text.secondary">
          目录
        </Typography>
        <Tooltip title={showHidden ? '隐藏已隐藏目录' : '显示已隐藏目录'}>
          <IconButton size="small" onClick={() => setShowHidden((v) => !v)}>
            {showHidden ? <VisibilityIcon fontSize="small" /> : <VisibilityOffIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      </Stack>

      <Box className="min-h-0 flex-1 overflow-auto py-1">
        {/* 根节点 */}
        <FolderRow
          name={rootName}
          relPath=""
          totalCount={tree.reduce((sum, n) => sum + n.totalCount, 0)}
          depth={0}
          expanded={expanded[''] ?? true}
          hasChildren={tree.length > 0}
          selected={selectedDir === ''}
          hidden={false}
          isRoot
          onToggle={() => toggleExpand('')}
          onSelect={() => selectDir('')}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ relPath: '', mouseX: e.clientX, mouseY: e.clientY });
          }}
        />
        {expanded[''] !== false &&
          tree.map((node) => (
            <TreeNode
              key={node.relPath}
              node={node}
              depth={1}
              hiddenByAncestor={false}
              expanded={expanded}
              showHidden={showHidden}
              hiddenSet={hiddenSet}
              selectedDir={selectedDir}
              onToggle={toggleExpand}
              onSelect={selectDir}
              onContextMenu={(relPath, e) => {
                e.preventDefault();
                setMenu({ relPath, mouseX: e.clientX, mouseY: e.clientY });
              }}
            />
          ))}
      </Box>

      <Menu
        open={menu !== null}
        onClose={() => setMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={menu ? { top: menu.mouseY, left: menu.mouseX } : undefined}
      >
        <MenuItem disabled={menu?.relPath === ''} onClick={() => handleMenuAction('hide')}>
          隐藏文件夹
        </MenuItem>
        <MenuItem
          disabled={menu === null || !hiddenSet.has(menu.relPath)}
          onClick={() => handleMenuAction('unhide')}
        >
          取消隐藏
        </MenuItem>
        <Divider />
        <MenuItem onClick={() => handleMenuAction('rescan')}>
          <RefreshIcon fontSize="small" sx={{ mr: 1 }} />
          重新扫描
        </MenuItem>
      </Menu>
    </Box>
  );
}

interface TreeNodeProps {
  node: FolderNode;
  depth: number;
  hiddenByAncestor: boolean;
  expanded: Record<string, boolean>;
  showHidden: boolean;
  hiddenSet: Set<string>;
  selectedDir: string | null;
  onToggle: (relPath: string) => void;
  onSelect: (relPath: string) => void;
  onContextMenu: (relPath: string, e: React.MouseEvent) => void;
}

function TreeNode(props: TreeNodeProps): JSX.Element | null {
  const { node, depth, hiddenByAncestor } = props;
  const isHidden = node.hidden || props.hiddenSet.has(node.relPath);

  // 剪枝：祖先隐藏 或 自身隐藏（且未开启显示隐藏）
  if (hiddenByAncestor || (isHidden && !props.showHidden)) return null;

  const isExpanded = props.expanded[node.relPath] === true;
  const visibleChildren = node.children.filter((c) => !props.hiddenSet.has(c.relPath));
  const hasChildren = visibleChildren.length > 0;

  return (
    <>
      <FolderRow
        name={node.name}
        relPath={node.relPath}
        totalCount={node.totalCount}
        depth={depth}
        expanded={isExpanded}
        hasChildren={hasChildren}
        selected={props.selectedDir === node.relPath}
        hidden={isHidden}
        isRoot={false}
        onToggle={() => props.onToggle(node.relPath)}
        onSelect={() => props.onSelect(node.relPath)}
        onContextMenu={(e) => props.onContextMenu(node.relPath, e)}
      />
      {isExpanded &&
        visibleChildren.map((child) => (
          <TreeNode
            key={child.relPath}
            {...props}
            node={child}
            depth={depth + 1}
            hiddenByAncestor={false}
          />
        ))}
    </>
  );
}

interface FolderRowProps {
  name: string;
  relPath: string;
  totalCount: number;
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
  selected: boolean;
  hidden: boolean;
  isRoot: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

function FolderRow({
  name,
  totalCount,
  depth,
  expanded,
  hasChildren,
  selected,
  hidden,
  onToggle,
  onSelect,
  onContextMenu
}: FolderRowProps): JSX.Element {
  return (
    <Box
      className="group flex cursor-pointer items-center gap-1 rounded-md py-1 pr-2"
      style={{ paddingLeft: 8 + depth * 16 }}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      sx={
        selected
          ? { bgcolor: 'primary.light', color: 'primary.contrastText' }
          : {
              '&:hover': { bgcolor: 'action.hover' },
              ...(hidden ? { opacity: 0.55 } : {})
            }
      }
    >
      {hasChildren ? (
        <IconButton size="small" className="p-0.5" onClick={(e) => { e.stopPropagation(); onToggle(); }}>
          {expanded ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
        </IconButton>
      ) : (
        <Box className="w-6 shrink-0" />
      )}
      {hidden ? (
        <VisibilityOffIcon fontSize="small" className="shrink-0" />
      ) : (
        <FolderIcon fontSize="small" className="shrink-0" />
      )}
      <Typography noWrap variant="body2" className="min-w-0 flex-1">
        {name}
      </Typography>
      <Chip
        size="small"
        label={totalCount}
        variant="outlined"
        sx={{ height: 18, fontSize: 11, '& .MuiChip-label': { px: 0.6 } }}
      />
    </Box>
  );
}
