/**
 * Mermaid 图表渲染。
 *
 * 用动态 import：Vite 会把 Mermaid 切成独立 chunk，只有文档里真的出现图表时才去取 ——
 * 不含图表的文档零成本（与 MathJax 同样思路）。
 */

/** Mermaid 单例，首次用到图表时才加载 */
let ready: Promise<typeof import('mermaid').default> | null = null;
/** 每次渲染用不同的 id，避免多张图互相覆盖 */
let seq = 0;

function loadMermaid(): Promise<typeof import('mermaid').default> {
  ready ??= (async () => {
    const mermaid = (await import('mermaid')).default;
    mermaid.initialize({
      startOnLoad: false,
      // strict：图表里不执行任何 HTML / 脚本，避免注入
      securityLevel: 'strict',
      theme: 'default',
    });
    return mermaid;
  })();
  return ready;
}

/**
 * 把 Mermaid 源码渲染成 SVG。
 *
 * @param source 图表源码，即 ```mermaid 围栏里的内容
 * @returns SVG 字符串；加载失败或语法有错时返回 null
 */
export async function renderMermaid(source: string): Promise<string | null> {
  try {
    const mermaid = await loadMermaid();
    seq += 1;
    const { svg } = await mermaid.render(`jinmo-diagram-${seq}`, source);
    return svg;
  } catch (err) {
    console.error('Mermaid 渲染失败', err);
    return null;
  }
}
