/**
 * 编辑原语：在整篇 Markdown 文本上做插入、删除、光标移动。
 *
 * 纯函数，不涉及 DOM 与 React。
 */

import { listPrefixOf } from './md-inline';

/** 一次编辑的结果 */
export interface EditOutcome {
  text: string;
  caret: number;
  /** 需要同时建立选区时给出，例如删除整行之后 */
  select?: { start: number; end: number };
}

/**
 * 在光标处插入文本。
 *
 * @param text 整篇 Markdown
 * @param caret 光标下标
 * @param insert 插入内容，可含换行
 * @returns 新文本与新光标，光标落在插入内容之后
 */
export function insertAt(text: string, caret: number, insert: string): EditOutcome {
  const pos = Math.max(0, Math.min(caret, text.length));
  return { text: text.slice(0, pos) + insert + text.slice(pos), caret: pos + insert.length };
}

/**
 * 退格，删除光标前一个字符。
 *
 * 光标位于列表行的行首（前缀之前）时不删除前缀，而是在该行上方插入一个同款空列表项，
 * 原内容下移一行，光标落在新空项上。删除前缀会破坏列表结构。
 *
 * @param text 整篇 Markdown
 * @param caret 光标下标
 * @returns 新文本与新光标；已在文首时原样返回
 */
export function backspace(text: string, caret: number): EditOutcome {
  if (caret <= 0) return { text, caret: 0 };

  const { index, start } = lineIndexOf(text, caret);
  const line = text.split('\n')[index] ?? '';
  const lp = listPrefixOf(line);

  if (lp && caret === start) {
    const insert = lp.prefix + '\n';
    return {
      text: text.slice(0, caret) + insert + text.slice(caret),
      caret: caret + lp.prefix.length,
    };
  }

  return { text: text.slice(0, caret - 1) + text.slice(caret), caret: caret - 1 };
}

/**
 * 前向删除，删除光标后一个字符。
 *
 * @param text 整篇 Markdown
 * @param caret 光标下标
 * @returns 新文本与新光标；已在文末时原样返回
 */
export function del(text: string, caret: number): EditOutcome {
  if (caret >= text.length) return { text, caret: text.length };
  return { text: text.slice(0, caret) + text.slice(caret + 1), caret };
}

/**
 * 回车换行，并在列表行内续写列表。
 *
 * 光标位于列表前缀之后时，换行并补出下一项的前缀；当前列表项内容为空时，改为移除本行前缀，
 * 即退出列表。
 *
 * @param text 整篇 Markdown
 * @param caret 光标下标
 * @returns 新文本与新光标
 */
export function enter(text: string, caret: number): EditOutcome {
  const { index, start } = lineIndexOf(text, caret);
  const line = text.split('\n')[index] ?? '';
  const lp = listPrefixOf(line);

  if (lp && caret >= start + lp.len) {
    if (line.slice(lp.len).trim() === '') {
      return { text: text.slice(0, start) + text.slice(start + lp.len), caret: start };
    }
    return insertAt(text, caret, '\n' + lp.nextPrefix);
  }

  return insertAt(text, caret, '\n');
}

/**
 * 求光标所在行的行号与该行起始下标。
 *
 * @param text 整篇 Markdown
 * @param caret 光标下标
 * @returns 0 基行号与行首下标
 */
export function lineIndexOf(text: string, caret: number): { index: number; start: number } {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf('\n') + 1;
  return { index: before.split('\n').length - 1, start };
}

/**
 * 求某一一行行首或行尾的光标下标。
 *
 * @param text 整篇 Markdown
 * @param lineIndex 目标行号，0 基，越界时夹紧
 * @param where 行首或行尾
 * @returns 光标下标
 */
export function caretAtLineEdge(text: string, lineIndex: number, where: 'start' | 'end'): number {
  const lines = text.split('\n');
  const idx = Math.max(0, Math.min(lineIndex, lines.length - 1));
  let pos = 0;
  for (let i = 0; i < idx; i++) pos += lines[i].length + 1;
  return where === 'start' ? pos : pos + lines[idx].length;
}

