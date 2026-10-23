/**
 * 逐行渲染模型的构建。
 *
 * 纯逻辑，不依赖 DOM 与 React —— 因此可以直接对比「全量重建」与「增量重建」的结果，
 * 用测试保证两者永远一致。
 *
 * 增量重建的前提：击键只改一小段文本，其余几百行一个字都没动。
 * 全量重建每次都把整篇切行、逐行查缓存、重建全部行对象，成本与文档长度成正比；
 * 增量只重解析被改动覆盖的那几行，其余行对象原样复用（只平移 `start`）。
 */

import { classifyLine, parseInline, type InlineSeg, type LineKind } from './md-inline';
import { fenceLangOf, parseFenceOptions } from './code-langs';
import { tableAlignmentsOf, tableCellRanges, type TableAlign } from './md-commands';

/** 一行的渲染描述 */
export interface RenderLine {
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

/** 表格列对齐方式 */
export type { TableAlign } from './md-commands';

/** 表格分隔行的形态：竖线、冒号、横杠、空格的组合，且至少含一个 `-` */
const TABLE_SEP_RE = /^\s*\|?[\s:|-]+\|?\s*$/;

/** 单行的解析结果。与「这一行在整篇里的位置」无关，因此可以跨次复用 */
interface LineParse {
  kind: LineKind;
  segs: InlineSeg[];
  prefixText: string;
  lang?: string;
}

/** 解析缓存：外层键 = 围栏状态 + 引用定义，内层键 = 行文本 */
interface ParseCache {
  buckets: Map<string, Map<string, LineParse>>;
  entries: number;
}

/** 缓存条目上限。超过就淘汰最旧的一半桶 —— 整表清空会让下一行起全部重解析 */
const PARSE_CACHE_MAX = 5000;

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

/** 代码围栏的跨行状态 */
interface FenceState {
  /** 当前围栏标记（如 ``` 或 ````）；null = 不在围栏内 */
  fence: string | null;
  /** 当前代码块的语言标识 */
  lang: string;
  /** 当前代码块是否显示行号 */
  noOn: boolean;
  /** 行号起始编号 */
  noFirst: number;
  /** 已数到第几行 */
  noCount: number;
}

function newFenceState(): FenceState {
  return { fence: null, lang: '', noOn: false, noFirst: 1, noCount: 0 };
}

/**
 * 让围栏状态跨过一行。
 *
 * @param st 状态，原地修改
 * @param line 整行源码
 * @param kind 该行的块类型
 * @param globalLineNumbers 全局行号开关
 * @returns 本行是否是开围栏，以及代码行应显示的行号
 */
function advanceFence(
  st: FenceState,
  line: string,
  kind: LineKind,
  globalLineNumbers: boolean,
): { opens: boolean; codeNo?: number } {
  if (kind.type === 'fence') {
    if (st.fence === null) {
      const indent = /^\s*/.exec(line)?.[0].length ?? 0;
      st.fence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1] ?? '```';
      const info = line.slice(indent + st.fence.length);
      // 语言必须用 fenceLangOf 取：`{.numberLines}` 这种纯属性串不是语言，
      // 直接用 `\S+` 抓会把属性当成语言，关键字高亮整块失效
      st.lang = fenceLangOf(info);
      const opts = parseFenceOptions(info);
      // 全局开关优先；关掉时还能靠围栏属性 `{.numberLines}` 单独打开
      st.noOn = globalLineNumbers || opts.lineNumbers === true;
      st.noFirst = opts.firstLineNumber ?? 1;
      st.noCount = 0;
      return { opens: true };
    }
    st.fence = null;
    return { opens: false };
  }
  if (kind.type === 'code' && st.noOn) {
    return { opens: false, codeNo: st.noFirst + st.noCount++ };
  }
  return { opens: false };
}

/** 两个围栏状态是否等价（决定改动是否破坏了后续行的类型） */
function sameFence(a: FenceState, b: FenceState): boolean {
  return a.fence === b.fence && a.lang === b.lang && a.noOn === b.noOn && a.noFirst === b.noFirst && a.noCount === b.noCount;
}

/** 收一遍引用式链接的定义行 `[id]: url`（脚注定义 `[^id]:` 不算） */
function collectDefs(raw: string[]): Record<string, string> {
  const defs: Record<string, string> = {};
  for (const line of raw) {
    // 定义行必然以 `[` 开头；先做一次廉价判断，省掉整篇的正则
    if (line.charCodeAt(0) !== 91) continue;
    const m = /^\[([^\]^][^\]]*)\]:\s*(\S+)/.exec(line);
    if (m) defs[m[1].trim().toLowerCase()] = m[2];
  }
  return defs;
}

