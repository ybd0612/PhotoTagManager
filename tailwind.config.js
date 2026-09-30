/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      /**
       * 语义色名。值一律写成 CSS 变量**名字**，真实色值只存在于 src/theme/tokens.ts
       * （它在首次渲染前把这些变量注入 :root）。这里若再抄一遍 hex，就成了第二个事实源，
       * 换色阶时必然出现"改了主题没改 Tailwind"的漂移——此前那份 #4f46e5 就是这么留下来的。
       */
      colors: {
        primary: { DEFAULT: 'var(--ptm-accent)', light: 'var(--ptm-accent-light)', dark: 'var(--ptm-accent-dark)' },
        accent: 'var(--ptm-accent)',
        canvas: 'var(--ptm-canvas)',
        surface: 'var(--ptm-surface)',
        'surface-2': 'var(--ptm-surface-2)',
        chrome: 'var(--ptm-chrome-bg)',
        ink: { DEFAULT: 'var(--ptm-ink)', 2: 'var(--ptm-ink-2)', 3: 'var(--ptm-ink-3)' },
        hairline: 'var(--ptm-hairline)',
        success: 'var(--ptm-success)',
        warning: 'var(--ptm-warning)',
        danger: 'var(--ptm-danger)'
      },
      borderRadius: {
        card: 'var(--ptm-r-md)',
        control: 'var(--ptm-r-sm)',
        sheet: 'var(--ptm-r-lg)'
      },
      boxShadow: {
        pop: 'var(--ptm-shadow-pop)'
      }
    }
  },
  plugins: [],
  // 关闭 preflight，避免与 MUI CssBaseline 冲突
  corePlugins: {
    preflight: false
  }
};
