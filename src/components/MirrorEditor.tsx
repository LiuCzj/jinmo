/**
 * 笔记编辑器：逐行 div 渲染、自绘光标，键盘与输入法挂在隐藏 textarea 上。
 *
 * 隐藏 textarea 不可省略：输入法需要真实的可聚焦元素。
 * 正文本身不用 textarea，因为同一容器内存在多种行高，而 line-height 作用于整个元素。
 */

import {
  createElement,
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { charColsForLine, classifyLine, parseInline, revealSegAt, type InlineSeg, type LineKind } from '@/lib/md-inline';
import { parseFenceOptions, fenceLangOf, fenceAttrs, buildFenceLine } from '@/lib/code-langs';
import { highlightCode } from '@/lib/md-code';
import { highlightMarkdown } from '@/lib/md-highlight';
import { renderMath } from '@/lib/md-math';
import { renderMermaid } from '@/lib/md-mermaid';
import { parseMarkdownFile, type ParsedMarkdownFile } from '@/lib/parse-md-file';
import {
  backspace,
  caretAtLineEdge,
  deleteWordAt,
  del,
  enter,
  insertAt,
  lineIndexOf,
  moveChar,
  moveLine,
  softBreak,
  wordBoundsAt,
  type EditOutcome,
} from '@/lib/md-editing';
import {
  changeHeadingLevel,
  clearInlineFormat,
  findAll,
  getContext,
  indentLine,
  indentLines,
  indentUnitAt,
  inTable,
  inlineTargetAt,
  insertBlock,
  insertImage,
  insertLink,
  insertParagraph,
  INDENT_SIZE_CHOICES,
  CODE_INDENT_SIZE_DEFAULT,
  lineBoundsAt,
  makeTableSnippet,
  SNIPPETS,
  tableAddColumn,
  tableAddRow,
  tableAlignmentsOf,
  tableSetAlign,
  tableBlockRange,
  tableCellRanges,
  tableDelete,
  tableDeleteColumn,
  tableDeleteRow,
  tableFormatSource,
  tableInsertColumn,
  tableInsertRow,
  tableMoveColumn,
  tableMoveRow,
  tablePosAt,
  tableTabTarget,
  unwrapSelection,
  wrapSelection,
  type FindHit,
  type InlineTarget,
  type Selection,
  type TableAlign,
} from '@/lib/md-commands';
import {
  buildContextMenu,
  buildImageMenu,
  buildLinkMenu,
  ContextMenu,
  FormatBubble,
  INLINE_COMMANDS,
  LangPicker,
  PromptDialog,
  TableBar,
  tableGroup,
  TableInsertDialog,
  type FloatPos,
  type MdMenuItem,
} from './MarkdownFloats';
import { FindBar, type FindState } from './FindBar';
import { pickImages, readClipboard, writeClipboard } from '@/lib/platform';

/** 一行的渲染描述 */
interface RenderLine {
  /** 这一行在整篇里的起始下标 */
  start: number;
  /** 这一行的源码（不含换行） */
  src: string;
  /** 块类型 */
  kind: LineKind;
  /** 前缀之后的可见片段 */
  segs: InlineSeg[];
  /** 前缀的源码文本（如 `## `），加虚化显示 */
  prefixText: string;
  /** 表格行的列数（取表头的列数，head/sep/body 三种行都有值） */
  tableCols?: number;
  /** 表格各列的对齐方式（取自分隔行；三种表格行都有值） */
  tableAligns?: TableAlign[];
  /** 代码块的语言标识，取自围栏后的第一个词；code 行与 fence 行都有 */
  lang?: string;
  /** 本行是代码块的开围栏（语言选择按钮挂在它上面） */
  codeFence?: boolean;
  /** 代码行要显示的行号（围栏属性 `{.numberLines}` 打开时才有；围栏行没有） */
  codeNo?: number;
  /** 块级公式的 TeX 源码；只挂在块的首行 */
  mathTex?: string;
  /** Mermaid 图表源码；只挂在块的首行 */
  diagram?: string;
  /** 块级内容（公式 / 图表）的起止行号；块内每一行都有 */
  mathBlockFirst?: number;
  mathBlockLast?: number;
}

/** 光标位置：整篇里的绝对字符下标 */
type Caret = number;

/**
 * 字符映射表的一条：DOM 里某个可见字符 ↔ 它在源码里的下标。
 * `src === null` 表示这个字符是纯装饰（列表圆点 / 序号），不占源码位置。
 */
interface CharMapEntry {
  node: Text;
  /** 在该文本节点里的偏移 */
  offset: number;
  /** 对应的行内源码下标；null = 装饰字符 */
  src: number | null;
}

/** 表格分隔行的形态：竖线、冒号、横杠、空格的组合，且至少含一个 `-` */
const TABLE_SEP_RE = /^\s*\|?[\s:|-]+\|?\s*$/;

  /**
   * 支持语法浮现的行类型：段落、标题、引用、列表、分割线。
   * 空行无源码可露；fence / code 按源码渲染；表格行需保持网格布局。
   */
const REVEALABLE = new Set<LineKind['type']>([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'quote',
  'ul',
  'ol',
  'p',
  'hr',
]);

/**
 * 取片段列表中 [from, to) 区间的内容，`srcStart` 平移成行内绝对列号。
 * 用于把整行的片段按单元格边界再切一刀。
 *
 * @param segs 整行的片段
 * @param from 区间起点（行内列号）
 * @param to 区间终点（不含）
 * @returns 区间内的片段
 */
function sliceSegs(segs: InlineSeg[], from: number, to: number): InlineSeg[] {
  const out: InlineSeg[] = [];
  for (const s of segs) {
    const s0 = s.srcStart;
    const s1 = s.srcStart + s.text.length;
    const a = Math.max(s0, from);
    const b = Math.min(s1, to);
    // 切片后标记符已不在区间内，raw 范围就是可见范围本身
    if (b > a) out.push({ ...s, text: s.text.slice(a - s0, b - s0), srcStart: a, rawStart: a, rawEnd: b });
  }
  return out;
}

/** 上一轮 buildLines 的结果，用于复用没变的行对象 */
let prevLines: RenderLine[] = [];
let prevDefsKey = '';

/**
 * 没有查找命中时的空数组。
 *
 * 必须是**同一个引用**：行组件是记忆化的，每次返回新 `[]` 会让所有行都判定为"变了"而重渲染。
 */
const NO_HITS: FindHit[] = [];

/** 不在源码模式时的空着色结果。同样是稳定引用，避免每次渲染都造一个新数组 */
const EMPTY_HTML: string[] = [];

/** 单行的解析结果。与「这一行在整篇里的位置」无关，因此可以跨次复用 */
interface LineParse {
  kind: LineKind;
  segs: InlineSeg[];
  prefixText: string;
  lang?: string;
  /** 本行是代码块的开围栏 */
  codeFence?: boolean;
}

/**
 * 单行解析结果的缓存。
 *
 * 打字时只有一行变了，其余几百行的解析结果一模一样；整篇重解析是长文档下敲字变慢的原因之一。
 * 缓存结果同时让未变行的 `segs` / `kind` 保持同一个引用，行组件的记忆化才跳得掉（见 linePropsEqual）。
 *
 * 外层键是「围栏状态 + 引用定义」，内层键是行文本：
 *  - 围栏状态决定这一行算 fence 还是 code，同样的 ``` 在围栏内外是两种含义；
 *  - 引用定义决定 `[x][id]` 能否解析成链接，定义行改了所有引用行都要重算。
 * 两者不进键就会读到过期结果。做成两层是为了让内层键直接用行文本，
 * 免得每行都拼一个长字符串再哈希。
 */
const parseCache = new Map<string, Map<string, LineParse>>();
/** 缓存条目上限。超过就整个丢掉重建 —— 打字过程中产生的中间态行会不断堆积 */
const PARSE_CACHE_MAX = 5000;
let parseCacheEntries = 0;

/**
 * 解析一行（行类型 + 可见片段 + 前缀），不涉及它在整篇里的位置。
 *
 * @param line 整行源码，不含换行
 * @param fence 进入这一行时的围栏标记；null = 不在围栏内
 * @param fenceLang 进入这一行时的围栏语言标识
 * @param defs 引用式链接的定义表
 * @returns 解析结果
 */
function parseLine(line: string, fence: string | null, fenceLang: string, defs: Record<string, string>): LineParse {
  const kind = classifyLine(line, fence);
  const prefixText = line.slice(0, kind.prefixLen);
  const body = line.slice(kind.prefixLen);
  /**
   * 片段下标需加上前缀长度：parseInline 收到的是去掉前缀的 body，
   * 而光标换算用的是相对整行的列号。
   */
  let segs =
    kind.type === 'code'
      ? [
          {
            text: body,
            srcStart: kind.prefixLen,
            rawStart: kind.prefixLen,
            rawEnd: kind.prefixLen + body.length,
            kind: 'plain' as const,
          },
        ]
      : parseInline(body, defs).map((s) => ({
          ...s,
          srcStart: s.srcStart + kind.prefixLen,
          rawStart: s.rawStart + kind.prefixLen,
          rawEnd: s.rawEnd + kind.prefixLen,
        }));

  // 任务列表：把行首的 `[ ] ` / `[x] ` 单独做成一个复选框片段，其余部分照常解析
  if (kind.type === 'ul') {
    const task = /^\[([ xX])\]\s+/.exec(body);
    if (task) {
      const shift = kind.prefixLen + task[0].length;
      segs = [
        {
          text: task[0],
          srcStart: kind.prefixLen,
          rawStart: kind.prefixLen,
          rawEnd: shift,
          kind: 'task',
          checked: task[1].toLowerCase() === 'x',
        },
        ...parseInline(body.slice(task[0].length), defs).map((s) => ({
          ...s,
          srcStart: s.srcStart + shift,
          rawStart: s.rawStart + shift,
          rawEnd: s.rawEnd + shift,
        })),
      ];
    }
  }

  const lang =
    kind.type === 'code'
      ? fenceLang
      : kind.type === 'fence'
        ? fenceLangOf(line.slice((/^\s*/.exec(line)?.[0].length ?? 0) + (/^\s*(`{3,}|~{3,})/.exec(line)?.[1].length ?? 3)))
        : undefined;

  return { kind, segs, prefixText, lang };
}

/**
 * 把整篇切成一行的渲染描述。
 *
 * 逐行的解析结果走 `parseCache`，只有真的改过的那一行会重新解析；
 * 内容与起始位置都没变的行再复用上一轮的对象：行组件是记忆化的，
 * 对象引用不变它就跳过重渲染 —— 这是长文档下敲字跟手的关键。
 *
 * @param src 整篇 Markdown
 * @returns 逐行的渲染描述
 */
function buildLines(src: string, globalLineNumbers = false): RenderLine[] {
  const raw = src.split('\n');
  const out: RenderLine[] = [];
  let pos = 0;
  /** 当前所处的代码围栏标记（如 ``` 或 ````）；null = 不在围栏内 */
  let fence: string | null = null;
  /** 当前代码围栏的语言标识 */
  let fenceLang = '';
  /** 当前代码块是否显示行号（来自围栏属性 `{.numberLines}`，见 parseFenceOptions） */
  let fenceNoOn = false;
  /** 当前代码块行号的起始编号（`startFrom="N"`，默认 1） */
  let fenceNoFirst = 1;
  /** 当前代码块已经数到第几行 */
  let fenceNoCount = 0;

  // 先收一遍引用式链接的定义行 `[id]: url`（脚注定义 `[^id]:` 不算）
  const defs: Record<string, string> = {};
  for (const line of raw) {
    // 定义行必然以 `[` 开头；先做一次廉价判断，省掉整篇的正则
    if (line.charCodeAt(0) !== 91) continue;
    const m = /^\[([^\]^][^\]]*)\]:\s*(\S+)/.exec(line);
    if (m) defs[m[1].trim().toLowerCase()] = m[2];
  }
  const defsSig = JSON.stringify(defs);

  /** 当前缓存桶（外层键 = 围栏状态 + 引用定义）。围栏状态只在围栏边界变，故不必每行重算 */
  let bucket: Map<string, LineParse> | null = null;
  let bucketKey = '';

  for (const line of raw) {
    const fenceState = fence === null ? '' : `${fence}|${fenceLang}`;
    const want = `${fenceState}\u0000${defsSig}`;
    if (bucket === null || want !== bucketKey) {
      bucketKey = want;
      bucket = parseCache.get(want) ?? null;
      if (bucket === null) {
        bucket = new Map();
        parseCache.set(want, bucket);
      }
    }
    let parse = bucket.get(line);
    if (parse === undefined) {
      parse = parseLine(line, fence, fenceLang, defs);
      if (parseCacheEntries >= PARSE_CACHE_MAX) {
        parseCache.clear();
        parseCacheEntries = 0;
        bucket = new Map();
        parseCache.set(bucketKey, bucket);
      }
      bucket.set(line, parse);
      parseCacheEntries++;
    }

    /** 本行是代码块的开围栏 —— 语言选择按钮只挂在这一行上 */
    const opensFence = parse.kind.type === 'fence' && fence === null;
    if (parse.kind.type === 'fence') {
      if (fence === null) {
        // 开围栏：记下标记、语言与行号属性（闭围栏不动这几个值）
        const indent = /^\s*/.exec(line)?.[0].length ?? 0;
        fence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1] ?? '```';
        const info = line.slice(indent + fence.length);
        // 语言必须用 fenceLangOf 取：`{.numberLines}` 这种纯属性串不是语言，
        // 直接用 `\S+` 抓会把属性当成语言，关键字高亮整块失效
        fenceLang = fenceLangOf(info);
        const opts = parseFenceOptions(info);
        // 全局开关优先；关掉时还能靠围栏属性 `{.numberLines}` 单独打开
        fenceNoOn = globalLineNumbers || opts.lineNumbers === true;
        fenceNoFirst = opts.firstLineNumber ?? 1;
        fenceNoCount = 0;
      } else {
        fence = null;
      }
    }

    /** 代码块里的内容行才编号；围栏本身不算一行 */
    const codeNo =
      parse.kind.type === 'code' && fenceNoOn ? fenceNoFirst + fenceNoCount++ : undefined;

    out.push({
      start: pos,
      src: line,
      kind: parse.kind,
      prefixText: parse.prefixText,
      segs: parse.segs,
      lang: parse.lang,
      codeFence: opensFence || undefined,
      codeNo,
    });
    pos += line.length + 1;
  }

  markTables(out);

  // 块级公式：$$ ... $$（可跨行）。整块渲染成一个公式，非编辑态下只占首行的高度
  let openAt = -1;
  let buf: string[] = [];
  const closeBlock = (endIndex: number) => {
    const first = out[openAt];
    if (!first) return;
    first.mathTex = buf.join('\n').trim();
    for (let k = openAt; k <= endIndex; k++) {
      out[k].mathBlockFirst = openAt;
      out[k].mathBlockLast = endIndex;
    }
    openAt = -1;
    buf = [];
  };
  for (let i = 0; i < out.length; i++) {
    const t = out[i].src.trim();
    if (openAt === -1) {
      if (t === '$$') {
        openAt = i;
        buf = [];
      } else if (t.length > 4 && t.startsWith('$$') && t.endsWith('$$')) {
        out[i].mathTex = t.slice(2, -2).trim();
        out[i].mathBlockFirst = i;
        out[i].mathBlockLast = i;
      }
    } else if (t === '$$') {
      closeBlock(i);
    } else {
      buf.push(out[i].src);
    }
  }

  // 图表块：```mermaid 围栏里的内容整块渲染成一张图，非编辑态下只占首行高度
  for (let i = 0; i < out.length; i++) {
    const fence = out[i];
    if (fence.kind.type !== 'fence' || fence.lang !== 'mermaid') continue;
    const body: string[] = [];
    let j = i + 1;
    while (j < out.length && out[j].kind.type === 'code') {
      body.push(out[j].src);
      j++;
    }
    if (j >= out.length || out[j].kind.type !== 'fence') continue; // 没有闭合围栏，按普通代码块处理
    fence.diagram = body.join('\n');
    for (let k = i; k <= j; k++) {
      out[k].mathBlockFirst = i;
      out[k].mathBlockLast = j;
    }
    i = j;
  }

  // 复用没变的行对象（见函数注释）。引用定义变了就不复用，避免拿到过期的链接解析结果
  const defsKey = JSON.stringify(defs);
  const merged =
    defsKey === prevDefsKey
      ? out.map((l, i) => {
          const p = prevLines[i];
          if (!p || p.src !== l.src || p.start !== l.start) return l;
          if (
            p.kind.type !== l.kind.type ||
            p.kind.prefixLen !== l.kind.prefixLen ||
            p.kind.marker !== l.kind.marker
          ) {
            return l;
          }
          if (
            p.lang !== l.lang ||
            p.codeFence !== l.codeFence ||
            p.codeNo !== l.codeNo ||
            p.mathTex !== l.mathTex ||
            p.diagram !== l.diagram ||
            p.mathBlockFirst !== l.mathBlockFirst ||
            p.mathBlockLast !== l.mathBlockLast ||
            // 表格的列数 / 列对齐派生自**分隔行**，行自己的 src 没变时也会变。
            // 不比较就会复用旧对象，表头行一直带着旧的对齐值（改完对齐表头不动，实测踩过）。
            // 对齐是数组、每次都是新引用，所以按值比。
            p.tableCols !== l.tableCols ||
            (p.tableAligns?.join() ?? '') !== (l.tableAligns?.join() ?? '')
          ) {
            return l;
          }
          return p;
        })
      : out;
  prevLines = merged;
  prevDefsKey = defsKey;

  return merged;
}

  /**
   * 标记表格块：连续行含竖线且下一行为分隔行形态时，标为 tableHead / tableSep / tableBody。
   * classifyLine 逐行判定无法看到下一行，故在此处按全文处理。
   *
   * @param lines buildLines 的产出，原地修改
   */
function markTables(lines: RenderLine[]): void {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.kind.type !== 'p' || !l.src.includes('|')) continue;
    const next = lines[i + 1];
    if (!next || next.kind.type !== 'p' || !TABLE_SEP_RE.test(next.src) || !next.src.includes('-')) continue;

    const cols = tableCellRanges(l.src).length;
    // 列对齐写在分隔行上（`:---` / `:---:` / `---:`），三种表格行共用同一份
    const aligns = tableAlignmentsOf(next.src);
    if (typeof window !== 'undefined') {
      (window as unknown as Record<string, unknown>).__dbgAligns = [
        ...(((window as unknown as Record<string, unknown[]>).__dbgAligns as unknown[]) ?? []),
        { sep: next.src, aligns },
      ].slice(-6);
    }
    l.kind = { type: 'tableHead', prefixLen: 0 };
    l.tableCols = cols;
    l.tableAligns = aligns;
    next.kind = { type: 'tableSep', prefixLen: 0 };
    next.tableCols = cols;
    next.tableAligns = aligns;
    for (let j = i + 2; j < lines.length; j++) {
      if (lines[j].kind.type !== 'p' || !lines[j].src.trimStart().startsWith('|')) break;
      lines[j].kind = { type: 'tableBody', prefixLen: 0 };
      lines[j].tableCols = cols;
      lines[j].tableAligns = aligns;
    }
  }
}

