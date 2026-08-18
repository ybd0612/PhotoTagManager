import { useCallback, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  LinearProgress,
  Paper,
  Snackbar,
  Stack,
  Tooltip,
  Typography
} from '@mui/material';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import RefreshIcon from '@mui/icons-material/Refresh';
import SellIcon from '@mui/icons-material/Sell';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import PhotoLibraryIcon from '@mui/icons-material/PhotoLibrary';
import { call, getApi } from '../api';
import { useAppStore } from '../store/useAppStore';
import { cancelScan, rescan, startScan } from '../hooks/useScan';
import { FolderTree } from './FolderTree';
import { TagFilterBar } from './TagFilterBar';
import { ThumbnailGrid } from './ThumbnailGrid';
import { PreviewOverlay } from './PreviewOverlay';
import { TagManagerDialog } from './TagManagerDialog';

/**
 * 三栏布局容器 + 顶部工具栏 + 底部状态栏（PRD §3.3 线框图）。
 * 空状态引导「选择根目录」；扫描中展示进度条；支持取消。
 */
export function AppLayout(): JSX.Element {
  const rootPath = useAppStore((s) => s.rootPath);
  const scanState = useAppStore((s) => s.scanState);
  const scanStats = useAppStore((s) => s.scanStats);
  const selectedImages = useAppStore((s) => s.selectedImages);
  const snackbar = useAppStore((s) => s.snackbar);
  const setSnackbar = useAppStore((s) => s.setSnackbar);

  const [tagManagerOpen, setTagManagerOpen] = useState(false);

  const handlePickDirectory = useCallback(async () => {
    try {
      const path = await call(getApi().pickDirectory());
      if (path) {
        await startScan(path);
      }
    } catch (error) {
      setSnackbar(`选择目录失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [startScan, setSnackbar]);

  const handleRescan = useCallback(() => {
    void rescan();
  }, [rescan]);

  const handleCancel = useCallback(() => {
    void cancelScan();
  }, [cancelScan]);

  const scanning = scanState === 'scanning';
  const hasRoot = rootPath !== null && rootPath !== '';

  return (
    <Box className="flex h-full flex-col bg-slate-50">
      {/* 顶部工具栏 */}
      <Paper
        component="header"
        className="flex h-14 shrink-0 items-center justify-between rounded-none border-b border-slate-200 px-4"
      >
        <Stack direction="row" spacing={1.5} alignItems="center">
          <PhotoLibraryIcon color="primary" />
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            PhotoTagManager
          </Typography>
          <Chip
            size="small"
            label={rootPath ?? '未选择目录'}
            variant="outlined"
            sx={{ maxWidth: 360 }}
            title={rootPath ?? ''}
          />
        </Stack>

        <Stack direction="row" spacing={1}>
          <Button
            variant="contained"
            startIcon={<FolderOpenIcon />}
            onClick={() => void handlePickDirectory()}
          >
            选择根目录
          </Button>
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            disabled={!hasRoot || scanning}
            onClick={handleRescan}
          >
            重新扫描
          </Button>
          <Tooltip title="标签管理（P1）">
            <span>
              <Button
                variant="outlined"
                startIcon={<SellIcon />}
                disabled={!hasRoot}
                onClick={() => setTagManagerOpen(true)}
              >
                标签管理
              </Button>
            </span>
          </Tooltip>
          {scanning && (
            <Button
              variant="text"
              color="error"
              startIcon={<StopCircleIcon />}
              onClick={handleCancel}
            >
              取消
            </Button>
          )}
        </Stack>
      </Paper>

      {/* 主体三栏 */}
      {!hasRoot || scanState === 'idle' ? (
        <EmptyState onPick={() => void handlePickDirectory()} />
      ) : (
        <Box className="flex min-h-0 flex-1">
          {/* 左：目录树 */}
          <Paper className="w-[260px] shrink-0 overflow-hidden rounded-none border-r border-slate-200">
            <FolderTree />
          </Paper>

          {/* 右：标签筛选条 + 缩略图网格 */}
          <Box className="flex min-w-0 flex-1 flex-col">
            <TagFilterBar />
            <Box className="min-h-0 flex-1">
              <ThumbnailGrid />
            </Box>
          </Box>
        </Box>
      )}

      {/* 底部状态栏 */}
      <Paper className="flex h-7 shrink-0 items-center justify-between rounded-none border-t border-slate-200 px-3">
        <Typography variant="caption" color="text.secondary">
          共 {scanStats?.imageCount.toLocaleString() ?? 0} 张
          <span className="mx-2 text-slate-300">|</span>
          已选 {selectedImages.size} 张
          <span className="mx-2 text-slate-300">|</span>
          已扫描 {scanStats?.scannedFiles.toLocaleString() ?? 0} 个文件
        </Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          {scanning && (
            <>
              <Typography variant="caption" color="text.secondary">
                扫描中…
              </Typography>
              <Box className="w-32">
                <LinearProgress variant="indeterminate" sx={{ height: 4 }} />
              </Box>
            </>
          )}
          {scanState === 'done' && (
            <Typography variant="caption" sx={{ color: 'success.main' }}>
              扫描完成 100%
            </Typography>
          )}
          {scanState === 'error' && (
            <Typography variant="caption" color="error">
              扫描出错
            </Typography>
          )}
        </Stack>
      </Paper>

      {/* 预览覆盖层 */}
      <PreviewOverlay />

      {/* 标签管理面板（P1） */}
      <TagManagerDialog open={tagManagerOpen} onClose={() => setTagManagerOpen(false)} />

      {/* 全局提示 */}
      <Snackbar
        open={snackbar !== null}
        autoHideDuration={3000}
        onClose={() => setSnackbar(null)}
        message={snackbar ?? ''}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  );
}

function EmptyState({ onPick }: { onPick: () => void }): JSX.Element {
  return (
    <Box className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
      <PhotoLibraryIcon sx={{ fontSize: 88, color: '#c7d2fe' }} />
      <Typography variant="h6" color="text.secondary">
        选择一个包含图片的文件夹开始管理标签
      </Typography>
      <Typography variant="body2" color="text.disabled">
        支持 JPG / PNG / WebP / RAW / HEIC / TIFF 等常见格式
      </Typography>
      <Button variant="contained" size="large" startIcon={<FolderOpenIcon />} onClick={onPick}>
        选择根目录
      </Button>
    </Box>
  );
}
