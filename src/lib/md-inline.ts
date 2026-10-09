/**
 * 行内 Markdown 解析与行类型判定。
 *
 * 纯函数、零依赖。不做块级解析。
 */

/** 一个可见片段及其在源码中的位置 */
export interface InlineSeg {
  /** 渲染后可见的文字 */
  text: string;
  /** text[0] 在源码行内的下标 */
  srcStart: number;
  /** 含标记符在内的完整源码范围起点（左闭） */
  rawStart: number;
  /** 含标记符在内的完整源码范围终点（右开） */
  rawEnd: number;
  /** 样式种类 */
  kind:
    | 'plain'
    | 'strong'
    | 'em'
    | 'code'
    | 'del'
    | 'link'
    | 'url'
    | 'math'
    | 'strongem'
    | 'fnref'
    | 'task'
    | 'html'
    | 'htmlvoid'
    | 'hl';
  /** kind 为 link 时的地址 */
  href?: string;
  /** kind 为 task 时是否已勾选 */
  checked?: boolean;
  /** kind 为 html / htmlvoid 时的标签名 */
  htmlTag?: string;
}

/** 允许渲染的行内 HTML 标签白名单；不在表内的当普通文本，避免注入 */
const HTML_TAGS = [
  'u',
  'sub',
  'sup',
  'kbd',
  'mark',
  'b',
  'i',
  'em',
  'strong',
  's',
  'del',
  'ins',
  'small',
  'abbr',
  'cite',
  'q',
  'var',
  'samp',
];

/** 允许渲染的单个标签（无内容），如 `<br>` */
const HTML_VOID = ['br'];

/**
 * 把一行源码切成可见片段。
 *
 * 无标记的片段满足 `rawStart === srcStart` 且 `rawEnd === srcStart + text.length`。
 *
 * @param src 一行源码，不含换行符
 * @param defs 引用式链接的定义表（id 小写 → 地址），来自全文的 `[id]: url` 行
 * @returns 可见片段；空行返回空数组
 */
