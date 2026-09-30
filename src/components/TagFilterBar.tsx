import { useMemo, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  IconButton,
  InputAdornment,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import SearchIcon from '@mui/icons-material/Search';
import { rootKey, useAppStore } from '../store/useAppStore';
import { collectDirAndDescendants } from '../utils/folders';
import { TAGS_PENDING } from '../utils/strings';
import type { SortKey, ThumbSize } from '../../shared/types';

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
  const nameQuery = useAppStore((s) => s.nameQuery);
  const setNameQuery = useAppStore((s) => s.setNameQuery);
  const sortKey = useAppStore((s) => s.sortKey);
  const sortDir = useAppStore((s) => s.sortDir);
  const setSort = useAppStore((s) => s.setSort);
  const thumbSize = useAppStore((s) => s.thumbSize);
  const setThumbSize = useAppStore((s) => s.setThumbSize);

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
    <Paper
      className="shrink-0 rounded-none bg-chrome px-3 py-2"
      sx={{ bgcolor: 'var(--ptm-chrome-bg)' }}
    >
      {/* 找图工具行：搜索 + 排序 + 标签筛选 + 缩略图档位（三档偏好持久化到 settings.json）。
          标签筛选原本独占一行，右侧大片留白；并进这一行后靠右的缩略图仍钉在行尾。
          整行 flex-wrap：窗口窄（左栏展开时约 1000px）或选中标签多，会自动折回两行。 */}
      <Stack direction="row" alignItems="center" spacing={1} className="flex-wrap">
        <TextField
          size="small"
          value={nameQuery}
          onChange={(e) => setNameQuery(e.target.value)}
          placeholder="搜索文件名"
          aria-label="搜索文件名"
          sx={{
            width: 220,
            // placeholder 小一号到 12px，与同行「排序」「缩略图」组标签同量级；
            // 浅灰由 MUI 自己的 currentColor + opacity .42 负责，这里不覆盖
            '& .MuiInputBase-input': { fontSize: 13, py: 0.75, '&::placeholder': { fontSize: 12 } }
          }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon sx={{ fontSize: 16 }} />
              </InputAdornment>
            ),
            endAdornment: nameQuery ? (
              <InputAdornment position="end">
                <IconButton size="small" aria-label="清空搜索" onClick={() => setNameQuery('')}>
                  <CloseIcon fontSize="small" />
                </IconButton>
              </InputAdornment>
            ) : null
          }}
        />
        <Stack direction="row" alignItems="center" spacing={0.75} className="shrink-0" sx={{ flexWrap: 'nowrap' }}>
          <Typography variant="caption" color="text.secondary" className="shrink-0">
            排序
          </Typography>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={sortKey}
            onChange={(_e, value: SortKey | null) => value && setSort(value)}
          >
            <ToggleButton value="name" sx={{ px: 1.25, py: 0.25 }}>名称</ToggleButton>
            <ToggleButton value="time" sx={{ px: 1.25, py: 0.25 }}>时间</ToggleButton>
            <ToggleButton value="size" sx={{ px: 1.25, py: 0.25 }}>大小</ToggleButton>
          </ToggleButtonGroup>
          <Tooltip title={sortDir === 'asc' ? '当前升序，点击改降序' : '当前降序，点击改升序'}>
            <Button
              size="small"
              color="inherit"
              aria-label="切换排序方向"
              onClick={() => setSort(sortKey)}
              sx={{ minWidth: 0, px: 1 }}
            >
              {sortDir === 'asc' ? '↑' : '↓'}
            </Button>
          </Tooltip>
        </Stack>

        {/* 标签筛选成组：图标 + 已选标签（或"未选择标签"）+ 同时/任一 + 清除 */}
        <Stack direction="row" spacing={0.75} alignItems="center" className="min-w-0 flex-wrap">
          <FilterAltIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
          <Typography variant="caption" color="text.secondary" className="shrink-0">
            标签筛选
          </Typography>
          {tagFilter.tags.length === 0 ? (
            <Typography variant="caption" color="text.disabled" className="shrink-0">
              未选择标签
            </Typography>
          ) : (
            tagFilter.tags.map((tag) => (
              <Chip
                key={tag}
                label={tag}
                size="small"
                color="primary"
                variant="filled"
                onDelete={() => toggleFilterTag(tag)}
              />
            ))
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

        <Box sx={{ flex: 1 }} />
        <Stack direction="row" alignItems="center" spacing={0.75} className="shrink-0" sx={{ flexWrap: 'nowrap' }}>
          <Typography variant="caption" color="text.secondary" className="shrink-0">
            缩略图
          </Typography>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={thumbSize}
            onChange={(_e, value: ThumbSize | null) => value && setThumbSize(value)}
          >
            <ToggleButton value="small" sx={{ px: 1.25, py: 0.25 }}>小</ToggleButton>
            <ToggleButton value="medium" sx={{ px: 1.25, py: 0.25 }}>中</ToggleButton>
            <ToggleButton value="large" sx={{ px: 1.25, py: 0.25 }}>大</ToggleButton>
          </ToggleButtonGroup>
        </Stack>
      </Stack>

      {/* 热门标签（当前上下文范围）+ 更多（全量标签列表） */}
      <Stack direction="row" alignItems="center" spacing={0.5} className="mt-1.5 flex-wrap">
        <Typography variant="caption" color="text.secondary" className="shrink-0">
          常用标签
        </Typography>
        {!hasContext || hotTags.length === 0 ? (
          <Typography variant="caption" color="text.disabled">
            {TAGS_PENDING}
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
        {allTags.length === 0 && <MenuItem disabled>{TAGS_PENDING}</MenuItem>}
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
