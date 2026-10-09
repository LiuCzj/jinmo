/**
 * 代码块语言表与匹配算法。
 *
 * 匹配流程：前缀匹配 → 排序 → 命中不足 4 条时补子串匹配 → 唯一命中且与输入完全相同时不提示。
 */

/**
 * 代码块语言候选表（141 条，未去重 —— 去重会改变匹配结果）。
 * 同一门语言存在多种写法是有意的：`js` 与 `javascript`、`c++` 与 `cpp` 都在表内，
 * 用户敲哪种前缀都能命中。
 */
export const CODE_LANG_HINTS: string[] = [
  'js', 'javascript', 'java', 'json', 'typescript', 'clojure', 'coffeescript', 'css', 'less', 'scss',
  'gfm', 'markdown', 'xaml', 'xml', 'haskell', 'html', 'lua', 'lisp', 'commonlisp', 'pascal',
  'perl', 'perl6', 'php', 'php+HTML', 'python', 'cython', 'ruby', 'shell', 'sh', 'sql',
  'sqlite', 'mssql', 'mysql', 'CQL', 'mariadb', 'cassandra', 'plsql', 'tiddlywiki', 'wiki', 'vb',
  'basic', 'visual basic', 'vbscript', 'velocity', 'verilog', 'xquery', 'yaml', 'go', 'groovy', 'nginx',
  'octave', 'c', 'clike', 'c++', 'cpp', 'objc', 'objective-c', 'csharp', 'c#', 'squirrel',
  'ceylon', 'kotlin', 'tex', 'latex', 'swift', 'scala', 'R', 'D', 'diff', 'erlang',
  'http', 'jade', 'rst', 'rust', 'jinja2', 'reStructuredText', 'asp', 'jsp', 'erb', 'ejs',
  'embeddedjs', 'powershell', 'dockerfile', 'jsx', 'tsx', 'react', 'vue', 'nsis', 'mathematica', 'tiki wiki',
  'properties', 'ini', 'livescript', 'assembly', 'gas', 'toml', 'matlab', 'ocaml', 'F#', 'fsharp',
  'elm', 'pgp', 'asciiarmor', 'spreadsheet', 'elixir', 'cmake', 'cypher', 'dart', 'django', 'dtd',
  'xml-dtd', 'dylan', 'handlebars', 'idl', 'web-idl', 'yacas', 'mbox', 'vhdl', 'julia', 'haxe',
  'hxml', 'fortran', 'protobuf', 'makefile', 'tcl', 'scheme', 'twig', 'bash', 'SAS', 'pseudocode',
  'stylus', 'cobol', 'oz', 'SPARQL', 'crystal', 'ASN.1', 'gherkin', 'smalltalk', 'turtle', 'glsl',
  'apl',
];

/** 不标语言时列表顶部那一项 */
export const PLAIN_LANG_LABEL = '纯文本';

/**
 * 候选最多显示多少条。
 */
export const MAX_LANG_HINTS = 40;

/**
 * 按输入片段匹配语言候选。
 *
 * @param input 用户敲进去的片段；空串表示还没输入
 * @param all 候选表，默认 `CODE_LANG_HINTS`
 * @returns 命中的语言名；`[]` 表示不必提示（唯一命中且与输入完全相同）
 */
export function matchLangs(input: string, all: string[] = CODE_LANG_HINTS): string[] {
  const q = input.toLowerCase();
  if (q === '') return [...all].sort();
  const out = all.filter((l) => l.toLowerCase().startsWith(q)).sort();
  if (out.length < 4) {
    for (const l of all) {
      if (l.toLowerCase().indexOf(q) > 0) out.push(l);
    }
  }
  // 只有一条命中、且和输入一模一样 → 用户已经把语言敲全了，不用再弹
  if (out.length === 1 && out[0] === input) return [];
  return out;
}

/**
 * 从代码块围栏的 info string 里读「行号」设置。
 *
 * 支持 `{.numberLines}` 开行号、`startFrom="5"` 定起始编号。
 * `{...}` 出现在 info string 的任意位置都认，语言和属性写在一起（` ```python {.numberLines} `）
 * 与只写属性（` ```{.numberLines} `）两种形式等价。
 *
 * @param info 围栏上语言那一串（不含围栏符号本身）
 * @returns 行号设置；没写就返回 `{}`
 */
export function parseFenceOptions(info: string): { lineNumbers?: boolean; firstLineNumber?: number } {
  const m = /\{([^}]*)\}/.exec(info ?? '');
  if (!m) return {};
  const parts = m[1].split(/\s+/).filter(Boolean);
  if (!parts.length) return {};
  const out: { lineNumbers?: boolean; firstLineNumber?: number } = {};
  for (const p of parts) {
    if (/^[.]number((-?l)|L)ines/.test(p)) out.lineNumbers = true;
    else {
      const sm = /^startFrom=['"](\d+)['"]$/.exec(p);
      if (sm) out.firstLineNumber = Number(sm[1]);
    }
  }
  return out;
}

/**
 * 取围栏 info string 里的语言词。
 *
 * 去掉首尾的 `{}`、剥离 `lang-` / `language-` 前缀后取第一个空白分隔的词。
 * 围栏属性词（`.numberLines`、`startFrom="5"`）不是语言，跳过 ——
 * 混进来会让 `{.numberLines}` 这种纯属性围栏被当成标了语言。
 *
 * @param info 围栏上的 info string
 * @returns 语言词（小写）；没有则空串
 */
export function fenceLangOf(info: string): string {
  const cleaned = (info || '').replace(/[{}]/g, ' ').trim();
  if (!cleaned) return '';
  for (const raw of cleaned.split(/\s+/)) {
    const low = raw.toLowerCase();
    // 属性词：以 `.` 开头，或形如 `key="value"`
    if (low.startsWith('.') && !/^\.*lang(uage)*-/.test(low)) continue;
    if (low.includes('=')) continue;
    const w = low.replace(/^\.*lang(uage)*-/, '');
    if (w) return w;
  }
  return '';
}

/**
 * 按行号设置拼出围栏的属性块。
 *
 * @param lineNumbers 是否开行号
 * @param firstLineNumber 起始编号；不传就不写 `startFrom`
 * @returns 属性块（形如 `{.numberLines startFrom="5"}`）；不需要时返回空串
 */
export function fenceAttrs(lineNumbers: boolean, firstLineNumber?: number): string {
  if (lineNumbers) {
    return `{.numberLines${firstLineNumber !== undefined ? ` startFrom="${firstLineNumber}"` : ''}}`;
  }
  if (firstLineNumber !== undefined) return `{startFrom="${firstLineNumber}"}`;
  return '';
}

/**
 * 拼回代码块的开围栏行。
 *
 * 语言紧贴围栏、属性块前留一个空格：```python {.numberLines}。
 * ` ``` python ` 虽然也能解析，但不是惯用写法。
 *
 * @param indent 行首缩进
 * @param marker 围栏标记（``` 或 ````）
 * @param lang 语言词；空串 = 不标语言
 * @param attrs 属性块；空串 = 没有
 * @returns 完整的围栏行
 */
export function buildFenceLine(indent: string, marker: string, lang: string, attrs: string): string {
  return indent + marker + lang + (attrs ? (lang ? ' ' : '') + attrs : '');
}

