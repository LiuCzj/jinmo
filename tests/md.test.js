/**
 * 纯函数单测（CommonJS，.cjs 不受 package.json 的 type:module 影响）。
 *
 * 被测对象：编译到 ./out/ 的三个纯函数模块（md-inline / md-editing / md-commands）。
 * 断言的是交接包第三节的“不变量”与第五节的高频坑，不碰 DOM。
 *
 * 用法：
 *   tsc src/lib/md-inline.ts src/lib/md-commands.ts src/lib/md-editing.ts \
 *       --rootDir src/lib --outDir temp/md-test/out --module commonjs --target ES2020 --skipLibCheck
 *   node temp/md-test/run.cjs
 */

const assert = require('node:assert');
const inline = require('./build/md-inline.js');
const edit = require('./build/md-editing.js');
const cmd = require('./build/md-commands.js');
const hl = require('./build/md-highlight.js');
const code = require('./build/md-code.js');

let passed = 0;
let failed = 0;

/**
 * 跑一条断言。
 * @param {string} name 用例名
 * @param {() => void} fn 断言体
 */
function it(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.log('  ✗ ' + name + '\n      ' + (e && e.message ? e.message.split('\n')[0] : e));
  }
}

console.log('\n[md-inline] 行内解析 / 行类型 / 字符列映射');

it('parseInline: **bold** → 片段 srcStart=2（标记不产生可见字符），raw 范围含标记', () => {
  const segs = inline.parseInline('**bold**');
  assert.deepStrictEqual(segs, [
    { text: 'bold', srcStart: 2, rawStart: 0, rawEnd: 8, kind: 'strong' },
  ]);
});

it('parseInline: 行内代码 `c` 的 srcStart 指向反引号之内，raw 含反引号', () => {
  const segs = inline.parseInline('a `c` b');
  assert.deepStrictEqual(segs, [
    { text: 'a ', srcStart: 0, rawStart: 0, rawEnd: 2, kind: 'plain' },
    { text: 'c', srcStart: 3, rawStart: 2, rawEnd: 5, kind: 'code' },
    { text: ' b', srcStart: 5, rawStart: 5, rawEnd: 7, kind: 'plain' },
  ]);
});

it('classifyLine: 标题 / 空行 / 围栏 / 引用 / 列表 / 分割线', () => {
  assert.strictEqual(inline.classifyLine('## 标题', false).type, 'h2');
  assert.strictEqual(inline.classifyLine('## 标题', false).prefixLen, 3);
  assert.strictEqual(inline.classifyLine('', false).type, 'blank');
  assert.strictEqual(inline.classifyLine('   ', false).type, 'blank');
  assert.strictEqual(inline.classifyLine('```', false).type, 'fence');
  assert.strictEqual(inline.classifyLine('code', true).type, 'code');
  assert.strictEqual(inline.classifyLine('> x', false).type, 'quote');
  assert.strictEqual(inline.classifyLine('- x', false).type, 'ul');
  assert.strictEqual(inline.classifyLine('- x', false).prefixLen, 2);
  assert.strictEqual(inline.classifyLine('1. x', false).type, 'ol');
  assert.strictEqual(inline.classifyLine('1. x', false).marker, '1');
  assert.strictEqual(inline.classifyLine('---', false).type, 'hr');
  assert.strictEqual(inline.classifyLine('普通段落', false).type, 'p');
});

it('listPrefixOf: 有序序号自增，无序沿用符号', () => {
  assert.strictEqual(inline.listPrefixOf('1. a').nextPrefix, '2. ');
  assert.strictEqual(inline.listPrefixOf('1) a').nextPrefix, '2) ');
  assert.strictEqual(inline.listPrefixOf('- a').nextPrefix, '- ');
  assert.strictEqual(inline.listPrefixOf('普通', null) === null || true, true);
  assert.strictEqual(inline.listPrefixOf('普通文本'), null);
});

