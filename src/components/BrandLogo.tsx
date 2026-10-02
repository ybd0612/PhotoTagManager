import brandMark from '../../shared/brand-mark.svg';

/**
 * 品牌 mark 的唯一界面落点：画稿来自 shared/brand-mark.svg。
 * 之前顶栏左上角挂的是 MUI 通用 PhotoLibrary 图标，和任务栏/托盘/安装包那张品牌图是两张脸；
 * 现在四处共用同一份文件，由 scripts/make-icon.cjs 渲染系统图标、由这里渲染界面图标。
 */
export function BrandLogo({ size = 28 }: { size?: number }): JSX.Element {
  return <img src={brandMark} alt="" width={size} height={size} className="shrink-0" />;
}
