/**
 * Markdown 编辑命令层。
 *
 * 纯函数：输入文本与光标位置，输出新文本与新光标位置。不改原值，不依赖外部状态。
 */

import { parseFenceOptions } from './code-langs';

/** 一次编辑的结果：改写后的文本 + 光标应该落在哪里 */
export interface EditResult {
  /** 改写后的完整文本 */
  text: string;
  /** 改写后光标应处的位置（相对 text 的绝对下标） */
  caret: number;
  /**
   * 改写后应当保持的选区。只在「多行缩进」这类需要保留原选中范围的命令上出现；
   * 缺省表示按 `caret` 收起选区。
   */
  select?: { start: number; end: number };
}

/** 选区，使用绝对下标 */
export interface Selection {
  start: number;
  /** 等于 start 表示没有选中内容 */
  end: number;
}

/**
 * 取光标所在行的起止下标（行尾不含换行符）。
 * @param text 全文
 * @param pos 光标位置（绝对下标）
 * @returns 该行在 text 中的起止下标
 */
export function lineBoundsAt(text: string, pos: number): { start: number; end: number } {
  // 光标可能停在换行符上，clamp 一下避免越界（textarea 允许 pos === length）
  const p = Math.max(0, Math.min(text.length, pos));
  const start = text.lastIndexOf('\n', p - 1) + 1; // 找不到时返回 -1，+1 正好是 0
  const nl = text.indexOf('\n', p);
  const end = nl === -1 ? text.length : nl;
  return { start, end };
}

/**
 * 取光标所在的整行文本。
 * @param text 全文
 * @param pos 光标位置
 * @returns 行文本（不含换行符）
 */
export function lineAt(text: string, pos: number): string {
  const { start, end } = lineBoundsAt(text, pos);
  return text.slice(start, end);
}

/**
 * 取光标所在的整块：连续的一串非空行（被空行或文件首尾夹住）。
 *
 * @param text 全文
 * @param pos 光标位置
 * @returns 块的起止下标，以及按行切开的数组
 */
export function blockAt(text: string, pos: number): { start: number; end: number; lines: string[] } {
  const { start: lineStart, end: lineEnd } = lineBoundsAt(text, pos);

  // 从当前行往上找，直到遇到空行或文件开头
  let start = lineStart;
  while (start > 0) {
    const prevEnd = start - 1; // 上一行的换行符
    const prevStart = text.lastIndexOf('\n', prevEnd - 1) + 1;
    if (text.slice(prevStart, prevEnd).trim() === '') break;
    start = prevStart;
  }

  // 从当前行往下找，直到遇到空行或文件结尾
  let end = lineEnd;
  while (end < text.length) {
    const nextStart = end + 1;
    const nextNl = text.indexOf('\n', nextStart);
    const nextEnd = nextNl === -1 ? text.length : nextNl;
    if (text.slice(nextStart, nextEnd).trim() === '') break;
    end = nextEnd;
  }

  return { start, end, lines: text.slice(start, end).split('\n') };
}

/** 光标所在行的「Markdown 前缀」：行首的空格缩进 + 一个块级标记（如 `- ` / `> ` / `1. `） */
const LINE_PREFIX_RE = /^(\s*)((?:[-*+]|\d+[.)])\s+|\s*\[[ xX]\]\s+|>\s?|#{1,6}\s+)?/;

/**
 * 取行首的缩进与块级标记（如 `  ` / `- ` / `> ` / `# `）。
 * @param line 整行文本
 * @returns 前缀字符串（可能为空串）与前缀长度
 */
export function linePrefix(line: string): { prefix: string; length: number } {
  const m = LINE_PREFIX_RE.exec(line);
  const prefix = m ? m[0] : '';
  return { prefix, length: prefix.length };
}

/** 输入即转换用的：一条「打这些字符 → 变成那个块级元素」的规则 */
interface AutoFormatRule {
  /** 触发字符序列（行首前缀） */
  trigger: string;
  /** 替换成的 Markdown 前缀 */
  replace: string;
}

/**
 * 输入即转换规则表。
 * 顺序从长到短：`- [ ] ` 必须排在 `- ` 前，否则待办永远触发不了。
 */
const AUTO_FORMAT_RULES: AutoFormatRule[] = [
  // 待办（比无序列表长，必须排前面）
  { trigger: '- [ ] ', replace: '- [ ] ' },
  { trigger: '- [x] ', replace: '- [x] ' },
  { trigger: '* [ ] ', replace: '- [ ] ' },
  // 无序列表统一成 `- `
  { trigger: '- ', replace: '- ' },
  { trigger: '* ', replace: '- ' },
  { trigger: '+ ', replace: '- ' },
  // 有序列表保留原编号符号
  { trigger: '1. ', replace: '1. ' },
  { trigger: '1) ', replace: '1) ' },
  // 引用
  { trigger: '> ', replace: '> ' },
  // 标题（长的排前面：###### 不能被 ##### 抢走）
  { trigger: '###### ', replace: '###### ' },
  { trigger: '##### ', replace: '##### ' },
  { trigger: '#### ', replace: '#### ' },
  { trigger: '### ', replace: '### ' },
  { trigger: '## ', replace: '## ' },
  { trigger: '# ', replace: '# ' },
];

/**
 * 输入即转换：光标前恰好等于某个 trigger 且位于行首时，替换为规范前缀。
 *
 * @param text 全文，已包含刚输入的字符
 * @param caret 光标位置
 * @returns 转换后的文本与光标；未命中规则时返回 null
 */