/**
 * 这一行是不是代码块的一部分（开闭围栏行或代码行）。
 *
 * 用来给代码块补上下边框与圆角：代码块整体是
 * `border:1px solid #e7eaed; border-radius:3px; margin:15px 0; padding:8px 0 6px`，
 * 而我们把代码块拆成了一行一个 div，只能靠「首行 / 末行」补上对应的边。
 *
 * @param lines 全部行
 * @param i 行下标
 * @returns 是代码块的一部分
 */
function isCodeLike(lines: RenderLine[], i: number): boolean {
  const t = lines[i]?.kind.type;
  return t === 'code' || t === 'fence';
}

/** 可拖入的整体导入文件扩展名（.md / .markdown / .mdx / 纯文本） */
const MD_FILE_RE = /\.(md|markdown|mdx|txt)$/i;

/** 可拖入的图片扩展名（只插占位语法，不做上传） */
const IMG_FILE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

/** 撤销合并窗口：相邻同类小编辑落在这个时间内并成一步 */
const UNDO_MERGE_MS = 600;

/** 撤销栈深度上限 */
const UNDO_MAX = 200;

/** 一次历史快照：那一步之后的光标位置要一起恢复 */
interface HistoryEntry {
  text: string;
  caret: number;
}

/**
 * 笔记编辑器。
 *
 * @param props.value 整篇 Markdown
 * @param props.onChange 变化回调
 * @param props.onSave 存在时绑定 Ctrl+S
 * @param props.onImport 存在时启用「拖 .md 文件进来整体导入」
 */
/** 编辑器对外暴露的命令入口，供原生菜单等外部调用 */
export interface EditorHandle {
  /** 执行一条命令，id 见 MarkdownFloats 的 MdCommand.id */
  runCommand(id: string): void;
  toggleSource(): void;
  toggleFocus(): void;
  toggleTypewriter(): void;
  toggleOutline(): void;
}

export interface MirrorEditorProps {
  /** 整篇 Markdown */
  value: string;
  onChange: (v: string) => void;
  /** 存在时绑定 Ctrl+S */
  onSave?: () => void;
  /** 存在时启用「拖 .md 文件进来整体导入」 */
  onImport?: (r: ParsedMarkdownFile) => void;
  /** 专注 / 打字机模式任一开启时回调 true —— 宿主据此收起页面上的说明、页头等干扰 */
  onImmersiveChange?: (on: boolean) => void;
  /** 极简外观：去掉外框，状态栏吸底 —— 用于「整个窗口就是编辑器」的宿主 */
  plain?: boolean;
}

