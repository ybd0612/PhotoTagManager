import { useEffect, useState } from 'react';
import {
  Box,
  Button,
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

  // 键盘：←/→ 翻页、Esc 关闭
  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closePreview();
      else if (e.key === 'ArrowLeft') previewStep(-1);
      else if (e.key === 'ArrowRight') previewStep(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview, closePreview, previewStep]);

  if (!preview) return null;

  const image = preview.image;
  const tags = tagCache.get(image.absPath) ?? image.tags ?? [];

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
        <Typography noWrap variant="subtitle1" className="min-w-0 flex-1 text-center ptm-selectable">
          {image.name}
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

      {/* 大图区 */}
      <Box className="flex min-h-0 flex-1 items-center justify-center p-4">
        <img
          key={image.absPath}
          src={toFileUrl(image.absPath)}
          alt={image.name}
          className="max-h-full max-w-full object-contain"
          draggable={false}
        />
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

        <Stack direction="row" spacing={3} alignItems="center">
          {infoLoading ? (
            <CircularProgress size={14} sx={{ color: 'rgba(255,255,255,0.6)' }} />
          ) : (
            <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.7)' }}>
              {info?.width && info?.height ? `${info.width} × ${info.height}` : '尺寸 -'}
              <span className="mx-2">|</span>
              {formatBytes(info?.sizeBytes)}
              <span className="mx-2">|</span>
              {info?.dateTimeOriginal ?? '拍摄时间 -'}
              <span className="mx-2">|</span>
              {[info?.make, info?.model].filter(Boolean).join(' ') || '相机 -'}
            </Typography>
          )}
          <Button
            size="small"
            variant="outlined"
            sx={{ color: 'white', borderColor: 'rgba(255,255,255,0.4)', ml: 'auto' }}
            onClick={closePreview}
          >
            关闭
          </Button>
        </Stack>
      </Box>
    </Box>
  );
}
