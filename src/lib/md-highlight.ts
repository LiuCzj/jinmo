/**
 * 源码模式用的 Markdown 着色：把整篇源码转成带 class 的 HTML 片段。
 *
 * 纯函数，零依赖。输出只包含 `<span class="...">` 与已转义的文本，
 * 可与一个透明 textarea 叠放，实现「带高亮的可编辑区」。
 */

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/** HTML 转义 */
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ESCAPES[c]);
}

/** 用 class 包一段文本 */
function span(cls: string, text: string): string {
  return text ? `<span class="${cls}">${esc(text)}</span>` : '';
}

/** 成对标记：开闭标记单独上色，内容另上色 */
const PAIRS: { open: string; close: string; cls: string }[] = [
  { open: '**', close: '**', cls: 'md-hl-strong' },
  { open: '~~', close: '~~', cls: 'md-hl-del' },
  { open: '==', close: '==', cls: 'md-hl-hl' },
  { open: '*', close: '*', cls: 'md-hl-em' },
  { open: '_', close: '_', cls: 'md-hl-em' },
];

/** 给一段普通文本着色（其中的行内标记） */
function inlineHtml(s: string): string {
  let out = '';
  let plain = '';
  let i = 0;

  const flush = () => {
    if (plain) {
      out += esc(plain);
      plain = '';
    }
  };

  while (i < s.length) {
    const rest = s.slice(i);

    if (rest.startsWith('`')) {
      const end = rest.indexOf('`', 1);
      if (end !== -1) {
        flush();
        out += span('md-hl-mark', '`') + span('md-hl-code', rest.slice(1, end)) + span('md-hl-mark', '`');
        i += end + 1;
        continue;
      }
    }

    const isImg = rest.startsWith('![');
    if (isImg || rest.startsWith('[')) {
      const open = isImg ? 2 : 1;
      const close = rest.indexOf(']', open);
      if (close !== -1 && rest[close + 1] === '(') {
        const paren = rest.indexOf(')', close + 2);
        if (paren !== -1) {
          flush();
          out +=
            span('md-hl-mark', rest.slice(0, open)) +
            span(isImg ? 'md-hl-img' : 'md-hl-link', rest.slice(open, close)) +
            span('md-hl-mark', '](') +
            span('md-hl-url', rest.slice(close + 2, paren)) +
            span('md-hl-mark', ')');
          i += paren + 1;
          continue;
        }
      }
    }

    let matched = false;
    for (const p of PAIRS) {
      if (!rest.startsWith(p.open)) continue;
      const end = rest.indexOf(p.close, p.open.length);
      if (end === -1 || end === p.open.length) continue;
      flush();
      out +=
        span('md-hl-mark', p.open) +
        span(p.cls, rest.slice(p.open.length, end)) +
        span('md-hl-mark', p.close);
      i += end + p.close.length;
      matched = true;
      break;
    }
    if (matched) continue;

    if (/^https?:\/\/[^\s]/.test(rest)) {
      let j = 0;
      while (j < rest.length && !/\s/.test(rest[j])) j++;
      flush();
      out += span('md-hl-url', rest.slice(0, j));
      i += j;
      continue;
    }

    plain += s[i];
    i++;
  }

  flush();
  return out;
}

/** 表格行：竖线上色，单元格内容按行内规则着色 */
function tableHtml(line: string): string {
  const parts = line.split('|');
  return parts
    .map((p, k) => (k < parts.length - 1 ? inlineHtml(p) + span('md-hl-mark', '|') : inlineHtml(p)))
    .join('');
}

/** 单行的着色结果 */
function lineHtml(line: string, inFence: boolean): string {
  if (inFence) return span('md-hl-code', line);
  if (/^\s*(```|~~~)/.test(line)) return span('md-hl-fence', line);

  const hm = /^(\s*)(#{1,6})(\s+)(.*)$/.exec(line);
  if (hm) return span('md-hl-mark', hm[1] + hm[2] + hm[3]) + span('md-hl-h', hm[4]);

  const qm = /^(\s*>\s?)(.*)$/.exec(line);
  if (qm) return span('md-hl-mark', qm[1]) + span('md-hl-quote', qm[2]);

  const lm = /^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/.exec(line);
  if (lm) return span('md-hl-mark', lm[1]) + inlineHtml(lm[2]);

  if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return span('md-hl-hr', line);
  if (line.includes('|')) return tableHtml(line);

  return inlineHtml(line);
}

/**
 * 把整篇 Markdown 逐行转成着色后的 HTML。
 *
 * 返回数组而非拼接串：调用方按行渲染成块级元素，行号才能随折行正确对齐。
 *
 * @param src 整篇 Markdown
 * @returns 每行一段 HTML
 */
export function highlightMarkdown(src: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of src.split('\n')) {
    out.push(lineHtml(line, inFence));
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
  }
  return out;
}