const MirrorEditor = forwardRef<EditorHandle, MirrorEditorProps>(function MirrorEditor(
  { value, onChange, onSave, onImport, onImmersiveChange, plain },
  ref,
) {
  /** 代码块是否显示行号（全局开关）。默认关，值存 localStorage。 */
  const [codeLineNumbers, setCodeLineNumbers] = useState(() => {
    try {
      return localStorage.getItem('jinmo.codeLineNumbers') === '1';
    } catch {
      return false;
    }
  });
  /**
   * 代码块的行长是否折行。默认 **折行**（true），值存 localStorage。
   * 关掉后代码块内长行横向滚动，不再撑宽整页。
   */
  const [codeWrap, setCodeWrap] = useState(() => {
    try {
      return localStorage.getItem('jinmo.codeNoWrap') !== '1';
    } catch {
      return true;
    }
  });
  /**
   * 代码块内 Tab 的缩进宽度（空格数）。默认 4，与正文缩进（2 空格）相互独立。
   */
  const [codeIndentSize, setCodeIndentSize] = useState(() => {
    try {
      const raw = Number(localStorage.getItem('jinmo.codeIndentSize'));
      return Number.isFinite(raw) && raw > 0 ? raw : CODE_INDENT_SIZE_DEFAULT;
    } catch {
      return CODE_INDENT_SIZE_DEFAULT;
    }
  });
  const lines = useMemo(() => buildLines(value, codeLineNumbers), [value, codeLineNumbers]);
  const [caret, setCaret] = useState<Caret>(0);
  /** 专注模式（F8）：只留当前块清晰，其余变淡 */
  const [focusMode, setFocusMode] = useState(false);
  /** 打字机模式（F9）：光标始终停在屏幕垂直中线 */
  const [typewriterMode, setTypewriterMode] = useState(false);
  /**
   * 光标所在行下标，-1 表示未定位。
   * 同步推导而非 useState + useEffect，后者会慢一帧导致浮现闪烁。
   */
  const caretLine = useMemo(() => {
    if (lines.length === 0) return -1;
    const li = lines.findIndex((l, i) => {
      const next = lines[i + 1];
      return caret >= l.start && (!next || caret < next.start);
    });
    return li === -1 ? lines.length - 1 : li;
  }, [caret, lines]);

  /**
   * 专注模式下保持清晰的「当前块」行下标集合，其余行变淡。
   * 列表项按单项划分，其余按连续非空行的整段划分。
   *
   * @returns 行下标集合；未开启专注模式时为 null
   */
  const focusBlock = useMemo(() => {
    if (!focusMode || caretLine < 0) return null;
    const line = lines[caretLine];
    if (!line) return null;

    if (line.kind.type === 'ul' || line.kind.type === 'ol') return new Set<number>([caretLine]);

    let from = caretLine;
    while (from > 0 && lines[from - 1].kind.type !== 'blank') from--;
    let to = caretLine;
    while (to + 1 < lines.length && lines[to + 1].kind.type !== 'blank') to++;
    const block = new Set<number>();
    for (let i = from; i <= to; i++) block.add(i);
    return block;
  }, [caretLine, focusMode, lines]);
  /** 选区锚点；null = 没有选区 */
  const [anchor, setAnchor] = useState<Caret | null>(null);
  /** 右键菜单：位置 + 条目 + 命中的图片/链接；null = 没开 */
  const [menu, setMenu] = useState<{
    pos: FloatPos;
    items: MdMenuItem[];
    /** 右键命中的图片/链接（专用菜单命令按它精确改写）；null = 通用菜单 */
    target: { t: InlineTarget; lineStart: number; lineSrc: string } | null;
  } | null>(null);
  /** 代码块语言下拉：行号 + 弹出位置；null = 关闭 */
  const [langPicker, setLangPicker] = useState<{ lineIndex: number; pos: FloatPos } | null>(null);
  /** 选区格式气泡的位置；null = 不显示 */
  const [bubble, setBubble] = useState<FloatPos | null>(null);
  /**
   * 表格悬浮工具条：`{ pos, at }`。
   *
   * `pos` 是浮层坐标（表格左上角上方），`at` 是 hover 命中的那个格子在全文里的下标 ——
   * 点工具条上的按钮就按这个位置执行，**不去动编辑器里的光标**，
   * 免得用户正在别处做的事被打断。
   */
  const [tableBar, setTableBar] = useState<{ pos: FloatPos; at: number } | null>(null);
  /** 悬浮条要用最新的 lines 算格子源码区间，而监听器只挂一次 */
  const linesRef = useRef<RenderLine[]>([]);

  /** 「插入表格」对话框是否打开 */
  const [tableAsk, setTableAsk] = useState(false);
  /** 表格对话框打开时记下的插入锚点；null = 用当前光标 */
  const [tableAnchor, setTableAnchor] = useState<number | null>(null);
  /**
   * 自绘单行输入框（替代 `window.prompt`）。
   *
   * 桌面壳（Electron）不实现 `window.prompt`，点「插入图像」等会毫无反应；
   * 网页版里它又会阻塞渲染线程。所以统一走这个自绘对话框。
   * null = 不显示；`onConfirm` 拿到去掉首尾空白的输入值。
   */
  const [prompt, setPrompt] = useState<{
    title: string;
    label?: string;
    initial?: string;
    placeholder?: string;
    onConfirm: (v: string) => void;
  } | null>(null);
  /** 状态栏上的一次性提示（如「请按 Ctrl+V」）；用提示条而不是弹窗，不打断操作 */
  const [notice, setNotice] = useState('');
  /** 有文件拖过编辑区时的视觉反馈 */
  const [dragging, setDragging] = useState(false);
  /** 整篇源码模式（Ctrl+/）：整篇按 Markdown 源码编辑，不做任何渲染 */
  const [sourceMode, setSourceMode] = useState(false);
  /** 源码模式的 textarea 与着色层 */
  const sourceRef = useRef<HTMLTextAreaElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  /** 源码模式的逐行着色结果。只在源码模式下算 —— 所见即所得时整篇着色是纯浪费 */
  const sourceHtml = useMemo(
    () => (sourceMode ? highlightMarkdown(value) : EMPTY_HTML),
    [sourceMode, value],
  );
  /** 大纲侧栏是否展开 */
  const [outlineOpen, setOutlineOpen] = useState(false);
  /** 大纲条目：级别、文本、行下标 */
  const headings = useMemo(
    () =>
      lines.flatMap((l, i) =>
        /^h[1-6]$/.test(l.kind.type)
          ? [{ line: i, level: Number(l.kind.type[1]), text: l.src.replace(/^\s*#{1,6}\s+/, '').trim() }]
          : [],
      ),
    [lines],
  );
  /** 撤销栈：entries 是逐步快照，index 指向「当前」状态 */
  const historyRef = useRef<{ entries: HistoryEntry[]; index: number }>({ entries: [], index: -1 });
  /** 上一次小编辑落栈的时刻（毫秒），配合 UNDO_MERGE_MS 判断要不要并入同一步 */
  const lastEditAt = useRef(0);
  /** 上一次小编辑的类别；「合并」只发生在同类相邻小编辑之间（打字连打 / 退格连删） */
  const lastKindRef = useRef<'input' | 'erase' | 'block'>('block');
  /** 每行 DOM，用于点击时按坐标反查字符 */
  const lineEls = useRef<(HTMLDivElement | null)[]>([]);
  /** 光标竖线的位置（相对编辑区容器） */
  const [caretBox, setCaretBox] = useState<{ x: number; y: number; h: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  /** 承接键盘与输入法的隐藏 textarea */
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  /** 是否正在用鼠标拖拽选选区 */
  const dragRef = useRef(false);
  /** 本次按下是否真的拖动过（用来吞掉拖拽后浏览器补发的那个 click） */
  const draggedRef = useRef(false);
  /** 是否聚焦（决定光标显不显示、闪烁不闪烁） */
  const [focused, setFocused] = useState(false);
  /** 输入法预编辑串；非空时显示在光标处 */
  const [composing, setComposing] = useState('');
  /** 是否处于输入法组合中。用 ref 而非 state：input 同步派发，读 state 会拿到旧值 */
  const composingRef = useRef(false);
  /** 用户按 Esc 取消本次组合的标记，与浏览器是否清空控件值无关 */
  const cancelPending = useRef(false);
  /** 刚由输入法提交的文本，用于丢弃紧随其后的重复 input */
  const justComposed = useRef('');

  // ── 查找 / 替换 ──────────────────────────────────────────
  /** 查找面板状态（命中数与当前下标是派生的，不存这里）；null = 面板关闭 */
  const [find, setFind] = useState<Omit<FindState, 'count' | 'index'> | null>(null);
  /** 当前命中在 findHits 里的下标；-1 = 无命中 */
  const [findIndex, setFindIndex] = useState(-1);
  /** 全文命中（随查找串 / 大小写 / 正文变化重算） */
  const findHits = useMemo<FindHit[]>(
    () => (find && find.query ? findAll(value, find.query, find.caseSensitive) : NO_HITS),
    [find, value],
  );

  /**
   * 把绝对字符下标换算成屏幕坐标（用于摆光标）。
   *
   * @param abs 绝对字符下标
   * @param li 该下标所在的行
   * @param map 该行的字符映射表（由 buildCharMap 产出，与点击反查共用同一张表）
   * @returns 光标盒；找不到时为 null
   */
  const measureCaret = useCallback(
    (abs: number, li: number, map: CharMapEntry[]): { x: number; y: number; h: number } | null => {
      if (!wrapRef.current) return null;
      const wr = wrapRef.current.getBoundingClientRect();

      if (li < 0 || li >= lines.length) return null;
      const line = lines[li];
      if (!line) return null;
      // 表格分隔行不渲染（hidden），光标借邻行的行盒摆在行首，别让它凭空消失
      if (line.kind.type === 'tableSep') {
        const nb = lineEls.current[li - 1] ?? lineEls.current[li + 1];
        if (!nb) return null;
        const nr = nb.getBoundingClientRect();
        return { x: nr.left - wr.left, y: nr.top - wr.top, h: nr.height };
      }
      const el = lineEls.current[li];
      if (!el) return null;

      const col = Math.max(0, Math.min(abs - line.start, line.src.length));
      const er = el.getBoundingClientRect();

      // 空行没有可见字符，光标摆在正文起始处。
      // 不能给 0 —— 那是容器的左边缘（在内边距之外），会跑到正文左边去
      if (line.kind.type === 'blank') {
        return { x: er.left - wr.left, y: er.top - wr.top, h: er.height };
      }

      /**
       * 在字符映射表里定位光标。
       * 规则：光标在源码下标 `col` 处，应画在「源码下标 ≥ col 的第一个可见字符」的左边缘；
       * 若 col 已越过后半行，则画在「源码下标 < col 的最后一个可见字符」的右边缘。
       */
      const head = map.find((c) => c.src !== null && c.src >= col);
      const prev = [...map].reverse().find((c) => c.src !== null && c.src < col);
      const cellOf = (e?: CharMapEntry) => e?.node.parentElement?.closest('[data-cell]') ?? null;
      /**
       * 表格里格尾的 `|` 不渲染：光标停在格尾时，「src ≥ col 的第一个可见字符」会是**下一格**的首字，
       * 直接按它画就会把光标画到隔壁格去。这种情况改贴本格最后一个字符的右边缘。
       *
       * ⚠️ 必须排除「有字符的列号正好等于 col」——那是光标正落在某格首字符上，属于正常情况，
       * 不加这个条件就会把光标从第 2 格错误地拉回第 1 格。
       */
      const jumped =
        !!head && !!prev && head.src !== col && cellOf(prev) !== null && cellOf(head) !== cellOf(prev);
      if (head && !jumped) {
        const r = document.createRange();
        r.setStart(head.node, head.offset);
        r.setEnd(head.node, head.offset + 1);
        const rr = r.getBoundingClientRect();
        if (rr.width || rr.height) return { x: rr.left - wr.left, y: rr.top - wr.top, h: rr.height };
      }

      // 光标其实在本格末尾：贴本格最后一个可见字符的右边缘
      if (jumped && prev) {
        const r = document.createRange();
        r.setStart(prev.node, prev.offset);
        r.setEnd(prev.node, prev.offset + 1);
        const rr = r.getBoundingClientRect();
        if (rr.width || rr.height) return { x: rr.right - wr.left, y: rr.top - wr.top, h: rr.height };
      }

      // 行尾：量最后一个有源码映射的字符，取右边缘
      const tail = [...map].reverse().find((c) => c.src !== null);
      if (tail) {
        const len = (tail.node.nodeValue ?? '').length;
        const r = document.createRange();
        r.setStart(tail.node, Math.min(tail.offset, len - 1));
        r.setEnd(tail.node, Math.min(tail.offset + 1, len));
        const rr = r.getBoundingClientRect();
        if (rr.width || rr.height) return { x: rr.right - wr.left, y: rr.top - wr.top, h: rr.height };
      }

      /**
       * 兜底：这一行一个「有源码映射的字符」都没有（空代码行、全是装饰字符的行）。
       * 摆到该行行盒的左边缘，**不能给 0** —— 0 是容器的左边缘（在内边距之外），
       * 光标会画到正文左边去。
       */
      return { x: er.left - wr.left, y: er.top - wr.top, h: er.height };
    },
    [lines],
  );

  /**
   * 判断某一行是否处于编辑态：光标在本行、编辑器已聚焦，且行类型支持浮现。
   * 表格行渲染为网格，不算编辑态。
   *
   * @param li 行下标
   * @returns 是否编辑态
   */
  const isEditingLine = useCallback(
    (li: number): boolean => {
      const l = lines[li];
      return !!l && focused && li === caretLine && REVEALABLE.has(l.kind.type);
    },
    [caretLine, focused, lines],
  );

  /**
   * 取某一行实际要渲染的片段：编辑态下光标所在的行内元素露出标记。
   *
   * 渲染与 buildCharMap 必须都调用此函数，否则 DOM 与列号映射不一致。
   *
   * @param li 行下标
   * @returns 该行要渲染的片段
   */
  const effectiveSegs = useCallback(
    (li: number): InlineSeg[] => {
      const line = lines[li];
      if (!line) return [];
      if (!isEditingLine(li)) return line.segs;
      return revealSegAt(line.segs, line.src, caret - line.start);
    },
    [caret, isEditingLine, lines],
  );

  /**
   * 建立「DOM 可见字符」与「源码下标」的对应表，点击反查与光标绘制共用。
   *
   * 列号算法见 md-inline 的 charColsForLine，按片段消费。
   *
   * @param li 行下标
   * @returns 逐可见字符映射；行不存在时返回空数组
   */
  const buildCharMap = useCallback(
    (li: number): CharMapEntry[] => {
      const el = lineEls.current[li];
      const line = lines[li];
      if (!el || !line) return [];

      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const nodes: { node: Text; text: string; decorative: boolean }[] = [];
      let n: Text | null;
      while ((n = walker.nextNode() as Text | null)) {
        // 跳过 MathJax 输出的文本（SVG 内的 title、mjx-assistive-mml 里的 MathML），
        // 它们不占源码列 —— 渲染成公式后可见文本只剩我们补的那个隐藏占位。
        // 语言标签与行号同理：都是控件不是正文，混进映射表会让整行的列号错位。
        if (n.parentElement?.closest('mjx-container, svg, .MathJax, .md-lang-btn, .md-code-lineno'))
          continue;
        const text = n.nodeValue ?? '';
        if (!text) continue;
        const cls = n.parentElement?.className ?? '';
        // 预编辑串与列表圆点/序号是「正在输入 / 纯装饰」，不属于正文，不占源码列
        const decorative = cls.includes('md-preedit') || cls.includes('md-list-marker');
        nodes.push({ node: n, text, decorative });
      }

      let cols: number[];
      if (line.kind.type === 'tableHead' || line.kind.type === 'tableBody') {
        // 表格行：DOM 是去掉竖线后的单元格文本，映射也按「去竖线后的片段」消费
        const cellSegs = tableCellRanges(line.src).flatMap((r) => sliceSegs(line.segs, r.from, r.to));
        cols = charColsForLine(cellSegs, false, nodes);
      } else if (line.kind.type === 'fence') {
        // 围栏行整行按源码原样渲染，列号 1:1
        cols = [];
        for (const nd of nodes) {
          for (let k = 0; k < nd.text.length; k++) cols.push(k < line.src.length ? k : -1);
        }
      } else if (line.kind.type === 'code' && line.src === '') {
        /**
         * 空代码行：DOM 里只有一个 nbsp 占位符（一个字符都不渲染的话这一行高度会塌成 0，
         * 代码块底色中间就断开了）。它没有对应的源码字符，把它挂到列 0 上，
         * 光标才画得到这一行的文字起始处；不挂就会掉进 measureCaret 的兜底分支，画到行盒左边缘去。
         */
        cols = [];
        for (const nd of nodes) {
          for (let k = 0; k < nd.text.length; k++) cols.push(0);
        }
      } else {
        // 与 JSX 的渲染条件保持一致：只有编辑态才渲染块前缀节点
        const prefixRendered = isEditingLine(li) && line.prefixText !== '';
        cols = charColsForLine(effectiveSegs(li), prefixRendered, nodes);
      }

      const final: CharMapEntry[] = [];
      let idx = 0;
      for (const nd of nodes) {
        for (let k = 0; k < nd.text.length; k++) {
          const c = cols[idx];
          idx++;
          final.push({ node: nd.node, offset: k, src: typeof c === 'number' && c >= 0 ? c : null });
        }
      }
      return final;
    },
    [effectiveSegs, isEditingLine, lines],
  );

  /** 光标 / 行 / 文本任一变化 → 重新量光标位置 */
  useLayoutEffect(() => {
    const map = buildCharMap(caretLine);
    setCaretBox(measureCaret(caret, caretLine, map));
  }, [caret, caretLine, buildCharMap, measureCaret, value]);

  /** 光标变了 → 把隐藏输入框挪到光标处，让输入法候选窗出现在正确位置 */
  useLayoutEffect(() => {
    const ta = inputRef.current;
    if (!ta || !caretBox || !wrapRef.current) return;
    const wr = wrapRef.current.getBoundingClientRect();
    ta.style.left = `${caretBox.x}px`;
    ta.style.top = `${caretBox.y}px`;
    ta.style.height = `${caretBox.h}px`;
    void wr;
  }, [caretBox]);

  /** 状态栏提示 3 秒后自动消失 */
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  /**
   * 进入源码模式时把光标位置带过去：textaree 选区设为当前光标并滚入视野。
   * 依赖只写 sourceMode，避免用户输入时被反复拽回。
   */
  useEffect(() => {
    if (!sourceMode) return;
    const ta = sourceRef.current;
    if (!ta) return;
    ta.focus();
    const pos = Math.max(0, Math.min(caret, ta.value.length));
    ta.setSelectionRange(pos, pos);
    // 按行高估算，够用即可（精确量需要建镜像元素，不值当）
    const line = ta.value.slice(0, pos).split('\n').length - 1;
    ta.scrollTop = Math.max(0, line * 22 - ta.clientHeight / 2);
    syncSourceScroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceMode]);

  /** 专注 / 打字机任一开启 → 告诉宿主「进沉浸了」，让它把页头、说明这些干扰收起来 */
  useEffect(() => {
    onImmersiveChange?.(focusMode || typewriterMode);
  }, [focusMode, typewriterMode, onImmersiveChange]);

  /**
   * 打字机模式：把光标钉在屏幕垂直中线上。
   * 依赖只放 caretBox（相对编辑区，不受页面滚动影响），滚完不会再触发。
   */
  useLayoutEffect(() => {
    if (!typewriterMode || !focused || !caretBox) return;
    const wr = wrapRef.current?.getBoundingClientRect();
    if (!wr) return;
    const caretY = wr.top + caretBox.y + caretBox.h / 2;
    const delta = caretY - window.innerHeight / 2;
    if (Math.abs(delta) > 1) window.scrollBy(0, delta);
  }, [caretBox, focused, typewriterMode]);

  /**
   * 有选区时把格式气泡浮到选区末尾上方。
   * 位置为视口坐标，需由相对编辑区的坐标补上容器偏移。
   */
  useEffect(() => {
    if (menu || anchor === null || anchor === caret) {
      setBubble(null);
      return;
    }
    const abs = Math.max(anchor, caret);
    const { index } = lineIndexOf(value, abs);
    const box = measureCaret(abs, index, buildCharMap(index));
    const wr = wrapRef.current?.getBoundingClientRect();
    if (!box || !wr) {
      setBubble(null);
      return;
    }
    setBubble({
      x: Math.max(8, Math.min(wr.left + box.x, window.innerWidth - 240)),
      y: Math.max(8, wr.top + box.y - 44),
    });
  }, [anchor, caret, menu, value, measureCaret, buildCharMap]);

  /**
   * 应用一次编辑：写回文本、摆好光标、推进撤销栈。
   *
   * @param r 编辑结果
   * @param kind 编辑类别：'input' 打字（可合并）｜'erase' 退格删除（可合并）｜
   * 'block' 结构性操作（粘贴 / IME 上屏 / 命令，自成一步撤销）
   */
  const applyEdit = useCallback(
    (r: EditOutcome, kind: 'input' | 'erase' | 'block' = 'block') => {
      const h = historyRef.current;
      const now = Date.now();
      // 只有「同类相邻小编辑」才并入上一步；类别变了或超时就另起一步
      const merged =
        kind !== 'block' &&
        kind === lastKindRef.current &&
        now - lastEditAt.current < UNDO_MERGE_MS &&
        h.entries[h.index] !== undefined;
      if (merged) {
        h.entries[h.index] = { text: r.text, caret: r.caret };
      } else {
        // 另起一步：丢弃当前状态之后的重做分支
        h.entries = h.entries.slice(0, h.index + 1);
        h.entries.push({ text: r.text, caret: r.caret });
        if (h.entries.length > UNDO_MAX) h.entries.shift();
        h.index = h.entries.length - 1;
      }
      lastEditAt.current = now;
      lastKindRef.current = kind;
      onChange(r.text);
      setCaret(r.caret);
      /**
       * 多行缩进这类命令要保留原选中范围（Tab 连按才能继续缩进同一段）。
       * 其余命令一律收起选区。
       */
      if (r.select) {
        setAnchor(r.select.start === r.select.end ? null : r.select.start);
        setCaret(r.select.end);
      } else {
        setAnchor(null);
      }
    },
    [onChange],
  );

  /** 撤销：回退到上一步快照 */
  const undo = useCallback(() => {
    const h = historyRef.current;
    if (h.index <= 0) return;
    h.index -= 1;
    const e = h.entries[h.index];
    lastEditAt.current = 0;
    lastKindRef.current = 'block';
    onChange(e.text);
    setCaret(e.caret);
    setAnchor(null);
  }, [onChange]);

  /** 重做：前进到下一步快照 */
  const redo = useCallback(() => {
    const h = historyRef.current;
    if (h.index >= h.entries.length - 1) return;
    h.index += 1;
    const e = h.entries[h.index];
    lastEditAt.current = 0;
    lastKindRef.current = 'block';
    onChange(e.text);
    setCaret(e.caret);
    setAnchor(null);
  }, [onChange]);

  /** 正文被编辑器以外的方式改写（整体导入、父组件重置）→ 撤销栈作废重建 */
  useEffect(() => {
    const h = historyRef.current;
    const top = h.entries[h.index];
    if (!top || top.text !== value) {
      h.entries = [{ text: value, caret }];
      h.index = 0;
      lastEditAt.current = 0;
      lastKindRef.current = 'block';
    }
  }, [value, caret]);

  /** 当前选区（没有选中时 start === end === caret） */
  const currentSelection = useCallback((): Selection => {
    const a = anchor ?? caret;
    return { start: Math.min(a, caret), end: Math.max(a, caret) };
  }, [anchor, caret]);

  // ── 查找 / 替换：定位、导航、替换 ──────────────────────────

  /**
   * 把某处命中滚进视野并选中；其余命中由查找高亮表示，避免两套高亮互相覆盖。
   */
  const gotoHit = useCallback(
    (i: number) => {
      const h = findHits[i];
      if (!h) return;
      setAnchor(h.start);
      setCaret(h.end);
      setFindIndex(i);
      requestAnimationFrame(() => {
        const li = lines.findIndex((l, k) => {
          const next = lines[k + 1];
          return h.start >= l.start && (!next || h.start < next.start);
        });
        if (li >= 0) lineEls.current[li]?.scrollIntoView({ block: 'center' });
      });
    },
    [findHits, lines],
  );

  /** 命中下标兜底：查找串变了、命中数变了，都保证下标合法 */
  useEffect(() => {
    if (!find || findHits.length === 0) {
      setFindIndex(-1);
      return;
    }
    setFindIndex((i) => {
      if (i >= 0 && i < findHits.length) return i;
      // 新一次查找：从光标处往后找第一处，找不到就回到第一处
      const at = findHits.findIndex((h) => h.start >= caret);
      return at === -1 ? 0 : at;
    });
  }, [find, findHits, caret]);

  /** 打开面板（Ctrl+F 查找 / Ctrl+H 替换） */
  const openFind = useCallback((mode: 'find' | 'replace') => {
    setFind((f) => (f ? { ...f, mode } : { mode, query: '', replace: '', caseSensitive: false }));
  }, []);

  /** 关闭面板并把焦点还给编辑器 */
  const closeFind = useCallback(() => {
    setFind(null);
    setFindIndex(-1);
    inputRef.current?.focus();
  }, []);

  const findNext = useCallback(() => {
    if (!findHits.length) return;
    gotoHit((findIndex + 1) % findHits.length);
  }, [findHits, findIndex, gotoHit]);

  const findPrev = useCallback(() => {
    if (!findHits.length) return;
    gotoHit((findIndex - 1 + findHits.length) % findHits.length);
  }, [findHits, findIndex, gotoHit]);

  /** 替换当前命中，并把光标移到下一处 */
  const replaceOne = useCallback(() => {
    if (!find || findIndex < 0) return;
    const h = findHits[findIndex];
    if (!h) return;
    const next = value.slice(0, h.start) + find.replace + value.slice(h.end);
    const nextCaret = h.start + find.replace.length;
    applyEdit({ text: next, caret: nextCaret }, 'block');
    // 用新文本直接算下一次命中，别等 findHits 重算（那是下一帧的事）
    const nh = findAll(next, find.query, find.caseSensitive);
    const at = nh.findIndex((x) => x.start >= nextCaret);
    setFindIndex(at === -1 ? (nh.length ? 0 : -1) : at);
  }, [applyEdit, find, findHits, findIndex, value]);

  /** 全部替换（从后往前替换，避免下标错位） */
  const replaceAll = useCallback(() => {
    if (!find || findHits.length === 0) return;
    let next = value;
    for (let i = findHits.length - 1; i >= 0; i--) {
      const h = findHits[i];
      next = next.slice(0, h.start) + find.replace + next.slice(h.end);
    }
    applyEdit({ text: next, caret: Math.min(caret, next.length) }, 'block');
    setNotice(`已替换 ${findHits.length} 处`);
  }, [applyEdit, caret, find, findHits, value]);

  /**
   * 把当前行的前缀换成 `prefix`（传空串 = 去掉前缀变正文）。
   *
   * 用于「转为引用 / 无序列表 / 有序列表 / 待办项 / 正文」这类整行切换命令。
   *
   * @param prefix 新的行前缀（如 `> ` / `- ` / `1. ` / `- [ ] `）
   */
  const setLinePrefix = useCallback(
    (prefix: string) => {
      const { start, end } = lineBoundsAt(value, caret);
      const line = value.slice(start, end);
      const bare = line.replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+|-\s\[[ xX]\]\s+)/, '');
      const next = prefix + bare;
      applyEdit({
        text: value.slice(0, start) + next + value.slice(end),
        caret: start + next.length,
      });
    },
    [applyEdit, caret, value],
  );

  /**
   * 在当前行之后另起一段插入一个块片段（表格 / 代码块 / 分割线）。
   *
   * @param snippet 片段源码（含内部光标占位约定，见 SNIPPETS）
   */
  const insertAfterLine = useCallback(
    (snippet: string, at?: number) => {
      applyEdit(insertBlock(value, at ?? caret, snippet, 'below'));
    },
    [applyEdit, caret, value],
  );

  /**
   * 找光标所在代码块的起止行号。
   *
   * @param from 起始查找的行号（一般是光标所在行）
   * @returns 开围栏行号与闭围栏行号；找不到开围栏时都是 -1，没有闭围栏时 close 为 -1
   */
  const codeBlockRangeAt = (from: number): { open: number; close: number } => {
    const all = value.split('\n');
    let open = -1;
    for (let i = from; i >= 0; i--) {
      if (/^\s*(?:`{3,}|~{3,})/.test(all[i])) {
        open = i;
        break;
      }
    }
    if (open === -1) return { open: -1, close: -1 };
    let close = -1;
    for (let i = open + 1; i < all.length; i++) {
      if (/^\s*(?:`{3,}|~{3,})/.test(all[i])) {
        close = i;
        break;
      }
    }
    return { open, close };
  };

  /**
   * 代码块外侧的两个插入锚点。
   *
   * 「插入 / 段落」在代码块里被调用时，插入点必须挪到代码块**外面**：
   * 否则插进去的表格、代码块会被当成代码文本，连续插两个代码块就分不清谁是谁。
   *
   * @returns `before` = 开围栏行的行首（插在块上方用）；`after` = 闭围栏行的行尾（插在块下方用）。
   *          光标不在代码块里时返回 null
   */
  const codeBlockOuter = (): { before: number; after: number } | null => {
    if (!getContext(value, caret).code) return null;
    const { open, close } = codeBlockRangeAt(lineIndexOf(value, caret).index);
    if (open === -1) return null;
    return {
      before: caretAtLineEdge(value, open, 'start'),
      after: close === -1 ? value.length : caretAtLineEdge(value, close, 'end'),
    };
  };

  /**
   * 改代码块的语言：只重写围栏 info string 里的语言词，围栏标记长度与
   * **行号属性（`{.numberLines startFrom="N"}`）都原样保留**。
   *
   * @param li 开围栏所在行号
   * @param lang 语言标识；空串 = 纯文本
   */
  const setCodeLang = useCallback(
    (li: number, lang: string) => {
      const l = lines[li];
      if (!l || !l.codeFence) return;
      const indent = /^\s*/.exec(l.src)?.[0] ?? '';
      const marker = /^\s*(`{3,}|~{3,})/.exec(l.src)?.[1] ?? '```';
      const opts = parseFenceOptions(l.src.slice(indent.length + marker.length).trim());
      const info = buildFenceLine(indent, marker, lang, fenceAttrs(opts.lineNumbers === true, opts.firstLineNumber));
      applyEdit({
        text: value.slice(0, l.start) + info + value.slice(l.start + l.src.length),
        caret: l.start + info.length,
      });
    },
    [applyEdit, lines, value],
  );

  /**
   * 点代码块右上角的语言标签：在标签下方弹出语言列表。
   *
   * @param li 开围栏所在行号
   * @param e 点击事件，用来取标签位置
   */
  const onPickLang = (li: number, e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setBubble(null);
    setLangPicker({ lineIndex: li, pos: { x: r.left, y: r.bottom + 4 } });
  };

  /**
   * 统一的命令分发 —— 格式气泡、右键菜单、快捷键都走这里。
   *
   * @param id 命令标识（见 MarkdownFloats 的 MdCommand.id）
   */
  const runCommand = useCallback(
    (id: string) => {
      setMenu(null);
      setBubble(null);
      // 菜单是 Portal，点它的按钮会拿走焦点 —— 立刻拿回隐藏输入框，
      // 否则「粘贴被拒后请按 Ctrl+V」的提示是空话：按了也没人接事件
      inputRef.current?.focus();
      const sel = currentSelection();

      // ── 代码块语言（id 形如 `lang:<行号>:<语言>`，见 buildLangMenu） ──
      if (id.startsWith('lang:')) {
        const rest = id.slice(5);
        const cut = rest.indexOf(':');
        setCodeLang(Number(rest.slice(0, cut)), rest.slice(cut + 1));
        return;
      }

      // ── 行内格式：再按一次取消 ──
      const markOf: Record<string, string> = {
        bold: '**',
        italic: '*',
        strike: '~~',
        code: '`',
        highlight: '==',
        // 行内公式 `$x$`：与行内代码同构，一对同字符包裹
        math: '$',
      };
      if (id === 'link') {
        applyEdit(insertLink(value, sel));
        return;
      }
      if (markOf[id]) {
        const mark = markOf[id];
        applyEdit(unwrapSelection(value, sel, mark) ?? wrapSelection(value, sel, mark));
        return;
      }

      // ── 标题：换掉已有的标题标记 ──
      const headingLevels: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
      if (id in headingLevels) {
        const level = headingLevels[id];
        const { start, end } = lineBoundsAt(value, caret);
        const line = value.slice(start, end);
        const bare = line.replace(/^\s*#{1,6}\s+/, '');
        const next = '#'.repeat(level) + ' ' + bare;
        applyEdit({ text: value.slice(0, start) + next + value.slice(end), caret: start + next.length });
        return;
      }

      // ── 整行前缀切换 ──
      if (id === 'normal') return setLinePrefix('');
      if (id === 'quote') return setLinePrefix('> ');
      if (id === 'bullet') return setLinePrefix('- ');
      if (id === 'ordered') return setLinePrefix('1. ');
      if (id === 'todo') return setLinePrefix('- [ ] ');

      // ── 缩进 / 反缩进（Ctrl+[ / Ctrl+]） ──
      if (id === 'indent' || id === 'outdent') {
        const dir = id === 'indent' ? 'in' : 'out';
        const unit = indentUnitAt(value, caret, codeIndentSize);
        // 有选区就整段缩进；无选区只动光标那一行
        if (sel.end > sel.start) {
          return applyEdit(indentLines(value, sel.start, sel.end, dir, unit));
        }
        return applyEdit(indentLine(value, caret, dir, unit));
      }

      // ── 升降标题级别（Ctrl+= / Ctrl+-） ──
      if (id === 'heading-up') return applyEdit(changeHeadingLevel(value, caret, 1));
      if (id === 'heading-down') return applyEdit(changeHeadingLevel(value, caret, -1));

      // ── 另起一段插入。在代码块里调用时插入点要挪到块外（见 codeBlockOuter） ──
      const outer = codeBlockOuter();
      const belowAt = outer ? outer.after : caret;
      if (id === 'table') {
        // 行列数让用户填。锚点要记下来 ——
        // 对话框确认时组件可能已重渲染，那时再读 caret 就不一定是原来的位置了
        setTableAnchor(outer ? outer.after : null);
        setTableAsk(true);
        return;
      }
      if (id === 'codeblock') return insertAfterLine(SNIPPETS.code, belowAt);
      if (id === 'mathblock') return insertAfterLine(SNIPPETS.math, belowAt);
      if (id === 'toc') return insertAfterLine(SNIPPETS.toc, belowAt);
      if (id === 'linkref') return insertAfterLine(SNIPPETS.linkref, belowAt);
      if (id === 'hr') return insertAfterLine(SNIPPETS.hr, belowAt);
      if (id === 'p-before') {
        return applyEdit(insertParagraph(value, outer ? outer.before : caret, 'above'));
      }
      if (id === 'p-after') return applyEdit(insertParagraph(value, belowAt, 'below'));

      // ── 脚注：在光标处插引用标记（定义行由用户自己写在文末） ──
      if (id === 'footnote') {
        const mark = '[^1]';
        applyEdit({
          text: value.slice(0, sel.start) + mark + value.slice(sel.end),
          caret: sel.start + mark.length,
        });
        return;
      }

      // ── YAML Front Matter：只能有一份，放在整篇最前面 ──
      if (id === 'yaml') {
        if (/^---\r?\n/.test(value)) {
          setNotice('开头已经有 YAML Front Matter 了');
          return;
        }
        const snippet = SNIPPETS.yaml;
        applyEdit({ text: snippet + '\n\n' + value, caret: snippet.indexOf('\n') + 1 });
        return;
      }

      // ── 撤销 / 重做 / 全选 / 清除格式 ──
      if (id === 'undo') return undo();
      if (id === 'redo') return redo();
      if (id === 'select-all') {
        setAnchor(0);
        setCaret(value.length);
        return;
      }
      if (id === 'clear-format') {
        const r = clearInlineFormat(value, currentSelection());
        if (!r) {
          setNotice('先选中一段带格式的文字');
          return;
        }
        applyEdit(r);
        return;
      }

      // ── 表格：旧菜单的两条（保留兼容） ──
      if (id === 'table-row') {
        const r = tableAddRow(value, caret);
        if (r) applyEdit(r);
        return;
      }
      if (id === 'table-col') {
        const r = tableAddColumn(value);
        if (r) applyEdit(r);
        return;
      }

      // ── 表格：完整操作（九项菜单） ──
      if (id.startsWith('table-')) {
        const pos = tablePosAt(value, caret);
        if (!pos) {
          setNotice('光标不在表格里');
          return;
        }
        if (id === 'table-copy') {
          const { from, to } = tableBlockRange(pos);
          void navigator.clipboard.writeText(value.slice(from, to)).then(
            () => setNotice('已复制表格源码'),
            () => setNotice('浏览器拒绝了剪贴板写入，请选中后 Ctrl+C'),
          );
          return;
        }
        // 分隔行是表头的附属行，在它上下插行会让表头与分隔行脱节
        if ((id === 'table-row-above' || id === 'table-row-below') && pos.rowIndex === 1) {
          setNotice('光标在分隔行上，请放到数据行再插行');
          return;
        }
        if (id === 'table-row-delete' && pos.rowIndex <= 1) {
          setNotice('表头与分隔行不能单独删，可用「删除表格」');
          return;
        }
        if (id === 'table-col-delete' && pos.cols <= 1) {
          setNotice('只剩一列了，再删就不成表格');
          return;
        }
        const r =
          id === 'table-row-above'
            ? tableInsertRow(value, caret, 'above')
            : id === 'table-row-below'
              ? tableInsertRow(value, caret, 'below')
              : id === 'table-row-delete'
                ? tableDeleteRow(value, caret)
                : id === 'table-col-left'
                  ? tableInsertColumn(value, caret, 'left')
                  : id === 'table-col-right'
                    ? tableInsertColumn(value, caret, 'right')
                    : id === 'table-col-delete'
                      ? tableDeleteColumn(value, caret)
                      : id === 'table-row-up'
                        ? tableMoveRow(value, caret, 'up')
                        : id === 'table-row-down'
                          ? tableMoveRow(value, caret, 'down')
                          : id === 'table-col-move-left'
                            ? tableMoveColumn(value, caret, 'left')
                            : id === 'table-col-move-right'
                              ? tableMoveColumn(value, caret, 'right')
                              : id === 'table-format'
                        ? tableFormatSource(value, caret)
                        : id === 'table-align-left'
                          ? tableSetAlign(value, caret, 'left')
                          : id === 'table-align-center'
                            ? tableSetAlign(value, caret, 'center')
                            : id === 'table-align-right'
                              ? tableSetAlign(value, caret, 'right')
                              : id === 'table-align-none'
                                ? tableSetAlign(value, caret, 'none')
                                : id === 'table-delete'
                                  ? tableDelete(value, caret)
                                  : null;
        if (r) applyEdit(r);
        return;
      }

      // ── 剪贴板：走平台层。桌面版由主进程读写（渲染进程的 navigator.clipboard
      //    在 Electron 里默认被拒），网页版才用浏览器 API ──
      if (id === 'cut' || id === 'copy') {
        const text = value.slice(sel.start, sel.end);
        if (!text) {
          setNotice('先选中要操作的文字');
          return;
        }
        writeClipboard(text).then((ok) =>
          setNotice(ok ? (id === 'cut' ? '已剪切' : '已复制') : '剪贴板写入被拒，请用 Ctrl+C / Ctrl+X'),
        );
        if (id === 'cut') {
          applyEdit({ text: value.slice(0, sel.start) + value.slice(sel.end), caret: sel.start });
        }
        return;
      }
      if (id === 'paste') {
        const insert = (t: string) => {
          if (!t) return;
          const s = currentSelection();
          /**
           * 光标停在**围栏行**上时，把插入点挪进代码块正文。
           *
           * 直接插在围栏行里会把 ` ``` ` 撕坏（实测变成 `` ``PASTED` ``，代码块结构没了）。
           * 开围栏 → 内容成为第一条代码行；闭围栏 → 内容成为最后一条代码行（插在闭围栏上方）。
           *
           * 开/闭靠「本行之前的围栏数」判奇偶：偶数=开围栏，奇数=闭围栏。
           * 不能用 `codeBlockRangeAt` —— 它从光标行往**回**找围栏，光标停在闭围栏上时会找到它自己。
           */
          let at = s.start;
          let end = s.end;
          let text = t;
          const all = value.split('\n');
          const li = lineIndexOf(value, s.start).index;
          const isFence = (l: string) => /^\s*(?:`{3,}|~{3,})/.test(l);
          if (li >= 0 && li < all.length && isFence(all[li])) {
            const before = all.slice(0, li).filter(isFence).length;
            const targetLine = before % 2 === 0 ? li + 1 : li;
            if (targetLine < all.length) {
              let p = 0;
              for (let i = 0; i < targetLine; i++) p += all[i].length + 1;
              at = p;
              end = p;
              // 目标行本身有内容时补一个换行，别把新内容粘到原代码行上
              if (all[targetLine] !== '') text = t + '\n';
            }
          }
          applyEdit({
            text: value.slice(0, at) + text + value.slice(end),
            caret: at + text.length,
          });
        };
        readClipboard().then((t) => {
          if (!t) {
            setNotice('剪贴板为空或读取被拒 —— 也可直接按 Ctrl+V');
            return;
          }
          insert(t);
        });
        return;
      }

      // ── 删除这一段 ──
      if (id === 'delete-block') {
        const { start, end } = lineBoundsAt(value, caret);
        // 连同结尾换行一起删；删最后一行时改删前导换行，免得留下空行
        const from = end < value.length ? start : Math.max(0, start - 1);
        const to = end < value.length ? end + 1 : end;
        const next = value.slice(0, from) + value.slice(to);
        applyEdit({ text: next, caret: Math.min(from, next.length) });
        return;
      }

      // ── 右键命中的图片/链接：按 onContextMenu 存下的目标精确改写 ──
      if (id === 'link-open' || id === 'link-replace' || id === 'image-replace' || id === 'image-alt') {
        const mt = menu?.target;
        if (!mt) return;
        const absStart = mt.lineStart + mt.t.start;
        const absEnd = mt.lineStart + mt.t.end;
        if (id === 'link-open') {
          if (!mt.t.href) {
            setNotice('这个链接没有地址');
            return;
          }
          window.open(mt.t.href, '_blank', 'noopener,noreferrer');
          return;
        }
        if (id === 'link-replace' || id === 'image-replace') {
          const isImg = id === 'image-replace';
          setPrompt({
            title: isImg ? '修改图片地址' : '修改链接地址',
            label: '新的地址（http/https 或图床链接）',
            initial: mt.t.href || 'https://',
            placeholder: 'https://',
            onConfirm: (newUrl) => {
              const syntax = (isImg ? '!' : '') + `[${mt.t.label}](${newUrl})`;
              applyEdit({
                text: value.slice(0, absStart) + syntax + value.slice(absEnd),
                caret: absStart + syntax.length,
              });
            },
          });
          return;
        }
        // image-alt
        setPrompt({
          title: '修改替代文字',
          label: '替代文字（图片加载失败时显示）',
          initial: mt.t.label,
          onConfirm: (newAlt) => {
            const syntax = `![${newAlt}](${mt.t.href})`;
            applyEdit({
              text: value.slice(0, absStart) + syntax + value.slice(absEnd),
              caret: absStart + syntax.length,
            });
          },
        });
        return;
      }

      // ── 图片：问地址插入 URL 图片；本地文件走「本地图片…」或直接拖进来 ──
      if (id === 'image') {
        setPrompt({
          title: '插入图片',
          label: '图片地址（http/https 或图床链接）',
          placeholder: 'https://',
          onConfirm: (src) => {
            applyEdit(insertImage(value, currentSelection(), src));
          },
        });
        return;
      }

      // ── 本地图片：弹系统文件选择框（桌面版原生对话框 / 网页版 input[type=file]） ──
      if (id === 'image-file') {
        pickImages()
          .then((srcs) => {
            if (!srcs.length) return;
            const s = currentSelection();
            // 多选时每个文件单独一行 —— 不能塞给 insertImage，那会把整串当同一个地址
            const snippet = srcs.map((src) => `![](${src})`).join('\n');
            applyEdit({
              text: value.slice(0, s.start) + snippet + value.slice(s.end),
              caret: s.start + snippet.length,
            });
          })
          .catch(() => setNotice('打开图片选择框失败'));
        return;
      }

      // ── 代码块：复制内容 / 跳到块外 / 语言 / 行号 / 折行 / 缩进宽度 ──
      if (
        id === 'code-copy' ||
        id === 'code-exit' ||
        id === 'code-lineno' ||
        id === 'code-wrap' ||
        id === 'code-lang' ||
        id.startsWith('code-indent:')
      ) {
        // 缩进宽度与语言不需要定位到围栏，先单独处理
        if (id.startsWith('code-indent:')) {
          const size = Number(id.slice('code-indent:'.length));
          if (!Number.isFinite(size) || size <= 0) return;
          setCodeIndentSize(size);
          try {
            localStorage.setItem('jinmo.codeIndentSize', String(size));
          } catch {
            /* 隐私模式下写不了，忽略 */
          }
          setNotice(`代码块缩进宽度：${size} 个空格`);
          return;
        }
        if (id === 'code-wrap') {
          const next = !codeWrap;
          setCodeWrap(next);
          try {
            localStorage.setItem('jinmo.codeNoWrap', next ? '0' : '1');
          } catch {
            /* 隐私模式下写不了，忽略 */
          }
          setNotice(next ? '代码块恢复折行' : '代码块不折行（横向滚动）');
          return;
        }
        if (id === 'code-lang') {
          const li = lineIndexOf(value, caret).index;
          const el = lineEls.current[li];
          const r = el?.getBoundingClientRect();
          setMenu(null);
          setBubble(null);
          setLangPicker({
            lineIndex: codeBlockRangeAt(li).open,
            pos: { x: r?.left ?? 120, y: (r?.bottom ?? 120) + 4 },
          });
          return;
        }

        const all = value.split('\n');
        const { open, close } = codeBlockRangeAt(lineIndexOf(value, caret).index);
        if (open === -1) return;

        // 行号开关：全局设置，改完存盘
        if (id === 'code-lineno') {
          const next = !codeLineNumbers;
          setCodeLineNumbers(next);
          try {
            localStorage.setItem('jinmo.codeLineNumbers', next ? '1' : '0');
          } catch {
            /* 隐私模式下写不了，忽略 */
          }
          setNotice(next ? '代码块显示行号' : '代码块隐藏行号');
          return;
        }

        const lastLine = close === -1 ? all.length : close;
        if (id === 'code-copy') {
          navigator.clipboard
            .writeText(all.slice(open + 1, lastLine).join('\n'))
            .catch(() => window.alert('浏览器拒绝了剪贴板权限'));
          return;
        }
        // code-exit：把光标挪到闭栏之后另起一行
        if (close === -1) {
          const next = value + (value.endsWith('\n') ? '' : '\n');
          applyEdit({ text: next, caret: next.length });
        } else if (close + 1 < all.length) {
          applyEdit({ text: value, caret: caretAtLineEdge(value, close + 1, 'start') });
        } else {
          const next = value + '\n';
          applyEdit({ text: next, caret: next.length });
        }
        return;
      }

      // ── 选中当前行源码（「编辑源码」的落点：源码就在眼前，选中即可改） ──
      // 右键的是图片/链接时，选中它所在的那一整行（光标可能不在那一行上）
      if (id === 'source') {
        const mt = menu?.target;
        if (mt) {
          setAnchor(mt.lineStart);
          setCaret(mt.lineStart + mt.lineSrc.length);
        } else {
          const { start, end } = lineBoundsAt(value, caret);
          setAnchor(start);
          setCaret(end);
        }
        inputRef.current?.focus();
        return;
      }
    },
    [
      applyEdit,
      caret,
      currentSelection,
      insertAfterLine,
      menu,
      redo,
      setCodeLang,
      setLinePrefix,
      undo,
      value,
    ],
  );

  // 供原生菜单等外部调用
  useImperativeHandle(
    ref,
    () => ({
      runCommand: (id: string) => runCommand(id),
      toggleSource: () => setSourceMode((v) => !v),
      toggleFocus: () => setFocusMode((v) => !v),
      toggleTypewriter: () => setTypewriterMode((v) => !v),
      toggleOutline: () => setOutlineOpen((v) => !v),
    }),
    [runCommand],
  );

  /**
   * 右键落点是否应**保留当前选区**。
   *
   * 落点判定给一个字符的容差：选区只有两三个字时很窄，右键稍微偏一点就落到相邻字上，
   * 选区被清掉、接着点「复制」就成了空操作（用户反馈"选中文字后点右键，
   * 文字已经没处于被选中状态了"）。行自己的 onContextMenu 与编辑区空白处的
   * onBackgroundContextMenu 必须共用这一份判断 —— 之前后者是无条件清选区的。
   *
   * @param pos 右键落点对应的绝对下标
   * @returns true = 保留选区不动
   */
  const keepSelectionFor = (pos: number): boolean => {
    if (anchor === null || anchor === caret) return false;
    const from = Math.min(anchor, caret);
    const to = Math.max(anchor, caret);
    return pos >= from - 1 && pos <= to + 1;
  };

  /**
   * 右键：先把光标落到鼠标所在行的对应位置，再按上下文生成菜单。
   * 命中图片或链接语法时生成专用菜单。
   *
   * @param e 鼠标事件
   * @param li 被右键的行下标
   */
  const onContextMenu = (e: React.MouseEvent, li: number) => {
    e.preventDefault();
    const pos = caretFromPoint(li, e.clientX, e.clientY);
    /**
     * 右键点在已有选区内时不动选区，否则复制会得到空内容。
     */
    if (!keepSelectionFor(pos)) {
      setCaret(pos);
      setAnchor(null);
    }
    setBubble(null);

    const line = lines[li];
    // 列号夹进行范围（pos 可能落在行尾换行上）；命中则带出「行内起止 + 行位置」供命令改写
    const col = Math.max(0, Math.min(pos - line.start, Math.max(0, line.src.length - 1)));
    const hit = inlineTargetAt(line.src, col);
    const target = hit ? { t: hit, lineStart: line.start, lineSrc: line.src } : null;
    const items = hit
      ? hit.kind === 'image'
        ? buildImageMenu()
        : buildLinkMenu()
      : buildContextMenu(getContext(value, pos), { extended: true, codeLineNumbers, codeWrap, codeIndentSize });
    setMenu({ pos: { x: e.clientX, y: e.clientY }, items, target });
  };

  /**
   * 在某一行的字符表里反查光标下标，点左半边落在字前、右半边落在字后。
   *
   * 传入 clientY 时先按 Y 锁定视觉行再在行内按 X 找，否则折行段落会跨行抓错字。
   *
   * @param li 行下标
   * @param clientX 视口横坐标
   * @param clientY 视口纵坐标，可选
   * @returns 光标绝对下标
   */
  const caretFromPoint = useCallback(
    (li: number, clientX: number, clientY?: number): number => {
      const line = lines[li];
      if (!line || !wrapRef.current) return caret;
      const wr = wrapRef.current.getBoundingClientRect();
      const el = lineEls.current[li];
      const map = buildCharMap(li);
      let next = line.start + line.kind.prefixLen;

      /**
       * ── 折行后的命中修正 ──
       *
       * 代码块与长段落折行后，同一个「逻辑行」在屏幕上占多个「视觉行」。
       * 只按 X 找字符 → 点到第二视觉行会落到第一视觉行的字上（看着点在缩进后的位置、光标却跳到上面）。
       *
       * 浏览器原生的 `caretRangeFromPoint` 本来就按「视觉行 + X」命中，先拿它锁定**视觉行**；
       * 但它是按最近字符边界吸附的（点在字右半边仍返回字前），
       * 所以**列号仍要自己算**：在该视觉行范围内，按点击点落在字符中点的哪一侧决定 before/after。
       * 两个都失败（旧内核、点到行外）时才退回纯手算。
       */
      const nativeBand = (): { top: number; bottom: number } | null => {
        if (clientY === undefined || !el) return null;
        // 点必须真的落在这个行元素上，否则会命中隔壁行
        if (clientX < elBox.left || clientX > elBox.right || clientY < elBox.top || clientY > elBox.bottom)
          return null;
        const anyDoc = document as Document & {
          caretRangeFromPoint?: (x: number, y: number) => Range | null;
          caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
        };
        let node: Node | null = null;
        let offset = 0;
        if (typeof anyDoc.caretRangeFromPoint === 'function') {
          const r = anyDoc.caretRangeFromPoint(clientX, clientY);
          if (r) {
            node = r.startContainer;
            offset = r.startOffset;
          }
        } else if (typeof anyDoc.caretPositionFromPoint === 'function') {
          const p = anyDoc.caretPositionFromPoint(clientX, clientY);
          if (p) {
            node = p.offsetNode;
            offset = p.offset;
          }
        }
        if (!node || node.nodeType !== Node.TEXT_NODE) return null;
        // 用命中的那个字符圈出「视觉行」的上下界
        const hit = map.find((c) => c.node === node && c.offset === offset);
        const anchor = hit ?? map.find((c) => c.node === node);
        if (!anchor) return null;
        const r = document.createRange();
        r.setStart(anchor.node, Math.min(anchor.offset, (anchor.node.nodeValue ?? '').length - 1));
        r.setEnd(r.startContainer, Math.min(anchor.offset + 1, (anchor.node.nodeValue ?? '').length));
        const rr = r.getBoundingClientRect();
        if (!rr.height && !rr.width) return null;
        // 上下各放 3px 容差，紧贴视觉行边缘点击时不至于掉进相邻视觉行
        return { top: rr.top - 3, bottom: rr.bottom + 3 };
      };

      const elBox = el?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0);

      if (line.kind.type !== 'hr' && map.length) {
        const clickRel = clientX - wr.left;
        /**
         * 第一遍：锁定视觉行。
         * 优先用浏览器原生命中（折行、缩进、等宽字体全都自动对上），
         * 拿不到就退回「按 Y 找最近字符」。
         */
        let bandTop = Number.NEGATIVE_INFINITY;
        let bandBottom = Number.POSITIVE_INFINITY;
        const native = nativeBand();
        if (native) {
          bandTop = native.top;
          bandBottom = native.bottom;
        } else if (clientY !== undefined) {
          let bestDy = Number.POSITIVE_INFINITY;
          let bestRect: DOMRect | null = null;
          for (const c of map) {
            if (c.src === null) continue;
            const r = document.createRange();
            r.setStart(c.node, c.offset);
            r.setEnd(c.node, c.offset + 1);
            const rr = r.getBoundingClientRect();
            if (!rr.width) continue;
            const dy = Math.abs(rr.top + rr.height / 2 - clientY);
            if (dy < bestDy) {
              bestDy = dy;
              bestRect = rr;
            }
          }
          if (bestRect) {
            bandTop = bestRect.top - 2;
            bandBottom = bestRect.bottom + 2;
          }
        }
        // 第二遍：视觉行内按 X 找最近字符。点左半边落在字前、右半边落在字后
        let bestDist = Number.POSITIVE_INFINITY;
        for (const c of map) {
          if (c.src === null) continue;
          const r = document.createRange();
          r.setStart(c.node, c.offset);
          r.setEnd(c.node, c.offset + 1);
          const rr = r.getBoundingClientRect();
          if (!rr.width) continue;
          if (rr.bottom < bandTop || rr.top > bandBottom) continue;
          const mid = rr.left + rr.width / 2 - wr.left;
          const d = Math.abs(mid - clickRel);
          if (d < bestDist) {
            bestDist = d;
            next = line.start + c.src + (clickRel > mid ? 1 : 0);
          }
        }
      }

      // 表格：光标必须落在「被点的那一格」的源码范围内。
      // 格与格之间的 `|` 不渲染，不钳住就会算到隔壁格去（看着在第一格、打字却进第二格）
      if (line.kind.type === 'tableHead' || line.kind.type === 'tableBody') {
        const cells = el ? [...el.children] : [];
        const hitIdx = cells.findIndex((c) => {
          const r = c.getBoundingClientRect();
          return clientX >= r.left && clientX <= r.right;
        });
        const range = hitIdx === -1 ? undefined : tableCellRanges(line.src)[hitIdx];
        if (range) {
          next = Math.max(line.start + range.from, Math.min(next, line.start + range.to));
        }
      }

      return Math.max(line.start, Math.min(next, line.start + line.src.length));
    },
    [caret, lines],
  );

  /** 点击行：把光标放到离点击点最近的那个字符旁 */
  const onLineClick = (li: number, e: React.MouseEvent) => {
    const line = lines[li];
    if (!line) return;
  /**
   * 刚拖拽过则不动选区：浏览器在 mouseup 后还会补发 click。
   */
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
  /**
   * 点击是重新放置光标的动作，顺带清除可能残留的组合态。
   */
    if (composingRef.current) {
      composingRef.current = false;
      setComposing('');
    }
    setCaret(caretFromPoint(li, e.clientX, e.clientY));
    setAnchor(e.shiftKey ? caret : null);
    inputRef.current?.focus();
  };

  /**
   * 按视口坐标反查光标下标 —— 拖拽时鼠标会跨行，光靠行下标不够。
   *
   * @param clientX 视口横坐标
   * @param clientY 视口纵坐标
   * @returns 光标绝对下标
   */
  const caretFromPointXY = useCallback(
    (clientX: number, clientY: number): number => {
      const els = lineEls.current;
      let li = -1;
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (clientY >= r.top && clientY <= r.bottom) {
          li = i;
          break;
        }
      }
      // 鼠标拖到编辑区外：夹到首行 / 末行，别让选区跳空
      if (li === -1) {
        const first = els[0]?.getBoundingClientRect();
        li = first && clientY < first.top ? 0 : Math.max(0, lines.length - 1);
      }
      return caretFromPoint(li, clientX, clientY);
    },
    [caretFromPoint, lines.length],
  );

  /**
   * 左键按下：开始拖拽选区。
   *
   * 必须 preventDefault 关掉浏览器原生选择，否则两套选区会叠加。
   */
  const onLineMouseDown = (li: number, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const pos = caretFromPoint(li, e.clientX, e.clientY);
    dragRef.current = true;
    draggedRef.current = false;
    setAnchor(pos);
    setCaret(pos);
    inputRef.current?.focus();
  };

  /** 拖拽中：跟着鼠标更新光标那一端（锚点不动） */
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      draggedRef.current = true;
      setCaret(caretFromPointXY(e.clientX, e.clientY));
    };
    const onUp = () => {
      dragRef.current = false;
      // 没真的拖动时 anchor === caret，语义上就是「没有选区」，无需额外清理
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [caretFromPointXY]);

  /**
   * 键盘处理。所有按键在这里翻译成「文本编辑原语」的调用。
   *
   * @param e 来自隐藏 textarea 的键盘事件
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
  /**
   * Esc 表示取消组合，需在组合判定之前记录；该标记交给 onCompositionEnd。
   * Esc 时浏览器仍会派发 compositionend，缺少标记会导致取消却填入文本。
   */
    if (e.key === 'Escape' && composingRef.current) cancelPending.current = true;

  /**
   * 组合期间不处理任何按键，那是 IME 中间状态。
   * 判据用浏览器给的 isComposing，而非自身 state —— 后者在 compositionend 丢失后会永久为真。
   */
    if (e.nativeEvent.isComposing) return;

  /**
   * 自愈：浏览器称不在组合中却仍挂着预编辑串，先复位再处理本次按键。
   */
    if (composingRef.current) {
      composingRef.current = false;
      setComposing('');
    }

    const mod = e.ctrlKey || e.metaKey;

    // ── Alt+Shift+5：删除线（Shift+5 在部分键盘上是 %） ──
    if (e.altKey && e.shiftKey && (e.key === '5' || e.key === '%')) {
      e.preventDefault();
      runCommand('strike');
      return;
    }

    if (mod) {
      const k = e.key.toLowerCase();
      if (k === 's') {
        e.preventDefault();
        onSave?.();
        return;
      }
      // ── 撤销 / 重做 ──
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault();
        redo();
        return;
      }
  /**
   * 剪贴板不能在此 preventDefault，否则浏览器原生事件不派发。
   * 实际读写在 textarea 的 onCopy / onCut / onPaste 上完成。
   */

  // Shift 变体需排在普通变体之前，否则 Ctrl+Shift+K 会落进 Ctrl+K
      if (e.shiftKey && k === 'k') {
        e.preventDefault();
        runCommand('codeblock');
        return;
      }
      if (e.shiftKey && k === 'q') {
        e.preventDefault();
        runCommand('quote');
        return;
      }
      // Shift+[ / Shift+] 在多数键盘上是 { / }，两种都收
      if (e.shiftKey && (k === '[' || k === '{')) {
        e.preventDefault();
        runCommand('ordered');
        return;
      }
      if (e.shiftKey && (k === ']' || k === '}')) {
        e.preventDefault();
        runCommand('bullet');
        return;
      }
      if (e.shiftKey && k === 'i') {
        e.preventDefault();
        runCommand('image');
        return;
      }
      if (e.shiftKey && (k === '`' || k === '~')) {
        e.preventDefault();
        runCommand('code');
        return;
      }

      // 标题档位 Ctrl+1..6 / 正文 Ctrl+0
      if (/^[1-6]$/.test(k) && !e.shiftKey) {
        e.preventDefault();
        runCommand('h' + k);
        return;
      }
      if (k === '0' && !e.shiftKey) {
        e.preventDefault();
        runCommand('normal');
        return;
      }
      if (k === 't' && !e.shiftKey) {
        e.preventDefault();
        runCommand('table');
        return;
      }
      if (k === 'a' && !e.shiftKey) {
        e.preventDefault();
        runCommand('select-all');
        return;
      }
      if (k === '\\') {
        e.preventDefault();
        runCommand('clear-format');
        return;
      }

      // 表格内：Ctrl+E 选单元格 / Ctrl+L 选行 / Ctrl+Shift+Backspace 删行
      if (k === 'e' || k === 'l' || (k === 'backspace' && e.shiftKey)) {
        const p = tablePosAt(value, caret);
        if (p) {
          e.preventDefault();
          const base = p.lineStarts[p.rowIndex];
          if (k === 'e') {
            const range = tableCellRanges(p.lines[p.rowIndex])[p.colIndex];
            if (range) {
              setAnchor(base + range.from);
              setCaret(base + range.to);
            }
          } else if (k === 'l') {
            setAnchor(base);
            setCaret(base + p.lines[p.rowIndex].length);
          } else {
            runCommand('table-row-delete');
          }
          return;
        }
      }

      // ── 查找 / 替换 ──
      if (k === 'f') {
        e.preventDefault();
        openFind('find');
        return;
      }
      if (k === 'h') {
        e.preventDefault();
        openFind('replace');
        return;
      }

      // ── 大纲侧栏（Ctrl+Shift+O） ──
      if (k === 'o' && e.shiftKey) {
        e.preventDefault();
        setOutlineOpen((v) => !v);
        return;
      }

      // ── 整篇源码模式（Ctrl+/） ──
      if (k === '/') {
        e.preventDefault();
        setSourceMode(true);
        return;
      }

      // ── 选中词（Ctrl+D）/ 删除词（Ctrl+Shift+D） ──
      if (k === 'd') {
        e.preventDefault();
        if (e.shiftKey) {
          const r = deleteWordAt(value, caret);
          if (r) applyEdit(r, 'erase');
          return;
        }
        // 已有选区 → 选中「同一段文字」的下一处
        const hasSel = anchor !== null && anchor !== caret;
        if (hasSel) {
          const a = Math.min(anchor!, caret);
          const b = Math.max(anchor!, caret);
          const selText = value.slice(a, b);
          const nextAt = value.indexOf(selText, b);
          if (selText && nextAt !== -1) {
            setAnchor(nextAt);
            setCaret(nextAt + selText.length);
            return;
          }
        }
        const w = wordBoundsAt(value, caret);
        if (w) {
          setAnchor(w.start);
          setCaret(w.end);
        }
        return;
      }

      // ── 文首（Ctrl+Home）/ 文末（Ctrl+End）/ 跳到选区（Ctrl+J） ──
      if (k === 'home') {
        e.preventDefault();
        setAnchor(null);
        setCaret(0);
        return;
      }
      if (k === 'end') {
        e.preventDefault();
        setAnchor(null);
        setCaret(value.length);
        return;
      }
      if (k === 'j') {
        e.preventDefault();
        const li = lineIndexOf(value, caret).index;
        lineEls.current[li]?.scrollIntoView({ block: 'center' });
        return;
      }

      // ── 缩进 / 反缩进（Ctrl+[ / Ctrl+]；官方表：`[` 缩进、`]` 反缩进） ──
      if (k === '[') {
        e.preventDefault();
        runCommand('indent');
        return;
      }
      if (k === ']') {
        e.preventDefault();
        runCommand('outdent');
        return;
      }

      // ── 升降标题级别（Ctrl+= / Ctrl++ 升；Ctrl+- 降） ──
      if (k === '=' || k === '+') {
        e.preventDefault();
        runCommand('heading-up');
        return;
      }
      if (k === '-') {
        e.preventDefault();
        runCommand('heading-down');
        return;
      }

      const shortcutOf: Record<string, string> = { b: 'bold', i: 'italic', k: 'link', '`': 'code' };
      const cmd = shortcutOf[k];
      if (cmd) {
        e.preventDefault();
        runCommand(cmd);
        return;
      }
    }

    // ── F8 专注模式 / F9 打字机模式 ──
    if (e.key === 'F8') {
      e.preventDefault();
      setFocusMode((v) => !v);
      return;
    }
    if (e.key === 'F9') {
      e.preventDefault();
      setTypewriterMode((v) => !v);
      return;
    }

    // 选区：有 anchor 时，Backspace/Delete 删整段选区
    const hasSel = anchor !== null && anchor !== caret;
    const selStart = hasSel ? Math.min(anchor!, caret) : caret;
    const selEnd = hasSel ? Math.max(anchor!, caret) : caret;

    /**
     * ── Tab / Shift+Tab ──
     *
     * 规则（对齐主流代码编辑器）：
     *  - 表格内：跳到下一格；末格跳下一行首格；末行末格不加行，直接停在块尾
     *  - 有选区：缩进 / 反缩进选区覆盖到的每一行，并保留选区
     *  - 无选区：插入一个缩进单位（代码块内 4 空格，正文 2 空格）
     *
     * 必须 preventDefault —— 否则浏览器会把焦点移出编辑器，Tab 在编辑器里直接失效。
     */
    if (e.key === 'Tab') {
      e.preventDefault();
      const dir: 1 | -1 = e.shiftKey ? -1 : 1;

      if (inTable(value, caret)) {
        const target = tableTabTarget(value, caret, dir);
        if (target !== null) {
          setAnchor(null);
          setCaret(target);
        } else if (dir === 1) {
          setNotice('已在表格末尾');
        }
        return;
      }

      const unit = indentUnitAt(value, caret, codeIndentSize);
      if (hasSel) {
        applyEdit(indentLines(value, selStart, selEnd, dir === 1 ? 'in' : 'out', unit));
      } else if (dir === 1) {
        applyEdit(insertAt(value, caret, unit), 'input');
      } else {
        applyEdit(indentLine(value, caret, 'out', unit), 'input');
      }
      return;
    }

    switch (e.key) {
      case 'Backspace': {
        e.preventDefault();
        if (hasSel) {
          applyEdit({ text: value.slice(0, selStart) + value.slice(selEnd), caret: selStart }, 'erase');
        } else {
          applyEdit(backspace(value, caret), 'erase');
        }
        return;
      }
      case 'Delete': {
        e.preventDefault();
        if (hasSel) {
          applyEdit({ text: value.slice(0, selStart) + value.slice(selEnd), caret: selStart }, 'erase');
        } else {
          applyEdit(del(value, caret), 'erase');
        }
        return;
      }
      case 'Enter': {
        e.preventDefault();
        // Shift+Enter = 软换行：只断行、不续写列表（Enter 才会补出下一项前缀）
        if (e.shiftKey) {
          if (hasSel) {
            const head = value.slice(0, selStart) + '\n';
            applyEdit({ text: head + value.slice(selEnd), caret: head.length });
          } else {
            applyEdit(softBreak(value, caret));
          }
          return;
        }
        if (hasSel) {
          const head = value.slice(0, selStart) + '\n';
          applyEdit({ text: head + value.slice(selEnd), caret: head.length });
        } else {
          applyEdit(enter(value, caret));
        }
        return;
      }
      case 'ArrowLeft':
      case 'ArrowRight': {
        e.preventDefault();
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        const next = moveChar(value, hasSel && !e.shiftKey ? selStart : caret, hasSel && !e.shiftKey ? dir : dir);
        setCaret(next);
        if (e.shiftKey) {
          if (anchor === null) setAnchor(caret);
        } else {
          setAnchor(null);
        }
        return;
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault();
        const dir = e.key === 'ArrowUp' ? -1 : 1;
        if (hasSel && !e.shiftKey) {
          setCaret(dir === -1 ? selStart : selEnd);
          setAnchor(null);
          return;
        }
        const next = moveLine(value, caret, dir as -1 | 1);
        setCaret(next);
        if (e.shiftKey) {
          if (anchor === null) setAnchor(caret);
        } else {
          setAnchor(null);
        }
        return;
      }
      case 'Home':
      case 'End': {
        e.preventDefault();
        const { index } = lineIndexOf(value, caret);
        const next = caretAtLineEdge(value, index, e.key === 'Home' ? 'start' : 'end');
        setCaret(next);
        if (e.shiftKey) {
          if (anchor === null) setAnchor(caret);
        } else {
          setAnchor(null);
        }
        return;
      }
      default:
        break;
    }

    // 普通字符由 onChange（input 事件）统一处理，这里不插手
  };

  /**
   * 隐藏 textarea 的 input 事件，处理普通字符输入。
   *
   * 需丢弃两类 input：组合期的中间态 input，以及 compositionend 之后的重复 input。
   * 判据必须用 ref，input 同步派发时读 state 会拿到旧值。
   *
   * @param e 事件
   */
  const onInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;

    /** 浏览器对本次 input 的「是否处于组合中」表态；合成事件里该字段不存在（undefined） */
    const composingNow = (e.nativeEvent as Partial<InputEvent>).isComposing;

  /**
   * 自愈：浏览器称已不在组合中但 composingRef 仍为真，说明 compositionend 丢失。
   * 不复位会永久卡死。只在值为 false 时复位，undefined 表示浏览器未表态。
   */
    if (composingNow === false && composingRef.current) {
      composingRef.current = false;
      setComposing('');
    }

  /**
   * 组合期间不得改动这个 textarea（包括 value = ''），否则会打断输入法内部状态。
   * 判据两条并用：浏览器表态在组合中，或自身的 composingRef。
   */
    if (composingNow === true || composingRef.current) return;

    // 非组合期才清空：这个 textarea 只是「键盘通道」，不保存内容
    const typed = ta.value;
    ta.value = '';

  /**
   * 丢弃 compositionend 之后紧随的重复 input，判据为内容相同。
   * 消费后立即清空，保证只吃掉那一次。
   */
    if (typed && typed === justComposed.current) {
      justComposed.current = '';
      return;
    }
    if (!typed) return;

    // 有选区则先删掉选区再插入
    const hasSel = anchor !== null && anchor !== caret;
    const selStart = hasSel ? Math.min(anchor!, caret) : caret;
    const selEnd = hasSel ? Math.max(anchor!, caret) : caret;
    const base = hasSel ? value.slice(0, selStart) + value.slice(selEnd) : value;
    const pos = hasSel ? selStart : caret;
    applyEdit(insertAt(base, pos, typed), 'input');
  };

  /**
   * IME 开始组合。同步置 composingRef：组合期间浏览器会多次派发 input，
   * 需全部丢弃，否则拼音字母会被当正文插入。
   */
  const onCompositionStart = () => {
    composingRef.current = true;
    cancelPending.current = false; // 新一次组合，清掉上一轮的取消标记
    setComposing('\u200b'); // 占位，标记「正在输入」
  };

  /** IME 更新预编辑串 —— 把候选串显示在光标位置 */
  const onCompositionUpdate = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
    setComposing(e.data || '');
  };

  /**
   * IME 提交，把最终结果插入文本。
   *
   * 提交内容由两条信号共同判定：cancelPending 表示取消，不插入；
   * 否则取 textarea 当前值。不能只用 e.data —— Esc 取消时 e.data 可能仍是拼音。
   */
  const onCompositionEnd = (_e: React.CompositionEvent<HTMLTextAreaElement>) => {
    setComposing('');
    composingRef.current = false;
    const ta = inputRef.current;
    const committed = cancelPending.current ? '' : ta?.value ?? '';
    cancelPending.current = false;
    if (ta) ta.value = '';
    // 标记「刚提交的文本」；onInput 只丢弃与它内容相同的那一次
    justComposed.current = committed;
    if (!committed) return;
    applyEdit(insertAt(value, caret, committed));
  };

  /** 预编辑串（`\u200b` 是「刚开始组合」的占位，不显示） */
  const preedit = composing && composing !== '\u200b' ? composing : '';

  /**
   * 拖进来的文件：.md 整体导入（走 onImport 回调），图片插占位语法。
   *
   * @param file 用户拖进来的文件
   */
  const handleDrop = useCallback(
    async (file: File) => {
      if (MD_FILE_RE.test(file.name) && file.type !== 'image/svg+xml') {
        const parsed = parseMarkdownFile(await file.text(), file.name.replace(/\.[^.]+$/, ''));
        if (onImport) {
          onImport(parsed);
          setNotice(`已从 ${file.name} 载入`);
        } else {
          setNotice('这个页面没有接入整体导入，.md 文件已忽略');
        }
        return;
      }
      if (IMG_FILE_RE.test(file.name)) {
        applyEdit(insertImage(value, currentSelection(), file.name));
        setNotice(`已插入图片占位：${file.name}（需换成图床链接才能显示）`);
        return;
      }
      setNotice('只认 .md 文本文件和图片文件');
    },
    [applyEdit, currentSelection, onImport, value],
  );

  /**
   * 退出源码模式：把光标带到 textarea 的选区处，再把焦点还给隐藏输入框。
   * 焦点需等一帧，此刻隐藏 textarea 尚未挂回。
   */
  const exitSource = useCallback(() => {
    const ta = sourceRef.current;
    if (ta) setCaret(Math.max(0, Math.min(ta.selectionStart, value.length)));
    setSourceMode(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [value]);

  /** 勾选 / 取消某个任务列表项（就地改写源码里的 `[ ]` / `[x]`） */
  const toggleTaskAt = useCallback(
    (li: number, col: number) => {
      const line = lines[li];
      if (!line) return;
      const abs = line.start + col;
      const cur = value.slice(abs, abs + 3);
      if (!/^\[[ xX]\]$/.test(cur)) return;
      const next = cur[1] === ' ' ? '[x]' : '[ ]';
      applyEdit({ text: value.slice(0, abs) + next + value.slice(abs + 3), caret: abs + 3 });
    },
    [applyEdit, lines, value],
  );

  /**
   * 编辑区空白处按下：光标落到文末；末尾不是空行就先补一行。
   *
   * 点在行上时不插手 —— 那种情况交给行自己的处理函数（按坐标反查落点）。
   * 只处理左键：右键走 onBackgroundContextMenu，在这里改文档会让右键凭空多出一个换行。
   */
  const onBackgroundMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    /**
     * 只处理**真正落在编辑器里**的按下。
     *
     * 语言选择器 / 右键菜单 / 各种弹窗都是 `createPortal` 到 `body` 的，
     * 在 DOM 树里不在编辑器内；但它们在 **React 组件树**里仍是本容器的子节点，
     * 事件会沿着组件树冒泡到这里 —— 不挡住的话，点选择器的搜索框会被下面那句
     * `focus()` 把焦点抢回编辑器（实测：点输入框后 `focusin` 直接变成「编辑器输入」，
     * 用户看到的就是"点一下就乱跳"）。
     */
    if (!e.currentTarget.contains(e.target as Node)) return;
    inputRef.current?.focus();
    if ((e.target as HTMLElement).closest('.cursor-text')) return;
    e.preventDefault();
    if (value === '') return;
    if (value.endsWith('\n')) {
      setAnchor(null);
      setCaret(value.length);
    } else {
      applyEdit({ text: value + '\n', caret: value.length + 1 });
    }
  };

  /**
   * 按视口坐标找它落在哪一行。
   *
   * 右键点在行元素之外时（左右内边距、行与行之间的空隙）用得到：
   * 把 x 夹进正文列再取元素，否则点在 30px 内边距里取到的永远是容器，找不到行。
   *
   * @param clientX 视口横坐标
   * @param clientY 视口纵坐标
   * @returns 行下标；不在任何行上时 -1
   */
  const lineIndexAtPoint = (clientX: number, clientY: number): number => {
    // 任意一行都能给出正文列的左右边界（所有行的行盒一样宽）
    const sample = lineEls.current.find((el) => el);
    const sr = sample?.getBoundingClientRect();
    const x = sr ? Math.min(Math.max(clientX, sr.left + 1), sr.right - 1) : clientX;
    const hit = document.elementFromPoint(x, clientY) as HTMLElement | null;
    const raw = hit?.closest?.('.md-line')?.getAttribute('data-li');
    if (raw != null) return Number(raw);

    /**
     * 没命中任何行（点在行内边距、代码块容器的上下内边距、行间空隙上）：
     * 取**纵向最近**的那一行。
     *
     * ⚠️ 不能返回 -1 交给调用方"丢到文末"：代码块容器 `.md-fences` 有 8px/6px 上下内边距，
     * 点在块内这圈空白上会被判成"不在任何行上"，光标直接飞到文档末尾 ——
     * 表现就是"想往代码块里粘贴，内容却落到了代码块下面的空白处"（实测踩过）。
     */
    let best = -1;
    let bestDy = Number.POSITIVE_INFINITY;
    for (let i = 0; i < lineEls.current.length; i++) {
      const el = lineEls.current[i];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      // 隐藏行（表格分隔行 display:none）尺寸为 0，跳过
      if (r.width === 0 && r.height === 0) continue;
      const dy = clientY < r.top ? r.top - clientY : clientY > r.bottom ? clientY - r.bottom : 0;
      if (dy < bestDy) {
        bestDy = dy;
        best = i;
      }
    }
    return best;
  };

  /**
   * 编辑区空白处右键：光标先落到鼠标所在的那一行，再按该处上下文出菜单。
   *
   * 点在行上时直接返回 —— 行自己的 onContextMenu 已经处理过，事件会冒泡到这里。
   *
   * ⚠️ 不能一律把光标丢到文末：左右各有 30px 内边距，右键很容易落在行元素之外，
   * 那样「插入表格」会插到文档末尾，跟右键的位置完全对不上。
   */
  const onBackgroundContextMenu = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.md-line')) return;
    e.preventDefault();
    inputRef.current?.focus();

    const li = lineIndexAtPoint(e.clientX, e.clientY);
    let pos: number;
    if (li >= 0) {
      pos = caretFromPoint(li, e.clientX, e.clientY);
    } else {
      // 不在任何行上：在正文上方就落文首，在下方就落文末
      const first = lineEls.current.find((el) => el);
      const fr = first?.getBoundingClientRect();
      pos = fr && e.clientY < fr.top ? 0 : value.length;
    }
    /**
     * 右键落在已有选区内时**不动选区**，否则复制 / 剪切会拿到空内容。
     *
     * 与行自己的 `onContextMenu` 共用同一份判断：右键点在行的左右内边距、
     * 行间空隙、代码块容器的上下内边距上时，事件不会走到行自己的处理器、只走到这里 ——
     * 这里原来是无条件 `setAnchor(null)`，选区会被清掉。
     */
    if (!keepSelectionFor(pos)) {
      setCaret(pos);
      setAnchor(null);
    }
    setBubble(null);
    setMenu({
      pos: { x: e.clientX, y: e.clientY },
      items: buildContextMenu(getContext(value, pos), { extended: true, codeLineNumbers, codeWrap, codeIndentSize }),
      target: null,
    });
  };

  /** 跳到某一行的行首，并把该行滚到视野中间（大纲点击用） */
  const jumpToLine = useCallback(
    (li: number) => {
      const line = lines[li];
      if (!line) return;
      setAnchor(null);
      setCaret(line.start);
      inputRef.current?.focus();
      lineEls.current[li]?.scrollIntoView({ block: 'center' });
    },
    [lines],
  );

  /**
   * 取某一行的查找命中（转成行内列号）。
   *
   * 在父组件算而不是让行组件自己算：行组件要凭「没有命中」这个稳定结果跳过重渲染，
   * 一旦它自己去读 `line.start`，父组件就没法把 `start` 从比较里摘出去（见 linePropsEqual）。
   *
   * @param li 行下标
   * @returns 本行的命中范围（行内列号）；没有命中时返回同一个空数组引用
   */
  const hitsForLine = (li: number): { start: number; end: number }[] => {
    if (findHits.length === 0) return NO_HITS;
    const l = lines[li];
    if (!l) return NO_HITS;
    const lineEnd = l.start + l.src.length;
    const out: { start: number; end: number }[] = [];
    for (const h of findHits) {
      if (h.start >= lineEnd || h.end <= l.start) continue;
      out.push({
        start: Math.max(h.start, l.start) - l.start,
        end: Math.min(h.end, lineEnd) - l.start,
      });
    }
    return out.length ? out : NO_HITS;
  };

  /**
   * 源码模式：把着色层的滚动同步到 textarea。
   *
   * textarea 出现竖向滚动条时内容区会窄一截，着色层必须补上同样的右内边距，
   * 否则两边的折行位置不同、颜色会与文字错位。
   */
  const syncSourceScroll = () => {
    const ta = sourceRef.current;
    const pre = preRef.current;
    if (!ta || !pre) return;
    pre.style.paddingRight = `${20 + (ta.offsetWidth - ta.clientWidth)}px`;
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  };

  /** 行元素引用登记。必须是稳定引用，否则记忆化的行组件每次都会重渲染 */
  const registerLine = useCallback((li: number, el: HTMLDivElement | null) => {
    lineEls.current[li] = el;
  }, []);

  /**
   * 行的鼠标处理函数用 ref 转发。
   *
   * 这几个函数每次渲染都会重建，直接传给记忆化的行组件会让记忆化彻底失效。
   */
  const lineHandlers = useRef({ onLineClick, onLineMouseDown, onContextMenu, onPickLang });
  lineHandlers.current = { onLineClick, onLineMouseDown, onContextMenu, onPickLang };

  /**
   * 传给记忆化行组件的必须是**稳定引用**：只包一层 useCallback([])，
   * 内部再去读 ref 里的最新实现。直接把 `lineHandlers.current.xxx` 传下去没用 ——
   * ref 每次渲染都被赋成新函数，引用照样每次都变。
   */
  const stableLineClick = useCallback((li: number, e: React.MouseEvent) => {
    lineHandlers.current.onLineClick(li, e);
  }, []);
  const stableLineMouseDown = useCallback((li: number, e: React.MouseEvent) => {
    lineHandlers.current.onLineMouseDown(li, e);
  }, []);
  const stableContextMenu = useCallback((e: React.MouseEvent, li: number) => {
    lineHandlers.current.onContextMenu(e, li);
  }, []);
  const stablePickLang = useCallback((li: number, e: React.MouseEvent<HTMLButtonElement>) => {
    lineHandlers.current.onPickLang(li, e);
  }, []);

  /** 选区范围在全局算一次，别给每一行重复算 */
  const selLo = anchor !== null && anchor !== caret ? Math.min(anchor, caret) : null;
  const selHi = selLo === null ? null : Math.max(anchor ?? 0, caret);

  // ── 整篇源码模式：整篇按 Markdown 源码编辑，不做任何渲染 ──
  //
  // 纯文本视图，故用原生 textarea：输入法、撤销、选区、滚动都由它提供。
  // 着色画在下层的 <pre> 里；行号由每一行自己的 ::before 画在左内边距中 ——
  // 这样长段落折行时行号仍与该行首行对齐（行号若单独成一列，折行后整列都会漂）。
  if (sourceMode) {
    return (
      <div className={`bg-background ${plain ? 'flex min-h-screen flex-col' : 'rounded-lg border border-border'}`}>
        <div className="relative h-[70vh]">
          <pre
            ref={preRef}
            aria-hidden="true"
            className="md-src-pre pointer-events-none absolute inset-0 overflow-hidden py-4 font-mono text-[13px] leading-[1.7]"
            dangerouslySetInnerHTML={{
              __html: sourceHtml
                .map((h, i) => `<div class="md-src-line" data-n="${i + 1}">${h || '<br>'}</div>`)
                .join(''),
            }}
          />
          <textarea
            ref={sourceRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onScroll={syncSourceScroll}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === '/') {
                e.preventDefault();
                exitSource();
              }
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Markdown 源码"
            className="md-src-input absolute inset-0 resize-none overflow-auto bg-transparent py-4 pr-5 font-mono text-[13px] leading-[1.7] text-transparent caret-foreground outline-none"
          />
        </div>
        <div
          className={`border-t border-border px-4 py-2 text-[11px] text-muted-foreground ${
            plain ? 'sticky bottom-0 mt-auto bg-background' : ''
          }`}
        >
          源码模式 · 整篇 Markdown　<span className="text-accent">Ctrl+/</span> 返回所见即所得
        </div>
      </div>
    );
  }

  /**
   * 渲染一行。抽出来是因为代码块要把连续若干行塞进同一个容器里。
   *
   * @param i 行下标
   * @param inFence 本行是否在代码块容器内（容器已画边框，行不再自己补边）
   * @returns 行元素
   */
  const renderLine = (i: number, inFence: boolean, gap = false) => {
    const l = lines[i];
    if (!l) return null;
    return (
      <EditorLine
        key={i}
        line={l}
        index={i}
        gap={gap}
        editing={isEditingLine(i)}
        mathEditing={
          l.mathBlockFirst !== undefined &&
          caretLine >= (l.mathBlockFirst ?? 0) &&
          caretLine <= (l.mathBlockLast ?? 0)
        }
        dimmed={!!(focusMode && focusBlock && !focusBlock.has(i))}
        isTableLast={
          (l.kind.type === 'tableHead' || l.kind.type === 'tableBody') &&
          lines[i + 1]?.kind.type !== 'tableBody' &&
          lines[i + 1]?.kind.type !== 'tableSep'
        }
        isCodeFirst={!inFence && isCodeLike(lines, i) && !isCodeLike(lines, i - 1)}
        isCodeLast={!inFence && isCodeLike(lines, i) && !isCodeLike(lines, i + 1)}
        selStart={selLo === null ? 0 : selLo - l.start}
        selEnd={selHi === null ? 0 : selHi - l.start}
        caretCol={i === caretLine ? caret - l.start : -1}
        preedit={i === caretLine ? preedit : ''}
        lineHits={hitsForLine(i)}
        onLineClick={stableLineClick}
        onLineMouseDown={stableLineMouseDown}
        onContextMenu={stableContextMenu}
        onToggleTask={toggleTaskAt}
        onPickLang={stablePickLang}
        registerLine={registerLine}
      />
    );
  };

  /**
   * 逐个块渲染整篇：代码块整体包进 `.md-fences` 容器，其余行平铺。
   *
   * 容器负责边框 / 圆角 / 底色 / 外距；行元素仍是容器的直接子节点，
   * 因此 `lineEls` 下标、`data-li`、字符映射表全都不变。
   *
   * @returns 块级元素数组
   */
  const renderBlocks = () => {
    const out: React.ReactNode[] = [];
    for (let i = 0; i < lines.length; ) {
      if (isCodeLike(lines, i)) {
        let j = i;
        while (j + 1 < lines.length && isCodeLike(lines, j + 1)) j++;
        out.push(
          <div key={`f${i}`} className="md-fences">
            {lines.slice(i, j + 1).map((_, k) => renderLine(i + k, true))}
          </div>,
        );
        /**
         * 夹在**两块代码块之间**的那条空行整条不渲染。
         *
         * 代码块有边框 + 底色 ⇒ 形成 BFC ⇒ 上下 15px 外距不合并，
         * 这条空行会实打实再占 12.8px，两块看起来被硬塞了一道缝。
         * ⚠️ 块**末尾**那条空行不能动 —— 它是光标逃出代码块的唯一落点。
         */
        if (
          lines[j + 1]?.kind.type === 'blank' &&
          j + 2 < lines.length &&
          isCodeLike(lines, j + 2)
        ) {
          out.push(renderLine(j + 1, false, true));
          i = j + 2;
        } else {
          i = j + 1;
        }
      } else {
        out.push(renderLine(i, false));
        i++;
      }
    }
    return out;
  };

  /** 悬浮条要用最新的 lines 算格子区间，而 mousemove 监听器只挂一次 */
  linesRef.current = lines;

  /**
   * 表格悬浮工具条：鼠标停在表格上就浮出来，移开就消失。
   *
   * 挂在 document 上而不是给每个表格行加 `onMouseEnter` —— 行组件是 `memo` 的，
   * 多传一个回调会让所有行都判"变了"，长文档性能会掉。
   * `mousemove` 用 rAF 节流，避免高频 setState。
   */
  useEffect(() => {
    let raf = 0;
    /** 隐藏延时：从表格挪到工具条上要经过一小段空白，立刻隐藏就点不到按钮了 */
    let hideTimer = 0;
    const isSep = (el: Element) => {
      const t = (el.textContent || '').trim();
      return t.includes('|') && /^[\s|:\-]+$/.test(t);
    };

    const update = (target: Element | null) => {
      // 鼠标停在工具条自己身上时不要隐藏
      if (target?.closest?.('[role="toolbar"][aria-label="表格"]')) return;
      const row = target?.closest?.('.md-table-row') as HTMLElement | null;
      if (!row) {
        if (!hideTimer) {
          hideTimer = window.setTimeout(() => {
            hideTimer = 0;
            setTableBar(null);
          }, 160);
        }
        return;
      }
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = 0;
      }

      const li = Number(row.getAttribute('data-li'));
      const line = linesRef.current[li];
      if (!line) {
        setTableBar(null);
        return;
      }
      // hover 命中的那个格子；没命中格子（点在行内边距上）就退回第 0 格
      const cellEl = target?.closest?.('[data-cell]') as HTMLElement | null;
      const cells = cellEl ? [...(cellEl.parentElement?.querySelectorAll('[data-cell]') ?? [])] : [];
      const ci = Math.max(0, cells.indexOf(cellEl as HTMLElement));
      const range = tableCellRanges(line.src)[ci];
      const at = line.start + (range ? range.from : 0);

      // 整块表格的矩形：同一父容器里连续的「表格行 / 分隔行」
      const wrap = row.parentElement;
      if (!wrap) {
        setTableBar(null);
        return;
      }
      const kids = [...wrap.children];
      const isTbl = (el: Element) => el.classList.contains('md-table-row') || isSep(el);
      let a = kids.indexOf(row);
      let b = a;
      while (a > 0 && isTbl(kids[a - 1])) a--;
      while (b + 1 < kids.length && isTbl(kids[b + 1])) b++;
      const r1 = kids[a].getBoundingClientRect();
      const r2 = kids[b].getBoundingClientRect();
      setTableBar({ pos: { x: Math.min(r1.left, r2.left), y: Math.min(r1.top, r2.top) }, at });
    };

    const onMove = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        update(target);
      });
    };
    const onLeave = () => setTableBar(null);
    document.addEventListener('mousemove', onMove);
    document.documentElement.addEventListener('mouseleave', onLeave);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.documentElement.removeEventListener('mouseleave', onLeave);
      if (raf) cancelAnimationFrame(raf);
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, []);

  /**
   * 执行悬浮工具条上的表格命令。
   *
   * 用 hover 命中的那个格子的位置（`at`），**不动编辑器光标** ——
   * 用户可能在别处正做着事，hover 一下就挪光标会很讨厌。
   *
   * @param id 命令 id（与右键菜单同一套）
   * @param at 目标位置（全文下标）
   */
  const runTableBar = useCallback(
    (id: string, at: number) => {
      const r =
        id === 'table-row-above'
          ? tableInsertRow(value, at, 'above')
          : id === 'table-row-below'
            ? tableInsertRow(value, at, 'below')
            : id === 'table-col-left'
              ? tableInsertColumn(value, at, 'left')
              : id === 'table-col-right'
                ? tableInsertColumn(value, at, 'right')
                : id === 'table-align-left'
                  ? tableSetAlign(value, at, 'left')
                  : id === 'table-align-center'
                    ? tableSetAlign(value, at, 'center')
                    : id === 'table-align-right'
                      ? tableSetAlign(value, at, 'right')
                      : id === 'table-row-delete'
                        ? tableDeleteRow(value, at)
                        : id === 'table-col-delete'
                          ? tableDeleteColumn(value, at)
                          : id === 'table-delete'
                            ? tableDelete(value, at)
                            : null;
      if (r) applyEdit(r);
    },
    [value, applyEdit],
  );

  return (
    <div
      className={`relative bg-background transition-colors ${
        plain ? 'flex min-h-screen flex-col' : `rounded-lg border ${dragging ? 'border-accent' : 'border-border'}`
      } ${plain && dragging ? 'bg-accent/[0.04]' : ''}`}
      onMouseDown={onBackgroundMouseDown}
      onContextMenu={onBackgroundContextMenu}
      onDragOver={(e) => {
        // 必须 preventDefault，否则浏览器会用默认行为「打开这个文件」
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        const f = e.dataTransfer.files[0];
        if (!f) return;
        e.preventDefault();
        setDragging(false);
        // 一次拖多个文件时只取第一个，避免把正文替换成一大堆内容
        void handleDrop(f);
      }}
    >
      {outlineOpen && (
        <aside className="fixed top-0 left-0 z-40 h-screen w-60 overflow-y-auto border-r border-border bg-background px-2 py-5">
          <div className="px-2 pb-2 text-[11px] font-medium text-muted-foreground">大纲</div>
          {headings.length === 0 ? (
            <div className="px-2 text-[12px] text-muted-foreground/60">还没有标题</div>
          ) : (
            headings.map((h, k) => (
              <button
                key={`${h.line}-${k}`}
                type="button"
                onClick={() => jumpToLine(h.line)}
                title={h.text}
                style={{ paddingLeft: 8 + (h.level - 1) * 12 }}
                className="block w-full truncate rounded py-1 pr-2 text-left text-[13px] text-foreground/85 hover:bg-foreground/[0.06]"
              >
                {h.text || '(空标题)'}
              </button>
            ))
          )}
        </aside>
      )}
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-accent/[0.06] text-sm font-semibold text-accent">
          松手即可导入
        </div>
      )}
      {/*
        `select-none` 是必须的：选区由编辑器自己画（见 renderSegs 的 bg-accent/25），
        原生选区会和它叠在一起，且原生那份会被任何一次重渲染抹掉。
      */}
      <div
        ref={wrapRef}
        className={`relative select-none px-[30px] pt-[30px] pb-[100px] text-base leading-[1.6]${
          codeWrap ? '' : ' md-nowrap'
        }`}
      >
        {/* 空文档提示：放在行元素之外，不进字符映射表 */}
        {value === '' && (
          <div className="pointer-events-none absolute top-[30px] left-[30px] text-muted-foreground/45">
            开始输入，或按 Ctrl+O 打开文件
          </div>
        )}
        {/*
          渲染顺序：代码块的连续行被包进一个 `.md-fences` 容器里，
          边框、圆角、底色、15px 外距都画在这个容器上（而不是逐行补边）。

          容器只是**视觉分组**：行元素本身仍在容器内、仍带 `data-li`，
          `lineEls.current` 的下标与 `lines` 一一对应，光标定位与右键落点不受影响。
        */}
        {renderBlocks()}
        {caretBox && (
          <div
            className={`pointer-events-none absolute w-[2px] bg-accent ${
              focused && !composing ? 'animate-pulse' : ''
            }`}
            style={{ left: caretBox.x, top: caretBox.y, height: caretBox.h }}
          />
        )}

        {/* 输入通道：不可见但可聚焦。IME 必须挂在真实控件上，不能省。 */}
        <textarea
          ref={inputRef}
          onKeyDown={onKeyDown}
          onInput={onInput}
          onCompositionStart={onCompositionStart}
          onCompositionUpdate={onCompositionUpdate}
          onCompositionEnd={onCompositionEnd}
  /**
   * 剪贴板走原生事件，无需授权；
   * navigator.clipboard.readText() 要求文档聚焦，会报 NotAllowedError。
   */
          onCopy={(e) => {
            const sel = currentSelection();
            const text = value.slice(sel.start, sel.end);
            if (!text) return;
            e.preventDefault();
            e.clipboardData.setData('text/plain', text);
            setNotice('已复制');
          }}
          onCut={(e) => {
            const sel = currentSelection();
            const text = value.slice(sel.start, sel.end);
            if (!text) return;
            e.preventDefault();
            e.clipboardData.setData('text/plain', text);
            applyEdit({ text: value.slice(0, sel.start) + value.slice(sel.end), caret: sel.start });
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text/plain');
            // 剪贴板里没有纯文本（多半是截图/图片）—— 文本编辑器只收文字，明说，别静默吞掉
            if (!text) {
              e.preventDefault();
              setNotice(
                e.clipboardData.files.length > 0
                  ? '剪贴板里是图片 —— 把图片文件拖进编辑器可插入占位'
                  : '剪贴板里没有可粘贴的文字',
              );
              return;
            }
            e.preventDefault();
            const sel = currentSelection();
            applyEdit({
              text: value.slice(0, sel.start) + text + value.slice(sel.end),
              caret: sel.start + text.length,
            });
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
  // 失焦即不可能还在组合中，清掉残留态
            composingRef.current = false;
            setComposing('');
          }}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label="编辑器输入"
          className="absolute w-px resize-none border-0 bg-transparent p-0 text-transparent outline-none"
          style={{ caretColor: 'transparent', opacity: 0.01, height: 20, left: 0, top: 0 }}
        />
      </div>

      <div
        className={`border-t border-border px-4 py-2 text-[11px] text-muted-foreground ${
          plain ? 'sticky bottom-0 mt-auto bg-background' : ''
        }`}
      >
        下标 <span className="font-mono text-accent">{caret}</span>
        {'　'}
        {caretLine >= 0 ? `第 ${caretLine + 1} 行 / 共 ${lines.length} 行` : '未定位'}
        {focusMode && <span className="ml-2 rounded bg-accent/15 px-1.5 text-accent">专注</span>}
        {typewriterMode && <span className="ml-2 rounded bg-accent/15 px-1.5 text-accent">打字机</span>}
        {anchor !== null && <span className="ml-2 text-warm">已选区</span>}
        {composing && composing !== '\u200b' && <span className="ml-2 text-accent">输入中：{composing}</span>}
        {notice && <span className="ml-2 text-accent">{notice}</span>}
      </div>

      {/* 查找 / 替换面板：绝对定位在编辑区内（不 Portal，避免定位换算） */}
      {find && (
        <FindBar
          state={{ ...find, count: findHits.length, index: findIndex }}
          onQueryChange={(q) => setFind((f) => (f ? { ...f, query: q } : f))}
          onReplaceChange={(r) => setFind((f) => (f ? { ...f, replace: r } : f))}
          onToggleCase={() => setFind((f) => (f ? { ...f, caseSensitive: !f.caseSensitive } : f))}
          onNext={findNext}
          onPrev={findPrev}
          onReplaceOne={replaceOne}
          onReplaceAll={replaceAll}
          onClose={closeFind}
        />
      )}

      {/* 浮层统一 Portal 到 body，免得被编辑区的滚动/裁切影响 */}
      {tableAsk && (
        <TableInsertDialog
          onCancel={() => {
            setTableAsk(false);
            setTableAnchor(null);
          }}
          onConfirm={(cols, rows) => {
            setTableAsk(false);
            insertAfterLine(makeTableSnippet(cols, rows), tableAnchor ?? undefined);
            setTableAnchor(null);
          }}
        />
      )}
      {tableBar && (
        <TableBar
          pos={tableBar.pos}
          onRun={(id) => runTableBar(id, tableBar.at)}
          /**
           * 「更多操作」打开完整表格菜单（与右键「表格 ▸」同一份条目）。
           * 菜单挂在悬浮条下方一点，别盖住工具条本身。
           */
          onMore={() =>
            setMenu({ pos: { x: tableBar.pos.x, y: tableBar.pos.y + 34 }, items: tableGroup(), target: null })
          }
        />
      )}
      {menu && <ContextMenu pos={menu.pos} items={menu.items} onRun={runCommand} onClose={() => setMenu(null)} />}
      {langPicker && (
        <LangPicker
          pos={langPicker.pos}
          current={lines[langPicker.lineIndex]?.lang ?? ''}
          onPick={(id) => {
            setCodeLang(langPicker.lineIndex, id);
            setLangPicker(null);
            /**
             * 选完必须把焦点还给编辑器的隐藏输入框。
             *
             * 选择器里那个搜索框拿走了焦点，选择器一卸载焦点就落回 `<body>` ——
             * 此时直接打字/粘贴会**全部丢失**（实测：选完语言后连打 5 行代码，一个字都没进去）。
             * `onClose` 不加这句：那种情况用户是点了别处，抢焦点反而会把光标拽走。
             */
            inputRef.current?.focus();
          }}
          onClose={() => setLangPicker(null)}
        />
      )}
      {bubble && (
        <FormatBubble
          // 位置变化时强制重挂：Radix 只在「打开 / 滚动 / 尺寸变化」时重算定位，
          // 单纯换一个坐标 prop 不会让它挪窝，气泡就会钉在第一次的位置上。
          key={`${bubble.x},${bubble.y}`}
          pos={bubble}
          commands={INLINE_COMMANDS}
          onRun={runCommand}
          onClose={() => setBubble(null)}
        />
      )}
      {prompt && (
        <PromptDialog
          title={prompt.title}
          label={prompt.label}
          initial={prompt.initial}
          placeholder={prompt.placeholder}
          onConfirm={(v) => {
            const run = prompt.onConfirm;
            setPrompt(null);
            run(v);
          }}
          onCancel={() => setPrompt(null)}
        />
      )}
    </div>
  );
});

