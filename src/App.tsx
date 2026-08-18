import { createTheme, CssBaseline, ThemeProvider } from '@mui/material';
import { useScanSubscriptions } from './hooks/useScan';
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

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AppLayout />
    </ThemeProvider>
  );
}
