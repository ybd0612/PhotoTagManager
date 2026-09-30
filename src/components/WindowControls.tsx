import { useEffect, useState } from 'react';
import CloseIcon from '@mui/icons-material/Close';
import CropSquareIcon from '@mui/icons-material/CropSquare';
import FilterNoneIcon from '@mui/icons-material/FilterNone';
import RemoveIcon from '@mui/icons-material/Remove';
import { call, getApi } from '../api';
import type { IpcResult } from '../../shared/types';

/**
 * 右上角窗口控件（最小化 / 最大化·还原 / 关闭），由渲染层自己画。
 *
 * 原先这三个是系统覆盖层（titleBarStyle: 'hidden' + titleBarOverlay），代价是它由 DWM 画在网页之上：
 * 全屏预览的遮罩盖不住它，MUI 对话框也压不住它，而 Windows 侧没有任何 API 能把它们隐藏
 * （win.setWindowButtonVisibility 在 typings 里标的是 @platform darwin）。
 * 自绘之后它就是一条普通内容——预览覆盖层的 z-index 比它高，一盖就没了，"预览时不显示"零逻辑。
 *
 * 样式（尺寸、hover、关闭变红）在 src/styles/index.css 的 .ptm-window-controls。
 */
export function WindowControls(): JSX.Element {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const api = getApi();
    // 初值必须拉：双击标题栏、Win+↑、点任务栏都能把窗口最大化，那些都不经过本组件
    void call(api.isWindowMaximized())
      .then(setMaximized)
      .catch(() => undefined);
    return api.onWindowMaximized(setMaximized);
  }, []);

  // 三个动作只会在窗口已经没了的时候失败（那时也没什么可提示的），所以失败静默
  const fire = (promise: Promise<IpcResult<unknown>>): void => {
    void call(promise).catch(() => undefined);
  };

  return (
    <div className="ptm-window-controls" data-testid="window-controls" role="group" aria-label="窗口控制">
      <button type="button" aria-label="最小化" title="最小化" onClick={() => fire(getApi().windowMinimize())}>
        <RemoveIcon fontSize="small" />
      </button>
      <button
        type="button"
        aria-label={maximized ? '还原窗口' : '最大化窗口'}
        title={maximized ? '还原' : '最大化'}
        onClick={() => fire(getApi().windowToggleMaximize())}
      >
        {maximized ? <FilterNoneIcon fontSize="small" /> : <CropSquareIcon fontSize="small" />}
      </button>
      <button
        type="button"
        className="ptm-window-controls__close"
        aria-label="关闭窗口"
        title="关闭（收进托盘）"
        onClick={() => fire(getApi().windowClose())}
      >
        <CloseIcon fontSize="small" />
      </button>
    </div>
  );
}
