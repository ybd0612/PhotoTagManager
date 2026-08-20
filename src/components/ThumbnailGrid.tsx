import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { Box, Button, Card, Chip, Menu, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { FixedSizeGrid } from 'react-window';
import { rootKey, useAppStore } from '../store/useAppStore';
import { useThumbnails } from '../hooks/useThumbnails';
import { call, getApi, toFileUrl } from '../api';
import { collectDirAndDescendants } from '../utils/folders';
import type { ImageFile } from '../../shared/types';

/**
 * 缩略图网格（R09）：react-window 虚拟滚动，只渲染可视区；D4 性能策略④。
 * 支持 Ctrl/⌘ 多选、点击预览；标签角标右下角展示。
 */

const COL_WIDTH = 168;
const ROW_HEIGHT = 148;
const GAP = 12;

const PLACEHOLDER = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="140"><rect width="100%" height="100%" fill="#f1f5f9"/><text x="50%" y="50%" fill="#cbd5e1" font-size="13" text-anchor="middle" dominant-baseline="middle">加载中…</text></svg>`
)}`;

/** 多标签筛选：AND（默认，更精确）/ OR */
function applyTagFilter(
  images: ImageFile[],
  tags: string[],
  mode: 'AND' | 'OR',
  tagCache: Map<string, string[]>
): ImageFile[] {
  if (tags.length === 0) return images;
  return images.filter((image) => {
    const imageTags = tagCache.get(image.absPath) ?? image.tags ?? [];
    if (mode === 'AND') return tags.every((t) => imageTags.includes(t));
    return tags.some((t) => imageTags.includes(t));
  });
}

interface GridRange {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

export function ThumbnailGrid(): JSX.Element {
  const selectedRootId = useAppStore((s) => s.selectedRootId);
  const scannedRoots = useAppStore((s) => s.scannedRoots);
  const selectedDir = useAppStore((s) => s.selectedDir);
  const tree = useAppStore((s) => s.tree);
  const imagesByDir = useAppStore((s) => s.imagesByDir);
  const tagFilter = useAppStore((s) => s.tagFilter);
  const tagCache = useAppStore((s) => s.tagCache);
  const selectedImages = useAppStore((s) => s.selectedImages);
  const toggleSelectImage = useAppStore((s) => s.toggleSelectImage);
  const setPreview = useAppStore((s) => s.setPreview);

  // 递归汇总：选中目录 + 全部后代目录的图片（选根目录 = 全盘图片），按当前根分桶
  const images = useMemo(() => {
    if (selectedRootId === null || selectedDir === null) return [];
    const dirs = collectDirAndDescendants(tree, selectedDir);
    const list: ImageFile[] = [];
    for (const d of dirs) {
      const arr = imagesByDir.get(rootKey(selectedRootId, d));
      if (arr) list.push(...arr);
    }
    return list.sort((a, b) => a.relPath.localeCompare(b.relPath, 'zh-Hans-CN'));
  }, [selectedRootId, selectedDir, tree, imagesByDir]);
  const rootScanned = selectedRootId !== null && scannedRoots.has(selectedRootId);
  const filtered = useMemo(
    () => applyTagFilter(images, tagFilter.tags, tagFilter.mode, tagCache),
    [images, tagFilter.tags, tagFilter.mode, tagCache]
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [range, setRange] = useState<GridRange | null>(null);
  const [contextMenu, setContextMenu] = useState<{ mouseX: number; mouseY: number; image: ImageFile } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      setSize({ width: rect.width, height: rect.height });
    });
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // 列数按固定最小列宽计算；列宽自适应填满容器，避免右侧留白
  const cols = Math.max(1, Math.floor((size.width + GAP) / (COL_WIDTH + GAP)));
  const colWidth = Math.max(COL_WIDTH, Math.floor((size.width - (cols - 1) * GAP) / cols));
  const rowCount = Math.ceil(filtered.length / cols);

  // 可视区 absPath（仅请求视口内缩略图/标签）
  const visibleAbsPaths = useMemo(() => {
    if (!range || cols === 0) {
      return filtered.slice(0, 60).map((img) => img.absPath);
    }
    const start = range.r0 * cols + range.c0;
    const end = range.r1 * cols + range.c1 + 1;
    return filtered.slice(Math.max(0, start), Math.min(filtered.length, end)).map((img) => img.absPath);
  }, [range, filtered, cols]);

  const thumbnailVersions = useMemo(
    () => new Map(filtered.map((image) => [image.absPath, `${image.mtimeMs}:${image.size}`])),
    [filtered]
  );
  const { thumbnails } = useThumbnails(visibleAbsPaths, thumbnailVersions);

  const handleCellClick = (image: ImageFile, index: number, ctrl: boolean): void => {
    if (ctrl) {
      // Ctrl/⌘ + 单击：显式多选切换
      toggleSelectImage(image.id);
      return;
    }
    // 普通单击：仅打开预览，不改变选中状态（多选需 Ctrl/⌘，避免误选）
    setPreview(image, filtered);
  };

  const openContextMenu = (image: ImageFile, mouseX: number, mouseY: number): void => {
    setContextMenu({ mouseX, mouseY, image });
  };

  const handleContextMenu = (event: MouseEvent, image: ImageFile): void => {
    event.preventDefault();
    openContextMenu(image, event.clientX, event.clientY);
  };

  const handleRevealInExplorer = async (): Promise<void> => {
    const image = contextMenu?.image;
    setContextMenu(null);
    if (!image) return;
    try {
      await call(getApi().revealFileInExplorer(image.absPath));
    } catch (error) {
      useAppStore.getState().setSnackbar(`在资源管理器中打开失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  if (size.width <= 0) {
    return <div ref={containerRef} className="h-full w-full" />;
  }

  if (filtered.length === 0) {
    return (
      <div ref={containerRef} className="flex h-full w-full items-center justify-center">
        <Stack alignItems="center" spacing={1}>
          <Typography variant="body2" color="text.secondary">
            {!rootScanned
              ? '该根目录尚未扫描完成，图片会自动出现…'
              : images.length === 0
                ? '该目录暂无图片'
                : '没有符合当前标签筛选的图片'}
          </Typography>
        </Stack>
      </div>
    );
  }

  const Cell = ({ columnIndex, rowIndex, style }: { columnIndex: number; rowIndex: number; style: CSSProperties }): JSX.Element | null => {
    const index = rowIndex * cols + columnIndex;
    const image = filtered[index];
    if (!image) return null;
    const thumb = thumbnails.get(image.absPath);
    const directPreview = image.ext === '.gif' || image.ext === '.webp';
    const tags = tagCache.get(image.absPath) ?? image.tags ?? [];
    const selected = selectedImages.has(image.id);

    return (
      <div style={{ ...style, padding: GAP / 2 }}>
        <Card
          className="relative h-full w-full cursor-pointer overflow-hidden transition-shadow hover:shadow-md"
          role="button"
          tabIndex={0}
          aria-label={`打开图片预览：${image.name}`}
          onClick={(e) => handleCellClick(image, index, e.ctrlKey || e.metaKey)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleCellClick(image, index, false);
            } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
              e.preventDefault();
              const rect = e.currentTarget.getBoundingClientRect();
              openContextMenu(image, rect.left + rect.width / 2, rect.top + rect.height / 2);
            }
          }}
          onContextMenu={(e) => handleContextMenu(e, image)}
          sx={selected ? { outline: '2px solid', outlineColor: 'primary.main' } : { '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' } }}
        >
          <img
            src={directPreview ? toFileUrl(image.absPath) : (thumb?.dataUrl ?? PLACEHOLDER)}
            alt={image.name}
            loading="lazy"
            className="h-full w-full object-cover"
            draggable={false}
          />
          {/* 选中标记 */}
          {selected && (
            <CheckCircleIcon
              sx={{
                position: 'absolute',
                top: 6,
                right: 6,
                fontSize: 22,
                color: 'primary.main',
                bgcolor: 'background.paper',
                borderRadius: '50%'
              }}
            />
          )}
          {/* 标签角标（最多 3 个） */}
          {tags.length > 0 && (
            <Box
              className="absolute bottom-1 left-1 right-1 flex flex-wrap justify-end gap-0.5"
              sx={{ pointerEvents: 'none' }}
            >
              {tags.slice(0, 3).map((tag) => (
                <Chip
                  key={tag}
                  label={tag}
                  size="small"
                  sx={{ height: 16, fontSize: 10, bgcolor: 'rgba(15,23,42,0.72)', color: 'white' }}
                />
              ))}
            </Box>
          )}
        </Card>
      </div>
    );
  };

  return (
    <div className="flex h-full w-full flex-col">
      {/* 多选操作条：批量添加标签 / 清除选择 */}
      {selectedImages.size > 0 && <BatchTagBar selectedIds={selectedImages} />}
      <div ref={containerRef} className="min-h-0 flex-1">
        <FixedSizeGrid
          columnCount={cols}
          columnWidth={colWidth}
          height={size.height}
          rowCount={rowCount}
          rowHeight={ROW_HEIGHT}
          width={size.width}
          overscanRowCount={2}
          onItemsRendered={({ visibleRowStartIndex, visibleRowStopIndex, visibleColumnStartIndex, visibleColumnStopIndex }) => {
            setRange({
              r0: visibleRowStartIndex,
              r1: visibleRowStopIndex,
              c0: visibleColumnStartIndex,
              c1: visibleColumnStopIndex
            });
          }}
        >
          {Cell}
        </FixedSizeGrid>
      </div>
      <Menu
        open={contextMenu !== null}
        onClose={() => setContextMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={contextMenu ? { top: contextMenu.mouseY, left: contextMenu.mouseX } : undefined}
      >
        <MenuItem autoFocus onClick={() => void handleRevealInExplorer()}>在资源管理器中打开</MenuItem>
      </Menu>
    </div>
  );
}

interface BatchTagBarProps {
  selectedIds: Set<string>;
}

/** 多选后的批量操作条：统一为选中图片添加标签 / 清除选择 */
function BatchTagBar({ selectedIds }: BatchTagBarProps): JSX.Element {
  const imagesByDir = useAppStore((s) => s.imagesByDir);
  const setSnackbar = useAppStore((s) => s.setSnackbar);
  const clearSelection = useAppStore((s) => s.clearSelection);
  const setTagsForImages = useAppStore((s) => s.setTagsForImages);
  const [tag, setTag] = useState('');

  // 选中图片的 absPath（跨所有根，selectedIds 全局唯一）
  const absPaths = useMemo(() => {
    const out: string[] = [];
    for (const arr of imagesByDir.values()) {
      for (const img of arr) {
        if (selectedIds.has(img.id)) out.push(img.absPath);
      }
    }
    return out;
  }, [selectedIds, imagesByDir]);

  const handleAdd = async (): Promise<void> => {
    const t = tag.trim();
    if (!t || absPaths.length === 0) return;
    try {
      const res = await call(
        getApi().writeBatchTags(absPaths.map((absPath) => ({ absPath, add: [t] })))
      );
      // 批量写后重读标签，保证 tagCache/tagCounts 与 XMP 一致
      const results = await call(getApi().readBulkTags(absPaths));
      setTagsForImages(results);
      setSnackbar(
        `已为 ${res.okCount} 张图片添加标签「${t}」${res.failCount > 0 ? `，${res.failCount} 张失败` : ''}`
      );
      clearSelection();
      setTag('');
    } catch (error) {
      setSnackbar(`批量添加标签失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <Paper className="flex shrink-0 items-center gap-2 rounded-none border-b border-slate-200 px-3 py-1.5">
      <Typography variant="body2" color="text.secondary" className="shrink-0">
        已选 {selectedIds.size} 张
      </Typography>
      <TextField
        size="small"
        placeholder="输入标签，回车批量添加"
        value={tag}
        onChange={(e) => setTag(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void handleAdd();
        }}
        sx={{ width: 240 }}
      />
      <Button
        size="small"
        variant="contained"
        disabled={!tag.trim() || absPaths.length === 0}
        onClick={() => void handleAdd()}
      >
        批量添加标签
      </Button>
      <Button size="small" color="inherit" onClick={clearSelection}>
        清除选择
      </Button>
    </Paper>
  );
}
