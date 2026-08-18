/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 与 MUI 主题色对齐的语义色（Tailwind 只管布局/间距，交互色交给 MUI）
        primary: {
          DEFAULT: '#4f46e5',
          light: '#818cf8'
        }
      }
    }
  },
  plugins: [],
  // 关闭 preflight，避免与 MUI CssBaseline 冲突
  corePlugins: {
    preflight: false
  }
};
