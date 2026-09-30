import type { BrowserWindow } from 'electron';
import type { CaptionTheme } from '../shared/types';

/**
 * 右上角三个窗口控件由 Windows 的 DWM 绘制，是一块盖在网页之上的不透明矩形：
 * 底色只能由主进程整块指定，既改不了它的图标形状，也没法让网页内容把它遮住。
 * 所以界面换底色时（主界面纯白顶栏 ↔ 全屏预览近黑顶栏）必须跟着改这块的颜色，
 * 否则预览右上角就会糊着一块刺眼的白。
 */

/**
 * 覆盖层高度必须与顶栏高度严格相等，否则多出来的那几像素会往下压进内容区。
 * 主界面与全屏预览的顶栏都是 h-14（56px），见 src/styles/index.css 的 --ptm-header-height。
 */
export const CAPTION_OVERLAY_HEIGHT = 56;

/**
 * 两套底色各自取自它所贴合的那块界面：light 是 MUI Paper 顶栏的纯白，dark 是 PreviewOverlay 的 rgb(2,6,23)。
 *
 * dark 下图标与底色同色，等于让这三个按钮"看起来不存在"——全屏预览自己有「关闭预览」和 Esc，
 * 最大化/最小化在遮罩层上也没有可操作的对象。Windows 侧没有把它们摘掉的 API
 * （win.setWindowButtonVisibility 在 typings 里标的是 @platform darwin，只对 macOS 红绿灯生效），
 * 只能这么藏。残留：鼠标悬停到那一片时，系统自绘的 hover 高亮会浮出淡淡的方块。
 */
const PALETTE: Record<CaptionTheme, { color: string; symbolColor: string }> = {
  light: { color: '#ffffff', symbolColor: '#0f172a' },
  dark: { color: '#020617', symbolColor: '#020617' }
};

export function captionOverlay(theme: CaptionTheme): {
  color: string;
  symbolColor: string;
  height: number;
} {
  return { ...PALETTE[theme], height: CAPTION_OVERLAY_HEIGHT };
}

/**
 * 运行时换色。窗口不存在或已销毁时静默跳过：预览关闭与窗口销毁可能同帧发生，
 * 这时候报错只会把一次正常的关窗动作变成一条未捕获异常。
 */
export function applyCaptionTheme(win: BrowserWindow | null, theme: CaptionTheme): void {
  if (!win || win.isDestroyed()) return;
  win.setTitleBarOverlay(captionOverlay(theme));
}
