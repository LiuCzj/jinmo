import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * Vite 配置。
 *
 * 别名 `@` → `src`：交接包里的源码一律用 `@/lib/...` 引用，
 * 保持别名一致才能零改动移植。
 */
export default defineConfig({
  // 相对路径产物：构建完直接双击 dist/index.html 也能打开，不必起服务器
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
  },
});
