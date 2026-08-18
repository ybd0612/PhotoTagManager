import { useMemo, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Stack,
  TextField,
  Typography
} from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import { call, getApi } from '../api';
import { useAppStore } from '../store/useAppStore';

/**
 * 标签管理面板（P1，R12 基础版）：全量已用标签 + 计数；支持重命名/合并标签（批量更新 XMP）。
 * 重命名成功后清空标签缓存（tagEpoch++），网格按需重新读取。
 */
export function TagManagerDialog({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const tagCounts = useAppStore((s) => s.tagCounts);
  const setSnackbar = useAppStore((s) => s.setSnackbar);
  const bumpTagEpoch = useAppStore((s) => s.bumpTagEpoch);
  const setTagCache = (): void => {
    useAppStore.setState({ tagCache: new Map(), tagCounts: new Map() });
    bumpTagEpoch();
  };

  const [renaming, setRenaming] = useState<string | null>(null);
  const [newName, setNewName] = useState('');

  const allTags = useMemo(
    () =>
      [...tagCounts.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN')
      ),
    [tagCounts]
  );

  const handleRename = async (from: string): Promise<void> => {
    const to = newName.trim();
    setRenaming(null);
    setNewName('');
    if (!to || from === to) return;
    try {
      const count = await call(getApi().renameTag(from, to));
      setSnackbar(`已合并「${from}」→「${to}」（更新 ${count} 张图片）`);
      setTagCache();
    } catch (error) {
      setSnackbar(`标签重命名失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>
        <Stack direction="row" alignItems="center" justifyContent="space-between">
          <Typography variant="h6">标签管理</Typography>
          <IconButton onClick={onClose} size="small">
            <CloseIcon />
          </IconButton>
        </Stack>
      </DialogTitle>
      <DialogContent dividers>
        {allTags.length === 0 ? (
          <Typography color="text.secondary" variant="body2">
            暂无标签数据。浏览图片后，已用标签会自动汇总到这里。
          </Typography>
        ) : (
          <List dense disablePadding>
            {allTags.map(([tag, count]) => (
              <ListItem
                key={tag}
                secondaryAction={
                  renaming === tag ? (
                    <IconButton
                      edge="end"
                      size="small"
                      color="primary"
                      onClick={() => void handleRename(tag)}
                    >
                      <CheckIcon />
                    </IconButton>
                  ) : (
                    <IconButton edge="end" size="small" onClick={() => { setRenaming(tag); setNewName(''); }}>
                      <EditIcon fontSize="small" />
                    </IconButton>
                  )
                }
                sx={{ px: 0 }}
              >
                {renaming === tag ? (
                  <TextField
                    autoFocus
                    size="small"
                    value={newName}
                    placeholder="新标签名"
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleRename(tag);
                      if (e.key === 'Escape') { setRenaming(null); setNewName(''); }
                    }}
                    fullWidth
                  />
                ) : (
                  <ListItemText
                    primary={
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Chip size="small" label={tag} />
                        <Typography variant="caption" color="text.secondary">
                          {count} 张
                        </Typography>
                      </Stack>
                    }
                  />
                )}
              </ListItem>
            ))}
          </List>
        )}
      </DialogContent>
      <DialogActions>
        <Box className="w-full px-2 pb-2">
          <Typography variant="caption" color="text.secondary">
            提示：重命名会将原标签在所有图片的 XMP 中替换为目标标签（批量更新）。
          </Typography>
        </Box>
        <Button onClick={onClose}>关闭</Button>
      </DialogActions>
    </Dialog>
  );
}
