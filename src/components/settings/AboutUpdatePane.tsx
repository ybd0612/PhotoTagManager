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
import { BrandLogo } from '../BrandLogo';
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
        <Stack direction="row" spacing={1.25} alignItems="center" sx={{ mb: 0.75 }}>
          <BrandLogo size={32} />
          <Typography variant="h6">图片管家 PhotoTagManager</Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary">
          一款 Windows 本机图片管理工具：浏览、搜索、打标、清理。标签直接写进图片文件自身的 XMP 元数据——不搬文件、不建数据库，图片复制或移动后标签跟着走。
        </Typography>
      </Box>
      <Divider />

      <Box>
        <Typography variant="subtitle2" gutterBottom>
          产品信息
        </Typography>
        <Typography variant="body2">当前版本：{packageJson.version}</Typography>
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Typography variant="body2" color="text.secondary">
            程序名：PhotoTagManager
          </Typography>
          <Hint
            testId="app-name-hint"
            text="PhotoTagManager 同时是安装目录名、进程名与快捷方式名；配置文件夹在 %APPDATA%\\photo-tag-manager。"
          />
        </Stack>
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
        <Typography variant="body2">
          许可证：MIT License（全文见仓库 <code>LICENSE</code> 文件）
        </Typography>
      </Box>
      <Divider />

      <Stack spacing={0.75}>
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Typography variant="subtitle2">更新</Typography>
          <Hint
            testId="update-hint"
            text="应用启动时会自动静默检查一次，发现新版本在右下角提示；这里的按钮是手动再查一次。更新只从 GitHub Releases 拉取安装包，并使用「常规」里设置的代理；连不上时会说明原因，照片始终不出本机。"
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
          许可与免责
        </Typography>
        <Typography variant="body2" color="text.secondary">
          本软件按 MIT 许可提供，可自由使用、复制、修改与再分发（含商用），但按「现状」交付，不含任何明示或暗示的担保。
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          标签写进图片文件自身的 XMP 元数据，「移到回收站」依赖系统回收站的可恢复性——这两种操作都可能改坏或丢数据，重要目录请先自行备份。
        </Typography>
      </Box>
    </Stack>
  );
}
