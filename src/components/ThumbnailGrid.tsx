import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Box, Card, Chip, Stack, Typography } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { FixedSizeGrid } from 'react-window';
import { useAppStore } from '../store/useAppStore';
import { useThumbnails } from '../hooks/useThumbnails';
import { toFileUrl } from '../api';
import type { FolderNode, ImageFile } from '../../shared/types';

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

/**
 * 收集目录及其全部后代目录的 relPath（含自身；'' 额外包含根目录直接图片）。
 * 用于递归汇总视图：选中根目录显示全盘图片，选中子目录显示该目录及子树图片。
 */
function collectDirAndDescendants(tree: FolderNode[], dir: string): string[] {
  const out: string[] = [];
  const walk = (nodes: FolderNode[]): void => {
    for (const n of nodes) {
      out.push(n.relPath);
      if (n.children.length > 0) walk(n.children);
    }
  };
  if (dir === '') {
    out.push('');
    walk(tree);
    return out;
  }
  const find = (nodes: FolderNode[]): boolean => {
    for (const n of nodes) {
      if (n.relPath === dir) {
        out.push(n.relPath);
        walk(n.children);
        return true;
      }
      if (find(n.children)) return true;
    }
    return false;
  };
  find(tree);
  return out;
}

interface GridRange {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

export function ThumbnailGrid(): JSX.Element {
  const selectedDir = useAppStore((s) => s.selectedDir);
  const tree = useAppStore((s) => s.tree);
  const imagesByDir = useAppStore((s) => s.imagesByDir);
  const tagFilter = useAppStore((s) => s.tagFilter);
  const tagCache = useAppStore((s) => s.tagCache);
  const selectedImages = useAppStore((s) => s.selectedImages);
  const toggleSelectImage = useAppStore((s) => s.toggleSelectImage);
  const setPreview = useAppStore((s) => s.setPreview);

  // 递归汇总：选中目录 + 全部后代目录的图片（选根目录 = 全盘图片）
  const images = useMemo(() => {
    if (selectedDir === null) return [];
    const dirs = collectDirAndDescendants(tree, selectedDir);
    const list: ImageFile[] = [];
    for (const d of dirs) {
      const arr = imagesByDir.get(d);
      if (arr) list.push(...arr);
    }
    return list.sort((a, b) => a.relPath.localeCompare(b.relPath, 'zh-Hans-CN'));
  }, [selectedDir, tree, imagesByDir]);
  const filtered = useMemo(
    () => applyTagFilter(images, tagFilter.tags, tagFilter.mode, tagCache),
    [images, tagFilter.tags, tagFilter.mode, tagCache]
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [range, setRange] = useState<GridRange | null>(null);

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

  const cols = Math.max(1, Math.floor((size.width + GAP) / (COL_WIDTH + GAP)));
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

  const { thumbnails } = useThumbnails(visibleAbsPaths);

  const handleCellClick = (image: ImageFile, index: number, ctrl: boolean): void => {
    if (ctrl) {
      toggleSelectImage(image.id);
      return;
    }
    toggleSelectImage(image.id);
    setPreview(image, filtered);
  };

  if (size.width <= 0) {
    return <div ref={containerRef} className="h-full w-full" />;
  }

  if (filtered.length === 0) {
    return (
      <div ref={containerRef} className="flex h-full w-full items-center justify-center">
        <Stack alignItems="center" spacing={1}>
          <Typography variant="body2" color="text.secondary">
            {images.length === 0 ? '该目录暂无图片' : '没有符合当前标签筛选的图片'}
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
          onClick={(e) => handleCellClick(image, index, e.ctrlKey || e.metaKey)}
          sx={selected ? { outline: '2px solid', outlineColor: 'primary.main' } : {}}
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
    <div ref={containerRef} className="h-full w-full">
      <FixedSizeGrid
        columnCount={cols}
        columnWidth={COL_WIDTH}
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
  );
}