it('charColsForLine: 格式化行按片段消费，列号对齐源码（不是按长度累加）', () => {
  // **bold**：可见 4 字，源码列号应是 2,3,4,5（跳过开头 **）
  const segs = inline.parseInline('**bold**');
  const cols = inline.charColsForLine(segs, false, [{ text: 'bold', decorative: false }]);
  assert.deepStrictEqual(cols, [2, 3, 4, 5]);
});

it('charColsForLine: 装饰字符（列表圆点）不给列号', () => {
  const segs = inline.parseInline('item');
  const cols = inline.charColsForLine(segs, false, [
    { text: '•', decorative: true },
    { text: 'item', decorative: false },
  ]);
  assert.deepStrictEqual(cols, [-1, 0, 1, 2, 3]);
});

console.log('\n[md-editing] 回车 / 退格 / 光标移动');

it('enter: 列表项行尾回车 → 续写下一项', () => {
  const r = edit.enter('- a', 3);
  assert.strictEqual(r.text, '- a\n- ');
  assert.strictEqual(r.caret, 6);
});

it('enter: 有序列表项回车 → 序号 +1', () => {
  const r = edit.enter('1. a', 4);
  assert.strictEqual(r.text, '1. a\n2. ');
});

it('enter: 空列表项回车 → 退出列表（去掉前缀）', () => {
  const r = edit.enter('- ', 2);
  assert.strictEqual(r.text, '');
  assert.strictEqual(r.caret, 0);
});

it('backspace: 列表行首退格 → 上方插入空项，不删前缀', () => {
  const r = edit.backspace('x\n- a', 2);
  assert.strictEqual(r.text, 'x\n- \n- a');
  assert.strictEqual(r.caret, 4);
});

it('backspace: 普通字符前退格 → 删一个字符', () => {
  const r = edit.backspace('abc', 2);
  assert.strictEqual(r.text, 'ac');
  assert.strictEqual(r.caret, 1);
});

it('moveLine: 上下移动尽量保持同列，短行夹到行尾', () => {
  assert.strictEqual(edit.moveLine('abc\nde', 2, 1), 6);
  assert.strictEqual(edit.moveLine('abc\nde', 6, -1), 2);
});

it('caretAtLineEdge: 行首 / 行尾', () => {
  assert.strictEqual(edit.caretAtLineEdge('abc\nde', 1, 'end'), 6);
  assert.strictEqual(edit.caretAtLineEdge('abc\nde', 1, 'start'), 4);
});

console.log('\n[md-commands] 表格 / 包裹 / 上下文');

it('tableCellRanges: 首尾竖线可选，尾随空格不算一格', () => {
  assert.strictEqual(cmd.tableCellRanges('| a | b |').length, 2);
  assert.strictEqual(cmd.tableCellRanges('| a | b | ').length, 2);
  assert.strictEqual(cmd.tableCellRanges('a | b').length, 2);
  assert.strictEqual(cmd.countTableColumns('| a | b |'), 2);
});

it('makeTableSnippet: 列数行数正确（含表头与分隔行）', () => {
  const s = cmd.makeTableSnippet(3, 4);
  const lines = s.split('\n');
  assert.strictEqual(lines.length, 4);
  assert.strictEqual(lines[0], '|  |  |  |');
  assert.strictEqual(lines[1], '| --- | --- | --- |');
});

it('tableInsertRow(below): 在表头上插行要落到分隔行之后', () => {
  const text = '| a | b |\n| --- | --- |\n| c | d |';
  const r = cmd.tableInsertRow(text, 2, 'below');
  assert.ok(r, '应能插行');
  assert.strictEqual(r.text.split('\n')[2], '|  |  |');
});

it('tableDeleteRow: 表头 / 分隔行不可单独删（返回 null）', () => {
  const text = '| a | b |\n| --- | --- |\n| c | d |';
  assert.strictEqual(cmd.tableDeleteRow(text, 2), null);
});

it('tableInsertColumn(right): 每行都补一列', () => {
  const text = '| a | b |\n| --- | --- |\n| c | d |';
  const r = cmd.tableInsertColumn(text, 2, 'right');
  assert.ok(r, '应能插列');
  for (const l of r.text.split('\n')) {
    assert.strictEqual(cmd.countTableColumns(l), 3, '每行都应是 3 列: ' + l);
  }
});

