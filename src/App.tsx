import { useEffect } from 'react';
import { createTheme, CssBaseline, ThemeProvider } from '@mui/material';
import { applyCssTokens, tokens } from './theme/tokens';
import { getApi } from './api';
import { autoScanAllRoots, useScanSubscriptions } from './hooks/useScan';
import { useAppStore } from './store/useAppStore';
import { AppLayout } from './components/AppLayout';
import { WindowControls } from './components/WindowControls';

// 必须在首次渲染前注入：手写 CSS 与 Tailwind 类靠这批变量取色，晚一步第一帧就没有值
applyCssTokens();

const { ink, surface, accent, radius, font, shadow, motion } = tokens;

/**
 * 现代化浅色主题（MUI 负责交互组件与主题，Tailwind 负责布局间距）。
 * 所有色值、圆角、字号、动效都取自 src/theme/tokens.ts —— 这里不许再出现字面量。
 */
const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: accent.main, light: accent.light, dark: accent.dark, soft: accent.soft, contrastText: accent.onColor },
    secondary: { main: '#0ea5e9' },
    background: { default: surface.canvas, paper: surface.paper },
    text: { primary: ink.primary, secondary: ink.secondary, disabled: ink.tertiary },
    divider: ink.hairline
  },
  shape: { borderRadius: radius.md },
  typography: {
    fontFamily: [
      'Segoe UI Variable Text',
      'Segoe UI',
      'Microsoft YaHei',
      '-apple-system',
      'BlinkMacSystemFont',
      'Helvetica Neue',
      'Arial',
      'sans-serif'
    ].join(','),
    // 正文 13 而不是 MUI 默认的 16：信息密集型工具里，字号收一档比换字体更像"设计过"
    fontSize: font.body,
    h6: { fontSize: font.title, fontWeight: 600, letterSpacing: '-0.012em' },
    subtitle1: { fontSize: font.subtitle, fontWeight: 600 },
    subtitle2: { fontSize: font.body, fontWeight: 600, letterSpacing: '0.006em' },
    body1: { fontSize: font.subtitle },
    body2: { fontSize: font.body },
    caption: { fontSize: font.caption, letterSpacing: '0.006em' }
  },
  transitions: {
    easing: { easeOut: motion.ease, easeInOut: motion.ease },
    duration: { short: motion.fast, standard: motion.base }
  },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        // 中文按钮全大写没有意义，以前是每个组件各写一遍 textTransform，现在收到主题里
        root: { textTransform: 'none', fontWeight: 500, letterSpacing: '0.01em' }
      }
    },
    MuiPaper: { defaultProps: { elevation: 0 } },
    MuiChip: { styleOverrides: { root: { borderRadius: radius.sm, fontWeight: 500 } } },
    MuiTooltip: {
      styleOverrides: {
        tooltip: { borderRadius: radius.sm, fontSize: font.caption, padding: `${tokens.space.s2}px ${tokens.space.s3}px`, backgroundColor: 'rgba(28, 32, 39, 0.94)', boxShadow: shadow.pop },
        arrow: { color: 'rgba(28, 32, 39, 0.94)' }
      }
    },
    MuiDialog: { styleOverrides: { paper: { borderRadius: radius.lg, boxShadow: shadow.pop } } },
    MuiMenu: { styleOverrides: { paper: { borderRadius: radius.md, boxShadow: shadow.pop } } },
    MuiOutlinedInput: { styleOverrides: { root: { borderRadius: radius.sm, backgroundColor: surface.paper } } }
  }
});

export default function App(): JSX.Element {
  // 全局订阅扫描事件（progress/done/error）——唯一订阅者
  useScanSubscriptions();

  // 启动加载持久化根列表（R10）；选中第一个根并自动扫描全部根（优先选中根，其余串行后台扫）
  useEffect(() => {
    let cancelled = false;
    // 视图偏好与根列表互不依赖：偏好读不到只影响默认排序/档位，不该挡住根加载
    void useAppStore.getState().loadUiPrefs();
    void getApi()
      .listRoots()
      .then((result) => {
        if (cancelled || !result.ok) return;
        const roots = result.data;
        useAppStore.getState().setRoots(roots);
        if (roots.length > 0) {
          useAppStore.getState().selectRoot(roots[0].id);
          void autoScanAllRoots(roots);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AppLayout />
      {/* 窗口级 chrome：不进三栏布局，挂在根上。z-index 见 index.css 的 .ptm-window-controls */}
      <WindowControls />
    </ThemeProvider>
  );
}
