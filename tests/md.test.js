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
const langs = require('./build/code-langs.js');

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
  assert.strictEqual(inline.classifyLine('## 标题', null).type, 'h2');
  assert.strictEqual(inline.classifyLine('## 标题', null).prefixLen, 3);
  assert.strictEqual(inline.classifyLine('', null).type, 'blank');
  assert.strictEqual(inline.classifyLine('   ', null).type, 'blank');
  assert.strictEqual(inline.classifyLine('```', null).type, 'fence');
  assert.strictEqual(inline.classifyLine('code', '```').type, 'code');
  assert.strictEqual(inline.classifyLine('> x', null).type, 'quote');
  assert.strictEqual(inline.classifyLine('- x', null).type, 'ul');
  assert.strictEqual(inline.classifyLine('- x', null).prefixLen, 2);
  assert.strictEqual(inline.classifyLine('1. x', null).type, 'ol');
  assert.strictEqual(inline.classifyLine('1. x', null).marker, '1');
  assert.strictEqual(inline.classifyLine('---', null).type, 'hr');
  assert.strictEqual(inline.classifyLine('普通段落', null).type, 'p');
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

it('makeTableSnippet: 行数含表头行，分隔行不算行', () => {
  const lines = cmd.makeTableSnippet(3, 4).split('\n');
  // 4 行 = 表头 + 分隔 + 2 个数据行
  assert.strictEqual(lines.length, 5);
  assert.strictEqual(lines[0], '|  |  |  |');
  assert.strictEqual(lines[1], '| --- | --- | --- |');
  assert.strictEqual(lines[4], '|  |  |  |');
});

it('makeTableSnippet: 最少 1 行 1 列（只有表头也能成表）', () => {
  const lines = cmd.makeTableSnippet(1, 1).split('\n');
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0], '|  |');
  assert.strictEqual(lines[1], '| --- |');
});