export function autoFormat(text: string, caret: number): EditResult | null {
  const { start } = lineBoundsAt(text, caret);
  // 光标之前、行首之后的那一段（含行首缩进）
  const before = text.slice(start, caret);

  for (const rule of AUTO_FORMAT_RULES) {
    // ① 触发串之后必须什么都没写
    if (!before.endsWith(rule.trigger)) continue;
    const head = before.slice(0, before.length - rule.trigger.length);

    // ② 触发串之前只能是空白（即它在行首）
    if (head.trim() !== '') continue;

    // 缩进保留（嵌套列表靠它）
    const newBefore = head + rule.replace;
    return {
      text: text.slice(0, start) + newBefore + text.slice(caret),
      caret: start + newBefore.length,
    };
  }

  return null;
}

/**
 * 判断光标所在行是否整行由 `---` / `***` / `___`（三个以上）构成。
 * @param text 全文
 * @param caret 光标位置
 * @returns 是分割线则 true
 */
export function isHorizontalRuleLine(text: string, caret: number): boolean {
  const line = lineAt(text, caret).trim();
  return /^(?:-{3,}|\*{3,}|_{3,})$/.test(line);
}

/**
 * 表格补分隔行：光标所在行含 `|`、且下一行还不是分隔行时，自动补出 `| --- | --- |`。
 * 条件是：含 `|`、列数 ≥ 2、下一行非分隔行、光标在行尾。
 *
 * @param text 全文
 * @param caret 光标位置
 * @returns 需要补时返回新文本与光标位置；否则 null
 */
export function tablePipeNewline(text: string, caret: number): EditResult | null {
  const { start, end } = lineBoundsAt(text, caret);
  const line = text.slice(start, end);

  if (!line.includes('|')) return null;
  if (line.trim() === '' || line.trim() === '|') return null;

  // 下一行已是分隔行则不再补（防连按两次回车补两条）
  const nextStart = end + 1;
  if (nextStart < text.length) {
    const nextNl = text.indexOf('\n', nextStart);
    const nextEnd = nextNl === -1 ? text.length : nextNl;
    const nextLine = text.slice(nextStart, nextEnd).trim();
    if (/^\|?[\s:|-]+\|?$/.test(nextLine) && nextLine.includes('-')) return null;
  }

  // 按未转义的 `|` 切列（`\|` 是转义竖线，不算分隔）
  const cells = line.replace(/\\\|/g, '').split('|');
  const trimmed = cells.slice(cells[0].trim() === '' ? 1 : 0, cells[cells.length - 1].trim() === '' ? -1 : undefined);
  if (trimmed.length < 2) return null;

  const sep = '| ' + trimmed.map(() => '---').join(' | ') + ' |';
  // 光标在行尾才插
  if (caret !== end) return null;

  return { text: text.slice(0, end) + '\n' + sep + text.slice(end), caret: end + 1 + sep.length };
}

/**
 * 用一对标记包裹选区（加粗 / 斜体 / 删除线 / 行内代码 / 高亮）。
 * 无选区时抓光标左边的词；选区内首尾空白留在标记外（`** x **` 渲染不出来）。
 *
 * @param text 全文
 * @param sel 当前选区
 * @param mark 包裹标记，如 `**`
 * @returns 改写后的文本与光标位置（落在收尾标记之后）
 */