it('wrapSelection / unwrapSelection: 包裹与取消对称', () => {
  const w = cmd.wrapSelection('hello', { start: 0, end: 5 }, '**');
  assert.strictEqual(w.text, '**hello**');
  const u = cmd.unwrapSelection('**hello**', { start: 2, end: 7 }, '**');
  assert.ok(u, '应能取消');
  assert.strictEqual(u.text, 'hello');
});

it('inlineTargetAt: 命中图片优先于链接', () => {
  const t = cmd.inlineTargetAt('![alt](u)', 1);
  assert.ok(t && t.kind === 'image');
  assert.strictEqual(t.href, 'u');
  assert.strictEqual(t.label, 'alt');
});

it('getContext: 标题级别 / 空行判定', () => {
  const c = cmd.getContext('# 标题', 2);
  assert.strictEqual(c.heading, true);
  assert.strictEqual(c.headingLevel, 1);
  assert.strictEqual(cmd.getContext('   ', 1).empty, true);
});

it('autoFormat: 行首 "* " → 规范成 "- "', () => {
  const r = cmd.autoFormat('* ', 2);
  assert.ok(r, '应触发转换');
  assert.strictEqual(r.text, '- ');
});

it('insertLink: 无选区时选中占位文字', () => {
  const r = cmd.insertLink('', { start: 0, end: 0 });
  assert.strictEqual(r.text, '[文字](url)');
  assert.deepStrictEqual(r.select, { start: 1, end: 3 });
});

console.log('\n[新增] 软换行 / 选词删词 / 查找 / 缩进 / 升降标题');

it('softBreak: 只断行、不续写列表（与 enter 的区别）', () => {
  const a = edit.softBreak('- abc', 5);
  assert.strictEqual(a.text, '- abc\n');
  assert.strictEqual(a.caret, 6);
  const b = edit.enter('- abc', 5);
  assert.strictEqual(b.text, '- abc\n- '); // enter 会续出下一项
});

it('wordBoundsAt: 光标在词内 / 词尾都能抓到这个词', () => {
  assert.deepStrictEqual(edit.wordBoundsAt('foo bar', 1), { start: 0, end: 3 });
  assert.deepStrictEqual(edit.wordBoundsAt('foo bar', 3), { start: 0, end: 3 });
  assert.deepStrictEqual(edit.wordBoundsAt('foo bar', 5), { start: 4, end: 7 });
});

it('deleteWordAt: 删词并吃掉后面的一个空格', () => {
  const r = edit.deleteWordAt('foo bar', 1);
  assert.strictEqual(r.text, 'bar');
  assert.strictEqual(r.caret, 0);
});

it('findAll: 非重叠命中 + 大小写开关', () => {
  assert.deepStrictEqual(cmd.findAll('aAa', 'a', false).map((h) => h.start), [0, 1, 2]);
  assert.deepStrictEqual(cmd.findAll('aAa', 'a', true).map((h) => h.start), [0, 2]);
  assert.deepStrictEqual(cmd.findAll('abc', ''), []);
});

it('indentLine: 缩进加一个单位、反缩进去掉一个单位', () => {
  assert.strictEqual(cmd.indentLine('abc', 1, 'in').text, '  abc');
  assert.strictEqual(cmd.indentLine('  abc', 3, 'out').text, 'abc');
  // 已顶格时反缩进是空操作
  assert.strictEqual(cmd.indentLine('abc', 1, 'out').text, 'abc');
});

it('changeHeadingLevel: 段落→h1→h2…，降级 h1→段落', () => {
  assert.strictEqual(cmd.changeHeadingLevel('abc', 1, 1).text, '# abc');
  assert.strictEqual(cmd.changeHeadingLevel('# abc', 1, 1).text, '## abc');
  assert.strictEqual(cmd.changeHeadingLevel('## abc', 1, -1).text, '# abc');
  assert.strictEqual(cmd.changeHeadingLevel('# abc', 1, -1).text, 'abc');
  assert.strictEqual(cmd.changeHeadingLevel('abc', 1, -1).text, 'abc');
});

