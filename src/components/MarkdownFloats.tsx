'use client';

/**
 * 编辑器浮层：选区格式气泡、右键上下文菜单。
 *
 * 导出：
 * - `FormatBubble` / `ContextMenu` —— 两个浮层组件，Portal 到 body
 * - `INLINE_COMMANDS` / `BLOCK_COMMANDS` —— 命令表
 * - `buildContextMenu` / `buildImageMenu` / `buildLinkMenu` —— 按上下文生成菜单项
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bold,
  Italic,
  Code,
  Link2,
  Highlighter,
  Strikethrough,
  Table,
  Quote,
  List,
  ListOrdered,
  ListChecks,
  Minus,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  Image as ImageIcon,
  Code2,
  Link as LinkIcon,
  ExternalLink,
  Scissors,
  Copy,
  ClipboardPaste,
  Trash2,
  Pilcrow,
  Plus,
  Type,
  Undo2,
  Redo2,
  Eraser,
  TextSelect,
  ArrowUpToLine,
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  AlignLeft,
  Sigma,
  Search,
  IndentIncrease,
} from 'lucide-react';
import { INDENT_SIZE_CHOICES, type ContextInfo } from '@/lib/md-commands';
import { matchLangs, PLAIN_LANG_LABEL, MAX_LANG_HINTS } from '@/lib/code-langs';

/** 一条可执行的编辑命令 */
export interface MdCommand {
  /** 命令标识，既是 React key 也是调用方 switch 的依据 */
  id: string;
  /** 按钮上的中文说明 */
  label: string;
  /** 图标组件 */
  icon: React.ComponentType<{ size?: number | string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  /** 展示用的快捷键提示（只显示，绑定在 MarkdownEditor 的 onKeyDown） */
  hint?: string;
  /** 高亮显示（表示当前已生效） */
  active?: boolean;
}

/** 分隔线（菜单分组用） */
export interface MdSeparator {
  separator: true;
}

/**
 * 子菜单项：悬停展开，用来收纳同类命令。
 *
 * 菜单平铺过长会顶到视口外、部分项不可见，故同类命令收进子菜单。
 */
export interface MdSubmenu {
  /** 触发项文案 */
  label: string;
  /** 触发项图标 */
  icon: MdCommand['icon'];
  /** 展开后的条目 */
  items: MdMenuItem[];
}

/**
 * 一排图标按钮。把「加粗/斜体/删除线/行内代码/高亮/链接」收成一排，
 * 六个文字项压成一行，省下五行高度。
 */
export interface MdIconRow {
  icons: MdCommand[];
}

export type MdMenuItem = MdCommand | MdSeparator | MdSubmenu | MdIconRow;

/** 判断是分隔线还是命令项 */
export function isSeparator(item: MdMenuItem): item is MdSeparator {
  return 'separator' in item;
}

/** 判断是不是子菜单 */
export function isSubmenu(item: MdMenuItem): item is MdSubmenu {
  return 'items' in item;
}

/** 判断是不是图标行 */
export function isIconRow(item: MdMenuItem): item is MdIconRow {
  return 'icons' in item;
}

/** 浮层位置（相对视口） */
export interface FloatPos {
  x: number;
  y: number;
}

/**
 * 选区格式气泡。选中文字时浮出，给最常用的行内格式。
 *
 * @param props.pos 浮层坐标（视口坐标，已由调用方算好）
 * @param props.commands 要显示的命令
 * @param props.onRun 点某条命令时触发
 * @param props.onClose 需要关闭时（点了别处、按了 Esc）通知调用方
 */
export function FormatBubble({
  pos,
  commands,
  onRun,
  onClose,
}: {
  pos: FloatPos;
  commands: MdCommand[];
  onRun: (id: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 用 mousedown 而非 click：click 到达时选区已被按下动作清掉
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="toolbar"
      aria-label="格式"
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-[300] flex items-center gap-0.5 rounded-lg border border-border bg-card p-1 shadow-xl"
      // 气泡自己不许被选中，否则「按下鼠标想点按钮」会先把选区弄丢
      onMouseDown={(e) => e.preventDefault()}
    >
      {commands.map((c) => (
        <button
          key={c.id}
          type="button"
          title={c.hint ? `${c.label}（${c.hint}）` : c.label}
          aria-label={c.label}
          onClick={() => onRun(c.id)}
          className={`flex size-7 items-center justify-center rounded-md transition-colors ${
            c.active
              ? 'bg-accent/15 text-accent'
              : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground'
          }`}
        >
          <c.icon size={15} aria-hidden="true" />
        </button>
      ))}
    </div>,
    document.body,
  );
}

/**
 * 右键上下文菜单。
 *
 * @param props.pos 浮层坐标（鼠标位置）
 * @param props.items 要展示的条目（可含分隔线）
 * @param props.onRun 点某条命令时触发
 * @param props.onClose 需要关闭时通知调用方
 */
export function ContextMenu({
  pos,
  items,
  onRun,
  onClose,
}: {
  pos: FloatPos;
  items: MdMenuItem[];
  onRun: (id: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  /** 当前展开的子菜单（下标 + 飞出位置） */
  const [openSub, setOpenSub] = useState<{ index: number; pos: FloatPos } | null>(null);
  /**
   * 关闭子菜单的延时句柄。
   *
   * 不能一离开主菜单就立刻关：菜单与飞出层之间隔着几个像素的缝，
   * 鼠标穿过去的瞬间就会触发主菜单的 `onMouseLeave`，子菜单当场消失、点不到。
   * 给一点缓冲，鼠标进到飞出层就取消。
   */
  const closeTimer = useRef<number | null>(null);
  const cancelClose = () => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpenSub(null), 260);
  };
  useEffect(() => cancelClose, []);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      /**
       * 只有点到「菜单项按钮」才不关 —— 关早了按钮收不到 click，命令就丢了。
       *
       * 按「点在菜单范围内就不关」判定会形成死区：该区域内点击无法关闭菜单。
       */
      if (t?.closest?.('[role="menuitem"]')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    /**
     * 滚动 / 滚轮 / 窗口失焦都要关掉：菜单是 `fixed` 定位的，页面一滚它就钉在原地、跟内容脱节。
     * `pointerdown` 用捕获阶段：比冒泡阶段的 mousedown 更不容易被中途拦掉。
     *
     * 但**发生在菜单自己身上**的滚动/滚轮不算「页面动了」：菜单可以比视口高（`overflow-y-auto`），
     * 语言列表就有 28 项。不排除的话滚一下就把菜单关了，等于没法用。
     */
    const inMenu = (t: EventTarget | null) =>
      t instanceof Element && !!t.closest('[role="menu"]');
    const onScroll = (e: Event) => {
      if (inMenu(e.target)) return;
      onClose();
    };
    const onDismiss = () => onClose();
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('wheel', onScroll, { passive: true });
    window.addEventListener('resize', onDismiss, { passive: true });
    window.addEventListener('blur', onDismiss);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('wheel', onScroll);
      window.removeEventListener('resize', onDismiss);
      window.removeEventListener('blur', onDismiss);
    };
  }, [onClose]);