/**
 * 标记表格块：连续行含竖线且下一行为分隔行形态时，标为 tableHead / tableSep / tableBody。
 * classifyLine 逐行判定无法看到下一行，故在此处按全文处理。
 *
 * @param lines 行数组，原地修改
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
 * 标记块级公式与 Mermaid 图表。
 *
 * 两者都是跨行结构，必须在表格标记之后跑（表格行不会是公式/图表块）。
 *
 * @param lines 行数组，原地修改
 */
function markBlocks(lines: RenderLine[]): void {
  // 块级公式：$$ ... $$（可跨行）。整块渲染成一个公式，非编辑态下只占首行的高度
  let openAt = -1;
  let buf: string[] = [];
  const closeBlock = (endIndex: number) => {
    const first = lines[openAt];
    if (!first) return;
    first.mathTex = buf.join('\n').trim();
    for (let k = openAt; k <= endIndex; k++) {
      lines[k].mathBlockFirst = openAt;
      lines[k].mathBlockLast = endIndex;
    }
    openAt = -1;
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].src.trim();
    if (openAt === -1) {
      if (t === '$$') {
        openAt = i;
        buf = [];
      } else if (t.length > 4 && t.startsWith('$$') && t.endsWith('$$')) {
        lines[i].mathTex = t.slice(2, -2).trim();
        lines[i].mathBlockFirst = i;
        lines[i].mathBlockLast = i;
      }
    } else if (t === '$$') {
      closeBlock(i);
    } else {
      buf.push(lines[i].src);
    }
  }

  // 图表块：```mermaid 围栏里的内容整块渲染成一张图，非编辑态下只占首行高度
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i];
    if (fence.kind.type !== 'fence' || fence.lang !== 'mermaid') continue;
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j].kind.type === 'code') {
      body.push(lines[j].src);
      j++;
    }
    if (j >= lines.length || lines[j].kind.type !== 'fence') continue; // 没有闭合围栏，按普通代码块处理
    fence.diagram = body.join('\n');
    for (let k = i; k <= j; k++) {
      lines[k].mathBlockFirst = i;
      lines[k].mathBlockLast = j;
    }
    i = j;
  }
}

/** 从缓存取一行解析结果，没有就解析并存进去 */
function cachedParse(
  cache: ParseCache,
  bucketKey: string,
  line: string,
  fence: string | null,
  fenceLang: string,
  defs: Record<string, string>,
): LineParse {
  let bucket = cache.buckets.get(bucketKey);
  if (bucket === undefined) {
    bucket = new Map();
    cache.buckets.set(bucketKey, bucket);
  }
  const hit = bucket.get(line);
  if (hit !== undefined) return hit;

  const parse = parseLine(line, fence, fenceLang, defs);
  if (cache.entries >= PARSE_CACHE_MAX) {
    /**
     * 只淘汰最旧的一半桶，**不整表清空**。
     *
     * 整表清空会让当前这一行之后的每一行都重新解析，打字过程中就会出现
     * 周期性的卡顿尖峰（缓存刚攒满 → 一次全清 → 全文重算）。
     * Map 保持插入顺序，从头部删即按「最久未用」淘汰。
     */
    const drop = Math.max(1, Math.floor(cache.buckets.size / 2));
    let n = 0;
    for (const [k, b] of cache.buckets) {
      if (n++ >= drop) break;
      cache.entries -= b.size;
      cache.buckets.delete(k);
    }
    bucket = cache.buckets.get(bucketKey);
    if (bucket === undefined) {
      bucket = new Map();
      cache.buckets.set(bucketKey, bucket);
    }
  }
  bucket.set(line, parse);
  cache.entries++;
  return parse;
}

/**
 * 全量重建。
 *
 * @param src 整篇 Markdown
 * @param globalLineNumbers 是否全局显示代码行号
 * @param cache 解析缓存
 * @returns 逐行的渲染描述，以及每行「进入时」的围栏状态（增量重建要用）
 */
