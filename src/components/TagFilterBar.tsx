import { useMemo, useState } from 'react';
import {
  Button,
  Chip,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography
} from '@mui/material';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import { rootKey, useAppStore } from '../store/useAppStore';
import { collectDirAndDescendants } from '../utils/folders';

/**
 * 标签筛选条（R08，多根/目录上下文）：两行布局。
 * - 第一行：已选标签 chips + AND/OR 切换 + 清除 +「高级筛选」（全量标签 Menu）。
 * - 第二行：热门标签（当前选中根+目录递归范围内的标签计数 top20，点击即筛选）。
 * 热门标签与高级筛选均基于**当前上下文**（选中目录递归子树），避免出现当前目录没有的标签。
 */
export function TagFilterBar(): JSX.Element {
  const selectedRootId = useAppStore((s) => s.selectedRootId);
  const selectedDir = useAppStore((s) => s.selectedDir);
  const tree = useAppStore((s) => s.tree);
  const imagesByDir = useAppStore((s) => s.imagesByDir);
  const tagCache = useAppStore((s) => s.tagCache);
  const tagFilter = useAppStore((s) => s.tagFilter);
  const toggleFilterTag = useAppStore((s) => s.toggleFilterTag);
  const setFilterMode = useAppStore((s) => s.setFilterMode);
  const clearFilter = useAppStore((s) => s.clearFilter);

  const [anchor, setAnchor] = useState<null | HTMLElement>(null);

  /** 当前上下文（选中根 + 选中目录递归子树）内图片的标签计数 */
  const contextTagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (selectedRootId === null || selectedDir === null) return counts;
    const dirs = collectDirAndDescendants(tree, selectedDir);
    for (const d of dirs) {
      const imgs = imagesByDir.get(rootKey(selectedRootId, d));
      if (!imgs) continue;
      for (const img of imgs) {
        const tags = tagCache.get(img.absPath) ?? img.tags ?? [];
        for (const t of tags) {
          counts.set(t, (counts.get(t) ?? 0) + 1);
        }
      }
    }
    return counts;
  }, [selectedRootId, selectedDir, tree, imagesByDir, tagCache]);

  const hotTags = useMemo(
    () =>
      [...contextTagCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
        .slice(0, 20),
    [contextTagCounts]
  );

  const allTags = useMemo(
    () =>
      [...contextTagCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
        .slice(0, 200),
    [contextTagCounts]
  );

  const hasContext = selectedRootId !== null && selectedDir !== null;

  return (
    <Paper className="shrink-0 rounded-none border-b border-slate-200 px-3 py-2">
      {/* 第一行：已选筛选 + 模式 + 高级筛选 */}
      <Stack direction="row" alignItems="center" spacing={1} className="flex-wrap">
        <FilterAltIcon fontSize="small" sx={{ color: 'text.secondary' }} />
        <Typography variant="body2" color="text.secondary" className="shrink-0">
          标签筛选
        </Typography>

        {tagFilter.tags.length === 0 ? (
          <Typography variant="body2" color="text.disabled" className="shrink-0">
            未选择标签（标签会在读取图片后显示）
          </Typography>
        ) : (
          <Stack direction="row" spacing={0.5} className="min-w-0 flex-1 flex-wrap items-center">
            {tagFilter.tags.map((tag) => (
              <Chip
                key={tag}
                label={tag}
                size="small"
                color="primary"
                variant="filled"
                onDelete={() => toggleFilterTag(tag)}
              />
            ))}
          </Stack>
        )}

        <ToggleButtonGroup
          exclusive
          size="small"
          value={tagFilter.mode}
          onChange={(_e, value: 'AND' | 'OR' | null) => {
            if (value) setFilterMode(value);
          }}
          className="shrink-0"
        >
          <ToggleButton value="AND" sx={{ px: 1.5, py: 0.25 }}>
            同时包含
          </ToggleButton>
          <ToggleButton value="OR" sx={{ px: 1.5, py: 0.25 }}>
            任一包含
          </ToggleButton>
        </ToggleButtonGroup>

        {tagFilter.tags.length > 0 && (
          <Button size="small" color="inherit" className="shrink-0" onClick={clearFilter}>
            清除
          </Button>
        )}
      </Stack>

      {/* 第二行：热门标签（当前上下文范围）+ 更多（全量标签列表） */}
      <Stack direction="row" alignItems="center" spacing={0.5} className="mt-1.5 flex-wrap">
        <Typography variant="caption" color="text.secondary" className="shrink-0">
          常用标签
        </Typography>
        {!hasContext || hotTags.length === 0 ? (
          <Typography variant="caption" color="text.disabled">
            当前目录暂无标签（浏览图片后自动汇总）
          </Typography>
        ) : (
          hotTags.map(([tag, count]) => {
            const selected = tagFilter.tags.includes(tag);
            return (
              <Tooltip key={tag} title={`${count} 张图片`}>
                <Chip
                  label={`${tag}（${count}）`}
                  size="small"
                  variant={selected ? 'filled' : 'outlined'}
                  color={selected ? 'primary' : 'default'}
                  onClick={() => toggleFilterTag(tag)}
                  sx={{ cursor: 'pointer' }}
                />
              </Tooltip>
            );
          })
        )}
        {/* 标签数量超过热门上限时提供全量列表入口 */}
        {hasContext && hotTags.length > 0 && allTags.length > hotTags.length && (
          <Button
            size="small"
            color="inherit"
            startIcon={<MoreHorizIcon />}
            className="shrink-0"
            onClick={(e) => setAnchor(e.currentTarget)}
          >
            更多标签…
          </Button>
        )}
      </Stack>

      {/* 高级筛选：当前上下文全量标签 */}
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        PaperProps={{ sx: { maxHeight: 360, width: 240 } }}
      >
        {allTags.length === 0 && <MenuItem disabled>当前目录暂无标签数据</MenuItem>}
        {allTags.map(([tag, count]) => {
          const selected = tagFilter.tags.includes(tag);
          return (
            <MenuItem
              key={tag}
              selected={selected}
              onClick={() => {
                toggleFilterTag(tag);
              }}
            >
              <ListItemText primary={tag} secondary={`${count} 张`} />
              {selected && <Chip size="small" label="已选" color="primary" />}
            </MenuItem>
          );
        })}
      </Menu>
    </Paper>
  );
}