export function parseInline(src: string, defs?: Record<string, string>): InlineSeg[] {
  const segs: InlineSeg[] = [];
  let buf = '';
  let bufSrcStart = 0;
  let i = 0;

  const flush = () => {
    if (buf) {
      segs.push({
        text: buf,
        srcStart: bufSrcStart,
        rawStart: bufSrcStart,
        rawEnd: bufSrcStart + buf.length,
        kind: 'plain',
      });
      buf = '';
    }
  };

  while (i < src.length) {
    // 行内代码。优先级最高，内部不再识别其他标记
    if (src[i] === '`') {
      const end = src.indexOf('`', i + 1);
      if (end !== -1) {
        flush();
        segs.push({ text: src.slice(i + 1, end), srcStart: i + 1, rawStart: i, rawEnd: end + 1, kind: 'code' });
        i = end + 1;
        continue;
      }
    }

    // 转义 `\*` 之类。反斜杠占一列但不产生可见字符，映射指向被转义的那个字符
    if (src[i] === '\\' && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!>~$|]/.test(src[i + 1])) {
      flush();
      segs.push({ text: src[i + 1], srcStart: i + 1, rawStart: i, rawEnd: i + 2, kind: 'plain' });
      i += 2;
      continue;
    }

    // 脚注引用 [^id]
    if (src[i] === '[' && src[i + 1] === '^') {
      const end = src.indexOf(']', i + 2);
      if (end !== -1) {
        flush();
        segs.push({
          text: src.slice(i + 2, end),
          srcStart: i + 2,
          rawStart: i,
          rawEnd: end + 1,
          kind: 'fnref',
        });
        i = end + 1;
        continue;
      }
    }

    // 行内 HTML。只渲染白名单里的标签，其余当普通文本（不做注入）
    if (src[i] === '<') {
      const open = /^<([a-zA-Z][a-zA-Z0-9]*)(?:\s[^>]*)?>/.exec(src.slice(i));
      if (open && HTML_TAGS.includes(open[1].toLowerCase())) {
        const tag = open[1].toLowerCase();
        const innerStart = i + open[0].length;
        const close = src.indexOf(`</${tag}>`, innerStart);
        if (close !== -1) {
          flush();
          segs.push({
            text: src.slice(innerStart, close),
            srcStart: innerStart,
            rawStart: i,
            rawEnd: close + tag.length + 3,
            kind: 'html',
            htmlTag: tag,
          });
          i = close + tag.length + 3;
          continue;
        }
      }
      const voidTag = /^<([a-zA-Z][a-zA-Z0-9]*)\s*\/?>/.exec(src.slice(i));
      if (voidTag && HTML_VOID.includes(voidTag[1].toLowerCase())) {
        flush();
        segs.push({
          text: voidTag[0],
          srcStart: i,
          rawStart: i,
          rawEnd: i + voidTag[0].length,
          kind: 'htmlvoid',
          htmlTag: voidTag[1].toLowerCase(),
        });
        i += voidTag[0].length;
        continue;
      }
    }

    // 行内公式 $...$。规则接近 Pandoc：
    // 开 $ 后不能是空白；闭 $ 前不能是空白、前一字符不能是反斜杠、后不能紧跟数字（`$2` 保持文本）
    if (src[i] === '$' && src[i + 1] !== undefined && src[i + 1] !== '$' && !/\s/.test(src[i + 1])) {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '$' && src[j - 1] !== '\\' && !/\s/.test(src[j - 1])) {
          const after = src[j + 1];
          if (after === undefined || !/\d/.test(after)) break;
        }
        j++;
      }
      if (j < src.length) {
        flush();
        segs.push({
          text: src.slice(i + 1, j),
          srcStart: i + 1,
          rawStart: i,
          rawEnd: j + 1,
          kind: 'math',
        });
        i = j + 1;
        continue;
      }
    }

    // 图片 ![alt](url) 与链接 [text](url)
    const isImg = src[i] === '!' && src[i + 1] === '[';
    if (isImg || src[i] === '[') {
      const open = isImg ? i + 1 : i;
      const close = src.indexOf(']', open + 1);
      if (close !== -1 && src[close + 1] === '(') {
        const paren = src.indexOf(')', close + 2);
        if (paren !== -1) {
          flush();
          const label = src.slice(open + 1, close);
          const href = src.slice(close + 2, paren);
          if (isImg) {
            // 图片渲染为占位符。\uFE0F 是变体选择符，缺失时 Windows 会按单色字体渲染成锯齿方框
            segs.push({
              text: '🖼️ ' + (label || href),
              srcStart: i,
              rawStart: i,
              rawEnd: paren + 1,
              kind: 'link',
              href,
            });
          } else {
            segs.push({
              text: label,
              srcStart: open + 1,
              rawStart: open,
              rawEnd: paren + 1,
              kind: 'link',
              href,
            });
          }
          i = paren + 1;
          continue;
        }
      }

      // 引用式链接 [文字][id]；id 留空时用文字本身当 id
      if (!isImg && close !== -1 && src[close + 1] === '[') {
        const refEnd = src.indexOf(']', close + 2);
        if (refEnd !== -1) {
          const label = src.slice(open + 1, close);
          const id = src.slice(close + 2, refEnd).trim() || label;
          const href = defs?.[id.toLowerCase()];
          if (href !== undefined) {
            flush();
            segs.push({
              text: label,
              srcStart: open + 1,
              rawStart: open,
              rawEnd: refEnd + 1,
              kind: 'link',
              href,
            });
            i = refEnd + 1;
            continue;
          }
        }
      }
    }

    // 粗斜体 ***x***。必须先于 ** 匹配，否则会被拆成 `**` + `*x*`
    if (src.startsWith('***', i)) {
      const end = src.indexOf('***', i + 3);
      if (end !== -1) {
        flush();
        segs.push({
          text: src.slice(i + 3, end),
          srcStart: i + 3,
          rawStart: i,
          rawEnd: end + 3,
          kind: 'strongem',
        });
        i = end + 3;
        continue;
      }
    }

    // 文本高亮 ==x==（扩展语法）
    if (src.startsWith('==', i)) {
      const end = src.indexOf('==', i + 2);
      if (end !== -1) {
        flush();
        segs.push({
          text: src.slice(i + 2, end),
          srcStart: i + 2,
          rawStart: i,
          rawEnd: end + 2,
          kind: 'hl',
        });
        i = end + 2;
        continue;
      }
    }

    // 加粗与删除线。两字符标记必须先于单字符标记匹配
    const pair = src.startsWith('**', i) ? '**' : src.startsWith('~~', i) ? '~~' : null;
    if (pair) {
      const end = src.indexOf(pair, i + 2);
      if (end !== -1) {
        flush();
        segs.push({
          text: src.slice(i + 2, end),
          srcStart: i + 2,
          rawStart: i,
          rawEnd: end + 2,
          kind: pair === '**' ? 'strong' : 'del',
        });
        i = end + 2;
        continue;
      }
    }

    // 斜体
    if (src[i] === '*' || src[i] === '_') {
      const mark = src[i];
      const end = src.indexOf(mark, i + 1);
      if (end !== -1 && end > i + 1) {
        flush();
        segs.push({ text: src.slice(i + 1, end), srcStart: i + 1, rawStart: i, rawEnd: end + 1, kind: 'em' });
        i = end + 1;
        continue;
      }
    }

    // 裸 URL
    if (src.startsWith('http://', i) || src.startsWith('https://', i)) {
      let j = i;
      while (j < src.length && !/\s/.test(src[j])) j++;
      flush();
      segs.push({ text: src.slice(i, j), srcStart: i, rawStart: i, rawEnd: j, kind: 'url' });
      i = j;
      continue;
    }

    if (buf === '') bufSrcStart = i;
    buf += src[i];
    i++;
  }

  flush();
  return segs;
}