export function wrapSelection(text: string, sel: Selection, mark: string): EditResult {
  const { start, end } = sel;
  const selected = text.slice(start, end);

  // ── 情况①：有选区 ──
  if (start !== end) {
    // 把选区内部首尾的空白留在标记外面（`** x **` 不成立，必须是 `**x** `）
    const lead = selected.match(/^\s*/)?.[0] ?? '';
    const tail = selected.match(/\s*$/)?.[0] ?? '';
    const core = selected.slice(lead.length, selected.length - tail.length);

    // 空内容（选中的全是空白）就别包了，包了也是无效语法
    if (core === '') {
      return { text, caret: end };
    }

    const next = text.slice(0, start) + lead + mark + core + mark + tail + text.slice(end);
    // 光标落在收尾标记之后
    return { text: next, caret: start + lead.length + mark.length + core.length + mark.length };
  }

  // ── 情况②：无选区 ──
  // 尝试往左抓一个「词」：连续的、非空白的、非本标记字符的一段
  const left = text.slice(0, start);
  const wordMatch = left.match(/[^\s*_~`=]+$/);
  if (wordMatch) {
    const word = wordMatch[0];
    const wordStart = start - word.length;
    const next = text.slice(0, wordStart) + mark + word + mark + text.slice(start);
    // 光标落在被包裹的词之后
    return { text: next, caret: wordStart + mark.length + word.length + mark.length };
  }

  // 光秃秃地在光标处插一对空标记，光标落中间
  return { text: text.slice(0, start) + mark + mark + text.slice(end), caret: start + mark.length };
}

/**
 * 去掉选区外层的标记，即包裹的逆操作。
 *
 * @param text 全文
 * @param sel 当前选区
 * @param mark 要剥掉的标记
 * @returns 剥离结果；外层没有该标记时返回 null
 */
export function unwrapSelection(text: string, sel: Selection, mark: string): EditResult | null {
  const { start, end } = sel;
  let from = start;
  let to = end;

  // 无选区：光标处当空选区，向外扩一圈看是否刚好被包着
  if (from === to) {
    const before = text.slice(Math.max(0, from - mark.length), from);
    const after = text.slice(to, to + mark.length);
    if (before !== mark || after !== mark) return null;
    from -= mark.length;
    to += mark.length;
  }

  const outerBefore = text.slice(Math.max(0, from - mark.length), from);
  const outerAfter = text.slice(to, to + mark.length);
  if (outerBefore !== mark || outerAfter !== mark) return null;

  const inner = text.slice(from, to);
  const next = text.slice(0, from - mark.length) + inner + text.slice(to + mark.length);
  return { text: next, caret: from - mark.length + inner.length };
}

/**
 * 插入链接 `[文字](url)`。有选区时选中内容当文字、光标选中 url；无选区时选中「文字」二字。
 * @param text 全文
 * @param sel 当前选区
 * @returns 改写后的文本与选区
 */
export function insertLink(text: string, sel: Selection): EditResult & { select?: Selection } {
  const { start, end } = sel;
  const selected = text.slice(start, end).trim();

  if (selected !== '') {
    const inserted = `[${selected}](url)`;
    const next = text.slice(0, start) + inserted + text.slice(end);
    const urlStart = start + selected.length + 3; // `[` + 文字 + `](`
    return { text: next, caret: urlStart, select: { start: urlStart, end: urlStart + 3 } };
  }

  const inserted = '[文字](url)';
  const next = text.slice(0, start) + inserted + text.slice(end);
  return { text: next, caret: start + 1, select: { start: start + 1, end: start + 3 } };
}

/**
 * 插入图片 `![alt](src)`。
 * @param text 全文
 * @param sel 当前选区（选中内容当 alt）
 * @param src 图片地址
 * @returns 改写后的文本与光标位置
 */
export function insertImage(text: string, sel: Selection, src: string): EditResult {
  const alt = text.slice(sel.start, sel.end).trim();
  const inserted = `![${alt}](${src})`;
  return { text: text.slice(0, sel.start) + inserted + text.slice(sel.end), caret: sel.start + inserted.length };
}

/**
 * 给表格块每一行右侧补一列。分隔行补 `---`（补空格会丢列）。
 *
 * @param text 整块源码
 * @returns 补列后的结果；块里没有表格时返回 null
 */
export function tableAddColumn(text: string): { text: string; caret: number } | null {
  const lines = text.split('\n');
  const first = lines[0]?.trim() ?? '';
  const second = lines[1]?.trim() ?? '';
  if (!first.includes('|')) return null;
  if (!/^\|?[\s:|-]+\|?$/.test(second) || !second.includes('-')) return null;

  /**
   * 在行末尾的 `|` 之前插入一个新单元格（`| a | b |` → `| a | b |  |`）。
   * @param line 表格的一行
   * @param filler 新单元格内容
   * @returns 补好列的行
   */
  const pushCell = (line: string, filler: string): string => {
    const t = line.replace(/\s+$/, '');
    if (t.endsWith('|')) {
      const head = t.slice(0, -1).replace(/\s+$/, '');
      return `${head} | ${filler} |`;
    }
    // 没有结尾竖线（如 `a | b`）→ 先补竖线再补单元格
    return `${t} | ${filler} |`;
  };

  const next = lines
    .map((l, i) => {
      if (l.trim() === '') return l;
      if (!l.includes('|') && i !== 0) return l;
      // 第 2 行是分隔行，补 `---`；其余补空格占位
      return pushCell(l, i === 1 ? '---' : '');
    })
    .join('\n');

  return { text: next, caret: next.length };
}

/**
 * 在光标所在行的上方或下方插入一个块（表格、代码块、引用等），不替换原有行。
 * 当前行是空行时直接原地填入。
 *
 * @param text 全文
 * @param caret 光标位置
 * @param snippet 要插入的块内容（可含换行）
 * @param where 'above' 插在上方，'below' 插在下方
 * @returns 改写后的文本与光标位置（落在插入块内部）
 */
export function insertBlock(
  text: string,
  caret: number,
  snippet: string,
  where: 'above' | 'below' = 'below',
): EditResult {
  const { start, end } = lineBoundsAt(text, caret);

  // 当前行为空行时原地填入。空文档里必须走这条：否则会先垫出两个空行，
  // 表格看起来像是被插到了文末而不是光标处。
  if (text.slice(start, end).trim() === '') {
    const next = text.slice(0, start) + snippet + text.slice(end);
    return { text: next, caret: start + snippetInnerOffset(snippet) };
  }

  // 非空行的上下另起一段，中间留一个空行：紧贴上一段时表格会被当成段落的一部分
  if (where === 'above') {
    const next = text.slice(0, start) + snippet + '\n\n' + text.slice(start);
    return { text: next, caret: start + snippetInnerOffset(snippet) };
  }

  const next = text.slice(0, end) + '\n\n' + snippet + text.slice(end);
  return { text: next, caret: end + 2 + snippetInnerOffset(snippet) };
}

/**
 * 算插入块之后光标该落哪（落在块内部）：表格落第一格、代码块落围栏内、引用落 `> ` 后。
 * @param snippet 插入的块内容
 * @returns 相对 snippet 起点的偏移
 */
export function snippetInnerOffset(snippet: string): number {
  // 代码块：落到第一行围栏之后的换行处
  if (snippet.startsWith('```')) {
    const nl = snippet.indexOf('\n');
    return nl === -1 ? snippet.length : nl + 1;
  }
  // 公式块：落到两个 $$ 之间
  if (snippet.startsWith('$$')) {
    const nl = snippet.indexOf('\n');
    return nl === -1 ? snippet.length : nl + 1;
  }
  // 表格：落到第一个单元格内（`| ` 之后）
  if (snippet.startsWith('|')) {
    const bar = snippet.indexOf('| ');
    return bar === -1 ? snippet.length : bar + 2;
  }
  // 链接引用定义：落到 `[id]: ` 之后，方便直接粘 URL
  const def = snippet.match(/^\[[^\]]+\]:\s/);
  if (def) return def[0].length;
  // 引用 / 列表：落到标记之后
  const m = snippet.match(/^(?:>\s?|[-*+]\s|\d+[.)]\s)/);
  if (m) return m[0].length;
  return snippet.length;
}

