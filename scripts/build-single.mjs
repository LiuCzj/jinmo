/**
 * 把 dist/ 的构建产物内联成单个 HTML 文件，供直接双击打开或分发给他人。
 *
 * Vite 默认产出 ES module 与外部 CSS，通过 file:// 打开时 module 脚本会被 CORS 拦掉；
 * 内联进 HTML 后不再产生任何网络请求，双击即可运行。
 *
 * 用法：npm run build && node scripts/build-single.mjs
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';
const ASSETS = join(DIST, 'assets');

let html = readFileSync(join(DIST, 'index.html'), 'utf8');

for (const name of readdirSync(ASSETS)) {
  const body = readFileSync(join(ASSETS, name), 'utf8');
  if (name.endsWith('.css')) {
    // 用函数式替换：替换串里若含 $& / $` 等序列，字符串形式会被当作特殊模式展开
    html = html.replace(/<link[^>]*rel="stylesheet"[^>]*>/, () => `<style>\n${body}\n</style>`);
  } else if (name.endsWith('.js')) {
    // 内联脚本里出现 `</script` 会提前闭合标签
    const safe = body.replace(/<\/script/gi, '<\\/script');
    html = html.replace(
      /<script[^>]*src="[^"]*"[^>]*><\/script>/,
      () => `<script type="module">\n${safe}\n</script>`,
    );
  }
}

const out = join(DIST, 'markdown-editor.html');
writeFileSync(out, html, 'utf8');
console.log(`已生成 ${out}`);