console.log('\n[新增] 光标所在行内元素露出标记（1B 的核心）');

it('revealSegAt: 光标在加粗里 → 拆成 开标记 + 内容(保持 strong) + 闭标记', () => {
  const src = 'a **b** c';
  const segs = inline.parseInline(src);
  const out = inline.revealSegAt(segs, src, 4); // 光标落在 b 上
  assert.deepStrictEqual(
    out.map((s) => [s.text, s.srcStart, s.kind]),
    [
      ['a ', 0, 'plain'],
      ['**', 2, 'plain'],
      ['b', 4, 'strong'],
      ['**', 5, 'plain'],
      [' c', 7, 'plain'],
    ],
  );
});

it('revealSegAt: 光标在纯文本上 → 原样返回（没有标记可露）', () => {
  const src = 'plain text';
  const segs = inline.parseInline(src);
  assert.strictEqual(inline.revealSegAt(segs, src, 3), segs);
});

it('revealSegAt: 链接 → 露出 `[` 与 `](href)`', () => {
  const src = 'x [t](u) y';
  const segs = inline.parseInline(src);
  const out = inline.revealSegAt(segs, src, 3);
  assert.deepStrictEqual(
    out.map((s) => s.text),
    ['x ', '[', 't', '](u)', ' y'],
  );
});

it('revealSegAt: 图片 → 整段按源码原样（可见文本与源码不逐字对应）', () => {
  const src = 'see ![alt](u) ok';
  const segs = inline.parseInline(src);
  const out = inline.revealSegAt(segs, src, 7);
  assert.deepStrictEqual(
    out.map((s) => s.text),
    ['see ', '![alt](u)', ' ok'],
  );
});

console.log('\n[新增] 源码模式着色');

it('highlightMarkdown: HTML 特殊字符被转义', () => {
  const html = hl.highlightMarkdown('a < b & c > d').join('\n');
  assert.ok(html.includes('&lt;') && html.includes('&amp;') && html.includes('&gt;'));
  assert.ok(!html.includes('<b'));
});

it('highlightMarkdown: 标题的标记与正文分开着色', () => {
  const html = hl.highlightMarkdown('## 标题').join('\n');
  assert.ok(html.includes('md-hl-mark'));
  assert.ok(html.includes('md-hl-h'));
});

it('highlightMarkdown: 代码围栏内部不再解析行内标记', () => {
  const html = hl.highlightMarkdown('```\n**不该加粗**\n```').join('\n');
  assert.ok(!html.includes('md-hl-strong'));
});

it('highlightMarkdown: 输出行数与原文本一致（含空行）', () => {
  assert.strictEqual(hl.highlightMarkdown('a\n\nb').length, 3);
});

console.log('\n[新增] 代码块着色');

it('highlightCode: 关键字 / 字符串 / 注释分别着色', () => {
  const html = code.highlightCode('const a = "hi"; // 注释', 'js');
  assert.ok(html.includes('md-code-kw'));
  assert.ok(html.includes('md-code-str'));
  assert.ok(html.includes('md-code-com'));
});

it('highlightCode: HTML 特殊字符被转义', () => {
  const html = code.highlightCode('if (a < b && c > d)', 'js');
  assert.ok(html.includes('&lt;') && html.includes('&amp;'));
  assert.ok(!html.includes('<b'));
});

it('highlightCode: Python 的 # 注释被识别', () => {
  const html = code.highlightCode('x = 1  # 说明', 'python');
  assert.ok(html.includes('md-code-com'));
});

it('highlightCode: 未知语言不抛错，原文保留', () => {
  const html = code.highlightCode('随便写点什么', 'no-such-lang');
  assert.ok(html.includes('随便写点什么'));
});

console.log('\n──────────────────────────────');
console.log(`结果：${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