/**
 * 在当前块的上下另起一个空段落（「段落（上方 / 下方）」）。
 *
 * @param text 全文
 * @param caret 光标位置
 * @param where 'above' 插在当前块上方；'below' 插在下方
 * @returns 新文本与光标（落在新出现的空行上）
 */
export function insertParagraph(text: string, caret: number, where: 'above' | 'below'): EditResult {
  const { start, end } = lineBoundsAt(text, caret);
  if (where === 'above') {
    return { text: text.slice(0, start) + '\n' + text.slice(start), caret: start };
  }
  return { text: text.slice(0, end) + '\n' + text.slice(end), caret: end + 1 };
}

/** 预设的插入块内容 */
export const SNIPPETS = {
  /** 两列两行的空表格（含表头与分隔行，落到第一格） */
  table: '| 列 1 | 列 2 |\n| --- | --- |\n|  |  |\n|  |  |',
  /** 带语言标记的代码块 */
  code: '```\n\n```',
  /** 块级公式（光标落在两个 $$ 之间） */
  math: '$$\n\n$$',
  /** 目录标记 `[TOC]` */
  toc: '[TOC]',
  /** 链接引用定义 */
  linkref: '[1]: https://',
  /** YAML Front Matter */
  yaml: '---\ntitle: \n---',
  /** 单行引用 */
  quote: '> ',
  /** 分割线 */
  hr: '---',
  /** 无序列表项 */
  bullet: '- ',
  /** 有序列表项 */
  ordered: '1. ',
  /** 待办项 */
  todo: '- [ ] ',
} as const;

/**
 * 在表格里插入一整行（插在当前行之后，光标落到新行第一格）。
 * @param text 全文
 * @param caret 光标位置
 * @returns 加行后的文本与光标；光标不在表格里时 null
 */
export function tableAddRow(text: string, caret: number): EditResult | null {
  const block = blockAt(text, caret);
  const first = block.lines[0]?.trim() ?? '';
  if (!first.includes('|')) return null;
  const second = block.lines[1]?.trim() ?? '';
  if (!/^\|?[\s:|-]+\|?$/.test(second) || !second.includes('-')) return null;

  const cols = countTableColumns(block.lines[0]);
  const { end: lineEnd } = lineBoundsAt(text, caret);
  const rowText = '| ' + Array.from({ length: cols }, () => ' ').join(' | ') + ' |';
  const next = text.slice(0, lineEnd) + '\n' + rowText + text.slice(lineEnd);
  // +2 = 跳过 `| `
  return { text: next, caret: lineEnd + 1 + 2 };
}

/**
 * 数一行表格有几列（跳过转义竖线，去掉首尾空段）。
 * @param line 表格某一行
 * @returns 列数
 */
export function countTableColumns(line: string): number {
  return Math.max(1, tableCellRanges(line).length);
}

/**
 * 一行表格的单元格源码区间（不含竖线本身）。
 * 首尾竖线可选：`| a | b |` → 两格；`a | b` → 两格；`| a | b | ` 尾随空格不算一格。
 *
 * @param line 表格某一行
 * @returns 单元格区间（行内列号，左闭右开）
 */
export function tableCellRanges(line: string): { from: number; to: number }[] {
  const pipes: number[] = [];
  for (let k = 0; k < line.length; k++) if (line[k] === '|') pipes.push(k);
  if (pipes.length === 0) return [{ from: 0, to: line.length }];

  const ranges: { from: number; to: number }[] = [];
  // 行首竖线之前若还有内容（`a | b`），那也是一格
  if (line.slice(0, pipes[0]).trim() !== '') ranges.push({ from: 0, to: pipes[0] });
  for (let i = 0; i + 1 < pipes.length; i++) ranges.push({ from: pipes[i] + 1, to: pipes[i + 1] });
  // 末竖线之后若还有内容（`a | b`）才算尾巴那格；只有空白（`| a | b | `）不算
  const last = pipes[pipes.length - 1];
  if (line.slice(last + 1).trim() !== '') ranges.push({ from: last + 1, to: line.length });
  return ranges;
}

/** 一行的单元格文本（去掉首尾空白） */
function tableCellsOf(line: string): string[] {
  return tableCellRanges(line).map((r) => line.slice(r.from, r.to).trim());
}

/** 把单元格拼回一行规范写法：`| a | b |` */
function rowOf(cells: string[]): string {
  return '| ' + cells.join(' | ') + ' |';
}

/** 光标在表格里的位置描述 */
export interface TablePos {
  /** 块首行的绝对起始下标 */
  blockStart: number;
  /** 各行源码 */
  lines: string[];
  /** 各行的绝对起始下标 */
  lineStarts: number[];
  /** 光标所在行在块内的下标（0 = 表头） */
  rowIndex: number;
  /** 光标所在列（0 基） */
  colIndex: number;
  /** 表头列数 */
  cols: number;
}

