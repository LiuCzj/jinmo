/**
 * 数学公式渲染，用 MathJax（与 Typora 同一个引擎）。
 *
 * 加载的是 MathJax 官方为浏览器准备的自包含包 `es5/tex-svg.js`：
 * 它加载完会把 `window.MathJax` 装好，不需要构建工具做模块转换
 * （`js/` 目录是 CommonJS 且内部用了 `eval('__dirname')`，浏览器里跑不起来）。
 *
 * 该包用 `?url` 当静态资源引入，首次需要公式时才插 `<script>` 去取 ——
 * 不含公式的文档零成本。输出 SVG，不需要额外字体文件。
 */

// Vite 会把带 `?url` 的引用当静态资源处理并给出地址；TS 7 对「带后缀的裸包路径」匹配不到
// vite/client 里的 `*?url` 声明，故此处忽略类型检查（构建与运行都正常）。
// @ts-ignore
import mathjaxUrl from 'mathjax-full/es5/tex-svg.js?url';

/** MathJax 挂到 window 上的最小接口 */
interface MathJaxGlobal {
  tex2svg(tex: string, options: { display: boolean }): unknown;
  startup: { promise: Promise<unknown>; adaptor: { outerHTML(node: unknown): string } };
}

declare global {
  interface Window {
    /** MathJax 加载完会自己挂上来；具体类型在用到时断言 */
    MathJax?: unknown;
  }
}

let ready: Promise<MathJaxGlobal> | null = null;

function loadMathJax(): Promise<MathJaxGlobal> {
  ready ??= new Promise((resolve, reject) => {
    // 不要让它自动排版整个页面，我们只调 tex2svg
    const prev = (window.MathJax ?? {}) as Record<string, unknown>;
    window.MathJax = { ...prev, startup: { typeset: false } };
    const script = document.createElement('script');
    script.src = mathjaxUrl;
    script.onload = () => {
      const mj = window.MathJax as MathJaxGlobal | undefined;
      if (!mj?.tex2svg) return reject(new Error('MathJax 未挂到 window'));
      Promise.resolve(mj.startup.promise).then(() => resolve(mj), reject);
    };
    script.onerror = () => reject(new Error('MathJax 脚本加载失败'));
    document.head.appendChild(script);
  });
  return ready;
}

/**
 * 把 TeX 渲染成 HTML 片段。
 *
 * @param tex TeX 源码
 * @param display 是否块级（独立成行）
 * @returns HTML 字符串；加载失败或公式有语法错误时返回 null
 */
export async function renderMath(tex: string, display: boolean): Promise<string | null> {
  try {
    const mj = await loadMathJax();
    const node = mj.tex2svg(tex, { display });
    return mj.startup.adaptor.outerHTML(node);
  } catch (err) {
    console.error('MathJax 渲染失败', err);
    return null;
  }
}
