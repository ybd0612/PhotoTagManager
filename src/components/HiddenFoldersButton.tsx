import { useMemo, useState } from 'react';
import { Chip, Divider, IconButton, ListItemText, Menu, MenuItem, Tooltip } from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import { call, getApi } from '../api';
import { useAppStore } from '../store/useAppStore';

/**
 * 隐藏集管理入口：一个图标进、一个菜单出（在树里显示的开关 + 逐项恢复）。
 *
 * 从 FolderTree 的头部行搬到顶栏，是因为左栏可以整条收起（Ctrl+B）——入口留在树里
 * 就会跟着消失，收起状态下再也管不了隐藏目录。放顶栏后展开/收起两种状态都够得着。
 */
export function HiddenFoldersButton(): JSX.Element {
  const roots = useAppStore((s) => s.roots);
  const hiddenSet = useAppStore((s) => s.hiddenSet);
  const showHidden = useAppStore((s) => s.showHidden);
  const toggleShowHidden = useAppStore((s) => s.toggleShowHidden);
  const unhideFolderLocal = useAppStore((s) => s.unhideFolderLocal);
  const setSnackbar = useAppStore((s) => s.setSnackbar);
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);

  /** 跨根的隐藏目录清单，标签带根别名前缀免得分不清属于哪个根 */
  const hiddenEntries = useMemo(() => {
    const rootById = new Map(roots.map((root) => [root.id, root]));
    return [...hiddenSet]
      .map((key) => {
        const splitAt = key.indexOf('\u0000');
        const rootId = key.slice(0, splitAt);
        const relPath = key.slice(splitAt + 1);
        return { rootId, relPath, label: `${rootById.get(rootId)?.alias ?? rootId} / ${relPath}` };
      })
      .filter((entry) => entry.relPath !== '')
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'));
  }, [hiddenSet, roots]);

  const handleUnhide = async (rootId: string, relPath: string): Promise<void> => {
    try {
      await call(getApi().unhideFolder(rootId, relPath));
      unhideFolderLocal(rootId, relPath);
    } catch {
      setSnackbar('取消隐藏失败');
    }
  };

  return (
    <>
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
          onClick={(e) => setAnchor(e.currentTarget)}
        >
          {showHidden ? <VisibilityIcon fontSize="small" /> : <VisibilityOffIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        PaperProps={{ sx: { maxHeight: 360, width: 300 } }}
      >
        <MenuItem onClick={toggleShowHidden}>
          <ListItemText primary="在树中显示已隐藏目录" />
          {showHidden && <CheckIcon fontSize="small" />}
        </MenuItem>
        <Divider />
        {hiddenEntries.length === 0 && <MenuItem disabled>暂无已隐藏目录</MenuItem>}
        {hiddenEntries.map((entry) => (
          <MenuItem
            key={entry.label}
            onClick={() => {
              setAnchor(null);
              void handleUnhide(entry.rootId, entry.relPath);
            }}
          >
            <ListItemText primary={entry.label} />
            <Chip size="small" label="恢复" color="primary" />
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