/**
 * 上下移动光标，尽量保持列号。
 *
 * 目标行较短时夹到行尾。
 *
 * @param text 整篇 Markdown
 * @param caret 光标下标
 * @param dir -1 向上，1 向下
 * @returns 光标下标
 */
export function moveLine(text: string, caret: number, dir: -1 | 1): number {
  const lines = text.split('\n');
  const { index, start } = lineIndexOf(text, caret);
  const col = caret - start;
  const target = index + dir;
  if (target < 0 || target >= lines.length) return caret;
  const base = caretAtLineEdge(text, target, 'start');
  return base + Math.min(col, lines[target].length);
}

/**
 * 左右移动光标一个字符。
 *
 * @param text 整篇 Markdown
 * @param caret 光标下标
 * @param dir -1 向左，1 向右
 * @returns 光标下标
 */
export function moveChar(text: string, caret: number, dir: -1 | 1): number {
  return Math.max(0, Math.min(caret + dir, text.length));
}

/**
 * 按住 Shift 移动光标时求新的光标位置。
 *
 * 只返回新光标，选区锚点由调用方保存。
 *
 * @param text 整篇 Markdown
 * @param caret 光标下标
 * @param dir 移动方向
 * @param key 按下的方向键
 * @returns 光标下标
 */
export function extendSelection(
  text: string,
  caret: number,
  dir: -1 | 1,
  key: 'left' | 'right' | 'up' | 'down' | 'home' | 'end',
): number {
  switch (key) {
    case 'left':
    case 'right':
      return moveChar(text, caret, dir);
    case 'up':
    case 'down':
      return moveLine(text, caret, key === 'up' ? -1 : 1);
    case 'home': {
      const { index } = lineIndexOf(text, caret);
      return caretAtLineEdge(text, index, 'start');
    }
    case 'end': {
      const { index } = lineIndexOf(text, caret);
      return caretAtLineEdge(text, index, 'end');
    }
  }
}

/**
 * 删除光标所在的整行，含行尾换行符。
 *
 * @param text 整篇 Markdown
 * @param caret 光标下标
 * @returns 新文本与新光标
 */
export function deleteLine(text: string, caret: number): EditOutcome {
  const lines = text.split('\n');
  const { index } = lineIndexOf(text, caret);
  if (lines.length <= 1) return { text: '', caret: 0 };
  lines.splice(index, 1);
  const newText = lines.join('\n');
  let pos = 0;
  for (let i = 0; i < Math.min(index, lines.length); i++) pos += lines[i].length + 1;
  return { text: newText, caret: Math.min(pos, newText.length) };
}

/**
 * 软换行，插入换行但不续写列表。
 *
 * @param text 整篇 Markdown
 * @param caret 光标下标
 * @returns 新文本与新光标
 */
export function softBreak(text: string, caret: number): EditOutcome {
  return insertAt(text, caret, '\n');
}

/**
 * 求光标所在「词」的范围。
 *
 * 词的定义为连续的非空白、非行内标记字符，与 md-commands 中包裹选区时的取词规则一致。
 *
 * @param text 整篇 Markdown
 * @param pos 光标下标
 * @returns 词的起止；光标不在词内且不贴着词时返回 null
 */
export function wordBoundsAt(text: string, pos: number): { start: number; end: number } | null {
  const p = Math.max(0, Math.min(text.length, pos));
  const re = /[^\s*_~`=]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const s = m.index;
    const e = s + m[0].length;
    if (p >= s && p <= e) return { start: s, end: e };
    if (s > p) break;
  }
  return null;
}

/**
 * 删除光标所在的词。
 *
 * 连同词后紧邻的一个空格一并删除。
 *
 * @param text 整篇 Markdown
 * @param caret 光标下标
 * @returns 新文本与新光标；光标不在词上时返回 null
 */
export function deleteWordAt(text: string, caret: number): EditOutcome | null {
  const w = wordBoundsAt(text, caret);
  if (!w) return null;
  let end = w.end;
  if (text[end] === ' ') end += 1;
  return { text: text.slice(0, w.start) + text.slice(end), caret: w.start };
}
