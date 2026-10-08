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
  kind: 'plain' | 'strong' | 'em' | 'code' | 'del' | 'link' | 'url';
  /** kind 为 link 时的地址 */
  href?: string;
}

/**
 * 把一行源码切成可见片段。
 *
 * 无标记的片段满足 `rawStart === srcStart` 且 `rawEnd === srcStart + text.length`。
 *
 * @param src 一行源码，不含换行符
 * @returns 可见片段；空行返回空数组
 */
export function parseInline(src: string): InlineSeg[] {
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
 * @param inFence 该行是否位于代码围栏内部，由调用方按行序维护
 * @returns 块类型与前缀长度
 */
export function classifyLine(line: string, inFence: boolean): LineKind {
  if (inFence) return { type: 'code', prefixLen: 0 };
  if (line.trim() === '') return { type: 'blank', prefixLen: 0 };

  let m: RegExpExecArray | null;
  if ((m = /^(#{1,6})\s+/.exec(line))) {
    const lv = m[1].length;
    const key = ('h' + lv) as LineKind['type'];
    return { type: key, prefixLen: m[0].length };
  }
  if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return { type: 'hr', prefixLen: line.length };
  if (/^\s*```/.test(line)) return { type: 'fence', prefixLen: /^\s*```\w*\s*/.exec(line)?.[0].length ?? 3 };
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
