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
import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
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
  AlignCenter,
  AlignRight,
  AlignJustify,
  Ellipsis,
  Sigma,
  Search,
  IndentIncrease,
  Indent,
  Outdent,
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
/**
 * 给 Radix 的虚拟锚点：把「一个视口坐标」包成只报边界矩形的假元素。
 *
 * 浮层要贴在调用方算好的坐标上（鼠标位置 / 选区上方），那里没有真实 DOM 元素，
 * 所以造一个假元素交给 Radix，定位 / 翻转 / 防溢出由它负责。
 *
 * ⚠️ 每次渲染都刷新 `getBoundingClientRect` —— `useRef` 的初值只算一次，
 * 坐标变了却还报旧矩形的话，浮层会钉在第一次的位置上。
 *
 * @param pos 视口坐标（左上角）
 * @returns 可直接传给 `virtualRef` 的 ref
 */
function useVirtualAnchor(pos: FloatPos) {
  const ref = useRef({
    getBoundingClientRect: () => ({
      x: pos.x,
      y: pos.y,
      width: 0,
      height: 0,
      top: pos.y,
      left: pos.x,
      right: pos.x,
      bottom: pos.y,
      toJSON: () => ({}),
    }),
  });
  ref.current.getBoundingClientRect = () => ({
    x: pos.x,
    y: pos.y,
    width: 0,
    height: 0,
    top: pos.y,
    left: pos.x,
    right: pos.x,
    bottom: pos.y,
    toJSON: () => ({}),
  });
  return ref;
}

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
  /**
   * 气泡位置是调用方按选区算好的视口坐标。
   * `side="bottom" align="start" sideOffset={0}` 让内容左上角正好落在该坐标，
   * 与旧的 `style={{left, top}}` 等价；越界翻转 / 防溢出交给 Radix。
   */
  const anchorRef = useVirtualAnchor(pos);

  return (
    <Popover.Root
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Popover.Anchor virtualRef={anchorRef} />
      <Popover.Portal>
        <Popover.Content
          role="toolbar"
          aria-label="格式"
          side="bottom"
          align="start"
          sideOffset={0}
          collisionPadding={8}
          className="z-[300] flex items-center gap-0.5 rounded-lg border border-border bg-card p-1 shadow-xl outline-none"
          /**
           * 绝不能抢焦点：气泡出现时用户还在编辑、选区还在，抢焦点会把选区弄丢。
           * 关闭后同理，焦点交给调用方。
           */
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
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
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
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
  /**
   * 菜单要贴在鼠标位置，而鼠标位置没有真实元素 —— 放一个 0×0 的隐形锚点。
   *
   * 菜单本身（外点关闭 / Escape / 子菜单 / 键盘导航 / 焦点管理 / 越界翻转）
   * 全部交给 Radix DropdownMenu，不再自绘。
   */
  useEffect(() => {
    /**
     * 滚动 / 滚轮 / 窗口尺寸变化要关掉菜单。
     *
     * 这是**产品规则**不是通用能力：菜单贴的是鼠标位置（fixed 定位），
     * 页面一滚它就钉在原地跟内容脱节。Radix 不做这件事。
     *
     * 但发生在菜单自己身上的滚动不算「页面动了」：菜单可以比视口高
     * （`overflow-y-auto`），滚一下就把菜单关了等于没法用。
     * 刚弹出的一小段时间也宽限：Radix 打开时会聚焦内容，可能补发一次 scroll。
     */
    const openedAt = Date.now();
    const inMenu = (t: EventTarget | null) => t instanceof Element && !!t.closest('[role="menu"]');
    const onScroll = (e: Event) => {
      if (inMenu(e.target)) return;
      if (Date.now() - openedAt < 300) return;
      onClose();
    };
    const onDismiss = () => onClose();
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('wheel', onScroll, { passive: true });
    window.addEventListener('resize', onDismiss, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('wheel', onScroll);
      window.removeEventListener('resize', onDismiss);
    };
  }, [onClose]);

  /** 渲染一条叶子命令（分隔线 / 子菜单 / 图标行不在这里） */
  const renderLeaf = (item: MdMenuItem, key: string) => {
    if (isSeparator(item)) {
      return <DropdownMenu.Separator key={key} className="my-1 border-t border-border" />;
    }
    if (isSubmenu(item) || isIconRow(item)) return null;
    return (
      <DropdownMenu.Item
        key={key}
        aria-label={item.label}
        onSelect={() => onRun(item.id)}
        className={`flex cursor-default items-center gap-2.5 px-3 py-1.5 text-left text-sm outline-none transition-colors ${
          item.active
            ? 'bg-accent/10 text-accent'
            : 'text-foreground data-[highlighted]:bg-foreground/[0.06]'
        }`}
      >
        <item.icon size={15} aria-hidden="true" />
        <span className="flex-1">{item.label}</span>
        {item.hint && <span className="text-[11px] text-muted-foreground">{item.hint}</span>}
      </DropdownMenu.Item>
    );
  };

  return (
    <DropdownMenu.Root
      open
      // modal 必须关：Radix 默认会把 body 的 pointer-events 置空并给其余内容加 aria-hidden，
      // 那会让底下的编辑器完全点不动。
      modal={false}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DropdownMenu.Trigger asChild>
        <span
          aria-hidden="true"
          tabIndex={-1}
          style={{ position: 'fixed', left: pos.x, top: pos.y, width: 0, height: 0, pointerEvents: 'none' }}
        />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align="start"
          sideOffset={0}
          collisionPadding={8}
          className="z-[300] max-h-[calc(100vh-16px)] min-w-[200px] overflow-y-auto rounded-lg border border-border bg-card py-1 shadow-2xl outline-none"
          // 关闭后不把焦点还给那个隐形锚点；选命令时由 runCommand 自己把焦点交回编辑器
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {items.map((item, i) => {
            if (isSeparator(item)) {
              return <DropdownMenu.Separator key={`sep-${i}`} className="my-1 border-t border-border" />;
            }

            // 一排图标按钮（行内格式 / 块级包裹 / 缩进）：点一下直接生效
            if (isIconRow(item)) {
              return (
                <DropdownMenu.Item
                  key={`row-${i}`}
                  // 这一行本身不是命令，别让 Radix 把它当条目「选中」而关菜单
                  onSelect={(e) => e.preventDefault()}
                  className="flex cursor-default items-center gap-0.5 px-2 py-1 outline-none"
                >
                  {item.icons.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      title={c.hint ? `${c.label}（${c.hint}）` : c.label}
                      aria-label={c.label}
                      aria-pressed={c.active ? true : undefined}
                      onClick={() => onRun(c.id)}
                      className={`flex size-7 items-center justify-center rounded-md transition-colors ${
                        c.active
                          ? 'bg-accent/12 text-accent'
                          : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground'
                      }`}
                    >
                      <c.icon size={15} aria-hidden="true" />
                    </button>
                  ))}
                </DropdownMenu.Item>
              );
            }

            // 子菜单：悬停 / 右方向键展开，由 Radix 负责
            if (isSubmenu(item)) {
              return (
                <DropdownMenu.Sub key={`sub-${i}`}>
                  <DropdownMenu.SubTrigger className="flex cursor-default items-center gap-2.5 px-3 py-1.5 text-left text-sm text-foreground outline-none transition-colors data-[highlighted]:bg-foreground/[0.06] data-[state=open]:bg-foreground/[0.06]">
                    <item.icon size={15} aria-hidden="true" />
                    <span className="flex-1">{item.label}</span>
                    <span className="text-[11px] text-muted-foreground">▸</span>
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.SubContent
                      collisionPadding={8}
                      className="z-[310] max-h-[calc(100vh-16px)] min-w-[180px] overflow-y-auto rounded-lg border border-border bg-card py-1 shadow-2xl outline-none"
                    >
                      {item.items.map((sub, k) => renderLeaf(sub, `sub-${i}-${k}`))}
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Portal>
                </DropdownMenu.Sub>
              );
            }

            return renderLeaf(item, item.id);
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// ── 弹窗外壳（Radix Dialog）────────────────────────────────

/**
 * 弹窗基座：外点关闭 / Escape / 焦点陷阱 / **关闭后焦点归还原处**全部由 Radix 负责。
 *
 * 这些以前是自绘的，踩过一串坑：
 * - 关闭后焦点落回 `<body>` → 紧接着打字**一个字都进不去**（实测）
 * - 遮罩的 `onMouseDown` 要手动 `stopPropagation`，漏一处就点内容也关窗
 * - 输入框要手动 `autoFocus`，还要自己处理 Escape
 *
 * @param props.title 标题（同时作为无障碍名）
 * @param props.onClose 关闭（外点 / Escape / 取消都走它）
 * @param props.width 内容宽度类名
 */
function ModalShell({
  title,
  onClose,
  width = 'w-[320px]',
  children,
}: {
  title: string;
  onClose: () => void;
  width?: string;
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[320] bg-foreground/20" />
        <Dialog.Content
          aria-label={title}
          className={`fixed left-1/2 top-[18vh] z-[321] -translate-x-1/2 rounded-lg border border-border bg-card p-4 shadow-2xl ${width}`}
        >
          <Dialog.Title className="mb-3 text-sm font-bold text-foreground">{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ── 单行文本输入对话框 ────────────────────────────────────

/**
 * 自绘的单行输入框，替代 `window.prompt`。
 *
 * 桌面壳（Electron）不实现 `window.prompt`，网页版里它又会阻塞渲染线程，
 * 两条路都不能用，必须自绘。
 *
 * @param props.title 标题
 * @param props.label 输入框上方的说明
 * @param props.initial 初始值
 * @param props.placeholder 占位文字
 * @param props.onConfirm 确定（返回去掉首尾空白的文本）
 * @param props.onCancel 取消（点遮罩、Esc、取消按钮）
 */
export function PromptDialog({
  title,
  label,
  initial = '',
  placeholder,
  onConfirm,
  onCancel,
}: {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(initial);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  /** 空值不提交 —— 空的地址 / 空的替代文字没有意义 */
  const submit = () => {
    const t = v.trim();
    if (!t) return;
    onConfirm(t);
  };

  return (
    <ModalShell title={title} onClose={onCancel} width="w-[420px]">
      <div>
        {label && <p className="mb-1.5 text-xs text-muted-foreground">{label}</p>}
        <input
          autoFocus
          value={v}
          placeholder={placeholder}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-ring"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="btn-soft">
            取消
          </button>
          <button type="button" onClick={submit} className="btn-primary">
            确定
          </button>
        </div>
      </div>
    </ModalShell>
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

  /** 把输入夹到合法范围；空值或非数字才退回默认值 */
  const clampNum = (v: string, min: number, max: number, dflt: number) => {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) return dflt;
    return Math.max(min, Math.min(max, n));
  };

  const INPUT =
    'w-16 rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-ring';

  return (
    <ModalShell title="插入表格" onClose={onCancel}>
      <div>
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
    </ModalShell>
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
   *
   * `matchLangs` 在「唯一命中且与输入完全相同」时会返回空数组 —— 那是给
   * "已经敲全了、别再弹提示"的场景设计的（单测 `matchLangs('json') === []` 就是断这个）。
   * 但在本面板里列表**就是全部内容**，返回空只会显示「无匹配」，用户明明把语言打全了；
   * 而且打全后按回车也提交不了。所以这里把精确命中的那一条补回来。
   */
  const matched = matchLangs(query);
  const exactHit =
    query === '' ? undefined : matchLangs('').find((l) => l.toLowerCase() === query.toLowerCase());
  const shown = matched.length ? matched : exactHit ? [exactHit] : [];
  const list: { id: string; label: string }[] = [
    ...(query === '' ? [{ id: '', label: PLAIN_LANG_LABEL }] : []),
    ...shown.slice(0, MAX_LANG_HINTS).map((l) => ({ id: l, label: l })),
  ];

  /** 面板贴在右键点出来的坐标上，定位 / 翻转 / 防溢出交给 Radix */
  const anchorRef = useVirtualAnchor(pos);

  useEffect(() => {
    setHi(0);
  }, [query]);

  // 键盘上下移动时把选中项滚进视野
  useEffect(() => {
    const el = listRef.current?.querySelectorAll('[data-lang-li]')[hi] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [hi, list.length]);

  return (
    <Popover.Root
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Popover.Anchor virtualRef={anchorRef} />
      <Popover.Portal>
        <Popover.Content
          data-lang-picker=""
          role="listbox"
          aria-label="选择代码块语言"
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="z-[330] w-[240px] overflow-hidden rounded-lg border border-border bg-card shadow-2xl outline-none"
          /**
           * 自己聚焦搜索框，并带 `preventScroll` ——
           * 面板贴边时输入框可能有一截在视口外，默认聚焦会让浏览器把它滚进视野、
           * 页面跟着动一下（用户反馈过"屏幕乱动"）。
           */
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus({ preventScroll: true });
          }}
          /** 关闭后不把焦点还给触发元素（那个元素是个虚拟锚点），交给调用方处理 */
          onCloseAutoFocus={(e) => e.preventDefault()}
          onKeyDown={(e) => {
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
          }}
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
          <div ref={listRef} data-lang-picker-list="" className="max-h-[264px] overflow-y-auto py-1">
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
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ── 命令表 ────────────────────────────────────────────────

/**
 * 行内格式（气泡用，也是右键菜单第一排按钮）。
 *
 * 顺序：加粗 / 斜体 / 删除线 / 高亮 / 行内代码 / 行内公式 / 链接。
 * 删除线、高亮、行内公式原先只有命令实现（或连命令都没有）而没有菜单入口，
 * 导致右键菜单够不着 —— 见 `strike` / `highlight` / `math` 三条。
 *
 * @returns 行内格式按钮（`id` 交给 runCommand 分发）
 */
export const INLINE_COMMANDS: MdCommand[] = [
  { id: 'bold', label: '加粗', icon: Bold, hint: 'Ctrl+B' },
  { id: 'italic', label: '斜体', icon: Italic, hint: 'Ctrl+I' },
  { id: 'strike', label: '删除线', icon: Strikethrough, hint: 'Alt+Shift+5' },
  { id: 'highlight', label: '高亮', icon: Highlighter },
  { id: 'code', label: '行内代码', icon: Code, hint: 'Ctrl+`' },
  { id: 'math', label: '行内公式', icon: Sigma },
  { id: 'link', label: '链接', icon: Link2, hint: 'Ctrl+K' },
];

/**
 * 块级包裹那一排按钮：引用 / 有序 / 无序 / 待办。
 *
 * 这四项原本埋在 `段落 ▸` 子菜单里，要钻两层才点得到；
 * 提成一排直接点，跟行内格式一样一眼可见。
 *
 * @param ctx 光标上下文，用来给已生效的那项打高亮
 * @returns 一排按钮命令
 */
export function blockWrapCommands(ctx: ContextInfo): MdCommand[] {
  return [
    { id: 'quote', label: '引用', icon: Quote, active: ctx.quote },
    { id: 'ordered', label: '有序列表', icon: ListOrdered, active: ctx.list },
    { id: 'bullet', label: '无序列表', icon: List, active: ctx.list },
    { id: 'todo', label: '待办项', icon: ListChecks },
  ];
}

/** 缩进那一排按钮 */
export const INDENT_COMMANDS: MdCommand[] = [
  { id: 'outdent', label: '减少缩进', icon: Outdent, hint: 'Ctrl+[' },
  { id: 'indent', label: '增加缩进', icon: Indent, hint: 'Ctrl+]' },
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
 * `段落 ▸` 子菜单：只留标题档位与「正文」。
 *
 * 引用 / 有序 / 无序 / 待办已提到主菜单那一排按钮上，这里不再重复，
 * 免得同一个命令两个入口、用户分不清哪个是「正牌」。
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
 * 条目顺序：图像 / 本地图片… / ── / 脚注 / 链接引用 / 水平分割线 / 表格 /
 * 代码块 / 公式块 / 内容目录 / YAML Front Matter / ── / 段落（上方）/ 段落（下方）。
 *
 * 「图像」问的是网络地址（写进 `![](url)`）；本地文件走「本地图片…」弹系统选择框。
 * 两者必须分开：图片地址没法在文件选择框里输入，文件也没法在输入框里选。
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
      { id: 'image-file', label: '本地图片…', icon: ImageIcon },
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
 * 表格悬浮条上的按钮。
 *
 * 鼠标移到表格上时浮出来，让「插入表格之后还能干什么」一眼可见 ——
 * 否则这些能力只能靠右键 → 表格 ▸ 两层才找得到（用户反馈过"插入表格就没了"）。
 * 点一下直接生效，走的是与右键菜单同一套命令。
 */
export const TABLE_BAR_ALIGNS: MdCommand[] = [
  { id: 'table-align-left', label: '左对齐', icon: AlignLeft },
  { id: 'table-align-center', label: '居中对齐', icon: AlignCenter },
  { id: 'table-align-right', label: '右对齐', icon: AlignRight },
];

/**
 * 表格悬浮工具条。
 *
 * 鼠标停在表格上时浮在表格上方；移开就消失（由调用方控制挂载）。
 * 它**不抢焦点、不参与选区**：点按钮时按 hover 命中的那个格子算目标位置，
 * 不去动编辑器里的光标，所以不会把用户正在做的事打断。
 *
 * @param props.pos 浮层坐标（表格左上角上方，视口坐标）
 * @param props.onRun 点某条命令时触发，参数是命令 id
 */
export function TableBar({
  pos,
  onRun,
  onMore,
}: {
  pos: FloatPos;
  onRun: (id: string) => void;
  /** 点「更多操作」时打开完整表格菜单（插入/删除/复制/格式化…） */
  onMore: () => void;
}) {
  const anchorRef = useVirtualAnchor(pos);
  return (
    <Popover.Root open onOpenChange={() => {}}>
      <Popover.Anchor virtualRef={anchorRef} />
      <Popover.Portal>
        <Popover.Content
          role="toolbar"
          aria-label="表格"
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-[300] flex items-center gap-0.5 rounded-lg border border-border bg-card p-1 shadow-xl outline-none"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
        >
          {/* 列对齐三连：参考实现就是把这三个直接摆在表格上方左侧 */}
          {TABLE_BAR_ALIGNS.map((c) => (
            <button
              key={c.id}
              type="button"
              title={c.label}
              aria-label={c.label}
              onClick={() => onRun(c.id)}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <c.icon size={15} aria-hidden="true" />
            </button>
          ))}
          <span className="mx-0.5 h-4 w-px bg-border" />
          {/* 其余全部收进「更多操作」——参考实现右上角那个按钮 */}
          <button
            type="button"
            title="更多操作"
            aria-label="更多操作"
            onClick={onMore}
            className="flex h-7 items-center gap-1 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <span className="text-[11px]">更多操作</span>
            <Ellipsis size={14} aria-hidden="true" />
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * 表格组的分组顺序：上方/下方插入行 → 左侧/右侧插入列 → 上移/下移该行、左移/右移该列 →
 * 列对齐 → 删除行/删除列 → 复制表格/格式化表格源码 → 删除表格。
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
    // 移动：行按整行交换、列连分隔行一起换（对齐标记跟着列走）
    { id: 'table-row-up', label: '上移该行', icon: ArrowUpToLine },
    { id: 'table-row-down', label: '下移该行', icon: ArrowDownToLine },
    { id: 'table-col-move-left', label: '左移该列', icon: ArrowLeftToLine },
    { id: 'table-col-move-right', label: '右移该列', icon: ArrowRightToLine },
    { separator: true },
    // 列对齐：写在分隔行上（`:---` / `:---:` / `---:`），按当前列生效
    { id: 'table-align-left', label: '左对齐', icon: AlignLeft },
    { id: 'table-align-center', label: '居中对齐', icon: AlignCenter },
    { id: 'table-align-right', label: '右对齐', icon: AlignRight },
    { id: 'table-align-none', label: '默认对齐', icon: AlignJustify },
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
    /*
     * 代码块里也要有「全选」。
     *
     * 它跟「撤销/重做」一样是**文档级**命令，不依赖光标在哪；只给段落菜单不给代码块菜单
     * 会很别扭 —— 而且文档开头就是代码块时，右键拿到的就是这个菜单，
     * 自动化脚本想「全选→剪切」清空整篇会一直失败（实测踩过）。
     */
    if (opts.extended) {
      items.push({ separator: true });
      items.push({ id: 'select-all', label: '全选', icon: TextSelect, hint: 'Ctrl+A' });
    }
    items.push({ separator: true });
    items.push(...deleteGroup());
    return items;
  }

  // ── 行内格式 + 块级包裹 + 缩进：三排按钮，一眼可见、一点即生效 ──
  // 这些操作原本要钻 `段落 ▸` 两层子菜单才点得到，是「没实用性」观感的来源。
  items.push({ separator: true });
  items.push({ icons: INLINE_COMMANDS });
  items.push({ icons: blockWrapCommands(ctx) });
  items.push({ icons: INDENT_COMMANDS });

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