export default MirrorEditor;

/** 各块类型的行样式 */
const LINE_CLS: Record<string, string> = {
  // 行高与字号按各档标题的基准值取
  h1: 'text-[2.25rem] font-bold leading-[1.2] mt-1 mb-1 pb-[0.3em] border-b border-border',
  h2: 'text-[1.75rem] font-bold leading-[1.225] mt-1 mb-1 pb-[0.3em] border-b border-border',
  h3: 'text-[1.5rem] font-bold leading-[1.43] mt-1 mb-1',
  h4: 'text-[1.25rem] font-bold leading-[1.4] mt-1 mb-1',
  h5: 'text-[1rem] font-bold leading-[1.4] mt-1 mb-1',
  h6: 'text-[1rem] font-bold leading-[1.4] mt-1 mb-1 text-muted-foreground',
  // 引自 github.css：border-left 4px solid #dfe2e5 / padding 0 15px / color #777
  quote: 'border-l-4 border-border pl-[15px] pr-[15px] text-muted-foreground',
  // 列表：ul,ol { padding-left: 30px }；圆点用负 text-indent 挂到缩进区
  ul: 'pl-[30px] -indent-[1.2em]',
  ol: 'pl-[30px] -indent-[1.2em]',
  // 分割线：github.css → height 2px / background #e7e7e7 / margin 16px 0；线由内层 span 画
  hr: 'my-4 leading-none',
  code: 'font-mono text-sm',
  // 围栏行跟代码行同一字号：否则光标进代码块时 ``` 比代码本身还大
  fence: 'font-mono text-sm',
  p: '',
  // 空行 = 段落间距 0.8em，不是一整行高 —— 整行高会让每个块之间都多出一条空白；leading-[0] 压掉行盒，否则 strut 会撑回整行高
  blank: 'leading-[0]',
};

