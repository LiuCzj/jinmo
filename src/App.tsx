import { useCallback, useEffect, useRef, useState } from 'react';
import MirrorEditor, { type EditorHandle } from '@/components/MirrorEditor';

/**
 * 编辑器宿主页。
 *
 * 职责：持有整篇 Markdown（唯一真相），把受控接口接到 `MirrorEditor` 上。
 *
 * 在桌面壳里（`window.desktop` 存在）额外接管：打开 / 保存文件、原生菜单命令、窗口标题。
 * 网页版没有 `window.desktop`，这些能力自动降级为不可用。
 */

const SAMPLE = `# 第一章 大模型技术与发展

大模型（Large Language Model）是近年来人工智能领域最重要的进展之一。

## 1.1 大模型发展过程

从 2018 年的 GPT-1 到今天，这条路走了大约八年。关键转折点是 **Transformer 架构** 的提出。

- 第一代：以 BERT、GPT 为代表的预训练
- 第二代：以 GPT-3 为代表的规模化
- 第三代：指令微调与对齐

> 规模并非唯一变量，数据质量同样决定最终效果。

行内代码示例：把 \`frontmatter\` 写在文件开头。

链接示例：[项目主页](https://example.com/repo) 上右键应出链接菜单。

图片示例：![示意图](https://example.com/404.png) 上右键应出图片菜单。

| 列一 | 列二 |
| --- | --- |
| 甲 | 乙 |

这一段是特意准备的长句子：长段落会自动折行，折行之后每一行都该能点到准确的位置——把鼠标放到任意一个视觉行的末尾点一下，光标就应该停在那个字的后面，而不是跑到上面或者下面别的行里去；再选中半行试试，高亮也应该贴着手走。`;