/**
 * 取光标所在表格的位置信息。
 *
 * @param text 全文
 * @param caret 光标位置
 * @returns 位置描述；光标不在表格里时 null
 */
export function tablePosAt(text: string, caret: number): TablePos | null {
  const block = blockAt(text, caret);
  const lines = block.lines;
  if (lines.length < 2) return null;
  if (!lines[0].includes('|')) return null;
  const second = lines[1].trim();
  if (!/^\|?[\s:|-]+\|?$/.test(second) || !second.includes('-')) return null;

  const lineStarts: number[] = [];
  let pos = block.start;
  for (const l of lines) {
    lineStarts.push(pos);
    pos += l.length + 1;
  }
  let rowIndex = lineStarts.findIndex((s, i) => caret >= s && caret <= s + lines[i].length);
  if (rowIndex === -1) rowIndex = 0;

  const colInLine = Math.max(0, caret - lineStarts[rowIndex]);
  const pipesBefore = lines[rowIndex].slice(0, colInLine).split('|').length - 1;
  const leadPipe = lines[rowIndex].trimStart().startsWith('|') ? 1 : 0;
  const cols = Math.max(1, tableCellRanges(lines[0]).length);
  const colIndex = Math.max(0, Math.min(cols - 1, pipesBefore - leadPipe));

  return { blockStart: block.start, lines, lineStarts, rowIndex, colIndex, cols };
}

/** 整块表格的源码范围（含末行，不含末行换行） */
export function tableBlockRange(pos: TablePos): { from: number; to: number } {
  const last = pos.lines.length - 1;
  return { from: pos.blockStart, to: pos.lineStarts[last] + pos.lines[last].length };
}

/**
 * 表格里按 Tab 时的下一个落点：光标移到下一格内容的开头。
 *
 * 末格 → 下一行首格；末行末格 → 不动（返回 null，由调用方决定是否新增一行）。
 * 分隔行不参与跳转，直接跳过去。
 *
 * @param text 全文
 * @param caret 光标位置
 * @param dir `1` 向后（Tab）；`-1` 向前（Shift+Tab）
 * @returns 目标光标下标；无可跳之处时 null
 */
export function tableTabTarget(text: string, caret: number, dir: 1 | -1 = 1): number | null {
  const pos = tablePosAt(text, caret);
  if (!pos) return null;

  const cellCount = Math.max(1, tableCellRanges(pos.lines[0]).length);
  let row = pos.rowIndex;
  let col = pos.colIndex + dir;

  // 跨行：行号进一格，列号绕回
  if (col >= cellCount) {
    col = 0;
    row += 1;
  } else if (col < 0) {
    col = cellCount - 1;
    row -= 1;
  }
  // 分隔行不落点
  if (row === 1) row += dir;
  // 跳出行范围就到底了
  if (row < 0 || row >= pos.lines.length) return null;

  const ranges = tableCellRanges(pos.lines[row]);
  const range = ranges[Math.min(col, ranges.length - 1)];
  if (!range) return null;
  // 落在格内内容之前（跳过 `| ` 与首尾空白）
  const inner = pos.lines[row].slice(range.from, range.to);
  const lead = inner.length - inner.replace(/^\s+/, '').length;
  return pos.lineStarts[row] + range.from + lead;
}

/** 表格块所有行用同一套单元格重建后的文本 */
function rebuildBlock(nextLines: string[]): string {
  return nextLines.join('\n');
}

/**
 * 在表格里插入一行（空行，列数与表头一致）。
 *
 * @param text 全文
 * @param caret 光标位置
 * @param where 'above' 插在当前行上方；'below' 插在下方
 * @returns 新文本与光标；光标不在表格、或在分隔行上时 null
 */
export function tableInsertRow(text: string, caret: number, where: 'above' | 'below'): EditResult | null {
  const pos = tablePosAt(text, caret);
  if (!pos) return null;
  // 分隔行是表头的附属行，在它上下插行会让表头与分隔行脱节
  if (pos.rowIndex === 1) return null;

  // 在表头下方插入时必须落到分隔行之后，否则表头与分隔行被拆开
  const at =
    where === 'above'
      ? pos.lineStarts[pos.rowIndex]
      : pos.rowIndex === 0
        ? pos.lineStarts[1] + pos.lines[1].length + 1
        : pos.lineStarts[pos.rowIndex] + pos.lines[pos.rowIndex].length + 1;
  const next = text.slice(0, at) + rowOf(Array(pos.cols).fill('')) + '\n' + text.slice(at);
  // 光标落到新行第一格（`| ` 之后）
  return { text: next, caret: at + 2 };
}

/**
 * 删除表格里的一行。
 *
 * @param text 全文
 * @param caret 光标位置
 * @returns 新文本与光标；光标不在表格，或行为表头、分隔行时返回 null
 */
export function tableDeleteRow(text: string, caret: number): EditResult | null {
  const pos = tablePosAt(text, caret);
  if (!pos) return null;
  if (pos.rowIndex <= 1) return null;

  const from = pos.lineStarts[pos.rowIndex];
  const to = from + pos.lines[pos.rowIndex].length + 1;
  const next = text.slice(0, from) + text.slice(to);
  return { text: next, caret: Math.max(0, Math.min(from, next.length)) };
}

/**
 * 在光标所在列的左 / 右侧插入一列。
 *
 * @param text 全文
 * @param caret 光标位置
 * @param side 'left' 插在左侧；'right' 插在右侧
 * @returns 新文本与光标；光标不在表格里时 null
 */
