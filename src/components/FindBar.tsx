import { useEffect, useRef } from 'react';
import { ChevronUp, ChevronDown, X, CaseSensitive } from 'lucide-react';

/**
 * 查找 / 替换面板。
 *
 * 由宿主（MirrorEditor）持有全部状态，本组件只负责显示与回调 —— 这样
 * 「命中计算 / 当前命中 / 正文替换」都留在能拿到整篇文本的地方，面板本身不碰正文。
 */

/** 面板状态（宿主维护） */
export interface FindState {
  mode: 'find' | 'replace';
  query: string;
  replace: string;
  caseSensitive: boolean;
  /** 命中总数 */
  count: number;
  /** 当前命中下标（0 基）；无命中为 -1 */
  index: number;
}

/** 输入框统一样式 */
const INPUT =
  'h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ring';

/** 小图标按钮统一样式 */
const ICON_BTN =
  'flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground';

/**
 * 查找 / 替换面板。
 *
 * @param props.state 面板状态
 * @param props.onQueryChange 查找串变化
 * @param props.onReplaceChange 替换串变化
 * @param props.onToggleCase 切换区分大小写
 * @param props.onNext 下一个命中
 * @param props.onPrev 上一个命中
 * @param props.onReplaceOne 替换当前命中
 * @param props.onReplaceAll 全部替换
 * @param props.onClose 关闭面板
 */
export function FindBar({
  state,
  onQueryChange,
  onReplaceChange,
  onToggleCase,
  onNext,
  onPrev,
  onReplaceOne,
  onReplaceAll,
  onClose,
}: {
  state: FindState;
  onQueryChange: (v: string) => void;
  onReplaceChange: (v: string) => void;
  onToggleCase: () => void;
  onNext: () => void;
  onPrev: () => void;
  onReplaceOne: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
}) {
  const queryRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);

  /**
   * 打开 / 切换模式时聚焦输入框。
   *
   * 只在模式变化时聚焦：依赖 state.mode 而不是每次渲染 ——
   * 否则每敲一个字都会重新 select，光标被顶到末尾、没法在中间改字。
   */
  useEffect(() => {
    const el = state.mode === 'replace' ? replaceRef.current : queryRef.current;
    if (el && document.activeElement !== el) {
      el.focus();
      el.select();
    }
  }, [state.mode]);

  /**
   * 面板内的键盘处理。
   * Enter = 下一个 / （在替换框里）替换当前；Shift+Enter = 上一个；Esc = 关闭。
   */
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (state.mode === 'replace' && document.activeElement === replaceRef.current) onReplaceOne();
      else if (e.shiftKey) onPrev();
      else onNext();
      return;
    }
    // Ctrl+F 在面板里再按一次 → 回到查找框并全选
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      queryRef.current?.focus();
      queryRef.current?.select();
    }
  };

  const counter = state.count === 0 ? '无结果' : `${state.index + 1}/${state.count}`;

  return (
    <div
      /**
       * 必须阻止冒泡：编辑器外层挂的是「点哪都把焦点还给隐藏 textarea」的 mousedown，
       * 不拦的话点面板会把焦点抢走，输入框永远打不了字。
       */
      onMouseDown={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="查找和替换"
      className="absolute right-3 top-3 z-30 w-[440px] max-w-[calc(100%_-_1.5rem)] rounded-lg border border-border bg-card p-2 shadow-2xl"
    >
      <div className="flex items-center gap-1.5">
        <input
          ref={queryRef}
          value={state.query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onKey}
          placeholder="查找"
          aria-label="查找"
          className={INPUT}
        />
        <span className="w-14 shrink-0 text-center text-[11px] tabular-nums text-muted-foreground">{counter}</span>
        <button
          type="button"
          title="区分大小写"
          aria-label="区分大小写"
          aria-pressed={state.caseSensitive}
          onClick={onToggleCase}
          className={`flex size-7 shrink-0 items-center justify-center rounded-md transition-colors ${
            state.caseSensitive
              ? 'bg-accent/15 text-accent'
              : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground'
          }`}
        >
          <CaseSensitive size={15} aria-hidden="true" />
        </button>
        <button type="button" title="上一个（Shift+Enter）" aria-label="上一个" onClick={onPrev} className={ICON_BTN}>
          <ChevronUp size={15} aria-hidden="true" />
        </button>
        <button type="button" title="下一个（Enter）" aria-label="下一个" onClick={onNext} className={ICON_BTN}>
          <ChevronDown size={15} aria-hidden="true" />
        </button>
        <button type="button" title="关闭（Esc）" aria-label="关闭" onClick={onClose} className={ICON_BTN}>
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      {state.mode === 'replace' && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            ref={replaceRef}
            value={state.replace}
            onChange={(e) => onReplaceChange(e.target.value)}
            onKeyDown={onKey}
            placeholder="替换为"
            aria-label="替换为"
            className={INPUT}
          />
          <button
            type="button"
            onClick={onReplaceOne}
            disabled={state.count === 0}
            className="flex h-8 shrink-0 items-center rounded-md border border-border px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-foreground/[0.06] disabled:cursor-not-allowed disabled:opacity-45"
          >
            替换
          </button>
          <button
            type="button"
            onClick={onReplaceAll}
            disabled={state.count === 0}
            className="flex h-8 shrink-0 items-center rounded-md bg-accent px-2.5 text-[12px] font-medium text-accent-foreground transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-45"
          >
            全部替换
          </button>
        </div>
      )}
    </div>
  );
}