it('makeTableSnippet: 列数决定每行单元格数', () => {
  for (const c of [1, 2, 5, 8]) {
    const lines = cmd.makeTableSnippet(c, 3).split('\n');
    for (const l of lines) assert.strictEqual(cmd.tableCellRanges(l).length, c);
  }
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

it('revealSegAt: 任务片段 → 露出 `[ ] ` 源码（不复用复选框渲染态）', () => {
  // buildLines 造出的真实片段：task 覆盖 `[ ] `，raw 与 src 等长
  const src = '- [ ] 待办';
  const segs = [
    { text: '[ ] ', srcStart: 2, rawStart: 2, rawEnd: 6, kind: 'task', checked: false },
    { text: '待办', srcStart: 6, rawStart: 6, rawEnd: 8, kind: 'plain' },
  ];
  const out = inline.revealSegAt(segs, src, 3);
  // 关键：kind 必须变成 plain，否则 renderSegs 还会画复选框、源码模式看不出区别
  assert.strictEqual(out[0].kind, 'plain', '任务片段应展开成 plain 才能显示原文');
  assert.strictEqual(out[0].text, '[ ] ');
  assert.deepStrictEqual(
    out.map((s) => s.kind),
    ['plain', 'plain'],
  );
});

it('revealSegAt: 任务片段等长是唯一特例 —— 提前 return 会把它打回，必须排在它前面', () => {
  // 这是一个回归用例：曾经把 task 分支写在「可见文本与源码等长 → return segs」之后，
  // 于是永远执行不到，任务行在源码模式下看不出 `[ ] ` 原文。
  const src = '- [x] 完成';
  const segs = [
    { text: '[x] ', srcStart: 2, rawStart: 2, rawEnd: 6, kind: 'task', checked: true },
    { text: '完成', srcStart: 6, rawStart: 6, rawEnd: 8, kind: 'plain' },
  ];
  const out = inline.revealSegAt(segs, src, 4);
  assert.notStrictEqual(out, segs, '不能原样返回（那说明被提前 return 拦下了）');
  assert.strictEqual(out[0].kind, 'plain');
});

it('revealSegAt: 光标不在任务片段上时不受影响', () => {
  const src = '- [ ] 待办';
  const segs = [
    { text: '[ ] ', srcStart: 2, rawStart: 2, rawEnd: 6, kind: 'task', checked: false },
    { text: '待办', srcStart: 6, rawStart: 6, rawEnd: 8, kind: 'plain' },
  ];
  // col=0 落在 `- ` 上（前缀不在 segs 里，findIndex 会命中第一个 raw 区间不覆盖 0 的片段）
  const out = inline.revealSegAt(segs, src, 7);
  assert.strictEqual(out[0].kind, 'task', '光标在正文上时复选框照旧');
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

console.log('\n[新增] 粗斜体 / 转义 / 引用式链接 / 脚注');

it('parseInline: 粗斜体 ***x*** 不被拆成 ** + *x*', () => {
  const segs = inline.parseInline('***粗斜***');
  assert.deepStrictEqual(
    segs.map((s) => [s.text, s.kind, s.srcStart, s.rawStart, s.rawEnd]),
    [['粗斜', 'strongem', 3, 0, 8]],
  );
});

it('parseInline: 转义 \\* 输出字面星号，反斜杠不占可见字符', () => {
  const segs = inline.parseInline('a \\* b');
  assert.deepStrictEqual(
    segs.map((s) => [s.text, s.srcStart, s.rawStart, s.rawEnd]),
    [
      ['a ', 0, 0, 2],
      ['*', 3, 2, 4],
      [' b', 4, 4, 6],
    ],
  );
});

it('parseInline: 引用式链接用 defs 解析出地址', () => {
  const segs = inline.parseInline('见 [文档][d1]', { d1: 'https://x' });
  const link = segs.find((s) => s.kind === 'link');
  assert.ok(link && link.href === 'https://x' && link.text === '文档');
});

it('parseInline: 没有对应定义时引用式链接保持原文', () => {
  const segs = inline.parseInline('见 [文档][nope]');
  assert.ok(!segs.some((s) => s.kind === 'link'));
});

it('parseInline: 脚注引用 [^1] → kind=fnref，可见文字是脚注 id', () => {
  const segs = inline.parseInline('正文[^1]');
  assert.deepStrictEqual(
    segs.map((s) => [s.text, s.kind, s.srcStart]),
    [
      ['正文', 'plain', 0],
      ['1', 'fnref', 4],
    ],
  );
});

console.log('\n[新增] 行内 HTML');

it('parseInline: 白名单内的行内 HTML 单独成片段', () => {
  const segs = inline.parseInline('a <u>下划线</u> b');
  assert.deepStrictEqual(
    segs.map((s) => [s.text, s.kind, s.htmlTag, s.srcStart, s.rawStart, s.rawEnd]),
    [
      ['a ', 'plain', undefined, 0, 0, 2],
      ['下划线', 'html', 'u', 5, 2, 12],
      [' b', 'plain', undefined, 12, 12, 14],
    ],
  );
});

it('parseInline: 白名单外的标签当普通文本（不做注入）', () => {
  const segs = inline.parseInline('<script>x</script>');
  assert.ok(!segs.some((s) => s.kind === 'html'));
});

it('parseInline: <br> 识别为无内容标签', () => {
  const segs = inline.parseInline('a<br>b');
  const v = segs.find((s) => s.kind === 'htmlvoid');
  assert.ok(v && v.htmlTag === 'br' && v.text === '<br>');
});

console.log('\n[新增] 文本高亮');

it('parseInline: ==x== 单独成片段', () => {
  const segs = inline.parseInline('a ==重点== b');
  assert.deepStrictEqual(
    segs.map((s) => [s.text, s.kind, s.srcStart, s.rawStart, s.rawEnd]),
    [
      ['a ', 'plain', 0, 0, 2],
      ['重点', 'hl', 4, 2, 8],
      [' b', 'plain', 8, 8, 10],
    ],
  );
});

it('parseInline: 落单的 == 当普通文本', () => {
  const segs = inline.parseInline('a == b');
  assert.ok(!segs.some((s) => s.kind === 'hl'));
});

console.log('\n[新增] 围栏识别');

it('classifyLine: 闭围栏也认成 fence，否则后面整篇会被误判成代码', () => {
  assert.strictEqual(inline.classifyLine('```', '```').type, 'fence');
  assert.strictEqual(inline.classifyLine('```js', null).type, 'fence');
  assert.strictEqual(inline.classifyLine('正文', '```').type, 'code');
  assert.strictEqual(inline.classifyLine('正文', null).type, 'p');
});

it('classifyLine: 四个反引号的围栏不被内层三个反引号闭合', () => {
  assert.strictEqual(inline.classifyLine('```', '````').type, 'code');
  assert.strictEqual(inline.classifyLine('````', '````').type, 'fence');
});

console.log('\n[新增] 插入块（表格 / 代码块）的落点');

it('insertBlock: 空文档里原地填入，不垫空行', () => {
  const r = cmd.insertBlock('', 0, '| a |\n| --- |', 'below');
  assert.strictEqual(r.text, '| a |\n| --- |');
  assert.strictEqual(r.caret, 2, '光标应落在第一格内容处');
});

it('insertBlock: 光标在空行上时原地填入', () => {
  const text = '第一段\n\n第三段';
  const r = cmd.insertBlock(text, 4, '| a |\n| --- |', 'below');
  assert.strictEqual(r.text, '第一段\n| a |\n| --- |\n第三段');
});

it('insertBlock: 非空行下方插入，中间留一个空行', () => {
  const text = '第一段\n第二段';
  const r = cmd.insertBlock(text, 0, '| a |\n| --- |', 'below');
  assert.strictEqual(r.text, '第一段\n\n| a |\n| --- |\n第二段');
});

it('insertBlock: 非空行上方插入，中间留一个空行', () => {
  const text = '第一段\n第二段';
  const r = cmd.insertBlock(text, 4, '| a |\n| --- |', 'above');
  assert.strictEqual(r.text, '第一段\n| a |\n| --- |\n\n第二段');
});

it('insertBlock: 代码块片段的光标落在开围栏之后', () => {
  const r = cmd.insertBlock('', 0, '```\n\n```', 'below');
  assert.strictEqual(r.text, '```\n\n```\n', '代码块末尾补一个空行');
  assert.strictEqual(r.caret, 4, '光标应落在开围栏那一行的换行之后');
});

it('insertBlock: 代码块/公式块末尾补空行，让光标能落到块外', () => {
  // 空文档
  assert.strictEqual(cmd.insertBlock('', 0, '```\n\n```', 'below').text, '```\n\n```\n');
  // 非空行下方
  assert.strictEqual(cmd.insertBlock('A', 0, '```\n\n```', 'below').text, 'A\n\n```\n\n```\n');
  // 非空行上方：块后仍要有一个空行与原文分开
  assert.strictEqual(cmd.insertBlock('A', 0, '```\n\n```', 'above').text, '```\n\n```\n\n\nA');
  // 公式块同样处理
  assert.strictEqual(cmd.insertBlock('', 0, '$$\n\n$$', 'below').text, '$$\n\n$$\n');
  // 表格不补（表格不是会把光标关起来的容器）
  assert.strictEqual(cmd.insertBlock('', 0, '| a |\n| --- |', 'below').text, '| a |\n| --- |');
});

it('needsTrailingBlank: 只认代码块与公式块', () => {
  assert.strictEqual(cmd.needsTrailingBlank('```js\nx\n```'), true);
  assert.strictEqual(cmd.needsTrailingBlank('$$\nx$$'), true);
  assert.strictEqual(cmd.needsTrailingBlank('| a |\n| --- |'), false);
  assert.strictEqual(cmd.needsTrailingBlank('> 引用'), false);
});

console.log('\n[新增] 代码块语言匹配');

it('语言表 141 条，且不去重', () => {
  assert.strictEqual(langs.CODE_LANG_HINTS.length, 141);
  assert.ok(langs.CODE_LANG_HINTS.includes('js') && langs.CODE_LANG_HINTS.includes('javascript'));
  assert.ok(langs.CODE_LANG_HINTS.includes('c++') && langs.CODE_LANG_HINTS.includes('cpp'));
});

it('matchLangs: 前缀匹配优先，命中不足 4 条时补子串匹配', () => {
  // 「py」前缀只命中 python 一条 → 不足 4 条 → 再补子串，但没有任何语言含 py 且不在开头
  assert.deepStrictEqual(langs.matchLangs('py'), ['python']);
  // 「java」前缀命中 java / javascript 两条
  assert.deepStrictEqual(langs.matchLangs('java'), ['java', 'javascript']);
});

it('matchLangs: 唯一命中且与输入完全相同时不提示', () => {
  assert.deepStrictEqual(langs.matchLangs('json'), []);
  assert.deepStrictEqual(langs.matchLangs('python'), []);
});

it('matchLangs: 前缀命中 ≥4 条时不再补子串', () => {
  const r = langs.matchLangs('c');
  assert.ok(r.length >= 4);
  assert.ok(r.every((l) => l.toLowerCase().startsWith('c')), '不应该混进子串命中：' + r.join(','));
});

it('matchLangs: 空输入返回全部（排序后）', () => {
  const r = langs.matchLangs('');
  assert.strictEqual(r.length, 141);
  const sorted = [...r].sort();
  assert.deepStrictEqual(r, sorted);
});

it('matchLangs: 大小写不敏感（但「完全一致」的判定区分大小写）', () => {
  assert.deepStrictEqual(langs.matchLangs('PY'), ['python']);
  // 输入 Python 仍会提示 python —— 相等判定用的 `n[0] === e` 区分大小写
  assert.deepStrictEqual(langs.matchLangs('Python'), ['python']);
  assert.deepStrictEqual(langs.matchLangs('python'), []);
});

it('parseFenceOptions: 认 {.numberLines} 与 startFrom="N"', () => {
  assert.deepStrictEqual(langs.parseFenceOptions('{.numberLines}'), { lineNumbers: true });
  assert.deepStrictEqual(langs.parseFenceOptions('{startFrom="5"}'), { firstLineNumber: 5 });
  assert.deepStrictEqual(langs.parseFenceOptions('{.numberLines startFrom="5"}'), {
    lineNumbers: true,
    firstLineNumber: 5,
  });
  // 语言与属性写在一起也要认（只在 info string 里任意位置找 {...}，有意放宽）
  assert.deepStrictEqual(langs.parseFenceOptions('python {.numberLines}'), { lineNumbers: true });
  assert.deepStrictEqual(langs.parseFenceOptions('python {.numberLines startFrom="5"}'), {
    lineNumbers: true,
    firstLineNumber: 5,
  });
  // 没有 {...} 就什么都不认
  assert.deepStrictEqual(langs.parseFenceOptions('python'), {});
  assert.deepStrictEqual(langs.parseFenceOptions(''), {});
});

it('fenceLangOf: 从 info string 里取语言词', () => {
  assert.strictEqual(langs.fenceLangOf('python'), 'python');
  assert.strictEqual(langs.fenceLangOf('Python'), 'python');
  assert.strictEqual(langs.fenceLangOf('.lang-python'), 'python');
  assert.strictEqual(langs.fenceLangOf('lang-python'), 'python');
  assert.strictEqual(langs.fenceLangOf('{.numberLines}'), '', '纯属性串不该被当成语言');
  assert.strictEqual(langs.fenceLangOf('python {.numberLines}'), 'python');
});

it('buildFenceLine: 语言紧贴围栏，属性块前留一个空格', () => {
  assert.strictEqual(langs.buildFenceLine('', '```', 'python', ''), '```python');
  assert.strictEqual(langs.buildFenceLine('', '```', '', '{.numberLines}'), '```{.numberLines}');
  assert.strictEqual(
    langs.buildFenceLine('', '```', 'python', '{.numberLines startFrom="5"}'),
    '```python {.numberLines startFrom="5"}',
  );
  assert.strictEqual(langs.buildFenceLine('  ', '````', 'js', ''), '  ````js');
});

it('fenceAttrs: 行号属性块', () => {
  assert.strictEqual(langs.fenceAttrs(true), '{.numberLines}');
  assert.strictEqual(langs.fenceAttrs(true, 5), '{.numberLines startFrom="5"}');
  assert.strictEqual(langs.fenceAttrs(false), '');
  assert.strictEqual(langs.fenceAttrs(false, 5), '{startFrom="5"}');
});

// ── 缩进（Tab / Shift+Tab / Ctrl+[ ]） ──

it('indentUnitOf: 宽度转缩进串', () => {
  assert.strictEqual(cmd.indentUnitOf(4), '    ');
  assert.strictEqual(cmd.indentUnitOf(2), '  ');
  assert.strictEqual(cmd.indentUnitOf(8), '        ');
  // 非法宽度回退到正文单位（2 空格）
  assert.strictEqual(cmd.indentUnitOf(0), '  ');
  assert.strictEqual(cmd.indentUnitOf(-1), '  ');
  assert.strictEqual(cmd.indentUnitOf(NaN), '  ');
});

it('indentLines: 多行缩进保留选区，两端同步平移', () => {
  const text = 'aa\nbb\ncc';
  // 选中第 2、3 行（下标 3 到 8）
  const r = cmd.indentLines(text, 3, 8, 'in', '  ');
  assert.strictEqual(r.text, 'aa\n  bb\n  cc');
  assert.deepStrictEqual(r.select, { start: 5, end: 12 }, '选区两端都要跟着向后平移');
  assert.strictEqual(r.caret, 12);
});

it('indentLines: 多行反缩进，已到行首的行不动', () => {
  const text = '  aa\n    bb\ncc';
  const r = cmd.indentLines(text, 0, text.length, 'out', '  ');
  assert.strictEqual(r.text, 'aa\n  bb\ncc', '第三行没有缩进可退，保持不变');
  assert.deepStrictEqual(r.select, { start: 0, end: r.text.length });
});

it('indentLines: 反缩进优先吃一个 Tab', () => {
  const r = cmd.indentLines('\taa', 0, 3, 'out', '  ');
  assert.strictEqual(r.text, 'aa', 'Tab 占一格，一次吃一整个');
});

it('indentLine: 单行缩进用给定宽度', () => {
  assert.strictEqual(cmd.indentLine('aa', 0, 'in', '    ').text, '    aa');
  assert.strictEqual(cmd.indentLine('aa', 1, 'in', '    ').caret, 5, '光标随插入内容平移');
});

it('indentUnitAt: 代码块内用代码宽度，块外用正文宽度', () => {
  const text = 'para\n\n```py\nx = 1\n```\n';
  const offset = text.indexOf('x = 1');
  assert.strictEqual(cmd.indentUnitAt(text, offset, 4), '    ', '代码块内用 4 空格');
  assert.strictEqual(cmd.indentUnitAt(text, 1, 4), '  ', '块外仍用正文 2 空格');
});

// ── 表格里按 Tab 跳格 ──

it('tableTabTarget: 跳到下一格内容的开头', () => {
  const text = '| a | b |\n| --- | --- |\n| c | d |\n';
  // 光标在表头 `a` 上 → 跳到 `b`
  const b = cmd.tableTabTarget(text, 3, 1);
  assert.strictEqual(text.slice(b, b + 1), 'b');
});

it('tableTabTarget: 末格跳到下一行首格，跳过分隔行', () => {
  const text = '| a | b |\n| --- | --- |\n| c | d |\n';
  // 表头末格 `b`（下标 6）→ 应落到正文行首格 `c`，不能落在分隔行
  const c = cmd.tableTabTarget(text, 6, 1);
  assert.strictEqual(text.slice(c, c + 1), 'c');
});

it('tableTabTarget: 逆向跳格（Shift+Tab）', () => {
  const text = '| a | b |\n| --- | --- |\n| c | d |\n';
  const a = cmd.tableTabTarget(text, text.indexOf('c'), -1);
  assert.strictEqual(text.slice(a, a + 1), 'b', '正文首格反向跳回表头末格');
});

it('tableTabTarget: 表格末尾再往后跳返回 null', () => {
  const text = '| a | b |\n| --- | --- |\n| c | d |\n';
  assert.strictEqual(cmd.tableTabTarget(text, text.indexOf('d'), 1), null);
});

it('tableTabTarget: 不在表格里返回 null', () => {
  assert.strictEqual(cmd.tableTabTarget('普通段落', 1, 1), null);
});

console.log('\n──────────────────────────────');
console.log(`结果：${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