/**
 * 计算每个 DOM 可见字符对应的源码列号。
 *
 * 返回数组与「所有节点文本按顺序拼接」逐字符一一对应，无法对齐的位置为 -1。
 *
 * 必须按片段消费游标推进，不能按文本长度累加列号：标记符渲染后不显示，
 * 累加会让带格式的行整体错位。
 *
 * @param segs 行内片段，srcStart 为行内列号
 * @param prefixRendered 行前缀是否已渲染为独立的文本节点
 * @param nodes DOM 文本节点，按出现顺序
 * @returns 逐字符的源码列号
 */
export function charColsForLine(
  segs: InlineSeg[],
  prefixRendered: boolean,
  nodes: { text: string; decorative: boolean }[],
): number[] {
  const cols: number[] = [];
  let prefixDone = !prefixRendered;
  let segIdx = 0;
  let offInSeg = 0;

  const advanceSeg = () => {
    while (segIdx < segs.length && offInSeg >= segs[segIdx].text.length) {
      segIdx++;
      offInSeg = 0;
    }
  };

  for (const node of nodes) {
    if (node.decorative) {
      for (let k = 0; k < node.text.length; k++) cols.push(-1);
      continue;
    }
    if (!prefixDone) {
      for (let k = 0; k < node.text.length; k++) cols.push(k);
      prefixDone = true;
      continue;
    }
    for (let k = 0; k < node.text.length; k++) {
      advanceSeg();
      const seg = segs[segIdx];
      if (!seg) {
        cols.push(-1);
        continue;
      }
      const isImageSeg = seg.kind === 'link' && seg.text.startsWith('🖼');
      cols.push(seg.srcStart + (isImageSeg ? 0 : offInSeg));
      offInSeg++;
    }
  }
  return cols;
}

/** 列表行前缀 */
export interface ListPrefix {
  /** 前导空白 */
  indent: string;
  /** 完整前缀，如 `- ` */
  prefix: string;
  /** 前缀长度，即内容起始列 */
  len: number;
  ordered: boolean;
  /** 有序列表的序号文本 */
  marker?: string;
  /** 续写下一项使用的前缀，有序列表序号自增 */
  nextPrefix: string;
}

/**
 * 解析列表行前缀。
 *
 * @param line 一行源码
 * @returns 非列表行返回 null
 */
export function listPrefixOf(line: string): ListPrefix | null {
  const m = /^(\s*)([-*+]|\d+[.)])(\s+)/.exec(line);
  if (!m) return null;
  const indent = m[1];
  const sym = m[2];
  const gap = m[3];
  const ordered = /^\d/.test(sym);
  const marker = ordered ? sym.replace(/[.)]$/, '') : undefined;
  const nextSym = ordered ? `${Number(marker) + 1}${sym.slice(-1)}` : sym;
  return {
    indent,
    prefix: m[0],
    len: m[0].length,
    ordered,
    marker,
    nextPrefix: indent + nextSym + gap,
  };
}

/** 行的块类型 */
export interface LineKind {
  type:
    | 'h1'
    | 'h2'
    | 'h3'
    | 'h4'
    | 'h5'
    | 'h6'
    | 'quote'
    | 'ul'
    | 'ol'
    | 'hr'
    | 'fence'
    | 'code'
    | 'blank'
    | 'p'
    /** 表格行。classifyLine 不产出，由上层按上下文标记 */
    | 'tableHead'
    | 'tableSep'
    | 'tableBody';
  /** 前缀占用的源码长度，如 `## ` 为 3 */
  prefixLen: number;
  /** 有序列表的序号文本 */
  marker?: string;
}