export function tableInsertColumn(text: string, caret: number, side: 'left' | 'right'): EditResult | null {
  const pos = tablePosAt(text, caret);
  if (!pos) return null;

  const at = pos.colIndex + (side === 'right' ? 1 : 0);
  const nextLines = pos.lines.map((l, i) => {
    const cells = tableCellsOf(l);
    // 分隔行补 `---`，其余补空格；补齐到目标列数后再插，避免行长短不一插歪
    while (cells.length < pos.cols) cells.push(i === 1 ? '---' : '');
    cells.splice(at, 0, i === 1 ? '---' : '');
    return rowOf(cells);
  });

  const before = nextLines.slice(0, pos.rowIndex).reduce((n, l) => n + l.length + 1, 0);
  const next = text.slice(0, pos.blockStart) + rebuildBlock(nextLines) + text.slice(tableBlockRange(pos).to);
  return { text: next, caret: pos.blockStart + before + 2 };
}

/**
 * 删除光标所在列。
 *
 * @param text 全文
 * @param caret 光标位置
 * @returns 新文本与光标；光标不在表格、或只剩一列时 null
 */
export function tableDeleteColumn(text: string, caret: number): EditResult | null {
  const pos = tablePosAt(text, caret);
  if (!pos) return null;
  if (pos.cols <= 1) return null;

  const nextLines = pos.lines.map((l) => {
    const cells = tableCellsOf(l);
    while (cells.length < pos.cols) cells.push('');
    cells.splice(pos.colIndex, 1);
    return rowOf(cells);
  });

  const before = nextLines.slice(0, pos.rowIndex).reduce((n, l) => n + l.length + 1, 0);
  const next = text.slice(0, pos.blockStart) + rebuildBlock(nextLines) + text.slice(tableBlockRange(pos).to);
  return { text: next, caret: pos.blockStart + before + 2 };
}

/**
 * 格式化表格源码：所有行的单元格按规范写法重排（`| a | b |`），列宽不再靠手敲空格。
 *
 * @param text 全文
 * @param caret 光标位置
 * @returns 新文本与光标；光标不在表格里时 null
 */
export function tableFormatSource(text: string, caret: number): EditResult | null {
  const pos = tablePosAt(text, caret);
  if (!pos) return null;

  const nextLines = pos.lines.map((l, i) => {
    const cells = tableCellsOf(l);
    while (cells.length < pos.cols) cells.push(i === 1 ? '---' : '');
    return rowOf(cells);
  });

  const before = nextLines.slice(0, pos.rowIndex).reduce((n, l) => n + l.length + 1, 0);
  const next = text.slice(0, pos.blockStart) + rebuildBlock(nextLines) + text.slice(tableBlockRange(pos).to);
  return { text: next, caret: pos.blockStart + before + 2 };
}

/**
 * 删除整张表格（块内所有行，连同其后的一个换行）。
 *
 * @param text 全文
 * @param caret 光标位置
 * @returns 新文本与光标；光标不在表格里时 null
 */
export function tableDelete(text: string, caret: number): EditResult | null {
  const pos = tablePosAt(text, caret);
  if (!pos) return null;
  const { from, to } = tableBlockRange(pos);
  const end = text[to] === '\n' ? to + 1 : to;
  const next = text.slice(0, from) + text.slice(end);
  return { text: next, caret: Math.max(0, Math.min(from, next.length)) };
}

/**
 * 按行列数拼一张空表源码。
 *
 * 行数的口径：**含表头行**，不含分隔行（分隔行是表头的附属行，不算一行）。
 * 所以 `rows = 3` 出来是「表头 + 分隔 + 2 个数据行」，渲染成 3 行。
 *
 * @param cols 列数（≥1）
 * @param rows 总行数，含表头行（≥1）
 * @returns 表格源码（不含首尾换行）
 */
export function makeTableSnippet(cols: number, rows: number): string {
  const c = Math.max(1, Math.min(12, Math.floor(cols) || 1));
  const r = Math.max(1, Math.min(50, Math.floor(rows) || 1));
  const lines = [rowOf(Array(c).fill('')), rowOf(Array(c).fill('---'))];
  for (let i = 1; i < r; i++) lines.push(rowOf(Array(c).fill('')));
  return lines.join('\n');
}

/**
 * 清掉一段文本里的行内标记（加粗 / 斜体 / 行内代码 / 删除线 / 高亮 / 链接语法）。
 *
 * @param text 全文
 * @param sel 选区
 * @returns 新文本与光标；选区为空时 null
 */
export function clearInlineFormat(text: string, sel: Selection): EditResult | null {
  const { start, end } = sel;
  if (start === end) return null;
  const seg = text.slice(start, end);
  const plain = seg
    // 图片 / 链接 → 只留文字
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '$1')
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1')
    // 成对标记 → 去标记
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/==([^=]+)==/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
  if (plain === seg) return null;
  return { text: text.slice(0, start) + plain + text.slice(end), caret: start + plain.length };
}

/** 判断光标是否在表格块里 */
export function inTable(text: string, caret: number): boolean {
  const block = blockAt(text, caret);
  const first = block.lines[0]?.trim() ?? '';
  const second = block.lines[1]?.trim() ?? '';
  return first.includes('|') && /^\|?[\s:|-]+\|?$/.test(second) && second.includes('-');
}