/** 行内样式 */
const SEG_CLS: Record<InlineSeg['kind'], string> = {
  plain: '',
  strong: 'font-bold',
  em: 'italic',
  code: 'font-mono text-[0.9em] bg-secondary border border-border rounded-[3px] px-1',
  math: '',
  strongem: 'font-bold italic',
  fnref: 'md-fnref',
  task: '',
  html: '',
  htmlvoid: '',
  hl: 'md-hl-hl',
  del: 'line-through opacity-60',
  link: 'text-accent underline underline-offset-2',
  url: 'text-accent underline underline-offset-2',
};

/**
 * 预编辑串样式：下划线，与系统输入法视觉一致。
 *
 * `md-preedit` 不是 Tailwind 类，是给 `buildCharMap` 认的标记类 ——
 * 预编辑串混在行内，不排除掉会被当成正文、把列号游标带偏。
 */
const PREEDIT_CLS = 'md-preedit border-b-2 border-accent text-foreground';

/** 切开后的一个小片 */
interface SegPiece {
  kind: InlineSeg['kind'];
  text: string;
  /** 行内起始列号 */
  start: number;
  /** 所属片段带的地址（图片 / 链接） */
  href?: string;
  /** 任务项是否已勾选 */
  checked?: boolean;
  /** 行内 HTML 的标签名 */
  htmlTag?: string;
  /** 所属片段的起始列号；用于判断某片是不是该片段的第一片 */
  segStart: number;
}

