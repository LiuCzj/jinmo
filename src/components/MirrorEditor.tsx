/**
 * 笔记编辑器：逐行 div 渲染、自绘光标，键盘与输入法挂在隐藏 textarea 上。
 *
 * 隐藏 textarea 不可省略：输入法需要真实的可聚焦元素。
 * 正文本身不用 textarea，因为同一容器内存在多种行高，而 line-height 作用于整个元素。
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { charColsForLine, classifyLine, parseInline, revealSegAt, type InlineSeg, type LineKind } from '@/lib/md-inline';
import { highlightCode } from '@/lib/md-code';
import { highlightMarkdown } from '@/lib/md-highlight';
import { renderMath } from '@/lib/md-math';
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
  inlineTargetAt,
  insertImage,
  insertLink,
  lineBoundsAt,
  makeTableSnippet,
  snippetInnerOffset,
  SNIPPETS,
  tableAddColumn,
  tableAddRow,
  tableBlockRange,
  tableCellRanges,
  tableDelete,
  tableDeleteColumn,
  tableDeleteRow,
  tableFormatSource,
  tableInsertColumn,
  tableInsertRow,
  tablePosAt,
  unwrapSelection,
  wrapSelection,
  type FindHit,
  type InlineTarget,
  type Selection,
} from '@/lib/md-commands';
import {
  buildContextMenu,
  buildImageMenu,
  buildLinkMenu,
  ContextMenu,
  FormatBubble,
  INLINE_COMMANDS,
  TableInsertDialog,
  type FloatPos,
  type MdMenuItem,
} from './MarkdownFloats';
import { FindBar, type FindState } from './FindBar';

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
  /** 代码块的语言标识，取自围栏后的第一个词；仅 code 行有 */
  lang?: string;
  /** 块级公式的 TeX 源码；只挂在块的首行 */
  mathTex?: string;
  /** 块级公式的起止行号；块内每一行都有 */
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

/**
 * 把整篇切成一行的渲染描述。
 *
 * @param src 整篇 Markdown
 * @returns 逐行的渲染描述
 */
