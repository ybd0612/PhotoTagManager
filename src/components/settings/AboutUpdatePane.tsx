import type { MouseEvent } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  Divider,
  LinearProgress,
  Link,
  Stack,
  Typography
} from '@mui/material';
import { call, getApi } from '../../api';
import { Hint } from '../Hint';
import { updateActionLabel, updatePrimaryAction, updateStatusLabel } from '../../utils/updateStatus';
import packageJson from '../../../package.json';
import type { UpdateController } from '../../hooks/useUpdate';

/**
 * 「关于与更新」分区：版本号、许可与更新状态并置在一处。
 *
 * 更新就地完成，不再另开对话框：状态与主动作都由传入的控制器推导，
 * 这里是那份状态机在界面上的唯一落点（右下角通知卡共用同一个控制器）。
 */
export function AboutUpdatePane({ update }: { update: UpdateController }): JSX.Element {
  const { status } = update;
  const action = updatePrimaryAction(status);
  const downloading = status.state === 'downloading';

  const handleExternalLink = (url: string) => (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    // 主进程打不开外链时不打断用户，链接本身仍可靠 href 生效
    void call(getApi().openExternal(url)).catch(() => undefined);
  };

  return (
    <Stack spacing={2} data-testid="settings-about">
      <Box>
        <Typography variant="h6" gutterBottom>
          图片管家 PhotoTagManager
        </Typography>
        <Typography variant="body2" color="text.secondary">
          一款 Windows 本机图片管理工具：浏览、搜索、打标、清理，并在本机做 AI 处理。标签直接写进图片文件自身的 XMP 元数据——不搬文件、不建数据库，图片复制或移动后标签跟着走，照片内容不出本机。
        </Typography>
      </Box>
      <Divider />

      <Box>
        <Typography variant="subtitle2" gutterBottom>
          产品信息
        </Typography>
        <Typography variant="body2">当前版本：{packageJson.version}</Typography>
        <Typography variant="body2" color="text.secondary">
          程序名：PhotoTagManager（安装目录、进程与快捷方式同名；配置文件夹为 <code>%APPDATA%\photo-tag-manager</code>）
        </Typography>
        <Typography variant="body2">
          源码地址：{' '}
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
        <Typography variant="body2">
          许可证：源码公开非商业使用许可 v1.0（全文见仓库 <code>LICENSE</code> 文件）
        </Typography>
      </Box>
      <Divider />

      <Stack spacing={0.75}>
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Typography variant="subtitle2">更新</Typography>
          <Hint
            testId="update-hint"
            text="应用启动时会自动静默检查一次，发现新版本在右下角提示；这里的按钮是手动再查一次。更新只从 GitHub Releases 拉取安装包，与代理设置共用同一个出口；照片始终不出本机。"
          />
        </Stack>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Stack direction="row" spacing={1} alignItems="center" sx={{ flex: 1, minWidth: 0 }}>
            {status.state === 'checking' && <CircularProgress size={16} />}
            <Typography
              data-testid="update-status"
              variant="body2"
              color={status.state === 'error' ? 'error' : 'text.secondary'}
              sx={{ minWidth: 0 }}
            >
              {updateStatusLabel(status)}
            </Typography>
          </Stack>
          {action && (
            <Button
              variant="outlined"
              size="small"
              onClick={update.runPrimary}
              sx={{ textTransform: 'none' }}
            >
              {updateActionLabel(action, status)}
            </Button>
          )}
        </Stack>
        {downloading && (
          <LinearProgress variant="determinate" value={status.percent ?? 0} sx={{ width: '100%' }} />
        )}
      </Stack>
      <Divider />

      <Box>
        <Typography variant="subtitle2" gutterBottom>
          学习与使用说明
        </Typography>
        <Typography variant="body2">
          此项目仅供学习交流使用，严禁用于商业用途，请在 24 小时之内删除。
        </Typography>
      </Box>
    </Stack>
  );
}