/**
 * 把一行的片段在若干列号处切开。
 *
 * 选区边界与光标位置都要靠它切 —— 切完再渲染，就不必为每种情况各写一套逻辑。
 *
 * @param segs 该行片段（`srcStart` 已含前缀长度）
 * @param cuts 切开处的行内列号（越界的会被自动忽略）
 * @returns 切好的小片
 */
function splitSegsAt(segs: InlineSeg[], cuts: number[]): SegPiece[] {
  const marks = [...new Set(cuts)].sort((a, b) => a - b);
  const out: SegPiece[] = [];
  for (const s of segs) {
    const s0 = s.srcStart;
    const s1 = s.srcStart + s.text.length;
    const inner = marks.filter((c) => c > s0 && c < s1);
    let prev = s0;
    for (const c of [...inner, s1]) {
      out.push({
        kind: s.kind,
        text: s.text.slice(prev - s0, c - s0),
        start: prev,
        href: s.href,
        checked: s.checked,
        htmlTag: s.htmlTag,
        segStart: s0,
      });
      prev = c;
    }
  }
  return out;
}

/** 把 Markdown 里的图片地址转成浏览器可加载的 URL */
function imageSrc(href: string): string {
  const h = href.trim();
  if (/^(https?:|data:|blob:)/i.test(h)) return h;
  // 本地路径交给桌面壳的自定义协议；网页版加载不了，会走破图分支
  return window.desktop ? `jinmo-file://local/?p=${encodeURIComponent(h)}` : h;
}

