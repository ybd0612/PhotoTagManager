import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * electron-vite 三端构建配置。
 * - main: 主进程入口 + 三个额外入口
 *     scanWorker（worker_threads）      → out/main/scanWorker.js
 *     aiChild（utilityProcess 推理子进程）→ out/main/aiChild.js
 *     crashHarness（崩溃探针复用生产 runner；已在 build.files 里排除，不进产品包）
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
          scanWorker: resolve(__dirname, 'electron/services/scanWorker.ts'),
          aiChild: resolve(__dirname, 'electron/ai/inferenceChild.ts'),
          crashHarness: resolve(__dirname, 'electron/ai/crashHarness.ts')
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
