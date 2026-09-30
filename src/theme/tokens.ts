/**
 * 设计 token —— 全站颜色、圆角、间距、字号、阴影、动效的唯一事实源。
 *
 * 为什么要收到一处：此前浅色工具带的颜色写在 index.css、组件里又各抄一份 rgba，
 * 深色预览层的色板在 AiCompareView 建了个 OVERLAY 对象、PreviewOverlay 又把同样的值
 * 手抄了一遍。同一个事实有三处表述，改一处就漏两处，界面就会开始"各区块不像同一个应用"。
 *
 * 两份消费者：
 * - MUI 主题（src/App.tsx）直接读这里的字面量——它要拿 hex 去算明暗档，喂不了 var()；
 * - 手写 CSS 与 Tailwind 类读 applyCssTokens() 注入到 :root 的同名变量。
 * 两边同源，所以不会出现"CSS 改了 MUI 没改"。
 */

declare module '@mui/material/styles' {
  /**
   * 本项目给 primary 多加的一档：选中行的主色半透明底。
   * 不声明的话 `bgcolor: 'primary.soft'` 过不了 tsc（MUI 的 PaletteColor 只有 main/light/dark 等固定键），
   * 而退回去在每个组件里 import 常量就是第二个事实源——所以补类型，不绕过去。
   */
  interface PaletteColor {
    soft: string;
  }
  interface SimplePaletteColorOptions {
    soft?: string;
  }
}

/** 中性色阶：区域靠色块深浅分开，描边只保留一条必需的细分线 */
const ink = {
  /** 主文字。不用纯黑：近黑带一点冷调，大面积排字不刺眼 */
  primary: '#1c2027',
  secondary: '#5a626e',
  tertiary: '#8a929e',
  /**
   * 分隔线。真机眼验过：0.09 配上下面的色调差，板块之间"看不出分界"，
   * 所以分界主要交给这条线，色调差只做辅助。
   */
  hairline: 'rgba(28, 32, 39, 0.14)'
};

const surface = {
  /** 画布：右栏网格的底。纯白——图片本身多数是浅色，画布再压灰整页就发闷 */
  canvas: '#ffffff',
  /** 纸张：卡片、对话框、菜单 */
  paper: '#ffffff',
  /** 次级面：输入框、chip、缩略图占位 */
  muted: '#f1f3f6',
  /**
   * 工具带：顶栏 / 筛选栏 / 左栏 / 状态栏。与画布同为纯白，分界完全交给 hairline。
   * 之前这里压了一档灰（#f7f8fa），而带子上的输入框、切换按钮是白填充或不填充——
   * 圆角那一圈露出的就是这档灰，看着像漏色（真机眼验指出）。带子和控件必须同色才不会有这问题。
   */
  chrome: '#ffffff',
  /** 悬停底：半透明，压在任意底色上都能用，省掉每处再算一个色值 */
  hover: 'rgba(28, 32, 39, 0.045)',
  pressed: 'rgba(28, 32, 39, 0.085)'
};

const accent = {
  main: '#4f46e5',
  light: '#818cf8',
  dark: '#4338ca',
  /** 选中行底色：主色低透明，而不是另挑一个蓝 */
  soft: 'rgba(79, 70, 229, 0.10)',
  onColor: '#ffffff'
};

const status = {
  success: '#15803d',
  warning: '#d97706',
  danger: '#b91c1c',
  /** 深色预览层上的错误条 */
  dangerOnDark: 'rgba(183, 28, 28, 0.22)',
  dangerTextOnDark: '#ffcdd2'
};

/** 深色覆盖层（大图预览、抠图对比）专用：与浅色工具带是两套，别互相引用 */
const overlay = {
  scrim: 'rgba(9,12,20,0.72)',
  chip: 'rgba(2,6,23,0.62)',
  /** 图片上压字用的渐变终点：比 chip 深得多，白文件名才读得清 */
  captionScrim: 'rgba(9,12,20,0.82)',
  surfaceFaint: 'rgba(255,255,255,0.05)',
  surface: 'rgba(255,255,255,0.08)',
  surfaceStrong: 'rgba(255,255,255,0.14)',
  /** 暗底上的可点控件：悬停与按下两档，与浅色侧的 hover/pressed 对应 */
  surfaceHover: 'rgba(255,255,255,0.1)',
  surfaceActive: 'rgba(255,255,255,0.2)',
  /** 暗底上的一条竖分隔 */
  divider: 'rgba(255,255,255,0.18)',
  /** 压在照片上的浅色 chip 底（缩略图标签角标）：要够实，否则花背景上读不出 */
  chipOnImage: 'rgba(255,255,255,0.92)',
  /** 白字压图时的投影，保证任何画面都能读 */
  textOnImage: '0 1px 2px rgba(0,0,0,0.7)',
  hairline: 'rgba(255,255,255,0.12)',
  /** 压在照片上的浮层文字（按住提示、缩放读数） */
  textStrong: 'rgba(255,255,255,0.88)',
  /** 次级说明文字（掩码尺寸注明、元数据） */
  mid: 'rgba(255,255,255,0.72)',
  /** 最弱一档，再低就在近黑底上读不出了 */
  dim: 'rgba(255,255,255,0.55)',
  /** 暗底输入框描边：0.25 在近黑底上基本读不出边界 */
  fieldBorder: 'rgba(255,255,255,0.35)',
  /** placeholder：0.45 会连「这里能输入」都提示不出来 */
  fieldPlaceholder: 'rgba(255,255,255,0.6)',
  /** focus 态描边，取主题 primary.light */
  focus: '#818cf8'
};