function buildLines(src: string): RenderLine[] {
  const raw = src.split('\n');
  const out: RenderLine[] = [];
  let pos = 0;
  let inFence = false;
  /** 当前代码围栏的语言标识 */
  let fenceLang = '';

  // 先收一遍引用式链接的定义行 `[id]: url`（脚注定义 `[^id]:` 不算）
  const defs: Record<string, string> = {};
  for (const line of raw) {
    const m = /^\[([^\]^][^\]]*)\]:\s*(\S+)/.exec(line);
    if (m) defs[m[1].trim().toLowerCase()] = m[2];
  }

  for (const line of raw) {
    const kind = classifyLine(line, inFence);
    if (kind.type === 'fence') {
      // 只有开围栏那一行带语言，闭围栏不动
      if (!inFence) fenceLang = (/^\s*(?:```|~~~)\s*(\S+)/.exec(line)?.[1] ?? '').toLowerCase();
      inFence = !inFence;
    }
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
    out.push({
      start: pos,
      src: line,
      kind,
      prefixText,
      segs,
      lang: kind.type === 'code' ? fenceLang : undefined,
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

  return out;
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
    l.kind = { type: 'tableHead', prefixLen: 0 };
    l.tableCols = cols;
    next.kind = { type: 'tableSep', prefixLen: 0 };
    next.tableCols = cols;
    for (let j = i + 2; j < lines.length; j++) {
      if (lines[j].kind.type !== 'p' || !lines[j].src.trimStart().startsWith('|')) break;
      lines[j].kind = { type: 'tableBody', prefixLen: 0 };
      lines[j].tableCols = cols;
    }
  }
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
  const lines = useMemo(() => buildLines(value), [value]);
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
  /** 选区格式气泡的位置；null = 不显示 */
  const [bubble, setBubble] = useState<FloatPos | null>(null);
  /** 「插入表格」对话框是否打开 */
  const [tableAsk, setTableAsk] = useState(false);
  /** 状态栏上的一次性提示（如「请按 Ctrl+V」）；用提示条而不是弹窗，不打断操作 */
  const [notice, setNotice] = useState('');
  /** 有文件拖过编辑区时的视觉反馈 */
  const [dragging, setDragging] = useState(false);
  /** 整篇源码模式（Ctrl+/）：整篇按 Markdown 源码编辑，不做任何渲染 */
  const [sourceMode, setSourceMode] = useState(false);
  /** 源码模式的 textarea 与着色层 */
  const sourceRef = useRef<HTMLTextAreaElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  /** 源码模式的逐行着色结果 */
  const sourceHtml = useMemo(() => highlightMarkdown(value), [value]);
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
    () => (find && find.query ? findAll(value, find.query, find.caseSensitive) : []),
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
        return { x: 0, y: nr.top - wr.top, h: nr.height };
      }
      const el = lineEls.current[li];
      if (!el) return null;

      const col = Math.max(0, Math.min(abs - line.start, line.src.length));
      const er = el.getBoundingClientRect();

      // 空行没有可见字符，光标摆在行首
  // hr 为编辑态时整行按源码渲染，需走字符映射而非直接摆到行首
      if (line.kind.type === 'blank') {
        return { x: 0, y: er.top - wr.top, h: er.height };
      }

      /**
       * 在字符映射表里定位光标。
       * 规则：光标在源码下标 `col` 处，应画在「源码下标 ≥ col 的第一个可见字符」的左边缘；
       * 若 col 已越过后半行，则画在「源码下标 < col 的最后一个可见字符」的右边缘。
       */
      const head = map.find((c) => c.src !== null && c.src >= col);
      if (head) {
        const r = document.createRange();
        r.setStart(head.node, head.offset);
        r.setEnd(head.node, head.offset + 1);
        const rr = r.getBoundingClientRect();
        if (rr.width || rr.height) return { x: rr.left - wr.left, y: rr.top - wr.top, h: rr.height };
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

      return { x: 0, y: er.top - wr.top, h: er.height };
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
        // 它们不占源码列 —— 渲染成公式后可见文本只剩我们补的那个隐藏占位
        if (n.parentElement?.closest('mjx-container, svg, .MathJax')) continue;
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
        // 这两类整行按源码原样渲染，列号 1:1；` ` 占位（空源码行）没有对应字符
        cols = [];
        for (const nd of nodes) {
          for (let k = 0; k < nd.text.length; k++) cols.push(k < line.src.length ? k : -1);
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
      setAnchor(null);
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
    (snippet: string) => {
      const { end } = lineBoundsAt(value, caret);
      const insertFrom = end;
      const next = value.slice(0, insertFrom) + '\n\n' + snippet + value.slice(insertFrom);
      applyEdit({ text: next, caret: insertFrom + 2 + snippetInnerOffset(snippet) });
    },
    [applyEdit, caret, value],
  );

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

      // ── 行内格式：再按一次取消（Typora 行为） ──
      const markOf: Record<string, string> = {
        bold: '**',
        italic: '*',
        strike: '~~',
        code: '`',
        highlight: '==',
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
      if (id === 'indent') return applyEdit(indentLine(value, caret, 'in'));
      if (id === 'outdent') return applyEdit(indentLine(value, caret, 'out'));

      // ── 升降标题级别（Ctrl+= / Ctrl+-） ──
      if (id === 'heading-up') return applyEdit(changeHeadingLevel(value, caret, 1));
      if (id === 'heading-down') return applyEdit(changeHeadingLevel(value, caret, -1));

      // ── 另起一段插入 ──
      if (id === 'table') {
        // 行列数让用户填（Typora 的插入表格对话框）
        setTableAsk(true);
        return;
      }
      if (id === 'codeblock') return insertAfterLine(SNIPPETS.code);
      if (id === 'hr') return insertAfterLine(SNIPPETS.hr);

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

      // ── 表格：完整操作（Typora 的九项菜单） ──
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
                      : id === 'table-format'
                        ? tableFormatSource(value, caret)
                        : id === 'table-delete'
                          ? tableDelete(value, caret)
                          : null;
        if (r) applyEdit(r);
        return;
      }

      // ── 剪贴板 ──
      if (id === 'cut' || id === 'copy') {
        const text = value.slice(sel.start, sel.end);
        if (!text) {
          setNotice('先选中要操作的文字');
          return;
        }
        navigator.clipboard
          .writeText(text)
          .then(() => setNotice(id === 'cut' ? '已剪切' : '已复制'))
          .catch(() => setNotice('浏览器拒绝了剪贴板写入，请用 Ctrl+C / Ctrl+X'));
        if (id === 'cut') {
          applyEdit({ text: value.slice(0, sel.start) + value.slice(sel.end), caret: sel.start });
        }
        return;
      }
      if (id === 'paste') {
  /**
   * 主动读剪贴板受浏览器授权限制，存在 granted / prompt / denied 三态；
   * 被拒时引导用户改按 Ctrl+V（原生 paste 事件无需授权）。
   */
        const insert = (t: string) => {
          if (!t) return;
          const s = currentSelection();
          applyEdit({
            text: value.slice(0, s.start) + t + value.slice(s.end),
            caret: s.start + t.length,
          });
        };
        const guide = (denied: boolean) =>
          setNotice(
            denied
              ? '剪贴板权限被浏览器记住为拒绝 —— 点地址栏图标允许后重试，或直接按 Ctrl+V'
              : '浏览器拦下了右键粘贴 —— 直接按 Ctrl+V（焦点已就位）',
          );
        try {
          navigator.permissions
            ?.query({ name: 'clipboard-read' as PermissionName })
            .then((st) => {
              if (st.state === 'denied') {
                guide(true);
                return undefined;
              }
              return navigator.clipboard
                .readText()
                .then(insert)
                .catch(() => guide(false));
            })
            .catch(() => guide(false));
        } catch {
          guide(false);
        }
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
          const newUrl = window.prompt('新的地址（http/https 或图床链接）：', mt.t.href || 'https://');
          if (!newUrl) return;
          const syntax = (id === 'image-replace' ? '!' : '') + `[${mt.t.label}](${newUrl})`;
          applyEdit({
            text: value.slice(0, absStart) + syntax + value.slice(absEnd),
            caret: absStart + syntax.length,
          });
          return;
        }
        // image-alt
        const newAlt = window.prompt('替代文字（图片加载失败时显示）：', mt.t.label);
        if (newAlt === null) return;
        const syntax = `![${newAlt}](${mt.t.href})`;
        applyEdit({
          text: value.slice(0, absStart) + syntax + value.slice(absEnd),
          caret: absStart + syntax.length,
        });
        return;
      }

      // ── 图片：先问地址（拖拽进来的图片走 M4c 的拖放通道） ──
      if (id === 'image') {
        const src = window.prompt('图片地址（也可以直接把图片文件拖进编辑器）');
        if (!src) return;
        applyEdit(insertImage(value, currentSelection(), src));
        return;
      }

      // ── 代码块：复制内容 / 跳到块外 ──
      if (id === 'code-copy' || id === 'code-exit') {
        const all = value.split('\n');
        const cur = lineIndexOf(value, caret).index;
        let open = -1;
        for (let i = cur; i >= 0; i--) {
          if (/^\s*```/.test(all[i])) {
            open = i;
            break;
          }
        }
        if (open === -1) return;
        let close = -1;
        for (let i = open + 1; i < all.length; i++) {
          if (/^\s*```/.test(all[i])) {
            close = i;
            break;
          }
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
    [applyEdit, caret, currentSelection, insertAfterLine, menu, redo, setLinePrefix, undo, value],
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
   * 右键：先把光标落到鼠标所在行的对应位置，再按上下文生成菜单。
   * 命中图片或链接语法时生成专用菜单。
   *
   * @param e 鼠标事件
   * @param li 被右键的行下标
   */
  const onContextMenu = (e: React.MouseEvent, li: number) => {
    e.preventDefault();
    const pos = caretFromPoint(li, e.clientX, e.clientY);
    const from = anchor === null ? null : Math.min(anchor, caret);
    const to = anchor === null ? null : Math.max(anchor, caret);
  /**
   * 右键点在已有选区内时不动选区，否则复制会得到空内容。
   */
    const inside = from !== null && to !== null && pos >= from && pos <= to;
    if (!inside) {
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
      : buildContextMenu(getContext(value, pos), { extended: true });
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
      const map = buildCharMap(li);
      let next = line.start + line.kind.prefixLen;

      if (line.kind.type !== 'hr' && map.length) {
        const clickRel = clientX - wr.left;
        // 第一遍：找 Y 上离点击最近的可见字符，用它的上下缘圈出「视觉行」
        let bandTop = Number.NEGATIVE_INFINITY;
        let bandBottom = Number.POSITIVE_INFINITY;
        if (clientY !== undefined) {
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
        // 第二遍：视觉行内按 X 找最近字符
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

    // ── Alt+Shift+5：删除线（Typora 官方快捷键；Shift+5 在部分键盘上是 %） ──
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

      // ── 整篇源码模式（Typora：Ctrl+/） ──
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
        // 已有选区 → 选中「同一段文字」的下一处（与 Typora / VS Code 一致）
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

    // ── F8 专注模式 / F9 打字机模式（Typora 官方快捷键） ──
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
   * 取某一行的查找命中（转成行内列号），排除当前命中 —— 当前命中由选区高亮表示。
   *
   * @param li 行下标
   * @returns 本行的命中范围（行内列号）
   */
  const hitsForLine = (li: number): { start: number; end: number }[] => {
    if (!find || findHits.length === 0) return [];
    const l = lines[li];
    if (!l) return [];
    const from = l.start;
    const to = l.start + l.src.length;
    const out: { start: number; end: number }[] = [];
    for (let hi = 0; hi < findHits.length; hi++) {
      if (hi === findIndex) continue;
      const h = findHits[hi];
      if (h.start >= from && h.end <= to) out.push({ start: h.start - from, end: h.end - from });
    }
    return out;
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

  // ── 整篇源码模式：整篇按 Markdown 源码编辑，不做任何渲染 ──
  //
  // 纯文本视图，故用原生 textarea：输入法、撤销、选区、滚动都由它提供。
  // 着色画在下层的 <pre> 里；行号由每一行自己的 ::before 画在左内边距中 ——
  // 这样长段落折行时行号仍与该行首行对齐（行号若单独成一列，折行后整列都会漂）。
  if (sourceMode) {
    return (
      <div className={`bg-background ${plain ? '' : 'rounded-lg border border-border'}`}>
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
            plain ? 'sticky bottom-0 bg-background' : ''
          }`}
        >
          源码模式 · 整篇 Markdown　<span className="text-accent">Ctrl+/</span> 返回所见即所得
        </div>
      </div>
    );
  }

  return (
    <div
      className={`relative bg-background transition-colors ${
        plain ? '' : `rounded-lg border ${dragging ? 'border-accent' : 'border-border'}`
      } ${plain && dragging ? 'bg-accent/[0.04]' : ''}`}
      onMouseDown={() => inputRef.current?.focus()}
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
      <div ref={wrapRef} className="relative select-none px-[30px] pt-[30px] pb-[100px] text-base leading-[1.6]">
        {/* 空文档提示：放在行元素之外，不进字符映射表 */}
        {value === '' && (
          <div className="pointer-events-none absolute top-[30px] left-[30px] text-muted-foreground/45">
            开始输入，或按 Ctrl+O 打开文件
          </div>
        )}
        {lines.map((l, i) => {
          const isTableRow = l.kind.type === 'tableHead' || l.kind.type === 'tableBody';
          // 表格块的最后一行才补 border-b（表头下面由表体行的 border-t 顶上，不会双线）
          const nextKind = lines[i + 1]?.kind.type;
          const isTableLast =
            isTableRow && nextKind !== 'tableBody' && nextKind !== 'tableSep';
          /** 这一行是否处于「编辑态」（判定见 isEditingLine，渲染与列号映射共用它） */
          const editing = isEditingLine(i);
          /** 块级公式：非编辑态下整块只画一个公式，块内其余行不占高度 */
          const inMathBlock = l.mathBlockFirst !== undefined;
          const mathEditing =
            inMathBlock && caretLine >= (l.mathBlockFirst ?? 0) && caretLine <= (l.mathBlockLast ?? 0);
          /** 选区在本行内的列号范围；null = 本行没有选中内容 */
          const selRange =
            anchor !== null && anchor !== caret
              ? { start: Math.min(anchor, caret) - l.start, end: Math.max(anchor, caret) - l.start }
              : null;
          return (
          <div
            key={i}
            ref={(el) => {
              lineEls.current[i] = el;
            }}
            onClick={(e) => onLineClick(i, e)}
            onMouseDown={(e) => onLineMouseDown(i, e)}
            onContextMenu={(e) => onContextMenu(e, i)}
            className={`cursor-text transition-opacity duration-200 ${
              focusMode && focusBlock && !focusBlock.has(i) ? 'opacity-25' : ''
            } ${l.kind.type === 'code' || l.kind.type === 'fence' ? 'md-code-line' : ''} ${
              l.kind.type === 'tableSep'
                ? 'hidden'
                : isTableRow
                  ? `md-table-row grid border-border border-l border-r border-t ${isTableLast ? 'border-b' : ''} ${
                      l.kind.type === 'tableHead' ? 'font-bold' : ''
                    }`
                  : (LINE_CLS[l.kind.type] ?? '')
            }`}
            style={
              isTableRow
                ? { gridTemplateColumns: `repeat(${l.tableCols ?? 1}, minmax(0, 1fr))` }
                : undefined
            }
          >
            {inMathBlock && !mathEditing ? (
              l.mathBlockFirst === i ? (
                <div className="md-math-block">
                  <MathTex tex={l.mathTex ?? ''} display />
                </div>
              ) : null
            ) : l.kind.type === 'blank' ? (
              /* 空行 = 段落间距（Typora 0.8em），不是一整行高 —— 整行高会让每个块之间都多出一条空白 */
              <span className="inline-block h-[0.8em] w-full" />
            ) : l.kind.type === 'fence' ? (
              <span className="text-muted-foreground/40">{l.src || '\u00a0'}</span>
            ) : l.kind.type === 'hr' ? (
              /* 分割线：Typora 渲成一条 2px 灰线（github.css：height 2px / #e7e7e7 / margin 16px 0），
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
                  /* 标题的 `#` 比标题正文小一号（Typora 的做法），否则一大串 `######` 会喧宾夺主 */
                  <span
                    className={`text-muted-foreground/40 ${l.kind.type.startsWith('h') ? 'text-[0.6em]' : ''}`}
                  >
                    {l.prefixText}
                  </span>
                )}
                {renderSegs(effectiveSegs(i), selRange, caret - l.start, preedit, hitsForLine(i), l.lang, (col) => toggleTaskAt(i, col))}
              </>
            ) : (
              /* 非编辑行：完全不露语法 —— 没有 `#` / `>` / `**`，只有渲染结果 */
              <>
                {/* 任务项只画复选框，不再画圆点 */}
                {l.kind.type === 'ul' && l.segs[0]?.kind !== 'task' && (
                  <span className="md-list-marker">•</span>
                )}
                {l.kind.type === 'ol' && <span className="md-list-marker">{l.kind.marker}.</span>}
                {renderSegs(l.segs, selRange, -1, preedit, hitsForLine(i), l.lang, (col) => toggleTaskAt(i, col))}
              </>
            )}
          </div>
          );
        })}

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
          plain ? 'sticky bottom-0 bg-background' : ''
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
          onCancel={() => setTableAsk(false)}
          onConfirm={(cols, rows) => {
            setTableAsk(false);
            insertAfterLine(makeTableSnippet(cols, rows));
          }}
        />
      )}
      {menu && <ContextMenu pos={menu.pos} items={menu.items} onRun={runCommand} onClose={() => setMenu(null)} />}
      {bubble && (
        <FormatBubble
          pos={bubble}
          commands={INLINE_COMMANDS}
          onRun={runCommand}
          onClose={() => setBubble(null)}
        />
      )}
    </div>
  );
});

export default MirrorEditor;

/** 各块类型的行样式 */
const LINE_CLS: Record<string, string> = {
  // 行高与字号取自 Typora 默认主题 github.css
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
  p: '',
  // 空行按 Typora 的段落间距 0.8em 渲染；leading-[0] 压掉行盒，否则 strut 会撑回整行高
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