/** 判断光标是否在代码围栏里 */
export function inCodeFence(text: string, caret: number): boolean {
  const before = text.slice(0, caret);
  // 统计光标之前出现过的 ``` 数量，奇数即在围栏内
  const fences = before.match(/^\s*(?:```|~~~)/gm);
  return fences !== null && fences.length % 2 === 1;
}

/** 光标上下文的判定结果，供右键菜单决定显示哪些项 */
export interface ContextInfo {
  /** 在代码块里 */
  code: boolean;
  /** 所在代码块是否开了行号（围栏属性 `{.numberLines}`） */
  codeLineNumbers: boolean;
  /** 在表格里 */
  table: boolean;
  /** 所在行是不是列表项 */
  list: boolean;
  /** 所在行是不是引用 */
  quote: boolean;
  /** 所在行是不是标题 */
  heading: boolean;
  /** 标题档位（1~6）；0 = 不是标题。段落子菜单用它点亮当前档位 */
  headingLevel: number;
  /** 当前行是否为空（空行处可以随便插块） */
  empty: boolean;
}

/**
 * 判定光标所在位置的上下文（代码块 / 表格 / 列表 / 引用 / 标题 / 空行）。
 *
 * @param text 全文
 * @param caret 光标位置
 * @returns 上下文信息
 */
export function getContext(text: string, caret: number): ContextInfo {
  const line = lineAt(text, caret);
  const trimmed = line.trim();
  const hm = /^\s*(#{1,6})\s/.exec(line);
  const code = inCodeFence(text, caret);
  return {
    code,
    codeLineNumbers: code && (parseFenceOptions(codeFenceInfo(text, caret) ?? '').lineNumbers ?? false),
    table: inTable(text, caret),
    list: /^\s*(?:[-*+]|\d+[.)])\s+/.test(line),
    quote: /^\s*>\s?/.test(line),
    heading: hm !== null,
    headingLevel: hm ? hm[1].length : 0,
    empty: trimmed === '',
  };
}

/**
 * 取光标位置应使用的缩进单位串。
 *
 * 在代码块里用代码缩进宽度（默认 4 空格），其余位置用正文缩进（2 空格）。
 * 两者相互独立 —— 正文两空格是 Markdown 惯例，代码四空格是主流语言惯例。
 *
 * @param text 全文
 * @param caret 光标位置
 * @param codeSize 代码块的缩进宽度（空格数）
 * @returns 缩进单位串
 */
export function indentUnitAt(text: string, caret: number, codeSize: number): string {
  return inCodeFence(text, caret) ? indentUnitOf(codeSize) : INDENT_UNIT;
}

/**
 * 取光标所在代码块的开围栏 info string（围栏符号之后那一串）。
 *
 * @param text 全文
 * @param caret 光标位置
 * @returns info string；不在代码块里则 null
 */
function codeFenceInfo(text: string, caret: number): string | null {
  const lines = text.split('\n');
  const FENCE = /^\s*(`{3,}|~{3,})/;
  let pos = 0;
  /** 当前开围栏的标记；null = 不在围栏里 */
  let open: string | null = null;
  let info: string | null = null;
  for (const line of lines) {
    const atThisLine = caret >= pos && caret <= pos + line.length;
    const m = FENCE.exec(line);
    if (m) {
      if (open === null) {
        open = m[1];
        info = line.slice(m[0].length);
      } else if (m[1][0] === open[0] && m[1].length >= open.length) {
        // 闭围栏。光标正停在这一行上时仍算这个块，先把它当作块内
        if (atThisLine) return info;
        open = null;
        info = null;
      }
    }
    if (atThisLine) return info;
    pos += line.length + 1;
  }
  return null;
}

/** 右键命中的行内目标（图片 / 链接语法） */
export interface InlineTarget {
  /** 图片或链接 */  kind: 'image' | 'link';
  /** 语法在行内的起始列号（含 `![` 等标记符） */
  start: number;
  /** 语法在行内的结束列号（不含） */
  end: number;
  /** 链接/图片地址 */
  href: string;
  /** 链接文字或图片 alt */
  label: string;
}

/**
 * 查找覆盖 col 列的行内图片或链接语法。
 *
 * @param line 一行源码，不含换行
 * @param col 行内列号
 * @returns 命中的目标；没有则返回 null
 */
export function inlineTargetAt(line: string, col: number): InlineTarget | null {
  // 图片优先扫：`![alt](url)` 里的 `[alt](url)` 不能被当成链接
  const imgRe = /!\[([^\]]*)\]\(([^)]*)\)/g;
  let m: RegExpExecArray | null = imgRe.exec(line);
  while (m !== null) {
    if (col >= m.index && col < m.index + m[0].length) {
      return { kind: 'image', start: m.index, end: m.index + m[0].length, href: m[2], label: m[1] };
    }
    m = imgRe.exec(line);
  }

  const linkRe = /(?<!!)\[([^\]]*)\]\(([^)]*)\)/g;
  m = linkRe.exec(line);
  while (m !== null) {
    if (col >= m.index && col < m.index + m[0].length) {
      return { kind: 'link', start: m.index, end: m.index + m[0].length, href: m[2], label: m[1] };
    }
    m = linkRe.exec(line);
  }
  return null;
}

// ── 查找 / 替换 ────────────────────────────────────────────

/** 一处查找命中（全文绝对下标，左闭右开） */
export interface FindHit {
  start: number;
  end: number;
}

/**
 * 找出 query 在全文里的所有非重叠出现。
 *
 * @param text 全文
 * @param query 查找串（空串返回 `[]`）
 * @param caseSensitive 是否区分大小写
 * @returns 命中列表，按下标升序
 */