/**
 * 默认全是圆角，只有**板块相接的那几条边**是直的（2026-09-30 用户逐轮眼验后定的口径）。
 * 相接处不靠这里的档位，而是那几个通栏 Paper 在自己的 sx 里显式写 borderRadius: 0
 * （顶栏、左栏、筛选栏、网格工具行、状态栏）——不能靠 Tailwind 的 rounded-none 去压
 * MUI 的 .MuiPaper-root：两边特异性相同，谁赢取决于样式注入顺序，实测会翻车。
 * 圆形图形（选中勾、扫描呼吸点）走 50%/full，不归这里管。
 */
const radius = { sm: 8, md: 12, lg: 16, pill: 999 };

/**
 * 交给 MUI 的 sx 属性必须带单位：sx 里的裸数字是 theme.shape.borderRadius 的**倍率**，不是像素。
 * 本项目基准是 12，所以 borderRadius: 8 实测算成 96px——模型下拉那版"角太圆"就是这么来的。
 * 只有 styleOverrides 里的数字才是普通 CSS 数值（走 emotion 直接成 px），那一边不用套这个函数。
 */
export const px = (n: number): string => `${n}px`;

/** 8pt 刻度：间距只允许这六档，杜绝 py-1 这种随手值 */
const space = { s1: 4, s2: 8, s3: 12, s4: 16, s5: 24, s6: 32 };

/** 字号四档。正文从 MUI 默认的 16/14 收到 13，是"精致一点"最明显的一刀 */
const font = { caption: 12, body: 13, subtitle: 15, title: 22 };

/** 阴影两档：静止态几乎看不见，只在悬停与浮层上出现 */
const shadow = {
  /** 只留一档：浮层与 hover 抬升用。静止态阴影已撤（几十个 tile 同画阴影是纯绘制开销），
   *  没有消费者就不留在色板里，免得变成一处永不生效却要看一遍的死值 */
  pop: '0 6px 16px rgba(16, 24, 40, 0.10), 0 2px 6px rgba(16, 24, 40, 0.06)'
};

const motion = {
  fast: 120,
  base: 180,
  /** 与左栏折叠同一条曲线：全站一处改，动效气质才不会分叉 */
  ease: 'cubic-bezier(0.2, 0, 0, 1)'
};

export const tokens = { ink, surface, accent, status, overlay, radius, space, font, shadow, motion };

/** 深色覆盖层色板的单独导出名：预览层与对比视图共用这一份，不再由某个组件持有 */
export { overlay };

/**
 * 注入 :root 的 CSS 变量。名字与手写 CSS 里用的完全一致，
 * 所以 index.css / Tailwind 配置 / MUI 主题三者取到的是同一批值。
 */
const cssVars: Record<string, string> = {
  '--ptm-ink': ink.primary,
  '--ptm-ink-2': ink.secondary,
  '--ptm-ink-3': ink.tertiary,
  '--ptm-hairline': ink.hairline,
  '--ptm-canvas': surface.canvas,
  '--ptm-surface': surface.paper,
  '--ptm-surface-2': surface.muted,
  '--ptm-chrome-bg': surface.chrome,
  '--ptm-hover': surface.hover,
  '--ptm-pressed': surface.pressed,
  '--ptm-accent': accent.main,
  '--ptm-accent-light': accent.light,
  '--ptm-accent-dark': accent.dark,
  '--ptm-accent-soft': accent.soft,
  '--ptm-success': status.success,
  '--ptm-warning': status.warning,
  '--ptm-danger': status.danger,
  '--ptm-r-sm': `${radius.sm}px`,
  '--ptm-r-md': `${radius.md}px`,
  '--ptm-r-lg': `${radius.lg}px`,
  '--ptm-shadow-pop': shadow.pop,
  '--ptm-t-fast': `${motion.fast}ms`,
  '--ptm-t-base': `${motion.base}ms`,
  '--ptm-ease': motion.ease
};

let applied = false;

/** 在首次渲染前调用一次；重复调用是空操作 */
export function applyCssTokens(): void {
  if (applied || typeof document === 'undefined') return;
  const root = document.documentElement;
  for (const [name, value] of Object.entries(cssVars)) root.style.setProperty(name, value);
  applied = true;
}

/** 供测试与文档核对：变量表本身 */
export function cssTokenNames(): string[] {
  return Object.keys(cssVars);
}