function buildFull(
  src: string,
  globalLineNumbers: boolean,
  cache: ParseCache,
): { lines: RenderLine[]; ctx: FenceState[]; defs: Record<string, string> } {
  const raw = src.split('\n');
  const defs = collectDefs(raw);
  const defsSig = JSON.stringify(defs);
  const st = newFenceState();
  const out: RenderLine[] = [];
  const ctx: FenceState[] = [];
  let pos = 0;
  /** 上一行用的缓存桶键；围栏状态只在围栏边界变，不必每行重拼 */
  let lastBucketKey = '\u0001';
  let lastFenceState = '\u0001';

  for (const line of raw) {
    // 记下「进入这一行时」的状态，增量重建时直接从这里接上，不必从文首重扫
    ctx.push({ ...st });
    const fenceState = st.fence === null ? '' : `${st.fence}|${st.lang}`;
    if (fenceState !== lastFenceState) {
      lastFenceState = fenceState;
      lastBucketKey = `${fenceState}\u0000${defsSig}`;
    }
    const parse = cachedParse(cache, lastBucketKey, line, st.fence, st.lang, defs);
    const adv = advanceFence(st, line, parse.kind, globalLineNumbers);
    out.push({
      start: pos,
      src: line,
      kind: parse.kind,
      prefixText: parse.prefixText,
      segs: parse.segs,
      lang: parse.lang,
      codeFence: adv.opens || undefined,
      codeNo: adv.codeNo,
    });
    pos += line.length + 1;
  }

  markTables(out);
  markBlocks(out);
  return { lines: out, ctx, defs };
}

/** 增量重建时用来判断「这一段是否碰了跨行结构」 */
function touchesBlockStructure(l: RenderLine): boolean {
  const t = l.kind.type;
  if (t === 'fence' || t === 'code') return true;
  if (t === 'tableHead' || t === 'tableSep' || t === 'tableBody') return true;
  if (l.mathBlockFirst !== undefined || l.diagram !== undefined) return true;
  // 改动可能把普通段落变成表格/公式块的起点，所以源码形态也要看
  return l.src.includes('|') || l.src.includes('$$');
}

/**
 * 行构建器。每个编辑器实例一个 —— 缓存与上一轮结果都是实例私有的，
 * 多窗口并排打开时不会互相污染。
 */
export interface LineBuilder {
  /**
   * 构建逐行渲染描述。
   *
   * @param src 整篇 Markdown
   * @param globalLineNumbers 是否全局显示代码行号
   * @returns 逐行的渲染描述；行对象在内容未变时复用（行组件的记忆化靠它跳过重渲染）
   */
  build(src: string, globalLineNumbers?: boolean): RenderLine[];
}

/**
 * 创建一个行构建器。
 *
 * @returns 带内部缓存的构建器
 */