/**
 * 异步渲染 TeX（MathJax）。
 *
 * 渲染完成前先显示原文，避免公式位置跳动；渲染成 SVG 后可见文本消失，
 * 故补一个隐藏文本占位，字符映射表才能继续按片段消费。
 *
 * @param tex TeX 源码
 * @param display 是否块级
 */
function MathTex({ tex, display }: { tex: string; display: boolean }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void renderMath(tex, display).then((r) => {
      if (alive) setHtml(r);
    });
    return () => {
      alive = false;
    };
  }, [tex, display]);

  return html ? (
    <>
      <span className="md-math" dangerouslySetInnerHTML={{ __html: html }} />
      <span className="md-ghost" aria-hidden="true">
        {tex}
      </span>
    </>
  ) : (
    <span className="md-math-raw">{tex}</span>
  );
}

/**
 * Mermaid 图表。
 *
 * 异步渲染：加载完成前先占位，避免图表出现时把下面的内容顶走。
 *
 * @param source 图表源码
 */
function MermaidDiagram({ source }: { source: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setSvg(null);
    setFailed(false);
    void renderMermaid(source).then((r) => {
      if (!alive) return;
      if (r) setSvg(r);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [source]);

  if (svg) return <div className="md-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
  return <div className="md-mermaid-raw">{failed ? '图表语法有误，或渲染失败' : '正在渲染图表…'}</div>;
}

/** 行内图片；加载失败时浏览器会显示 alt，这里只补破图样式 */
function InlineImage({ href, alt }: { href: string; alt: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <img
      src={imageSrc(href)}
      alt={alt}
      draggable={false}
      className={broken ? 'md-img-inline md-img-inline-broken' : 'md-img-inline'}
      onError={() => setBroken(true)}
    />
  );
}

/** 行组件的 props */
interface EditorLineProps {
  line: RenderLine;
  index: number;
  editing: boolean;
  mathEditing: boolean;
  /** 专注模式下这一行是否变淡 */
  dimmed: boolean;
  /** 表格块的最后一行（补下边框，避免与下一行双线） */
  isTableLast: boolean;
  /** 代码块的第一行（补上边框与圆角：1px 边框 + 3px 圆角） */
  isCodeFirst: boolean;
  /** 代码块的最后一行 */
  isCodeLast: boolean;
  /** 选区在本行内的列号范围；`selStart >= selEnd` 表示本行没被选中 */
  selStart: number;
  selEnd: number;
  /** 光标在本行内的列号；-1 = 光标不在本行 */
  caretCol: number;
  preedit: string;
  /** 本行内的查找命中（行内列号）；没有命中时是同一个空数组引用 */
  lineHits: { start: number; end: number }[];
  /** 夹在两块代码块之间的空行 —— 整条不渲染（见 CSS 的 `.md-gap-line`） */
  gap?: boolean;
  onLineClick: (li: number, e: React.MouseEvent) => void;
  onLineMouseDown: (li: number, e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent, li: number) => void;
  onToggleTask: (li: number, col: number) => void;
  onPickLang: (li: number, e: React.MouseEvent<HTMLButtonElement>) => void;
  registerLine: (li: number, el: HTMLDivElement | null) => void;
}

/**
 * 行组件的自定义比较。
 *
 * 不比 `line.start`（这一行在整篇里的起始下标）：在文首敲一个字，后面每一行的 start 都会 +1，
 * 可它**不进 DOM** —— 只有父组件算 `caretCol` / `selStart` 时才用得到。
 * 默认的浅比较会因此判定整篇每一行都变了，敲字的耗时就跟文档长度成正比。
 *
 * 处理函数与 `registerLine` 都是稳定引用（见 stableLineClick 等），不必比。
 *
 * @returns true 表示 props 等价，跳过重渲染
 */
function linePropsEqual(a: EditorLineProps, b: EditorLineProps): boolean {
  const x = a.line;
  const y = b.line;
  if (x !== y) {
    if (
      x.src !== y.src ||
      x.kind !== y.kind ||
      x.segs !== y.segs ||
      x.prefixText !== y.prefixText ||
      x.lang !== y.lang ||
      x.codeFence !== y.codeFence ||
      x.codeNo !== y.codeNo ||
      x.tableCols !== y.tableCols ||
      x.tableAligns !== y.tableAligns ||
      x.mathTex !== y.mathTex ||
      x.diagram !== y.diagram ||
      x.mathBlockFirst !== y.mathBlockFirst ||
      x.mathBlockLast !== y.mathBlockLast
    ) {
      return false;
    }
  }
  return (
    a.index === b.index &&
    a.editing === b.editing &&
    a.mathEditing === b.mathEditing &&
    a.dimmed === b.dimmed &&
    a.isTableLast === b.isTableLast &&
    a.isCodeFirst === b.isCodeFirst &&
    a.isCodeLast === b.isCodeLast &&
    a.selStart === b.selStart &&
    a.selEnd === b.selEnd &&
    a.caretCol === b.caretCol &&
    a.preedit === b.preedit &&
    a.lineHits === b.lineHits &&
    a.gap === b.gap
  );
}

/**
 * 一行要渲染的内容。
 *
 * **记忆化**：长文档下每次移动光标都会重渲染整个组件，若不把行隔离出来，
 * 几千行时每次点击都要重建全部行元素，光标跟不 hands。
 */
const EditorLine = memo(function EditorLine({
  line: l,
  index: i,
  editing,
  mathEditing,
  dimmed,
  isTableLast,
  isCodeFirst,
  isCodeLast,
  selStart,
  selEnd,
  caretCol,
  preedit,
  lineHits,
  gap,
  onLineClick,
  onLineMouseDown,
  onContextMenu,
  onToggleTask,
  onPickLang,
  registerLine,
}: EditorLineProps) {
  const isTableRow = l.kind.type === 'tableHead' || l.kind.type === 'tableBody';
  const selRange = selStart < selEnd ? { start: selStart, end: selEnd } : null;
  const toggle = (col: number) => onToggleTask(i, col);

  return (
    <div
      ref={(el) => registerLine(i, el)}
      data-li={i}
      onClick={(e) => onLineClick(i, e)}
      onMouseDown={(e) => onLineMouseDown(i, e)}
      onContextMenu={(e) => onContextMenu(e, i)}
      className={`md-line cursor-text transition-opacity duration-200 ${gap ? 'md-gap-line' : ''} ${dimmed ? 'opacity-25' : ''} ${
        l.kind.type === 'code' || l.kind.type === 'fence'
          ? `md-code-line${isCodeFirst ? ' md-code-first' : ''}${isCodeLast ? ' md-code-last' : ''}`
          : ''
      } ${
        l.kind.type === 'tableSep'
          ? 'hidden'
          : isTableRow
            ? `md-table-row border-border border-l border-r border-t ${isTableLast ? 'border-b' : ''} ${
                l.kind.type === 'tableHead' ? 'font-bold' : ''
              }`
            : (LINE_CLS[l.kind.type] ?? '')
      }`}
    >
      {/*
        代码行号槽位（padding 0 3px 0 5px / text-align right / color #999，右侧 1px #ddd 分隔线）。
        它是控件不是正文，`buildCharMap` 里要跳过。
      */}
      {l.codeNo !== undefined && (
        <span className="md-code-lineno" aria-hidden="true">
          {l.codeNo}
        </span>
      )}
      {l.mathBlockFirst !== undefined && !mathEditing ? (
        l.mathBlockFirst === i ? (
          l.diagram !== undefined ? (
            <div className="md-mermaid-block">
              <MermaidDiagram source={l.diagram} />
            </div>
          ) : (
            <div className="md-math-block">
              <MathTex tex={l.mathTex ?? ''} display />
            </div>
          )
        ) : null
      ) : l.kind.type === 'blank' ? (
        /* 空行 = 段落间距 0.8em，不是一整行高 —— 整行高会让每个块之间都多出一条空白 */
        <span className="inline-block h-[0.8em] w-full" />
      ) : l.kind.type === 'fence' ? (
        <>
          {/*
           * 围栏默认**不显示** —— 参考实现里代码块只看得见代码与右上角的语言标签，
           * ` ``` ` 那一行是看不见的（用户明确要求照此改）。
           * 光标停到这一行才露出源码，与标题/引用等"语法随光标浮现"一致。
           *
           * ⚠️ 不能整条不渲染：围栏行是光标进出代码块的落点，
           * 而且它还要承载右上角的语言按钮。
           */}
          {caretCol >= 0 ? (
            <span className="text-muted-foreground/40">{l.src || '\u00a0'}</span>
          ) : (
            <span className="md-fence-ghost" aria-hidden="true" />
          )}
          {/* 语言标签只挂在开围栏上 */}
          {l.codeFence && (
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onPickLang(i, e);
              }}
              className="md-lang-btn"
              title="选择代码块语言"
            >
              {l.lang || '纯文本'}
            </button>
          )}
        </>
      ) : l.kind.type === 'code' && l.src === '' ? (
        /* 代码块里的空行：一个字符都不渲染会让这一行高度塌成 0，代码块底色中间断开 */
        <span>{'\u00a0'}</span>
      ) : l.kind.type === 'hr' ? (
        /* 分割线：渲染成一条 2px 灰线（height 2px / #e7e7e7 / margin 16px 0），
           光标停上来时才露出源码 `---` */
        editing ? (
          <span className="text-muted-foreground/40">{l.src || '\u00a0'}</span>
        ) : (
          <span className="block h-[2px] w-full bg-border" />
        )
      ) : isTableRow ? (
        /* 表格行：按单元格边界切片段渲染，竖线本身不出现在 DOM 里 */
        tableCellRanges(l.src).map((r, ci) => (
          <div
            key={ci}
            data-cell=""
            /** 列对齐：`none` 不写，交给浏览器默认（表头本来就会加粗居左） */
            style={{
              textAlign:
                l.tableAligns?.[ci] && l.tableAligns[ci] !== 'none'
                  ? (l.tableAligns[ci] as 'left' | 'center' | 'right')
                  : undefined,
            }}
            className="border-r border-border px-3 py-1.5 whitespace-pre-wrap last:border-r-0"
          >
            {sliceSegs(l.segs, r.from, r.to).map((p, k) => (
              <span key={k} className={p.text.startsWith('🖼') ? 'md-img-token' : SEG_CLS[p.kind]}>
                {p.text}
              </span>
            ))}
          </div>
        ))
      ) : editing ? (
        /* 编辑态：露出块前缀（`## ` / `> ` / `- `），并把光标所在的那个行内元素按源码原样显示 */
        <>
          {l.prefixText !== '' && (
            /* 标题的 `#` 比标题正文小一号，否则一大串 `######` 会喧宾夺主 */
            <span
              className={`text-muted-foreground/40 ${l.kind.type.startsWith('h') ? 'text-[0.6em]' : ''}`}
            >
              {l.prefixText}
            </span>
          )}
          {renderSegs(revealSegAt(l.segs, l.src, caretCol), selRange, caretCol, preedit, lineHits, l.lang, toggle)}
        </>
      ) : (
        /* 非编辑行：完全不露语法 —— 没有 `#` / `>` / `**`，只有渲染结果 */
        <>
          {/* 任务项只画复选框，不再画圆点 */}
          {l.kind.type === 'ul' && l.segs[0]?.kind !== 'task' && (
            <span className="md-list-marker">•</span>
          )}
          {l.kind.type === 'ol' && <span className="md-list-marker">{l.kind.marker}.</span>}
          {renderSegs(l.segs, selRange, -1, preedit, lineHits, l.lang, toggle)}
        </>
      )}
    </div>
  );
}, linePropsEqual);

