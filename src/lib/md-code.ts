/**
 * 代码块语法着色。
 *
 * 用 highlight.js 的 **common 子集**（约 35 门常用语言，体积可控）。
 * 旧实现是自己写的词法切分器（只能认注释/字符串/数字/关键字四类，语言覆盖有限）；
 * 换成成熟库后语言覆盖、嵌套结构、转义都由库负责。
 *
 * 输出 HTML，供 `dangerouslySetInnerHTML` 使用。文本由 highlight.js 负责转义，
 * 未知语言走本地转义兜底 —— 两条路都不会把原文当 HTML 解释。
 */
import hljs from 'highlight.js/lib/common';

/** 视为「纯文本、不着色」的语言标记 */
const PLAIN_LANGS = new Set(['', 'text', 'txt', 'plain', 'plaintext', '纯文本', 'none']);

/** HTML 转义（未知语言时的兜底输出） */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 归一化围栏里的语言标记。
 *
 * 围栏里可能带属性（`{.numberLines}`）、大小写混写（`JavaScript`）、别名（`bash` / `shell`）。
 * 别名交给 highlight.js 自己解析，这里只做去空白 + 小写。
 *
 * @param lang 围栏 info string 里的语言词
 * @returns 归一化后的语言名；空串表示没写
 */
export function normalizeLang(lang: string): string {
  return (lang || '').trim().toLowerCase();
}

/**
 * 这门语言能不能着色。
 *
 * @param lang 围栏里的语言词
 * @returns 有对应 highlighter 时 true；空串与纯文本返回 false
 */
export function isLangSupported(lang: string): boolean {
  const id = normalizeLang(lang);
  if (PLAIN_LANGS.has(id)) return false;
  return hljs.getLanguage(id) !== undefined;
}

/**
 * 给一段代码着色，返回 HTML 片段。
 *
 * 按**单行**调用 —— 代码块是逐行渲染的，所以跨行的块注释、多行字符串
 * 会在行边界处被各自解析（旧实现同样有这个限制）。
 *
 * @param code 该行的源码文本
 * @param lang 围栏里的语言词；未知或为空时只做转义、不着色
 * @returns 可直接塞进 `dangerouslySetInnerHTML` 的 HTML
 */
export function highlightCode(code: string, lang: string): string {
  const id = normalizeLang(lang);
  if (PLAIN_LANGS.has(id)) return escapeHtml(code);
  if (!hljs.getLanguage(id)) return escapeHtml(code);
  try {
    // ignoreIllegals：行级片段可能从半个字符串/注释中间开始，语法不完整，
    // 不能让库抛错，否则整行渲染会挂。
    return hljs.highlight(code, { language: id, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}
