import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Vitest 配置：默认 node 环境（服务层/worker 单测），
 * app.test.tsx 通过文件头 `// @vitest-environment jsdom` 切换到 jsdom。
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    globals: true,
    css: false
  }
});
