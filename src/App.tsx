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
        // 中文按钮全大写没有意义，以前是每个组件各写一遍 textTransform，现在收到主题里。
        // 按钮比容器小一档，显式给 sm 而不是吃 shape 的 md
        root: { textTransform: 'none', fontWeight: 500, letterSpacing: '0.01em', borderRadius: radius.sm }
      }
    },
    MuiPaper: { defaultProps: { elevation: 0 } },
    MuiChip: {
      styleOverrides: {
        root: { borderRadius: radius.sm, fontWeight: 500 },
        // 胶囊里的字实测比框中心低 0.5~1.5px：行盒本身是居中的，偏移来自字体 ascent/descent 不对称
        // （12.07px 字号下 asc 13 / desc 3），而 CSS 只按行盒对齐、管不到墨迹。上移 1px 后残差 ≤0.5px。
        label: { transform: 'translateY(-1px)' }
      }
    },
    // 切换钮（排序、缩略图档位）是可点控件，跟按钮同档，不吃容器的 md
    MuiToggleButton: { styleOverrides: { root: { borderRadius: radius.sm } } },
    MuiTooltip: {
      styleOverrides: {
        tooltip: { borderRadius: radius.sm, fontSize: font.caption, padding: `${tokens.space.s2}px ${tokens.space.s3}px`, backgroundColor: 'rgba(28, 32, 39, 0.94)', boxShadow: shadow.pop },
        arrow: { color: 'rgba(28, 32, 39, 0.94)' }
      }
    },
    MuiDialog: { styleOverrides: { paper: { borderRadius: radius.lg, boxShadow: shadow.pop } } },
    MuiMenu: { styleOverrides: { paper: { borderRadius: radius.md, boxShadow: shadow.pop } } },
    // 输入框字号只有一个来源：吃 caption 那一档（12px），与同行控件实测 12.07px、组标签 12px 同量级。
    // MUI 默认让输入框吃 body1（本项目 15px），而搜索框当年被单独压到 13px——同一行里输入框大一档，
    // 用户报"只要是个输入框都偏大"。盒高靠 input 上下内边距落到 ~29px，与按钮（27~29px）齐平。
    MuiInputBase: {
      styleOverrides: {
        root: { fontSize: font.caption },
        input: { fontSize: 'inherit', paddingTop: 5, paddingBottom: 5 }
      }
    },
    // 填充色不写死：写死成 paper 后，控件坐在有色带子上时圆角外会露出一圈带子色
    MuiOutlinedInput: { styleOverrides: { root: { borderRadius: radius.sm, backgroundColor: 'transparent' } } }
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