  /**
   * 按条目数估算菜单高度。
   *
   * 要按全部条目（含分隔线）算并留余量：只按命令项算会估小
   * （实测一处分隔线就让估算少了 23px），夹取差一截、菜单仍会超出视口底部。
   */
  const estHeight = (list: MdMenuItem[]): number => list.length * 30 + 16;

  const estH = estHeight(items);
  const estW = 200;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
  /**
   * 垂直方向：放得下就贴光标，放不下就整体上移到刚好放进视口。
   * 直接翻到光标上方会被夹到 `top: 4`，菜单会弹出在屏幕顶部并盖住顶栏。
   */
  const x = pos.x + estW > vw ? Math.max(4, pos.x - estW) : pos.x;
  const y = pos.y + estH > vh - 8 ? Math.max(4, vh - estH - 8) : pos.y;

  /**
   * 悬停某个子菜单项时算出飞出位置。
   *
   * 垂直方向必须夹取：不夹的话靠近窗口底部的子菜单会整片跑到视口外被裁掉。
   *
   * @param index 子菜单在 items 里的下标
   * @param el 触发项元素
   */
  const openSubmenuAt = (index: number, el: HTMLElement) => {
    cancelClose();
    const r = el.getBoundingClientRect();
    const w = 190;
    const inner = items[index] && isSubmenu(items[index]) ? (items[index] as MdSubmenu).items : [];
    const subH = estHeight(inner);
    const x = r.right + 2 + w > vw ? Math.max(4, r.left - w - 2) : r.right + 2;
    const y = Math.max(4, Math.min(r.top - 6, vh - subH - 8));
    setOpenSub({ index, pos: { x, y } });
  };