/** 取路径中的文件名 */
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export default function App() {
  const [text, setText] = useState(SAMPLE);
  const [savedAt, setSavedAt] = useState('');
  /** 沉浸模式：专注（F8）/ 打字机（F9）任一开启即为 true */
  const [immersive, setImmersive] = useState(false);

  const editorRef = useRef<EditorHandle>(null);
  /** 当前文件路径；null 表示尚未保存过 */
  const [filePath, setFilePath] = useState<string | null>(null);
  /** 是否有未保存改动 */
  const [dirty, setDirty] = useState(false);

  const desktop = typeof window !== 'undefined' ? window.desktop : undefined;

  const applyOpened = useCallback((path: string, content: string) => {
    setText(content);
    setFilePath(path);
    setDirty(false);
  }, []);

  const save = useCallback(
    async (pickPath?: boolean) => {
      if (!desktop) {
        setSavedAt(new Date().toLocaleTimeString());
        return;
      }
      const res = await desktop.saveFile(text, pickPath ? null : filePath);
      if (res) {
        setFilePath(res.path);
        setDirty(false);
        setSavedAt(new Date().toLocaleTimeString());
      }
    },
    [desktop, filePath, text],
  );

  const open = useCallback(async () => {
    const res = await desktop?.openFile();
    if (res) applyOpened(res.path, res.content);
  }, [desktop, applyOpened]);

  // 菜单与最近文件打开的文件
  useEffect(() => {
    if (!desktop) return;
    return desktop.onOpenFile(({ path, content }) => applyOpened(path, content));
  }, [desktop, applyOpened]);

  // 原生菜单命令
  useEffect(() => {
    if (!desktop) return;
    return desktop.onMenuCommand((id) => {
      switch (id) {
        case 'new':
          setText('');
          setFilePath(null);
          setDirty(false);
          break;
        case 'open':
          void open();
          break;
        case 'save':
          void save();
          break;
        case 'save-as':
          void save(true);
          break;
        case 'undo':
        case 'redo':
        case 'select-all':
        case 'find':
        case 'replace':
          editorRef.current?.runCommand(id);
          break;
        case 'toggle-source':
          editorRef.current?.toggleSource();
          break;
        case 'toggle-focus':
          editorRef.current?.toggleFocus();
          break;
        case 'toggle-typewriter':
          editorRef.current?.toggleTypewriter();
          break;
      }
    });
  }, [desktop, open, save]);

  // 窗口标题反映文件名与未保存状态
  useEffect(() => {
    if (!desktop) return;
    const name = filePath ? baseName(filePath) : '未命名';
    void desktop.setTitle(`${dirty ? '● ' : ''}${name} — Markdown 编辑器`);
  }, [desktop, dirty, filePath]);

  return (
    <div className={`mx-auto px-4 ${immersive ? 'max-w-2xl py-20' : 'max-w-3xl py-10'}`}>
      {!immersive && (
        <>
          <h1 className="mb-1 text-lg font-bold">jinmo · 所见即所得 Markdown 编辑器</h1>
          <p className="mb-4 text-[13px] text-muted-foreground">
            能做的：点击落点、打字、回车、退格、方向键、Home/End、
            <b className="text-foreground">中文输入法</b>、右键菜单、拖拽选区、撤销重做、表格编辑、
            <b className="text-foreground">语法随光标浮现</b>。
          </p>

          <div className="mb-6 rounded-lg border border-border bg-card p-4 text-[12px]">
            <p className="mb-2 font-bold text-foreground">请按下面顺序亲手试（重点是第 5 条）</p>
            <ol className="list-decimal space-y-1.5 pl-5 text-muted-foreground">
              <li>
                <b className="text-foreground">点击落点</b>：在任意一行中间点一下，光标应落在你点的那个字旁边
                （点字的左半边落在字前，右半边落在字后）。
              </li>
              <li>
                <b className="text-foreground">打字</b>：随便打几个英文字母，应就地插入，光标跟着走。
              </li>
              <li>
                <b className="text-foreground">回车 · 续列表</b>：光标放在某个列表项的行尾按回车，
                <b className="text-foreground">下面应自动出现新的 <code>- </code> 项</b>；
                再按一次回车（此时是空项），<b className="text-foreground">列表应退出</b>，变回普通空行。
              </li>
              <li>
                <b className="text-foreground">退格 · 列表行首</b>：光标放到某个列表项的<b className="text-foreground">最开头</b>
                （<code>- </code> 之前）按退格 —— 应是<b className="text-foreground">在它上方插入一个空的 <code>- </code> 项</b>，
                原内容整体下移，<b className="text-foreground">不该把 <code>- </code> 删掉</b>。
              </li>
              <li>
                <b className="text-foreground">中文输入法（重中之重）</b>：切微软拼音，在「是近年」和「来」之间
                打「人工智能」。看四点：① 候选窗正常跟手；② 拼音阶段屏幕上出现带下划线的预编辑串；
                ③ 上屏后<b className="text-foreground">不多不少正好 4 个字</b>；④ 上屏后再打英文字母，能正常输入。
              </li>
              <li>
                <b className="text-foreground">语法浮现</b>：把光标在标题 / 加粗 / 列表 / 引用之间来回移动 ——
                只有光标所在的那一处露出 <code>#</code> <code>**</code> <code>-</code>，移开就恢复渲染。
              </li>
              <li>
                <b className="text-foreground">源码模式</b>：<code>Ctrl+/</code> 整篇切成带行号与语法着色的 Markdown 源码，再按一次切回。
              </li>
              <li>
                <b className="text-foreground">沉浸式</b>：<code>F8</code> 专注模式（只留当前块清晰）、
                <code>F9</code> 打字机模式（光标锁在屏幕中线）。任一开启时，本页的说明与页头会自动收起来。
              </li>
              <li>
                <b className="text-foreground">复制粘贴</b>：选中后 Ctrl+C / Ctrl+X，Ctrl+V 粘贴；
                右键菜单里的粘贴要走浏览器的「剪贴板读取」授权，被拒就<strong className="text-foreground">直接按 Ctrl+V</strong>
                （想恢复右键粘贴：点地址栏的权限图标，把「剪贴板」允许掉）。
              </li>
              <li>
                <b className="text-foreground">撤销 / 重做</b>：Ctrl+Z / Ctrl+Shift+Z（或 Ctrl+Y）。
              </li>
            </ol>
          </div>
        </>
      )}

      <MirrorEditor
        ref={editorRef}
        value={text}
        onChange={(v) => {
          setText(v);
          setDirty(true);
        }}
        onSave={() => void save()}
        onImport={(r) => {
          setText(r.body);
          setDirty(true);
        }}
        onImmersiveChange={setImmersive}
      />

      {!immersive && (
        <>
          <p className="mt-3 text-[12px] text-muted-foreground">
            {desktop
              ? `${filePath ? baseName(filePath) : '未命名'}${dirty ? '（未保存）' : ''}　Ctrl+S 保存　Ctrl+O 打开`
              : savedAt
                ? `已触发保存（Ctrl+S）：${savedAt}`
                : '按 Ctrl+S 可触发宿主保存回调（当前仅记录时间）'}
          </p>

          <div className="mt-6 rounded-lg border border-border p-4">
            <p className="mb-2 text-xs font-bold text-muted-foreground">源码（只读，供比对）</p>
            <pre className="max-h-52 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground">
              {text}
            </pre>
          </div>
        </>
      )}
    </div>
  );
}
