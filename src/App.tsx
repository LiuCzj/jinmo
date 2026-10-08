import { useCallback, useEffect, useRef, useState } from 'react';
import MirrorEditor, { type EditorHandle } from '@/components/MirrorEditor';

/**
 * 编辑器宿主页。
 *
 * 职责：持有整篇 Markdown（唯一真相），把受控接口接到 `MirrorEditor` 上。
 *
 * 页面本身不放任何说明性内容 —— 整个窗口就是编辑器。
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

| 列一 | 列二 |
| --- | --- |
| 甲 | 乙 |

这一段是特意准备的长句子：长段落会自动折行，折行之后每一行都该能点到准确的位置——把鼠标放到任意一个视觉行的末尾点一下，光标就应该停在那个字的后面，而不是跑到上面或者下面别的行里去；再选中半行试试，高亮也应该贴着手走。`;

/** 取路径中的文件名 */
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/**
 * 初始文档：网页版给一份示例（免得演示页一片空白），桌面版从空白开始。
 * 桌面版要示例，可先 npm run dev，再用 npm run desktop:dev 连开发服务器看。
 */
const INITIAL = typeof window !== 'undefined' && window.desktop ? '' : SAMPLE;

export default function App() {
  const [text, setText] = useState(INITIAL);
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
      if (!desktop) return;
      const res = await desktop.saveFile(text, pickPath ? null : filePath);
      if (res) {
        setFilePath(res.path);
        setDirty(false);
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
        case 'toggle-outline':
          editorRef.current?.toggleOutline();
          break;
      }
    });
  }, [desktop, open, save]);

  // 窗口标题反映文件名与未保存状态
  useEffect(() => {
    if (!desktop) return;
    const name = filePath ? baseName(filePath) : '未命名';
    void desktop.setTitle(`${dirty ? '● ' : ''}${name} — jinmo`);
  }, [desktop, dirty, filePath]);

  return (
    <div className="min-h-screen">
      {/* 版心宽度与内边距照 github.css 的 `#write`：860px 内容宽 + 30px 内边距 */}
      <div className={`mx-auto ${immersive ? 'max-w-[780px]' : 'max-w-[920px]'}`}>
        <MirrorEditor
          ref={editorRef}
          plain
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
      </div>
    </div>
  );
}
