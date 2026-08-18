import { useEffect, useRef, useState } from 'react';
import {
  Box,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import AddIcon from '@mui/icons-material/Add';
import { call, formatBytes, getApi, toFileUrl } from '../api';
import { useAppStore } from '../store/useAppStore';
import type { ImageInfo } from '../../shared/types';

/**
 * 全屏预览覆盖层（R10）：大图 + ←/→ 翻页 + Esc 关闭 + 标签编辑（R07）+ 图片信息（P1）。
 */
export function PreviewOverlay(): JSX.Element | null {
  const preview = useAppStore((s) => s.preview);
  const tagCache = useAppStore((s) => s.tagCache);
  const closePreview = useAppStore((s) => s.closePreview);
  const previewStep = useAppStore((s) => s.previewStep);
  const setTagsForPath = useAppStore((s) => s.setTagsForPath);
  const setSnackbar = useAppStore((s) => s.setSnackbar);

  const [info, setInfo] = useState<ImageInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [newTag, setNewTag] = useState('');
  // 长图查看：缩放（0.5~5，光标为中心）+ 拖动平移；ref 镜像避免闭包
  const [zoom, setZoomState] = useState(1);
  const [offset, setOffsetState] = useState({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const offsetRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);
  const imgBoxRef = useRef<HTMLDivElement>(null);

  const setZoom = (z: number): void => {
    zoomRef.current = z;
    setZoomState(z);
  };
  const setOffset = (o: { x: number; y: number }): void => {
    offsetRef.current = o;
    setOffsetState(o);
  };
  const resetView = (): void => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  };

  const absPath = preview?.image.absPath ?? null;

  // 打开时加载图片信息
  useEffect(() => {
    if (!absPath) return;
    let cancelled = false;
    setInfo(null);
    setInfoLoading(true);
    void call(getApi().getImageInfo(absPath))
      .then((result) => {
        if (!cancelled) setInfo(result);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setInfoLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [absPath]);

  // 切换图片时重置缩放/平移
  useEffect(() => {
    resetView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [absPath]);

  // 滚轮缩放（光标为中心）；原生监听以允许 preventDefault（React wheel 是 passive）
  useEffect(() => {
    const el = imgBoxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const prev = zoomRef.current;
      const next = Math.min(5, Math.max(0.5, prev * (e.deltaY < 0 ? 1.15 : 0.87)));
      const ratio = next / prev;
      setZoom(next);
      setOffset({
        x: px - (px - offsetRef.current.x) * ratio,
        y: py - (py - offsetRef.current.y) * ratio
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // 拖动平移（仅在缩放 >1 时生效）
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const d = dragRef.current;
      if (!d) return;
      setOffset({ x: d.ox + (e.clientX - d.startX), y: d.oy + (e.clientY - d.startY) });
    };
    const onUp = (): void => {
      dragRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  /** 复制当前文件到剪贴板（可在资源管理器粘贴；文本同时写入路径） */
  const copyFileToClipboard = async (absPath: string): Promise<void> => {
    try {
      await call(getApi().copyFileToClipboard(absPath));
      setSnackbar('已复制文件，可在资源管理器中粘贴');
    } catch {
      setSnackbar('复制文件失败');
    }
  };

  // 键盘：←/→ 翻页、Esc 关闭、Ctrl+C 复制当前文件
  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closePreview();
      else if (e.key === 'ArrowLeft') previewStep(-1);
      else if (e.key === 'ArrowRight') previewStep(1);
      else if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        void copyFileToClipboard(preview.image.absPath);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview, closePreview, previewStep]);

  if (!preview) return null;

  const image = preview.image;
  const tags = tagCache.get(image.absPath) ?? image.tags ?? [];
  // 拆分绝对路径：目录部分（浅色）+ 文件名部分（白色）
  const lastSep = Math.max(image.absPath.lastIndexOf('\\'), image.absPath.lastIndexOf('/'));
  const dirPath = lastSep === -1 ? '' : image.absPath.slice(0, lastSep + 1);
  const fileName = lastSep === -1 ? image.absPath : image.absPath.slice(lastSep + 1);

  const applyWrite = async (
    nextTags: string[],
    request: { add?: string[]; remove?: string[] }
  ): Promise<void> => {
    const prev = tagCache.get(image.absPath) ?? image.tags ?? [];
    setTagsForPath(image.absPath, nextTags);
    try {
      const result = await call(getApi().writeImageTags({ absPath: image.absPath, ...request }));
      setTagsForPath(result.absPath, result.subjects, result.label);
    } catch {
      setTagsForPath(image.absPath, prev);
      setSnackbar('标签写入失败，请检查文件是否只读后重试');
    }
  };

  const handleAddTag = (): void => {
    const tag = newTag.trim();
    if (!tag) return;
    setNewTag('');
    if (tags.includes(tag)) return;
    void applyWrite([...tags, tag], { add: [tag] });
  };

  const handleRemoveTag = (tag: string): void => {
    void applyWrite(
      tags.filter((t) => t !== tag),
      { remove: [tag] }
    );
  };

  return (
    <Box
      className="fixed inset-0 z-50 flex flex-col"
      sx={{ bgcolor: 'rgba(2,6,23,0.94)', color: 'white' }}
    >
      {/* 顶栏 */}
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        className="h-12 shrink-0 px-3"
        sx={{ borderBottom: '1px solid rgba(255,255,255,0.12)' }}
      >
        <Tooltip title="上一张 (←)">
          <IconButton sx={{ color: 'white' }} onClick={() => previewStep(-1)}>
            <ChevronLeftIcon />
          </IconButton>
        </Tooltip>
        {/* 绝对路径：目录部分浅色 + 文件名白色 */}
        <Typography
          noWrap
          variant="subtitle1"
          className="min-w-0 flex-1 text-center ptm-selectable"
          title={image.absPath}
        >
          <span style={{ color: 'rgba(255,255,255,0.5)' }}>{dirPath}</span>
          <span style={{ color: 'white' }}>{fileName}</span>
          <Typography component="span" variant="caption" sx={{ color: 'rgba(255,255,255,0.55)', ml: 1 }}>
            {preview.index + 1} / {preview.list.length}
          </Typography>
        </Typography>
        <Tooltip title="下一张 (→)">
          <IconButton sx={{ color: 'white' }} onClick={() => previewStep(1)}>
            <ChevronRightIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title="关闭 (Esc)">
          <IconButton sx={{ color: 'white' }} onClick={closePreview}>
            <CloseIcon />
          </IconButton>
        </Tooltip>
      </Stack>

      {/* 大图区：滚轮缩放（光标为中心）+ 拖动平移（长图），双击重置 */}
      <Box
        ref={imgBoxRef}
        className={`relative flex min-h-0 flex-1 select-none items-center justify-center overflow-hidden p-4 ${
          zoom > 1 ? 'cursor-grab active:cursor-grabbing' : ''
        }`}
        sx={{ touchAction: 'none' }}
        onMouseDown={(e) => {
          if (zoomRef.current <= 1) return;
          dragRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            ox: offsetRef.current.x,
            oy: offsetRef.current.y
          };
          e.preventDefault();
        }}
        onDoubleClick={resetView}
      >
        <img
          key={image.absPath}
          src={toFileUrl(image.absPath)}
          alt={image.name}
          draggable={false}
          className="max-h-full max-w-full object-contain"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            transition: 'transform 0.06s linear'
          }}
        />
        {zoom !== 1 && (
          <Typography
            className="pointer-events-none absolute bottom-2 right-3"
            variant="caption"
            sx={{ color: 'rgba(255,255,255,0.55)' }}
          >
            {Math.round(zoom * 100)}% · 双击还原
          </Typography>
        )}
      </Box>

      {/* 底栏：标签 + 信息 */}
      <Box className="shrink-0 px-4 py-3" sx={{ borderTop: '1px solid rgba(255,255,255,0.12)' }}>
        <Stack direction="row" spacing={1} alignItems="center" className="mb-2 flex-wrap">
          <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.7)' }}>
            标签：
          </Typography>
          {tags.map((tag) => (
            <Chip
              key={tag}
              label={tag}
              size="small"
              onDelete={() => handleRemoveTag(tag)}
              sx={{ bgcolor: 'rgba(255,255,255,0.14)', color: 'white' }}
            />
          ))}
          <TextField
            size="small"
            placeholder="添加标签后回车"
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddTag();
            }}
            sx={{
              '& .MuiOutlinedInput-root': { color: 'white', bgcolor: 'rgba(255,255,255,0.08)' },
              '& .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(255,255,255,0.25)' },
              '& input::placeholder': { color: 'rgba(255,255,255,0.45)' }
            }}
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton size="small" sx={{ color: 'white' }} onClick={handleAddTag}>
                    <AddIcon fontSize="small" />
                  </IconButton>
                </InputAdornment>
              )
            }}
          />
        </Stack>

        <Divider sx={{ borderColor: 'rgba(255,255,255,0.12)', my: 1 }} />

        <Stack direction="row" spacing={2} alignItems="center" className="flex-wrap">
          {infoLoading ? (
            <CircularProgress size={14} sx={{ color: 'rgba(255,255,255,0.6)' }} />
          ) : (
            <>
              {/* 属性按需展示：内容为空则隐藏该属性 */}
              {info?.width && info?.height ? (
                <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.7)' }}>
                  {info.width} × {info.height}
                </Typography>
              ) : null}
              {info?.sizeBytes != null ? (
                <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.7)' }}>
                  {formatBytes(info.sizeBytes)}
                </Typography>
              ) : null}
              {info?.dateTimeOriginal ? (
                <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.7)' }}>
                  {info.dateTimeOriginal}
                </Typography>
              ) : null}
              {[info?.make, info?.model].filter(Boolean).join(' ') ? (
                <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.7)' }}>
                  {[info?.make, info?.model].filter(Boolean).join(' ')}
                </Typography>
              ) : null}
            </>
          )}
        </Stack>
      </Box>
    </Box>
  );
}
