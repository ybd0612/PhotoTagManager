import type { MouseEvent } from 'react';
import {
  Box,
  Button,
  Divider,
  Link,
  List,
  ListItem,
  ListItemText,
  Stack,
  Typography
} from '@mui/material';
import { call, getApi } from '../../api';
import packageJson from '../../../package.json';

/**
 * 「关于与更新」分区：版本号、许可与更新入口并置在一处。
 *
 * 手动检查复用 AppLayout 挂载的 UpdateDialog（状态机只有一份实现），本分区只负责触发；
 * 埋一层不伤可用性是因为启动时已静默检查过一轮，发现新版本会自己弹窗提示。
 */
export function AboutUpdatePane({
  onCheckUpdate = () => undefined
}: {
  /** 由 AppLayout 传入：关掉设置再打开更新对话框，避免两个模态叠在一起 */
  onCheckUpdate?: () => void;
}): JSX.Element {
  const handleExternalLink = (url: string) => (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    // 主进程打不开外链时不打断用户，链接本身仍可靠 href 生效
    void call(getApi().openExternal(url)).catch(() => undefined);
  };

  return (
    <Stack spacing={2} data-testid="settings-about">
      <Box>
        <Typography variant="h6" gutterBottom>
          照片标签管家 PhotoTagManager
        </Typography>
        <Typography variant="body2" color="text.secondary">
          一款面向 Windows 的本地图片标签管理工具，帮助你整理、标记和快速查找照片。
        </Typography>
      </Box>
      <Divider />

      <Box>
        <Typography variant="subtitle2" gutterBottom>
          产品信息
        </Typography>
        <Typography variant="body2">当前版本：{packageJson.version}</Typography>
        <Typography variant="body2" color="text.secondary">
          程序名：PhotoTagManager（安装目录、进程与配置文件夹同名）
        </Typography>
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
      <Divider />

      <Stack direction="row" spacing={1.5} alignItems="flex-start">
        <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle2">更新</Typography>
          <Typography variant="caption" color="text.secondary">
            启动时自动静默检查，发现新版本会弹窗提示；这里可以手动再查一次。
          </Typography>
        </Stack>
        <Button
          variant="outlined"
          size="small"
          onClick={onCheckUpdate}
          sx={{ textTransform: 'none' }}
        >
          检查更新
        </Button>
      </Stack>
      <Divider />

      <Box>
        <Typography variant="subtitle2" gutterBottom>
          学习与使用说明
        </Typography>
        <List dense disablePadding>
          <ListItem disableGutters>
            <ListItemText primary="1. 添加一个或多个图片根目录，可为每个目录设置便于识别的别名。" />
          </ListItem>
          <ListItem disableGutters>
            <ListItemText primary="2. 选择根目录后启动扫描，等待扫描完成。" />
          </ListItem>
          <ListItem disableGutters>
            <ListItemText primary="3. 使用标签管理和筛选功能整理照片，点击缩略图可预览。" />
          </ListItem>
          <ListItem disableGutters>
            <ListItemText primary="4. 右键图片，或在放大图里点「在资源管理器中定位」即可打开所在文件夹。" />
          </ListItem>
        </List>
      </Box>
    </Stack>
  );
}
