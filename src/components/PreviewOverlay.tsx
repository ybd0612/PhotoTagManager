import { useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  Chip,
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
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { call, getApi, toFileUrl } from '../api';
import { useTrashImages } from '../hooks/useTrashImages';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import { useAppStore } from '../store/useAppStore';
import { ExifInfoPanel } from './ExifInfoPanel';
import { overlay, px, tokens } from '../theme/tokens';
import type { ImageInfo } from '../../shared/types';

/**
 * 全屏预览覆盖层（R10）：大图 + ←/→ 翻页 + Esc 关闭 + 标签编辑（R07）+ 图片信息（P1）。
 */
export function PreviewOverlay(): JSX.Element | null {
  const preview = useAppStore((s) => s.preview);
  const tagCache = useAppStore((s) => s.tagCache);
  const exifPanelExpanded = useAppStore((s) => s.exifPanelExpanded);
  const toggleExifPanel = useAppStore((s) => s.toggleExifPanel);
  const closePreview = useAppStore((s) => s.closePreview);
  const previewStep = useAppStore((s) => s.previewStep);
  const setTagsForPath = useAppStore((s) => s.setTagsForPath);
  const setSnackbar = useAppStore((s) => s.setSnackbar);

  const [imageMenu, setImageMenu] = useState<{ x: number; y: number } | null>(null);
  const { askTrash, dialog: trashDialog } = useTrashImages();
  const [info, setInfo] = useState<ImageInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [newTag, setNewTag] = useState('');
  // 长图查看：缩放（0.5~5，光标为中心）+ 拖动平移；ref 镜像避免闭包
  const [zoom, setZoomState] = useState(1);
  const [offset, setOffsetState] = useState({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const offsetRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

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
    setInfoError(false);
    setImageError(false);
    setInfoLoading(true);
    void call(getApi().getImageInfo(absPath))
      .then((result) => {
        if (!cancelled) setInfo(result);
      })
      .catch(() => {
        if (!cancelled) setInfoError(true);
      })
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

  /** 滚轮缩放（光标为中心）；React onWheel 属性无挂载时机问题（预览层无页面滚动冲突） */
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
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

  // 拖动平移：缩放不为 1 时生效，避免缩小后偏移超出视口时无法找回图片
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

  const revealInExplorer = async (absPath: string): Promise<void> => {
    try {
      await call(getApi().revealFileInExplorer(absPath));
    } catch {
      setSnackbar('在资源管理器中定位失败');
    }
  };

  // 打开预览时将焦点移入对话框，切换图片时保持焦点上下文
  useEffect(() => {
    if (preview) dialogRef.current?.focus();
  }, [preview?.image.absPath]);

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
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="preview-overlay-title"
      tabIndex={-1}
      className="fixed inset-0 flex flex-col"
      // 留在 MUI 模态带上：预览里弹出的右键菜单、回收站确认框都是 portal 挂 body、
      // 按这个带（1300）画的，覆盖层一旦抬到它之上就把自家浮层一起压住。
      // 右上角窗口控件由 WindowControls 在预览开着时显式隐藏，不靠这里的层级压它。
      // no-drag 是必须的：主顶栏 .ptm-titlebar 把窗口顶部 0..44px 登记成了拖拽带，而**层级高不等于能命中**——
      // 覆盖层不把自己减出去，落在带里的那排按钮（上一张 / 定位 / 复制 / 关闭）真实鼠标点击就会被当成
      // "拖动窗口"吞掉（2026-09-30 实测：只有恰好压在顶栏「设置」那颗 no-drag 洞上的「下一张」侥幸能点）。
      // 代价是预览开着时整窗不让拖，这符合全屏模态的惯例。
      sx={{ bgcolor: 'rgb(2,6,23)', color: 'white', zIndex: (theme) => theme.zIndex.modal, WebkitAppRegion: 'no-drag' }}
    >
      {/* 顶栏 */}
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        className="h-14 shrink-0 px-3"
        sx={{ borderBottom: `1px solid ${overlay.hairline}` }}
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
          id="preview-overlay-title"
          className="min-w-0 flex-1 text-center ptm-selectable"
          title={image.absPath}
        >
          <span style={{ color: overlay.dim }}>{dirPath}</span>
          <span style={{ color: 'white' }}>{fileName}</span>
          <Typography component="span" variant="caption" sx={{ color: overlay.dim, ml: 1 }}>
            {preview.index + 1} / {preview.list.length}
          </Typography>
        </Typography>
        <Tooltip title="下一张 (→)">
          <IconButton sx={{ color: 'white' }} onClick={() => previewStep(1)}>
            <ChevronRightIcon />
          </IconButton>
        </Tooltip>
        <Stack direction="row" spacing={0.5} sx={{ minWidth: 0 }}>
          <Tooltip title="在资源管理器中定位">
            <IconButton aria-label="在资源管理器中定位" sx={{ color: 'white' }} onClick={() => void revealInExplorer(image.absPath)}>
              <FolderOpenIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="复制文件">
            <IconButton aria-label="复制文件" sx={{ color: 'white' }} onClick={() => void copyFileToClipboard(image.absPath)}>
              <ContentCopyIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="关闭 (Esc)">
            <IconButton aria-label="关闭预览" sx={{ color: 'white' }} onClick={closePreview}>
              <CloseIcon />
            </IconButton>
          </Tooltip>
        </Stack>
      </Stack>

      {/* 大图区：滚轮缩放（光标为中心）+ 拖动平移（长图），双击重置 */}
      <Box
        data-testid="preview-stage"
        className={`relative flex min-h-0 flex-1 select-none items-center justify-center overflow-hidden p-4 ${
          zoom !== 1 ? 'cursor-grab active:cursor-grabbing' : ''
        }`}
        sx={{ touchAction: 'none' }}
        onContextMenu={(e) => {
          e.preventDefault();
          setImageMenu({ x: e.clientX, y: e.clientY });
        }}
        onMouseDown={(e) => {
          if (zoomRef.current !== 1) {
            dragRef.current = {
              startX: e.clientX,
              startY: e.clientY,
              ox: offsetRef.current.x,
              oy: offsetRef.current.y
            };
            e.preventDefault();
          }
        }}
        onDoubleClick={resetView}
        onWheel={handleWheel}
      >
        {imageError ? (
          <Stack alignItems="center" spacing={1} role="alert">
            <Typography>图片加载失败</Typography>
            <Stack direction="row" spacing={1}>
              <Button color="inherit" variant="outlined" onClick={() => setImageError(false)}>重试</Button>
              <Button color="inherit" onClick={() => previewStep(1)}>跳过</Button>
              <Button color="inherit" onClick={closePreview}>关闭</Button>
            </Stack>
          </Stack>
        ) : (
          <img
            key={image.absPath}
            src={toFileUrl(image.absPath)}
            alt={image.name}
            onError={() => setImageError(true)}
            draggable={false}
            className="max-h-full max-w-full object-contain"
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
              transition: 'transform 0.06s linear'
            }}
          />
        )}
        {zoom !== 1 && (
          <Typography
            data-testid="preview-zoom-badge"
            className="pointer-events-none absolute bottom-2 right-3"
            variant="caption"
            sx={{
              color: overlay.textStrong,
              bgcolor: overlay.chip,
              px: 1,
              py: 0.25,
              borderRadius: px(tokens.radius.sm)
            }}
          >
            {Math.round(zoom * 100)}% · 双击还原
          </Typography>
        )}
        <ExifInfoPanel
          info={info}
          loading={infoLoading}
          error={infoError}
          expanded={exifPanelExpanded}
          onToggle={toggleExifPanel}
        />
      </Box>
      <Menu
        open={imageMenu !== null}
        onClose={() => setImageMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={imageMenu ? { top: imageMenu.y, left: imageMenu.x } : undefined}
      >
        <MenuItem
          data-testid="preview-menu-trash"
          onClick={() => {
            const target = image.absPath;
            setImageMenu(null);
            askTrash([target]);
          }}
        >
          移到回收站
        </MenuItem>
      </Menu>
      {trashDialog}
      {/* 底栏下半：标签编辑（与上半同一块面板，不再各画一条分隔线） */}
      <Box className="shrink-0 px-4 pb-2.5 pt-1" sx={{ bgcolor: overlay.surfaceFaint }}>
        <Stack direction="row" spacing={1} alignItems="center" className="flex-wrap">
          <Typography variant="caption" sx={{ color: overlay.mid }}>
            标签：
          </Typography>
          {tags.map((tag) => (
            <Chip
              key={tag}
              label={tag}
              size="small"
              onDelete={() => handleRemoveTag(tag)}
              sx={{ bgcolor: overlay.surfaceStrong, color: 'white' }}
            />
          ))}
          <TextField
            size="small"
            placeholder="输入标签，回车添加"
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddTag();
            }}
            sx={{
              '& .MuiOutlinedInput-root': { color: 'white', bgcolor: overlay.surface },
              '& .MuiOutlinedInput-notchedOutline': { borderColor: overlay.fieldBorder },
              // focus 必须肉眼可辨：这块面板整层都是近黑底，只靠主题默认描边看不出光标在哪
              '& .MuiOutlinedInput-root.Mui-focused .MuiOutlinedInput-notchedOutline': {
                borderColor: overlay.focus,
                borderWidth: 2
              },
              // 显式 opacity:1：MUI 给 ::placeholder 另压了一层透明度，不写会被二次衰减
              '& input::placeholder': { color: overlay.fieldPlaceholder, opacity: 1 }
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
      </Box>
    </Box>
  );
}
