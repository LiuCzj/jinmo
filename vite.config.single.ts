import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config';

/**
 * 单文件分发用构建配置（产出 dist-single/，再由 scripts/build-single.mjs 内联成一个 HTML）。
 *
 * 在基础配置之上改两处，让产物能塞进单个 HTML：
 *  - `inlineDynamicImports`：把动态 import 的 chunk 合并进入口，产物只剩一个 JS。
 *    Mermaid / MathJax 的按需加载会因此失效 —— 单文件形态的必然取舍。
 *  - `assetsInlineLimit` 拉满：把 `?url` 引用的静态资源（MathJax 的 tex-svg.js）转成 data URI，
 *    否则内联后仍会去 `./assets/` 取文件，而单文件旁边没有 assets 目录。
 *
 * 网页版与桌面版走 `vite.config.ts`（正常分包，保留按需加载）。
 */
export default mergeConfig(
  base,
  defineConfig({
    build: {
      outDir: 'dist-single',
      emptyOutDir: true,
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  }),
);