/**
 * 判定一行的块类型与前缀长度。
 *
 * @param line 一行源码
 * @param fence 当前所处围栏的标记（如 ``` 或 ````）；不在围栏内传 null
 * @returns 块类型与前缀长度
 */
export function classifyLine(line: string, fence: string | null): LineKind {
  // 围栏行必须最先判：闭围栏也得认出来，否则调用方的状态永远翻不回去，
  // 代码块之后的整篇正文都会被误判成代码
  const fm = /^\s*(`{3,}|~{3,})/.exec(line);
  if (fm) {
    // CommonMark：N 个反引号的围栏只能被 ≥N 个同种标记闭合，否则它是内容（四反引号里能放三反引号）
    if (fence === null || (fm[1][0] === fence[0] && fm[1].length >= fence.length)) {
      return { type: 'fence', prefixLen: fm[0].length };
    }
  }
  if (fence !== null) return { type: 'code', prefixLen: 0 };
  if (line.trim() === '') return { type: 'blank', prefixLen: 0 };

  let m: RegExpExecArray | null;
  if ((m = /^(#{1,6})\s+/.exec(line))) {
    const lv = m[1].length;
    const key = ('h' + lv) as LineKind['type'];
    return { type: key, prefixLen: m[0].length };
  }
  if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return { type: 'hr', prefixLen: line.length };
  if ((m = /^(\s*)>\s?/.exec(line))) return { type: 'quote', prefixLen: m[0].length };
  const lp = listPrefixOf(line);
  if (lp) return { type: lp.ordered ? 'ol' : 'ul', prefixLen: lp.len, marker: lp.marker };
  return { type: 'p', prefixLen: 0 };
}

/**
 * 把光标所在的行内元素替换为源码原文，其余片段不变。
 *
 * 结果形如「开标记 + 原内容（保留样式） + 闭标记」。图片的可见文本与源码不逐字对应，
 * 整段按源码原文渲染。
 *
 * @param segs 整行的片段，各下标均为行内列号
 * @param src 整行源码
 * @param col 光标在行内的列号
 * @returns 替换后的片段；光标不在任何带标记的元素内时原样返回
 */
export function revealSegAt(segs: InlineSeg[], src: string, col: number): InlineSeg[] {
  const idx = segs.findIndex((s) => col >= s.rawStart && col <= s.rawEnd);
  if (idx === -1) return segs;
  const s = segs[idx];

  /*
   * 任务片段（`[ ] ` / `[x] `）必须先处理，且**必须排在下面那句提前 return 之前**。
   *
   * 它的可见文本就是源码本身（rawStart === srcStart、rawEnd === srcStart + text.length），
   * 正好满足「可见文本与源码等长 → 无需展开」的条件而被提前打回；
   * 于是光标落上去时 `- [ ] ` 露不出来（任务行在源码模式下看着跟渲染态一样）。
   * 这与图片（`🖼` 占位）同属「可见文本 ≠ 源码」的一类，只是它恰好等长。
   */
  if (s.kind === 'task') {
    const out = [...segs];
    out[idx] = {
      text: src.slice(s.rawStart, s.rawEnd),
      srcStart: s.rawStart,
      rawStart: s.rawStart,
      rawEnd: s.rawEnd,
      kind: 'plain',
    };
    return out;
  }

  if (s.rawStart === s.srcStart && s.rawEnd === s.srcStart + s.text.length) return segs;

  const out = [...segs];
  if (s.kind === 'link' && s.text.startsWith('🖼')) {
    out[idx] = {
      text: src.slice(s.rawStart, s.rawEnd),
      srcStart: s.rawStart,
      rawStart: s.rawStart,
      rawEnd: s.rawEnd,
      kind: 'plain',
    };
    return out;
  }

  const suffixStart = s.srcStart + s.text.length;
  out.splice(
    idx,
    1,
    {
      text: src.slice(s.rawStart, s.srcStart),
      srcStart: s.rawStart,
      rawStart: s.rawStart,
      rawEnd: s.srcStart,
      kind: 'plain',
    },
    s,
    {
      text: src.slice(suffixStart, s.rawEnd),
      srcStart: suffixStart,
      rawStart: suffixStart,
      rawEnd: s.rawEnd,
      kind: 'plain',
    },
  );
  return out;
}
