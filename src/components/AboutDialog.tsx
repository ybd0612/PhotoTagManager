import type { MouseEvent } from 'react';
import {
  Box,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Button,
  Link,
  List,
  ListItem,
  ListItemText,
  Stack,
  Typography,
} from '@mui/material';
import { call, getApi } from '../api';

interface AboutDialogProps {
  open: boolean;
  onClose: () => void;
}

/** 产品关于信息对话框，集中展示版本、开源许可及使用说明。 */
export function AboutDialog({ open, onClose }: AboutDialogProps): JSX.Element {
  const handleExternalLink = (url: string) => (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    void call(getApi().openExternal(url)).catch(() => {
      // Keep the dialog usable if the main process cannot open the URL.
    });
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" aria-labelledby="about-dialog-title">
      <DialogTitle id="about-dialog-title">关于照片标签管家</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Box>
            <Typography variant="h6" gutterBottom>
              照片标签管家
            </Typography>
            <Typography variant="body2" color="text.secondary">
              一款面向 Windows 的本地图片标签管理工具，帮助你整理、标记和快速查找照片。
            </Typography>
          </Box>

          <Box>
            <Typography variant="subtitle2" gutterBottom>
              产品信息
            </Typography>
            <Typography variant="body2">当前版本：0.1.1</Typography>
            <Typography variant="body2">
              开源地址：{' '}
              <Link
                href="https://github.com/ybd0612/PhotoTagManager"
                target="_blank"
                rel="noopener noreferrer"
                onClick={handleExternalLink('https://github.com/ybd0612/PhotoTagManager')}
                underline="hover"
              >
                github.com/ybd0612/PhotoTagManager
              </Link>
            </Typography>
            <Typography variant="body2">
              作者网站：{' '}
              <Link
                href="https://yangbang.de"
                target="_blank"
                rel="noopener noreferrer"
                onClick={handleExternalLink('https://yangbang.de')}
                underline="hover"
              >
                yangbang.de
              </Link>
            </Typography>
            <Typography variant="body2">许可证：MIT License</Typography>
          </Box>

          <Box>
            <Typography variant="subtitle2" gutterBottom>
              学习与使用说明
            </Typography>
            <List dense disablePadding>
              <ListItem disableGutters>
                <ListItemText primary="1. 添加一个或多个图片根目录，可为每个目录设置便于识别的别名。" />
              </ListItem>
              <ListItem disableGutters>
                <ListItemText primary="2. 选择根目录后启动扫描，等待图片索引完成。" />
              </ListItem>
              <ListItem disableGutters>
                <ListItemText primary="3. 使用标签管理和筛选功能整理照片，点击缩略图可预览。" />
              </ListItem>
              <ListItem disableGutters>
                <ListItemText primary="4. 可从图片操作中打开资源管理器并定位到原文件。" />
              </ListItem>
            </List>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} variant="contained" autoFocus>
          关闭
        </Button>
      </DialogActions>
    </Dialog>
  );
}