  /** 渲染子菜单里的条目（不递归，只支持一层） */
  const renderLeaf = (item: MdMenuItem, key: string) =>
    isSeparator(item) ? (
      <div key={key} className="my-1 border-t border-border" />
    ) : isSubmenu(item) || isIconRow(item) ? null : (
      <button
        key={item.id}
        type="button"
        role="menuitem"
        onClick={() => onRun(item.id)}
        className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition-colors ${
          item.active ? 'bg-accent/10 text-accent' : 'text-foreground hover:bg-foreground/[0.06]'
        }`}
      >
        <item.icon size={15} aria-hidden="true" />
        <span className="flex-1">{item.label}</span>
        {item.hint && <span className="text-[11px] text-muted-foreground">{item.hint}</span>}
      </button>
    );

  return createPortal(
    <>
      <div
        ref={ref}
        role="menu"
        style={{ left: x, top: y, minWidth: estW, maxHeight: vh - 16 }}
        className="fixed z-[300] overflow-y-auto rounded-lg border border-border bg-card py-1 shadow-2xl"
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
      >
        {items.map((item, i) => {
          if (isSeparator(item)) return <div key={`sep-${i}`} className="my-1 border-t border-border" />;

          // 一排图标按钮（行内格式）
          if (isIconRow(item)) {
            return (
              <div key={`row-${i}`} className="flex items-center gap-0.5 px-2 py-1">
                {item.icons.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="menuitem"
                    title={c.hint ? `${c.label}（${c.hint}）` : c.label}
                    aria-label={c.label}
                    onClick={() => onRun(c.id)}
                    className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                  >
                    <c.icon size={15} aria-hidden="true" />
                  </button>
                ))}
              </div>
            );
          }

          // 子菜单
          if (isSubmenu(item)) {
            return (
              <button
                key={`sub-${i}`}
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                onMouseEnter={(e) => openSubmenuAt(i, e.currentTarget)}
                onClick={(e) => openSubmenuAt(i, e.currentTarget)}
                className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition-colors ${
                  openSub?.index === i ? 'bg-foreground/[0.06]' : 'text-foreground hover:bg-foreground/[0.06]'
                }`}
              >
                <item.icon size={15} aria-hidden="true" />
                <span className="flex-1">{item.label}</span>
                <span className="text-[11px] text-muted-foreground">▸</span>
              </button>
            );
          }

          return renderLeaf(item, item.id);
        })}
      </div>

      {/* 子菜单飞出层：fixed 定位，不受主菜单的 overflow 裁切 */}
      {openSub && (
        <div
          data-submenu=""
          role="menu"
          style={{ left: openSub.pos.x, top: openSub.pos.y, minWidth: 180, maxHeight: vh - 16 }}
          className="fixed z-[310] overflow-y-auto rounded-lg border border-border bg-card py-1 shadow-2xl"
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          {items[openSub.index] && isSubmenu(items[openSub.index])
            ? (items[openSub.index] as MdSubmenu).items.map((s, k) => renderLeaf(s, `sub-${k}`))
            : null}
        </div>
      )}
    </>,
    document.body,
  );
}