export function createLineBuilder(): LineBuilder {
  const cache: ParseCache = { buckets: new Map(), entries: 0 };
  let lastSrc = '';
  let lastLineNumbers = false;
  let prev: RenderLine[] = [];
  /** 每行「进入时」的围栏状态，增量重建用它接上状态而不必从文首重扫 */
  let prevCtx: FenceState[] = [];
  /** 上一次的引用式链接定义表；改动没碰定义行时沿用它 */
  let prevDefs: Record<string, string> = {};

  /**
   * 尝试增量重建。
   *
   * 只重解析被改动覆盖的那几行。碰到围栏 / 表格 / 公式 / 图表就放弃（返回 null），
   * 因为这些结构跨行，局部重算很容易与全量结果不一致 —— 宁可慢一点，不能算错。
   *
   * @param nextSrc 新文本
   * @param prevSrc 上一次的文本
   * @param prevLines 上一次的行数组
   * @param prevCtx 上一次每行进入时的围栏状态
   * @param prevDefs 上一次的引用定义表
   * @param globalLineNumbers 行号开关
   * @returns 新的行数组、围栏状态与定义表；不能安全增量时 null
   */
  function tryIncremental(
    nextSrc: string,
    prevSrc: string,
    prevLines: RenderLine[],
    prevCtx: FenceState[],
    prevDefs: Record<string, string>,
    globalLineNumbers: boolean,
  ): { lines: RenderLine[]; ctx: FenceState[]; defs: Record<string, string> } | null {
    const a = prevSrc;
    const b = nextSrc;
    const max = Math.min(a.length, b.length);

    // 共同前缀 / 后缀（字符级）
    let head = 0;
    let tail = 0;
    /**
     * 纯追加 / 纯删除走原生比较。
     *
     * 逐字符循环在 280KB 的文档上要跑 28 万次 `charCodeAt`；
     * `startsWith` 底层是 memcmp，同一个量级快一个数量级。
     * 打字绝大多数就是「在末尾追加」或「退格删末尾」。
     */
    if (b.length > a.length && b.startsWith(a)) {
      head = a.length;
    } else if (a.length > b.length && a.startsWith(b)) {
      head = b.length;
    } else {
      while (head < max && a.charCodeAt(head) === b.charCodeAt(head)) head++;
      while (tail < max - head && a.charCodeAt(a.length - 1 - tail) === b.charCodeAt(b.length - 1 - tail)) tail++;
    }

    const aFrom = head;
    const aTo = a.length - tail;
    const bTo = b.length - tail;

    // 改动覆盖的旧行范围
    const oldFrom = lineIndexIn(prevLines, aFrom);
    const oldTo = aTo > aFrom ? lineIndexIn(prevLines, aTo - 1) : oldFrom;
    if (oldFrom < 0) return null;

    // 改动覆盖的新行
    const bLineStart = b.lastIndexOf('\n', head - 1) + 1;
    const bLineEndNl = b.indexOf('\n', bTo);
    const bLineEnd = bLineEndNl === -1 ? b.length : bLineEndNl;
    const newRaw = b.slice(bLineStart, bLineEnd).split('\n');

    // 前后各扩一行：markTables 要看下一行，公式/图表块跨行
    const checkFrom = Math.max(0, oldFrom - 1);
    const checkTo = Math.min(prevLines.length - 1, oldTo + 1);
    for (let i = checkFrom; i <= checkTo; i++) {
      if (touchesBlockStructure(prevLines[i])) return null;
    }

    /**
     * 引用式链接的定义行以 `[` 开头，改了它会影响**全文**所有 `[x][id]` 的解析，
     * 旧行里缓存好的 segs 会过期 —— 这种情况直接走全量。
     */
    for (const l of newRaw) if (l.charCodeAt(0) === 91) return null;
    for (let i = oldFrom; i <= oldTo; i++) if (prevLines[i].src.charCodeAt(0) === 91) return null;

    // 直接接上「进入 oldFrom 时」的围栏状态，不必从文首重扫
    const st = { ...prevCtx[oldFrom] };

    // 旧区间跨完后应达到的状态
    const stOld = { ...st };
    for (let i = oldFrom; i <= oldTo; i++) {
      advanceFence(stOld, prevLines[i].src, prevLines[i].kind, globalLineNumbers);
    }

    // 解析新行
    const defsSig = JSON.stringify(prevDefs);
    const stNew = { ...st };
    const fresh: RenderLine[] = [];
    const freshCtx: FenceState[] = [];
    let pos = prevLines[oldFrom].start;
    for (const line of newRaw) {
      freshCtx.push({ ...stNew });
      const fenceState = stNew.fence === null ? '' : `${stNew.fence}|${stNew.lang}`;
      const parse = cachedParse(cache, `${fenceState}\u0000${defsSig}`, line, stNew.fence, stNew.lang, prevDefs);
      const adv = advanceFence(stNew, line, parse.kind, globalLineNumbers);
      const row: RenderLine = {
        start: pos,
        src: line,
        kind: parse.kind,
        prefixText: parse.prefixText,
        segs: parse.segs,
        lang: parse.lang,
        codeFence: adv.opens || undefined,
        codeNo: adv.codeNo,
      };
      if (touchesBlockStructure(row)) return null;
      fresh.push(row);
      pos += line.length + 1;
    }

    // 围栏状态必须与改动前一致，否则后续行的类型全变了
    if (!sameFence(stOld, stNew)) return null;

    const out = prevLines.slice(0, oldFrom).concat(fresh, prevLines.slice(oldTo + 1));
    const outCtx = prevCtx.slice(0, oldFrom).concat(freshCtx, prevCtx.slice(oldTo + 1));

    // 重算 start：改动之后的行整体平移
    let at = 0;
    for (let i = 0; i < out.length; i++) {
      if (out[i].start !== at) out[i].start = at;
      at += out[i].src.length + 1;
    }
    return { lines: out, ctx: outCtx, defs: prevDefs };
  }

  return {
    build(src, globalLineNumbers = false) {
      if (src === lastSrc && globalLineNumbers === lastLineNumbers) return prev;

      if (prev.length > 0 && globalLineNumbers === lastLineNumbers) {
        const inc = tryIncremental(src, lastSrc, prev, prevCtx, prevDefs, globalLineNumbers);
        if (inc) {
          lastSrc = src;
          prev = inc.lines;
          prevCtx = inc.ctx;
          prevDefs = inc.defs;
          return inc.lines;
        }
      }

      const full = buildFull(src, globalLineNumbers, cache);
      lastSrc = src;
      lastLineNumbers = globalLineNumbers;
      prev = full.lines;
      prevCtx = full.ctx;
      prevDefs = full.defs;
      return full.lines;
    },
  };
}

/**
 * 按绝对下标找它所在的行。
 *
 * `lines[i].start` 单调递增，二分即可。
 *
 * @param lines 全部行
 * @param pos 绝对下标
 * @returns 行下标；空数组返回 -1
 */
export function lineIndexIn(lines: RenderLine[], pos: number): number {
  if (lines.length === 0) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid].start <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
