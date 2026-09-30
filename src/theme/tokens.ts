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
  /** 唯一一条分隔线。比原来的 #e2e8f0 更淡且带透明度，浅底深底都能用 */
  hairline: 'rgba(28, 32, 39, 0.09)'
};

const surface = {
  /** 画布：右栏网格的底 */
  canvas: '#f6f7f9',
  /** 纸张：卡片、对话框、菜单 */
  paper: '#ffffff',
  /** 次级面：输入框、chip、缩略图占位 */
  muted: '#f1f3f6',
  /** 工具带：顶栏 / 筛选栏 / 左栏 / 状态栏，比画布再深一档，靠色调分区 */
  chrome: '#eceef2',
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
  scrim: 'rgba(9, 12, 20, 0.72)',
  chip: 'rgba(2, 6, 23, 0.62)',
  /** 图片上压字用的渐变终点：比 chip 深得多，白文件名才读得清 */
  captionScrim: 'rgba(9, 12, 20, 0.82)',
  surfaceFaint: 'rgba(255, 255, 255, 0.05)',
  surface: 'rgba(255, 255, 255, 0.08)',
  surfaceStrong: 'rgba(255, 255, 255, 0.14)',
  hairline: 'rgba(255, 255, 255, 0.12)',
  textStrong: 'rgba(255, 255, 255, 0.88)',
  textMid: 'rgba(255, 255, 255, 0.72)',
  textDim: 'rgba(255, 255, 255, 0.55)',
  fieldBorder: 'rgba(255, 255, 255, 0.35)',
  focus: '#818cf8'
};

const radius = { sm: 8, md: 12, lg: 16, pill: 999 };

/** 8pt 刻度：间距只允许这六档，杜绝 py-1 这种随手值 */
const space = { s1: 4, s2: 8, s3: 12, s4: 16, s5: 24, s6: 32 };

/** 字号四档。正文从 MUI 默认的 16/14 收到 13，是"精致一点"最明显的一刀 */
const font = { caption: 12, body: 13, subtitle: 15, title: 22 };

/** 阴影两档：静止态几乎看不见，只在悬停与浮层上出现 */
const shadow = {
  raised: '0 1px 2px rgba(16, 24, 40, 0.04), 0 1px 3px rgba(16, 24, 40, 0.06)',
  pop: '0 6px 16px rgba(16, 24, 40, 0.10), 0 2px 6px rgba(16, 24, 40, 0.06)'
};

const motion = {
  fast: 120,
  base: 180,
  /** 与左栏折叠同一条曲线：全站一处改，动效气质才不会分叉 */
  ease: 'cubic-bezier(0.2, 0, 0, 1)'
};

export const tokens = { ink, surface, accent, status, overlay, radius, space, font, shadow, motion };

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
  '--ptm-shadow-raised': shadow.raised,
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