/**
 * 渲染一行的可见片段：切出选区高亮、查找命中高亮，并把输入法预编辑串内联插在光标处。
 *
 * 预编辑串必须内联插入、把后面的字推开，不能绝对定位盖上去 —— 盖上去会压住后面的文字。
 *
 * @param segs 该行的可见片段（`srcStart` 已含前缀长度）
 * @param sel 选区在本行内的列号范围；null = 本行没有选中内容
 * @param caretCol 光标在本行的列号；负数表示光标不在本行
 * @param preedit 预编辑串；空串表示当前没有组合
 * @param hits 查找命中在本行内的列号范围（当前命中不在其中，它由选区高亮表示）
 * @param codeLang 代码块的语言标识；`undefined` 表示不是代码行（空串表示代码行但未标语言）
 * @param onToggleTask 勾选/取消任务列表项，参数是该行内的列号
 * @returns React 节点数组
 */
function renderSegs(
  segs: InlineSeg[],
  sel: { start: number; end: number } | null,
  caretCol: number,
  preedit: string,
  hits: { start: number; end: number }[] = [],
  codeLang?: string,
  onToggleTask?: (col: number) => void,
): React.ReactNode[] {
  const cuts: number[] = [];
  if (sel) cuts.push(sel.start, sel.end);
  if (preedit && caretCol >= 0) cuts.push(caretCol);
  for (const h of hits) cuts.push(h.start, h.end);

  const pieces = splitSegsAt(segs, cuts);
  const out: React.ReactNode[] = [];
  let placed = false;

  pieces.forEach((p, k) => {
    // 光标落在本片之前 → 预编辑串插在这里
    if (!placed && preedit && caretCol >= 0 && p.start >= caretCol) {
      out.push(
        <span key={`pe${k}`} className={PREEDIT_CLS}>
          {preedit}
        </span>,
      );
      placed = true;
    }
    const selected = !!sel && p.start >= sel.start && p.start < sel.end;
    const hit = hits.find((h) => p.start >= h.start && p.start < h.end);
    // 选区优先：命中若与选区重叠就不叠一层黄底（当前命中就是选区）
    const extra = (hit && !selected ? ' bg-find/70' : '') + (selected ? ' bg-accent/25' : '');

    // 代码行：整片交给着色器。文本节点仍由浏览器生成，字符映射表照常按片段消费
    if (codeLang !== undefined) {
      out.push(
        <span
          key={k}
          className={`font-mono text-sm${extra}`}
          dangerouslySetInnerHTML={{ __html: highlightCode(p.text, codeLang) }}
        />,
      );
      return;
    }

    // 任务列表：复选框 + 隐藏占位（`[ ] ` 本身不显示）
    if (p.kind === 'task') {
      out.push(
        <span key={k} className={`md-task${extra}`}>
          <input
            type="checkbox"
            checked={p.checked}
            tabIndex={-1}
            className="md-task-box"
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              e.stopPropagation();
              onToggleTask?.(p.segStart);
            }}
          />
          <span className="md-ghost" aria-hidden="true">
            {p.text}
          </span>
        </span>,
      );
      return;
    }

    // 行内 HTML：白名单标签按元素渲染。可见文字就是标签内容，字符映射表照常
    if (p.kind === 'html') {
      out.push(createElement(p.htmlTag ?? 'span', { key: k, className: extra || undefined }, p.text));
      return;
    }

    // 无内容标签（`<br>`）：元素本身不产生可见字符，用隐藏占位保住映射
    if (p.kind === 'htmlvoid') {
      out.push(
        <span key={k} className={extra}>
          {createElement(p.htmlTag ?? 'br')}
          <span className="md-ghost" aria-hidden="true">
            {p.text}
          </span>
        </span>,
      );
      return;
    }

    // 行内公式：渲染成 MathJax 的 SVG
    if (p.kind === 'math') {
      out.push(
        <span key={k} className={`md-math-wrap${extra}`}>
          <MathTex tex={p.text} display={false} />
        </span>,
      );
      return;
    }

    // 图片：整段渲染成真图。片段可能被选区切开，只有第一片画图，
    // 其余片留隐藏文本占位 —— 字符映射表要按片段消费，占位不能省
    if (p.text.startsWith('🖼')) {
      out.push(
        <span key={k} className={`md-img-wrap${extra}`}>
          {p.start === p.segStart && p.href ? <InlineImage href={p.href} alt={p.text} /> : null}
          <span className="md-ghost" aria-hidden="true">
            {p.text}
          </span>
        </span>,
      );
      return;
    }

    out.push(
      <span key={k} className={SEG_CLS[p.kind] + extra}>
        {p.text}
      </span>,
    );
  });

  // 光标在该行末尾（超出所有片段）→ 补在最后
  if (!placed && preedit && caretCol >= 0) {
    out.push(
      <span key="pe-end" className={PREEDIT_CLS}>
        {preedit}
      </span>,
    );
  }

  return out;
}