import { IconButton, Tooltip } from '@mui/material';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';

/**
 * 解释型长句的收口形式：一个问号，悬浮或键盘聚焦才展开正文。
 *
 * 刻意不用于三类信息——操作引导（不知道就不会操作）、破坏性后果预警（不知道就会做错）、
 * 失败原因（报错当下必须看得见）。那三类必须常驻可见，藏进 hover 等于没写。
 */
export function Hint({ text, testId }: { text: string; testId?: string }): JSX.Element {
  return (
    <Tooltip title={text} placement="right">
      <IconButton
        size="small"
        aria-label="说明"
        data-testid={testId}
        sx={{ p: 0.25, color: 'text.disabled', alignSelf: 'center' }}
      >
        <HelpOutlineIcon sx={{ fontSize: 16 }} />
      </IconButton>
    </Tooltip>
  );
}