// ── 插入表格对话框 ────────────────────────────────────────

/**
 * 插入表格对话框：列数 / 行数可填，默认 3 列 4 行。
 *
 * @param props.onConfirm 确定（列数、总行数）
 * @param props.onCancel 取消（点遮罩、Esc、取消按钮）
 */
export function TableInsertDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: (cols: number, rows: number) => void;
  onCancel: () => void;
}) {
  const [cols, setCols] = useState('3');
  const [rows, setRows] = useState('3');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  /** 把输入夹到合法范围；空值或非数字才退回默认值 */
  const clampNum = (v: string, min: number, max: number, dflt: number) => {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) return dflt;
    return Math.max(min, Math.min(max, n));
  };

  const INPUT =
    'w-16 rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-ring';

  return createPortal(
    <div
      className="fixed inset-0 z-[320] flex items-start justify-center bg-foreground/20 pt-[18vh]"
      onMouseDown={onCancel}
    >
      <div
        role="dialog"
        aria-label="插入表格"
        className="w-[320px] rounded-lg border border-border bg-card p-4 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <p className="mb-3 text-sm font-bold text-foreground">插入表格</p>
        <div className="flex items-center gap-3 text-sm text-foreground">
          <label className="flex items-center gap-1.5">
            列
            <input
              autoFocus
              value={cols}
              onChange={(e) => setCols(e.target.value)}
              inputMode="numeric"
              aria-label="列数"
              className={INPUT}
            />
          </label>
          <label className="flex items-center gap-1.5">
            行
            <input
              value={rows}
              onChange={(e) => setRows(e.target.value)}
              inputMode="numeric"
              aria-label="行数"
              className={INPUT}
            />
          </label>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          行数含表头行（分隔行不算行）；表格必须有表头，最少 1 行 1 列
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="btn-soft">
            取消
          </button>
          <button
            type="button"
            onClick={() => onConfirm(clampNum(cols, 1, 12, 3), clampNum(rows, 1, 50, 3))}
            className="btn-primary"
          >
            确定
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function LangPicker({
  pos,
  current,
  onPick,
  onClose,
}: {
  pos: { x: number; y: number };
  /** 当前代码块已有的语言；用来把那一项标出来 */
  current: string;
  onPick: (lang: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  /**
   * 候选列表 = matchLangs 的匹配结果。
   * 空输入时在最前面补一条「纯文本」，用来把语言清掉（等价于清空输入，但更容易发现）。
   */
  const matched = matchLangs(query);
  const list: { id: string; label: string }[] = [
    ...(query === '' ? [{ id: '', label: PLAIN_LANG_LABEL }] : []),
    ...matched.slice(0, MAX_LANG_HINTS).map((l) => ({ id: l, label: l })),
  ];

  const w = 240;
  const maxH = 300;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
  const x = Math.min(Math.max(4, pos.x), Math.max(4, vw - w - 4));
  const y = pos.y + maxH + 4 > vh ? Math.max(4, pos.y - maxH - 8) : pos.y + 4;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setHi(0);
  }, [query]);

  // 键盘上下移动时把选中项滚进视野
  useEffect(() => {
    const el = listRef.current?.querySelectorAll('[data-lang-li]')[hi] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [hi, list.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHi((h) => Math.min(h + 1, Math.max(0, list.length - 1)));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHi((h) => Math.max(h - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const pick = list[hi];
        if (pick) onPick(pick.id);
        else if (query === '') onPick('');
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.('[data-lang-picker]')) return;
      onClose();
    };
    /**
     * 滚轮 / 滚动发生在面板自己身上不算「页面动了」——
     * 语言列表可以滚，滚一下就关没法用（和 ContextMenu 同一条规则）。
     */
    const onScroll = (e: Event) => {
      if (e.target instanceof Element && e.target.closest('[data-lang-picker]')) return;
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('wheel', onScroll, { passive: true });
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('wheel', onScroll);
    };
  }, [list, hi, query, onPick, onClose]);

  return createPortal(
    <div
      data-lang-picker=""
      role="listbox"
      aria-label="选择代码块语言"
      style={{ left: x, top: y, width: w }}
      className="fixed z-[320] overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Search size={14} className="text-muted-foreground" aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="选择语言"
          aria-label="搜索语言"
          className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        <span className="shrink-0 text-[11px] text-muted-foreground">{list.length}</span>
      </div>
      <div
        ref={listRef}
        data-lang-picker-list=""
        className="max-h-[264px] overflow-y-auto py-1"
        style={{ maxHeight: maxH - 36 }}
      >
        {list.length === 0 && (
          <div className="px-3 py-2 text-sm text-muted-foreground" data-lang-picker="">
            无匹配
          </div>
        )}
        {list.map((lang, i) => (
          <button
            key={lang.id || '__plain__'}
            type="button"
            data-lang-li={i}
            data-lang-picker=""
            onMouseEnter={() => setHi(i)}
            onClick={() => onPick(lang.id)}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
              i === hi ? 'bg-foreground/[0.06]' : 'hover:bg-foreground/[0.06]'
            }`}
          >
            <span className="flex-1 font-mono text-[13px] text-foreground">{lang.label}</span>
            {lang.id !== '' && lang.id === current && (
              <span className="text-[11px] text-accent">当前</span>
            )}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

// ── 命令表 ────────────────────────────────────────────────

/** 行内格式（气泡用） */
export const INLINE_COMMANDS: MdCommand[] = [
  { id: 'bold', label: '加粗', icon: Bold, hint: 'Ctrl+B' },
  { id: 'italic', label: '斜体', icon: Italic, hint: 'Ctrl+I' },
  { id: 'strike', label: '删除线', icon: Strikethrough },
  { id: 'code', label: '行内代码', icon: Code, hint: 'Ctrl+`' },
  { id: 'highlight', label: '高亮', icon: Highlighter },
  { id: 'link', label: '链接', icon: Link2, hint: 'Ctrl+K' },
];

/** 块级插入（菜单用） */
export const BLOCK_COMMANDS: MdCommand[] = [
  { id: 'h1', label: '一级标题', icon: Heading1 },
  { id: 'h2', label: '二级标题', icon: Heading2 },
  { id: 'h3', label: '三级标题', icon: Heading3 },
  { id: 'h4', label: '四级标题', icon: Heading4 },
  { id: 'h5', label: '五级标题', icon: Heading5 },
  { id: 'h6', label: '六级标题', icon: Heading6 },
  { id: 'table', label: '插入表格', icon: Table },
  { id: 'code', label: '插入代码块', icon: Code2 },
  { id: 'quote', label: '插入引用', icon: Quote },
  { id: 'bullet', label: '无序列表', icon: List },
  { id: 'ordered', label: '有序列表', icon: ListOrdered },
  { id: 'todo', label: '待办项', icon: ListChecks },
  { id: 'hr', label: '分割线', icon: Minus },
];

/**
 * 剪贴板组：剪切 / 复制 / 粘贴。放在菜单最上方。
 *
 * @returns 三条剪贴板命令
 */
export function clipboardGroup(): MdMenuItem[] {
  return [
    { id: 'cut', label: '剪切', icon: Scissors, hint: 'Ctrl+X' },
    { id: 'copy', label: '复制', icon: Copy, hint: 'Ctrl+C' },
    { id: 'paste', label: '粘贴', icon: ClipboardPaste, hint: 'Ctrl+V' },
  ];
}

/**
 * 删除当前块。文案即「删除」。
 *
 * @returns 一条删除命令
 */
export function deleteGroup(): MdMenuItem[] {
  return [{ id: 'delete-block', label: '删除', icon: Trash2 }];
}

/**
 * `段落 ▸` 子菜单：标题档位 + 列表 / 引用 / 正文。
 *
 * @param ctx 光标上下文（用来给当前生效的那一项打高亮）
 * @returns 子菜单条目
 */
function paragraphSubmenu(ctx: ContextInfo): MdSubmenu {
  return {
    label: '段落',
    icon: Pilcrow,
    items: [
      { id: 'h1', label: '一级标题', icon: Heading1, active: ctx.headingLevel === 1 },
      { id: 'h2', label: '二级标题', icon: Heading2, active: ctx.headingLevel === 2 },
      { id: 'h3', label: '三级标题', icon: Heading3, active: ctx.headingLevel === 3 },
      { id: 'h4', label: '四级标题', icon: Heading4, active: ctx.headingLevel === 4 },
      { id: 'h5', label: '五级标题', icon: Heading5, active: ctx.headingLevel === 5 },
      { id: 'h6', label: '六级标题', icon: Heading6, active: ctx.headingLevel === 6 },
      { separator: true },
      { id: 'quote', label: '引用', icon: Quote, active: ctx.quote },
      { id: 'bullet', label: '无序列表', icon: List, active: ctx.list },
      { id: 'ordered', label: '有序列表', icon: ListOrdered, active: ctx.list },
      { id: 'todo', label: '待办项', icon: ListChecks },
      { separator: true },
      { id: 'normal', label: '正文', icon: Type, active: !ctx.quote && !ctx.list && !ctx.heading },
    ],
  };
}

/**
 * 代码块的语言候选。顺序按常用度排，不按字母序。
 *
 * 空 id 表示「纯文本」，对应去掉围栏上的 info string。
 * 这里只列语言名；能不能着色由 `lib/md-code.ts` 决定，选了不支持的语言不影响渲染，只是不着色。
 */
export const CODE_LANGS: { id: string; label: string }[] = [
  { id: '', label: '纯文本' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'python', label: 'Python' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
  { id: 'java', label: 'Java' },
  { id: 'c', label: 'C' },
  { id: 'cpp', label: 'C++' },
  { id: 'csharp', label: 'C#' },
  { id: 'json', label: 'JSON' },
  { id: 'yaml', label: 'YAML' },
  { id: 'toml', label: 'TOML' },
  { id: 'xml', label: 'XML' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'scss', label: 'SCSS' },
  { id: 'sql', label: 'SQL' },
  { id: 'shell', label: 'Shell' },
  { id: 'powershell', label: 'PowerShell' },
  { id: 'php', label: 'PHP' },
  { id: 'ruby', label: 'Ruby' },
  { id: 'swift', label: 'Swift' },
  { id: 'kotlin', label: 'Kotlin' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'mermaid', label: 'Mermaid' },
  { id: 'diff', label: 'Diff' },
  { id: 'latex', label: 'LaTeX' },
];

/**
 * 代码块的语言选择菜单。
 *
 * 命令 id 编码成 `lang:<行号>:<语言>`：菜单本身不携带上下文，
 * 行号写进 id 后由 runCommand 解析，免得再给菜单状态加字段。
 *
 * @param lineIndex 代码块开围栏那一行的行号
 * @returns 菜单条目
 */
export function buildLangMenu(lineIndex: number): MdMenuItem[] {
  return CODE_LANGS.map((l) => ({ id: `lang:${lineIndex}:${l.id}`, label: l.label, icon: Code2 }));
}

/**
 * `插入 ▸` 子菜单。
 *
 * 条目顺序：图像 / ── / 脚注 / 链接引用 / 水平分割线 / 表格 /
 * 代码块 / 公式块 / 内容目录 / YAML Front Matter / ── / 段落（上方）/ 段落（下方）。
 *
 * 列表与引用不在这组，收在 `段落 ▸` 里。
 *
 * @returns 子菜单条目
 */
function insertSubmenu(): MdSubmenu {
  return {
    label: '插入',
    icon: Plus,
    items: [
      { id: 'image', label: '图像', icon: ImageIcon },
      { separator: true },
      { id: 'footnote', label: '脚注', icon: Type },
      { id: 'linkref', label: '链接引用', icon: LinkIcon },
      { id: 'hr', label: '水平分割线', icon: Minus },
      { id: 'table', label: '表格', icon: Table },
      { id: 'codeblock', label: '代码块', icon: Code2 },
      { id: 'mathblock', label: '公式块', icon: Sigma },
      { id: 'toc', label: '内容目录', icon: List },
      { id: 'yaml', label: 'YAML Front Matter', icon: AlignLeft },
      { separator: true },
      { id: 'p-before', label: '段落（上方）', icon: ArrowUpToLine },
      { id: 'p-after', label: '段落（下方）', icon: ArrowDownToLine },
    ],
  };
}

/**
 * 表格组的分组顺序：上方/下方插入行 → 左侧/右侧插入列 → 删除行/删除列 → 复制表格/格式化表格源码 → 删除表格。
 *
 * @returns 表格操作条目
 */
export function tableGroup(): MdMenuItem[] {
  return [
    { id: 'table-row-above', label: '上方插入行', icon: ArrowUpToLine },
    { id: 'table-row-below', label: '下方插入行', icon: ArrowDownToLine },
    { separator: true },
    { id: 'table-col-left', label: '左侧插入列', icon: ArrowLeftToLine },
    { id: 'table-col-right', label: '右侧插入列', icon: ArrowRightToLine },
    { separator: true },
    { id: 'table-row-delete', label: '删除行', icon: Trash2, hint: 'Ctrl+Shift+⌫' },
    { id: 'table-col-delete', label: '删除列', icon: Trash2 },
    { separator: true },
    { id: 'table-copy', label: '复制表格', icon: Copy },
    { id: 'table-format', label: '格式化表格源码', icon: AlignLeft },
    { separator: true },
    { id: 'table-delete', label: '删除表格', icon: Trash2 },
  ];
}

/**
 * `表格 ▸` 子菜单。
 *
 * 表格操作收在子菜单里，不在主菜单平铺 —— 平铺会把主菜单撑到视口外。
 *
 * @returns 子菜单条目
 */
export function tableSubmenu(): MdSubmenu {
  return { label: '表格', icon: Table, items: tableGroup() };
}

/**
 * `缩进宽度 ▸` 子菜单：只影响当前光标所在的代码块缩进，不影响正文。
 *
 * 候选取 2 / 4 / 8（与 lib/md-commands 的 INDENT_SIZE_CHOICES 一致），
 * 命令 id 形如 `code-indent:4`，由调用方解析。
 *
 * @param current 当前生效的缩进宽度（空格数）
 * @returns 子菜单条目
 */
function codeIndentSubmenu(current?: number): MdSubmenu {
  return {
    label: '缩进宽度',
    icon: IndentIncrease,
    items: INDENT_SIZE_CHOICES.map((n) => ({
      id: `code-indent:${n}`,
      label: `${n} 个空格`,
      icon: IndentIncrease,
      active: current === n,
    })),
  };
}

/**
 * 按光标上下文生成右键菜单项。
 *
 * **按上下文动态显隐**，不再是一份固定长列表：
 *  - 代码块里只留「块级」操作（跳出 / 语言 / 行号 / 折行 / 缩进宽度 / 插入），
 *    行内格式、清除格式、段落子菜单一并隐藏 —— 代码块内改标题、加粗都没有意义；
 *  - 表格里显示「表格 ▸」、隐藏「段落 ▸」（标题与表格互斥）；
 *  - 其余位置显示行内格式 + 段落 + 插入。
 *
 * @param ctx 光标上下文（lib/md-commands.ts 的 getContext 产出）
 * @param opts.extended 真时补上撤销/重做、全选
 * @param opts.codeLineNumbers 代码块全局行号开关当前值
 * @param opts.codeWrap 代码块当前是否折行
 * @param opts.codeIndentSize 代码块当前缩进宽度（空格数）
 * @returns 菜单条目（含分隔线 / 子菜单 / 图标行）
 */
export function buildContextMenu(
  ctx: ContextInfo,
  opts: {
    extended?: boolean;
    codeLineNumbers?: boolean;
    codeWrap?: boolean;
    codeIndentSize?: number;
  } = {},
): MdMenuItem[] {
  const items: MdMenuItem[] = [];

  if (opts.extended) {
    items.push(
      { id: 'undo', label: '撤销', icon: Undo2, hint: 'Ctrl+Z' },
      { id: 'redo', label: '重做', icon: Redo2, hint: 'Ctrl+Shift+Z' },
      { separator: true },
    );
  }

  items.push(...clipboardGroup());

  // ── 代码块里：只管块本身，行内格式与段落全部隐藏 ──
  if (ctx.code) {
    items.push({ separator: true });
    items.push({ id: 'code-copy', label: '复制代码块内容', icon: Copy });
    items.push({ id: 'code-exit', label: '在下方跳出代码块', icon: Code2 });
    items.push({ separator: true });
    items.push({ id: 'code-lang', label: '选择语言…', icon: Type });
    items.push({
      id: 'code-lineno',
      label: opts.codeLineNumbers ? '隐藏行号' : '显示行号',
      icon: ListOrdered,
      active: !!opts.codeLineNumbers,
    });
    items.push({
      id: 'code-wrap',
      label: opts.codeWrap === false ? '恢复折行' : '不折行（横向滚动）',
      icon: AlignLeft,
      active: opts.codeWrap === false,
    });
    items.push(codeIndentSubmenu(opts.codeIndentSize));
    items.push({ separator: true });
    /*
     * 只留「插入」：块内插不了段落层级，但常要在代码块前后补表格、公式、另一个代码块，
     * 全靠「跳出」再右键会分不清是哪一块。
     */
    items.push(insertSubmenu());
    items.push({ separator: true });
    items.push(...deleteGroup());
    return items;
  }

  // ── 行内格式：一排图标，六个文字项压成一行 ──
  items.push({ separator: true });
  items.push({ icons: INLINE_COMMANDS });

  if (opts.extended) {
    items.push({ separator: true });
    items.push({ id: 'clear-format', label: '清除格式', icon: Eraser, hint: 'Ctrl+\\' });
    items.push({ id: 'select-all', label: '全选', icon: TextSelect, hint: 'Ctrl+A' });
  }

  items.push({ separator: true });
  if (ctx.table) {
    // 表格里给完整表格操作；段落层级（标题）与表格互斥，不显示
    items.push(tableSubmenu());
  } else {
    items.push(paragraphSubmenu(ctx));
  }
  items.push(insertSubmenu());
  items.push({ separator: true });
  items.push(...deleteGroup());
  return items;
}

/** 图片上右键的菜单 */
export function buildImageMenu(): MdMenuItem[] {
  return [
    ...clipboardGroup(),
    { separator: true },
    { id: 'image-replace', label: '替换图片地址…', icon: ExternalLink },
    { id: 'image-alt', label: '修改替代文字…', icon: ImageIcon },
    { separator: true },
    { id: 'source', label: '编辑源码', icon: Code2 },
    { separator: true },
    ...deleteGroup(),
  ];
}

/** 链接上右键的菜单 */
export function buildLinkMenu(): MdMenuItem[] {
  return [
    ...clipboardGroup(),
    { separator: true },
    { id: 'link-open', label: '在新标签打开', icon: ExternalLink },
    { id: 'link-replace', label: '修改链接地址…', icon: LinkIcon },
    { separator: true },
    { id: 'source', label: '编辑源码', icon: Code2 },
    { separator: true },
    ...deleteGroup(),
  ];
}