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
  Typography
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import { useAppStore } from '../store/useAppStore';

/**
 * 标签筛选条（R08）：两行布局。
 * - 第一行：已选标签 chips + 高级筛选（全量标签 Menu）+ AND/OR 切换 + 清除。
 * - 第二行：热门标签（tagCounts 降序前 20），点击即加入/移出筛选。
 * 默认 AND（更精确），UI 提供切换开关（Q4）。
 */
export function TagFilterBar(): JSX.Element {
  const tagFilter = useAppStore((s) => s.tagFilter);
  const tagCounts = useAppStore((s) => s.tagCounts);
  const toggleFilterTag = useAppStore((s) => s.toggleFilterTag);
  const setFilterMode = useAppStore((s) => s.setFilterMode);
  const clearFilter = useAppStore((s) => s.clearFilter);

  const [anchor, setAnchor] = useState<null | HTMLElement>(null);

  const allTags = useMemo(
    () =>
      [...tagCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
        .slice(0, 200),
    [tagCounts]
  );

  // 热门标签：按计数降序取前 20（allTags 已按计数排序）
  const hotTags = useMemo(() => allTags.slice(0, 20), [allTags]);

  return (
    <Paper className="shrink-0 rounded-none border-b border-slate-200 px-3 py-2">
      <Stack spacing={1} className="min-w-0">
        {/* 第一行：筛选主操作区 */}
        <Stack direction="row" alignItems="center" spacing={1} className="min-w-0">
          <FilterAltIcon fontSize="small" sx={{ color: 'text.secondary', flexShrink: 0 }} />
          <Typography variant="body2" color="text.secondary" className="shrink-0">
            标签筛选
          </Typography>

          {tagFilter.tags.length === 0 ? (
            <Typography variant="body2" color="text.disabled" className="min-w-0 flex-1 truncate">
              未筛选（浏览图片后自动加载标签）
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

          <Button
            size="small"
            startIcon={<AddIcon />}
            className="shrink-0"
            onClick={(e) => setAnchor(e.currentTarget)}
          >
            高级筛选
          </Button>

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
              AND
            </ToggleButton>
            <ToggleButton value="OR" sx={{ px: 1.5, py: 0.25 }}>
              OR
            </ToggleButton>
          </ToggleButtonGroup>

          {tagFilter.tags.length > 0 && (
            <Button size="small" color="inherit" className="shrink-0" onClick={clearFilter}>
              清除
            </Button>
          )}
        </Stack>

        {/* 第二行：热门标签快捷筛选 */}
        <Stack direction="row" alignItems="center" spacing={0.5} className="min-w-0 flex-wrap">
          <Typography variant="body2" color="text.secondary" className="shrink-0">
            热门标签
          </Typography>
          {hotTags.length === 0 ? (
            <Typography variant="body2" color="text.disabled">
              浏览图片后自动加载标签
            </Typography>
          ) : (
            hotTags.map(([tag]) => {
              const selected = tagFilter.tags.includes(tag);
              return (
                <Chip
                  key={tag}
                  label={tag}
                  size="small"
                  variant={selected ? 'filled' : 'outlined'}
                  color={selected ? 'primary' : 'default'}
                  onClick={() => toggleFilterTag(tag)}
                />
              );
            })
          )}
        </Stack>
      </Stack>

      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        PaperProps={{ sx: { maxHeight: 360, width: 240 } }}
      >
        {allTags.length === 0 && <MenuItem disabled>暂无标签数据</MenuItem>}
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
