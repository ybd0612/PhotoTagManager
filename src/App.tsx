import { useEffect } from 'react';
import { createTheme, CssBaseline, ThemeProvider } from '@mui/material';
import { getApi } from './api';
import { startScan, useScanSubscriptions } from './hooks/useScan';
import { useAppStore } from './store/useAppStore';
import { AppLayout } from './components/AppLayout';

/** 现代化浅色主题（MUI 负责交互组件与主题，Tailwind 负责布局间距） */
const theme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: '#4f46e5',
      light: '#818cf8',
      dark: '#4338ca'
    },
    secondary: {
      main: '#0ea5e9'
    },
    background: {
      default: '#f8fafc',
      paper: '#ffffff'
    }
  },
  shape: {
    borderRadius: 10
  },
  typography: {
    fontFamily: [
      'Segoe UI',
      'Microsoft YaHei',
      '-apple-system',
      'BlinkMacSystemFont',
      'Helvetica Neue',
      'Arial',
      'sans-serif'
    ].join(',')
  },
  components: {
    MuiButton: {
      defaultProps: {
        disableElevation: true
      }
    },
    MuiPaper: {
      defaultProps: {
        elevation: 0
      }
    }
  }
});

export default function App(): JSX.Element {
  // 全局订阅扫描事件（progress/done/error）——唯一订阅者
  useScanSubscriptions();

  // 启动加载持久化根列表（R10：多根 + 别名）；选中第一个根并**自动扫描**（其余根懒扫描，点击才扫）
  useEffect(() => {
    let cancelled = false;
    void getApi()
      .listRoots()
      .then((result) => {
        if (cancelled || !result.ok) return;
        const roots = result.data;
        useAppStore.getState().setRoots(roots);
        if (roots.length > 0) {
          useAppStore.getState().selectRoot(roots[0].id);
          void startScan(roots[0]);
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
    </ThemeProvider>
  );
}