export function findAll(text: string, query: string, caseSensitive = false): FindHit[] {
  if (!query) return [];
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const out: FindHit[] = [];
  let i = 0;
  for (;;) {
    const at = hay.indexOf(needle, i);
    if (at === -1) break;
    out.push({ start: at, end: at + query.length });
    // 非重叠：下一次从本处之后接着找
    i = at + query.length;
  }
  return out;
}

// ── 缩进 / 标题级别 ────────────────────────────────────────

/** 正文缩进单位，两个空格 */
export const INDENT_UNIT = '  ';

/** 代码块缩进宽度默认值（空格数），与正文缩进相互独立 */
export const CODE_INDENT_SIZE_DEFAULT = 4;

/** 缩进宽度的合法取值（空格数） */
export const INDENT_SIZE_CHOICES = [2, 4, 8] as const;

/**
 * 把缩进宽度（空格数）转成实际的缩进字符串。
 *
 * @param size 空格数；非正数或非有限值时回退到正文缩进（2 空格）
 * @returns 由 `size` 个空格组成的串（最小 1 个空格）
 */
export function indentUnitOf(size: number): string {
  const n = Number.isFinite(size) && size > 0 ? Math.floor(size) : INDENT_UNIT.length;
  return ' '.repeat(n);
}

/**
 * 缩进 / 反缩进若干行。
 *
 * 缩进：每行行首加一个缩进单位；反缩进：每行行首吃掉一个 Tab，或至多一个缩进单位的空格。
 * 一次处理 `[from, to]` 覆盖到的所有行 —— Tab 有选区时就是走这条路径。
 *
 * @param text 全文
 * @param from 选区起点（含）
 * @param to 选区终点（含）；无选区时与 `from` 相同
 * @param dir `'in'` 缩进；`'out'` 反缩进
 * @param unit 缩进单位串，见 indentUnitOf
 * @returns 新文本与新选区（保持原选中范围，两端随增删平移）
 */
export function indentLines(
  text: string,
  from: number,
  to: number,
  dir: 'in' | 'out',
  unit: string = INDENT_UNIT,
): EditResult {
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.max(from, to);

  // 逐行处理：从后往前改，前面的下标才不会被打乱
  const bounds: { start: number; end: number }[] = [];
  let at = lineBoundsAt(text, lo).start;
  for (;;) {
    const b = lineBoundsAt(text, at);
    bounds.push(b);
    if (b.end >= hi || b.end >= text.length) break;
    at = b.end + 1;
  }

  let next = text;
  // 每一处增删都会让「选区起点之前」的长度变化，累加起来才是新选区
  let deltaAtLo = 0;
  let deltaAtHi = 0;

  for (let k = bounds.length - 1; k >= 0; k--) {
    const { start, end } = bounds[k];
    const line = next.slice(start, end);
    let change: { text: string; delta: number };

    if (dir === 'in') {
      change = { text: unit + line, delta: unit.length };
    } else {
      let drop = 0;
      if (line.startsWith('\t')) drop = 1;
      else drop = (line.match(new RegExp(`^ {1,${unit.length}}`))?.[0] ?? '').length;
      change = drop === 0 ? { text: line, delta: 0 } : { text: line.slice(drop), delta: -drop };
    }

    next = next.slice(0, start) + change.text + next.slice(end);
    // 本行起点在选区起点之前 → 影响选区起点
    if (start <= lo) deltaAtLo += change.delta;
    // 本行起点在选区终点之前 → 影响选区终点
    if (start <= hi) deltaAtHi += change.delta;
  }

  return {
    text: next,
    caret: Math.max(0, hi + deltaAtHi),
    select: {
      start: Math.max(0, lo + deltaAtLo),
      end: Math.max(0, hi + deltaAtHi),
    },
  };
}

/**
 * 光标所在行的缩进 / 反缩进（Ctrl+[ / Ctrl+]、无选区时的 Tab）。
 *
 * @param text 全文
 * @param caret 光标位置
 * @param dir `'in'` 缩进；`'out'` 反缩进
 * @param unit 缩进单位串，见 indentUnitOf
 * @returns 新文本与新光标
 */
export function indentLine(
  text: string,
  caret: number,
  dir: 'in' | 'out',
  unit: string = INDENT_UNIT,
): EditResult {
  const r = indentLines(text, caret, caret, dir, unit);
  // 无选区时只关心光标；indentLines 的 selection.end 就是新光标
  return { text: r.text, caret: r.caret };
}

/**
 * 升降标题级别。级别定义：0 = 正文，1..6 = h1..h6。
 *
 * 提升（delta = +1）：段落 → h1 → h2 → … → h6（到 h6 封顶）；
 * 降低（delta = -1）：h6 → … → h1 → 段落（到段落封顶）。
 *
 * @param text 全文
 * @param caret 光标位置
 * @param delta `+1` 升一级；`-1` 降一级
 * @returns 新文本与新光标（落在行尾）
 */
export function changeHeadingLevel(text: string, caret: number, delta: 1 | -1): EditResult {
  const { start, end } = lineBoundsAt(text, caret);
  const line = text.slice(start, end);
  const m = /^\s*(#{1,6})\s+/.exec(line);
  const cur = m ? m[1].length : 0;
  const level = Math.max(0, Math.min(6, cur + delta));
  const bare = line.replace(/^\s*#{1,6}\s+/, '');
  const next = level === 0 ? bare : '#'.repeat(level) + ' ' + bare;
  return { text: text.slice(0, start) + next + text.slice(end), caret: start + next.length };
}