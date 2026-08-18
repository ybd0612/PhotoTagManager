import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * electron-vite 三端构建配置。
 * - main: 主进程入口 + scanWorker（worker_threads 额外入口，输出 out/main/scanWorker.js）
 * - preload: 预加载脚本（contextBridge 白名单 API）
 * - renderer: React 渲染进程（Vite + React 插件）
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main.ts'),
          scanWorker: resolve(__dirname, 'electron/services/scanWorker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname),
    server: {
      port: 51783,
      strictPort: true
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html')
        }
      }
    }
  }
});
