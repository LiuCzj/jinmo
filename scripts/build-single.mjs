/**
 * 把 dist-single/ 的构建产物内联成单个 HTML，供直接双击打开或分发给他人。
 *
 * 输入是 `vite build --config vite.config.single.ts` 的产物：只有一个 JS 和一个 CSS。
 * 逐个读取 index.html 里声明的资源并按声明位置替换，不再靠「遍历目录碰运气」——
 * 后者在 assets 里出现第二个 JS 时会静默内联错文件，页面白屏且不报错。
 *
 * 用法：npm run build:single
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIST = 'dist-single';
const OUT = join('dist', 'markdown-editor.html');

let html = readFileSync(join(DIST, 'index.html'), 'utf8');
/** 相对产物路径 → 磁盘绝对路径 */
const toAbs = (p) => resolve(DIST, p.replace(/^\.\//, ''));
const inlined = [];
// 内联前先记下 index.html 声明了哪些相对资源；内联后要逐个核对，漏一个就会白屏
const declared = [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map((m) => m[1]);

html = html.replace(
  /<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g,
  (tag, href) => {
    const file = toAbs(href);
    if (!existsSync(file)) return tag;
    inlined.push(href);
    return `<style>\n${readFileSync(file, 'utf8')}\n</style>`;
  },
);

html = html.replace(/<script[^>]*src="([^"]+)"[^>]*><\/script>/g, (tag, src) => {
  const file = toAbs(src);
  if (!existsSync(file)) return tag;
  inlined.push(src);
  // 内联脚本里出现 `</script` 会提前闭合标签
  const safe = readFileSync(file, 'utf8').replace(/<\/script/gi, '<\\/script');
  return `<script type="module">\n${safe}\n</script>`;
});

// 兜底：声明过但没被内联的资源会让产物白屏，直接失败而不是默默生成
const missing = declared.filter((p) => !inlined.includes(p));
if (missing.length) {
  console.error('内联未完成，以下资源仍指向外部文件：\n' + missing.join('\n'));
  process.exit(1);
}
if (declared.length === 0) {
  console.error(`${DIST}/index.html 里没有声明任何相对资源，产物异常。`);
  process.exit(1);
}

writeFileSync(OUT, html, 'utf8');
console.log(`已内联：${inlined.join('、')}`);
console.log(`已生成 ${OUT}（${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB）`);
