import { useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
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
import { call, formatBytes, getApi, toFileUrl } from '../api';
import { rescan } from '../hooks/useScan';
import { useTrashImages } from '../hooks/useTrashImages';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import { useAppStore } from '../store/useAppStore';
import { useAiStore } from '../store/useAiStore';
import { AiActionSplitButton } from './AiActionSplitButton';
import { AiCompareActions, AiCompareStage, useCompareResult } from './AiCompareView';
import { overlay, tokens } from '../theme/tokens';
import type { ImageInfo } from '../../shared/types';

/**
 * 全屏预览覆盖层（R10）：大图 + ←/→ 翻页 + Esc 关闭 + 标签编辑（R07）+ 图片信息（P1）。
 */
export function PreviewOverlay(): JSX.Element | null {
  const preview = useAppStore((s) => s.preview);
  // 结果只在它那张照片上是有效的；hook 要早于下面的提前 return，所以从 preview 上取路径
  const compare = useCompareResult(preview?.image?.absPath);
  const setHoldingOriginal = useAiStore((s) => s.setHoldingOriginal);
  const compareMode = useAiStore((s) => s.compareMode);
  // AI 失败此前只写进 store，全仓没有任何一处渲染它——错误等于没发生
  const aiError = useAiStore((s) => s.error);
  const dismissAiError = useAiStore((s) => s.dismissError);
  const modelAction = useAiStore((s) => s.modelAction);
  const catalog = useAiStore((s) => s.catalog);
  const loadedModelId =
    catalog?.capabilities.flatMap((c) => c.models).find((m) => m.loaded)?.id ?? null;
  const tagCache = useAppStore((s) => s.tagCache);
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

  // 切换图片时重置缩放/平移，并放开"按住看原图"
  // （holding 是全局状态，不跟着换图复位的话，翻到下一张就没人能把它松开——和之前 aiResult 挂到下一张是同一类残留）
  useEffect(() => {
    resetView();
    useAiStore.getState().setHoldingOriginal(false);
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
      // 在大图上按下后于别处松手：只清 dragRef 会让 holding 卡在 true，原图下不来
      useAiStore.getState().setHoldingOriginal(false);
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

  /**
   * 保存成功后的可见性处理（§4.4 C2 选方案①：主动刷新，不甩给用户重扫）。
   * 不允许静默——点了保存却找不到文件，用户第一反应是保存失败。
   * 走 rescan() 而不是把新文件本地塞进列表：目录节点的 directCount / totalCount
   * 是扫描算出来的，只改 imagesByDir 会让文件夹徽标与磁盘悄悄对不上。
   */
  const handleAiSaved = (saved: { targetName: string; renamed: boolean }): void => {
    setSnackbar(
      saved.renamed
        ? '已保存为 ' + saved.targetName + '（同名已存在，序号顺延），正在刷新列表'
        : '已保存为 ' + saved.targetName + '，正在刷新列表'
    );
    void rescan();
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

  // 键盘：←/→ 翻页、Esc 关闭、Ctrl+C 复制当前文件、空格按住看原图（批次3 G9）
  useEffect(() => {
    if (!preview) return;
    const isTyping = (e: KeyboardEvent): boolean => {
      const el = e.target as HTMLElement | null;
      return (
        !!el &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true)
      );
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closePreview();
      else if (e.key === 'ArrowLeft') previewStep(-1);
      else if (e.key === 'ArrowRight') previewStep(1);
      else if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        void copyFileToClipboard(preview.image.absPath);
      } else if (e.key === ' ' && compare && !isTyping(e)) {
        // 标签输入框里打空格必须照常输字，所以 isTyping 挡在前面；
        // 没有这张图的对比结果时空格什么都不做（compare 为空），不进入"按住了个寂寞"的状态
        e.preventDefault();
        if (!e.repeat) setHoldingOriginal(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === ' ') setHoldingOriginal(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [preview, closePreview, previewStep, compare, setHoldingOriginal]);

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

  /** 元数据：原来自己占一行 + 一条 Divider，现在并进动作行右端 */
  const metaBlock = (
    <Stack
      direction="row"
      spacing={1.5}
      alignItems="center"
      data-testid="preview-meta"
      sx={{ ml: 'auto', whiteSpace: 'nowrap', pl: 1 }}
    >
      {infoLoading ? (
        <CircularProgress size={14} sx={{ color: overlay.dim }} aria-label="正在读取图片信息" />
      ) : infoError ? (
        <Typography variant="caption" sx={{ color: 'error.light' }}>图片信息读取失败</Typography>
      ) : (
        <>
          {info?.width && info?.height ? (
            <Typography variant="caption" sx={{ color: overlay.dim }}>{info.width} × {info.height}</Typography>
          ) : null}
          {info?.sizeBytes != null ? (
            <Typography variant="caption" sx={{ color: overlay.dim }}>{formatBytes(info.sizeBytes)}</Typography>
          ) : null}
          {info?.dateTimeOriginal ? (
            <Typography variant="caption" sx={{ color: overlay.dim }}>{info.dateTimeOriginal}</Typography>
          ) : null}
          {[info?.make, info?.model].filter(Boolean).join(' ') ? (
            <Typography variant="caption" sx={{ color: overlay.dim }}>
              {[info?.make, info?.model].filter(Boolean).join(' ')}
            </Typography>
          ) : null}
        </>
      )}
    </Stack>
  );

  return (
    <Box
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="preview-overlay-title"
      tabIndex={-1}
      className="fixed inset-0 flex flex-col"
      // 留在 MUI 模态带上：预览里弹出的模型下拉、右键菜单、下载确认框都是 portal 挂 body、
      // 按这个带（1300）画的，覆盖层一旦抬到它之上就把自家浮层一起压住（2026-09-30 点三角没反应）。
      // 右上角窗口控件由 WindowControls 在预览开着时显式隐藏，不靠这里的层级压它。
      sx={{ bgcolor: 'rgb(2,6,23)', color: 'white', zIndex: (theme) => theme.zIndex.modal }}
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
            return;
          }
          // 未缩放时大图区兼任"按住看原图"（批次3 G9，原先只能按底栏那颗按钮）；
          // 分屏模式原图同屏已在，不抢鼠标
          if (compare && compareMode === 'hold') setHoldingOriginal(true);
        }}
        onMouseUp={() => setHoldingOriginal(false)}
        onMouseLeave={() => setHoldingOriginal(false)}
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
        ) : compare ? (
          <AiCompareStage
            key={image.absPath}
            absPath={image.absPath}
            alt={image.name}
            onError={() => setImageError(true)}
            viewStyle={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
              transition: 'transform 0.06s linear'
            }}
          />
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
              borderRadius: tokens.radius.sm
            }}
          >
            {Math.round(zoom * 100)}% · 双击还原
          </Typography>
        )}
      </Box>

      {/* AI 失败要看得见：一条错误条，不弹窗、不打断浏览 */}
      {aiError && (
        <Stack
          direction="row"
          alignItems="center"
          spacing={1}
          className="shrink-0 px-4"
          sx={{ bgcolor: tokens.status.dangerOnDark }}
        >
          <Typography variant="caption" data-testid="ai-error" sx={{ color: tokens.status.dangerTextOnDark, minWidth: 0, flex: 1, py: 0.5 }}>
            {aiError.message}
          </Typography>
          {/* §8-17 的"一键卸载"：只在显存不足且确有模型驻留时出现，否则就是颗假控件 */}
          {aiError.code === 'GPU_MEMORY_LOW' && loadedModelId && (
            <Button
              size="small"
              color="inherit"
              data-testid="ai-error-unload"
              sx={{ textTransform: 'none', minWidth: 0 }}
              onClick={() => void modelAction(loadedModelId, 'unload').then(() => dismissAiError())}
            >
              卸载已加载的模型
            </Button>
          )}
          <Button
            size="small"
            color="inherit"
            sx={{ textTransform: 'none', minWidth: 0 }}
            onClick={dismissAiError}
          >
            知道了
          </Button>
        </Stack>
      )}

      {/* 底栏上半：AI 动作 + 对比动作 + 元数据（原来元数据自己一行还配一条 Divider） */}
      <Box className="shrink-0 px-4 pt-2.5" sx={{ bgcolor: overlay.surfaceFaint }}>
        <Stack
          direction="row"
          spacing={1.5}
          alignItems="center"
          data-testid="ai-bar"
          sx={{ flexWrap: 'nowrap', minWidth: 0 }}
        >
          {absPath && <AiActionSplitButton absPath={absPath} />}
          <AiCompareActions absPath={image.absPath} onSaved={handleAiSaved} />
          {/* 显式撑开件把元数据顶到最右（单行下仍用它，免得 ml:auto 与左段收缩互相抢宽度） */}
          <Box component="span" sx={{ flex: 1, minWidth: 8 }} />
          {metaBlock}
        </Stack>
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
