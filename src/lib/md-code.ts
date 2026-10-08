/**
 * 代码块的轻量语法着色。
 *
 * 不引任何高亮库：只做词法级切分（注释 / 字符串 / 数字 / 关键字），覆盖常用语言即可。
 * 输出 HTML，供 `<span dangerouslySetInnerHTML>` 使用；文本一律先转义。
 */

interface LangSpec {
  /** 行注释起始符 */
  line: string[];
  /** 块注释起止符 */
  block?: [string, string];
  keywords: string[];
}

const JS_KW = [
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
  'default', 'break', 'continue', 'new', 'class', 'extends', 'super', 'this', 'typeof', 'instanceof',
  'in', 'of', 'try', 'catch', 'finally', 'throw', 'async', 'await', 'import', 'from', 'export',
  'interface', 'type', 'enum', 'implements', 'public', 'private', 'protected', 'readonly', 'as',
  'null', 'undefined', 'true', 'false', 'void', 'delete', 'yield', 'static', 'get', 'set',
];

const PY_KW = [
  'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'in', 'not', 'and', 'or', 'is',
  'None', 'True', 'False', 'import', 'from', 'as', 'with', 'try', 'except', 'finally', 'raise',
  'lambda', 'yield', 'global', 'nonlocal', 'pass', 'break', 'continue', 'assert', 'async', 'await',
];

const GO_KW = [
  'func', 'package', 'import', 'var', 'const', 'type', 'struct', 'interface', 'map', 'chan', 'go',
  'defer', 'return', 'if', 'else', 'for', 'range', 'switch', 'case', 'default', 'break', 'continue',
  'nil', 'true', 'false', 'select', 'fallthrough',
];

const RUST_KW = [
  'fn', 'let', 'mut', 'const', 'static', 'struct', 'enum', 'impl', 'trait', 'pub', 'use', 'mod',
  'match', 'if', 'else', 'for', 'while', 'loop', 'return', 'break', 'continue', 'ref', 'move',
  'as', 'where', 'self', 'Self', 'true', 'false', 'Some', 'None', 'Ok', 'Err',
];

const C_KW = [
  'int', 'char', 'float', 'double', 'void', 'long', 'short', 'unsigned', 'signed', 'struct', 'union',
  'enum', 'typedef', 'static', 'const', 'return', 'if', 'else', 'for', 'while', 'do', 'switch',
  'case', 'default', 'break', 'continue', 'sizeof', 'include', 'define', 'class', 'public',
  'private', 'protected', 'virtual', 'namespace', 'using', 'template', 'new', 'delete', 'try',
  'catch', 'throw', 'nullptr', 'true', 'false',
];

const SQL_KW = [
  'select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create',
  'table', 'index', 'view', 'drop', 'alter', 'join', 'left', 'right', 'inner', 'outer', 'on',
  'group', 'by', 'order', 'having', 'limit', 'offset', 'as', 'and', 'or', 'not', 'null', 'distinct',
];

const SPECS: Record<string, LangSpec> = {
  javascript: { line: ['//'], block: ['/*', '*/'], keywords: JS_KW },
  python: { line: ['#'], keywords: PY_KW },
  json: { line: ['//'], keywords: ['true', 'false', 'null'] },
  shell: { line: ['#'], keywords: ['if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'case', 'esac', 'function', 'echo', 'export', 'local', 'return'] },
  go: { line: ['//'], block: ['/*', '*/'], keywords: GO_KW },
  rust: { line: ['//'], block: ['/*', '*/'], keywords: RUST_KW },
  sql: { line: ['--'], block: ['/*', '*/'], keywords: SQL_KW },
  yaml: { line: ['#'], keywords: ['true', 'false', 'null'] },
  css: { line: [], block: ['/*', '*/'], keywords: [] },
  html: { line: [], block: ['<!--', '-->'], keywords: [] },
  c: { line: ['//'], block: ['/*', '*/'], keywords: C_KW },
};

/** 语言别名 → 规范名 */
const ALIAS: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', ts: 'javascript', tsx: 'javascript', typescript: 'javascript',
  mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  py: 'python', python3: 'python',
  sh: 'shell', bash: 'shell', zsh: 'shell', console: 'shell',
  rs: 'rust',
  golang: 'go',
  cpp: 'c', 'c++': 'c', cc: 'c', h: 'c', hpp: 'c', java: 'c', cs: 'c', csharp: 'c', kotlin: 'c',
  yml: 'yaml',
  scss: 'css', less: 'css',
  xml: 'html', svg: 'html', vue: 'html',
  mysql: 'sql', postgres: 'sql', sqlite: 'sql',
};

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ESCAPES[c]);

/**
 * 给一段代码着色。
 *
 * @param code 代码文本（可含换行）
 * @param lang 语言标识，取围栏后的第一个词
 * @returns HTML 字符串；未知语言按通用规则（`//` 与 `#` 注释）处理
 */
export function highlightCode(code: string, lang: string): string {
  const key = ALIAS[lang.trim().toLowerCase()] ?? lang.trim().toLowerCase();
  const spec = SPECS[key];
  const lineMarks = spec ? spec.line : ['//', '#'];
  const block = spec?.block;
  const keywords = new Set(spec?.keywords ?? []);

  // 注释 / 字符串 / 数字 / 标识符 / 其它，按优先级依次尝试
  const lineAlt = lineMarks.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const parts: string[] = [];
  if (lineAlt) parts.push(`(?:${lineAlt})[^\\n]*`);
  if (block) {
    const [a, b] = block.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    parts.push(`${a}[\\s\\S]*?${b}`);
  }

  const re = new RegExp(
    [
      parts.length ? `(${parts.join('|')})` : '(?!)',
      `("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)`,
      `(\\b\\d[\\d_]*(?:\\.\\d+)?\\b)`,
      `([A-Za-z_$][\\w$]*)`,
    ].join('|'),
    'g',
  );

  let out = '';
  let last = 0;
  for (const m of code.matchAll(re)) {
    const at = m.index ?? 0;
    out += esc(code.slice(last, at));
    last = at + m[0].length;
    if (m[1]) out += `<span class="md-code-com">${esc(m[0])}</span>`;
    else if (m[2]) out += `<span class="md-code-str">${esc(m[0])}</span>`;
    else if (m[3]) out += `<span class="md-code-num">${esc(m[0])}</span>`;
    else out += keywords.has(m[0]) ? `<span class="md-code-kw">${esc(m[0])}</span>` : esc(m[0]);
  }
  out += esc(code.slice(last));
  return out;
}
