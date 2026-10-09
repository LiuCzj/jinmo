# jinmo

一个所见即所得的 Markdown 编辑器 —— **光标走到哪，哪里的 Markdown 语法才浮现**。

纯前端，零服务端依赖。同一份代码可以发布成网页，也可以打包成 Windows 桌面应用。

> 交互设计参考 Typora 的混合编辑体验。本项目与 Typora 无任何关联，未使用其代码或资源。

## 特性

| 能力 | 说明 |
|---|---|
| 语法随光标浮现 | 平时是渲染态，看不见 `#` `>` `**` `[]()`；光标移进某一行，那一行露出块前缀，**光标落进的那个行内元素**才露出标记，内容样式不丢 |
| 整篇源码模式 | `Ctrl+/` 在所见即所得与整篇 Markdown 源码之间切换，带行号与语法着色，光标位置来回保留 |
| 查找 / 替换 | `Ctrl+F` / `Ctrl+H`；面板内含命中计数、大小写开关、上一个 / 下一个 / 替换 / 全部替换 |
| 沉浸式 | `F8` 专注模式（只留当前块清晰）、`F9` 打字机模式（光标钉在屏幕垂直中线） |
| 表格 | 右键九项菜单：上下插行、左右插列、删除行列、复制表格、格式化表格源码、删除表格 |
| 任务列表 | `- [ ]` / `- [x]` 渲染成真复选框，点击即切换（不再显示 `[ ]` 原文） |
| 脚注 | 引用 `[^1]` 渲染成上标；定义 `[^1]: 说明` 单独成行 |
| 引用式链接 | `[文字][id]` + `[id]: url`，定义写在文末任意位置 |
| 行内标记 | 粗斜体 `***x***`、转义 `\*`、文本高亮 `==x==` |
| 图片 | `![alt](地址)` 直接渲染成图片；本地路径由桌面壳读取（相对路径按当前文件所在目录解析），加载失败退化为占位框 |
| 代码块高亮 | 按围栏语言着色（关键字 / 字符串 / 数字 / 注释）。零依赖，自己写的词法着色器，不引高亮库 |
| 数学公式 | 行内 `$...$`、块级 `$$...$$`，用 **MathJax** 渲染，输出 SVG 不需要字体文件 |
| 大纲侧栏 | `Ctrl+Shift+O` 列出全部标题，点击跳到对应行 |
| 中文输入法 | 组合期 / 上屏 / Esc 取消全流程处理，不丢字、不重复上屏 |
| 其它 | 撤销重做、剪贴板三通道、拖入 `.md` 整体导入、选区格式气泡、右键上下文菜单、`Ctrl+1..6` 标题 |

整包 gzip 后约 70 KB，不引任何浏览器端 Markdown 渲染器或代码高亮库。

## 快速开始

需要 Node.js 18 或以上。

```bash
npm install
npm run dev        # 开发服务器，默认 http://localhost:5173
```

## 常用命令

```bash
npm run dev          # 开发服务器
npm run typecheck    # 类型检查（tsc --noEmit）
npm test             # 纯函数单测
npm run build        # 类型检查 + 构建静态站到 dist/
npm run preview      # 本地预览 dist/
npm run build:single # 构建 + 生成可双击打开的单文件版
npm run desktop      # 构建 + 启动桌面版（Electron）
npm run desktop:dev  # 桌面版连开发服务器（需先 npm run dev）
```

两种产物：

- `dist/` —— 标准静态站，用于部署，也是**桌面版加载的那一份**。产物走相对路径，可直接放在 GitHub Pages 的子路径下。
- `dist/markdown-editor.html` —— 单文件版，JS 与 CSS 全部内联。**双击即可运行**，也可以直接发给别人。
  代价是失去了按需加载（Mermaid、MathJax 会一起打进去），文件约 8 MB。

## 桌面版

桌面壳用 Electron，主进程在 `electron/main.cjs`（`preload.cjs` 只暴露具名方法，页面拿不到 `ipcRenderer`）。

```bash
npm run desktop       # 构建后启动
npm run desktop:dev   # 连本地开发服务器，改代码即时生效
```

界面资源经自定义协议 `jinmo-app://` 从 `dist/` 读取，而不是 `file://`：
`file://` 下 ES module 会被 CORS 拦掉，只能把整个应用压成一个 HTML 来绕开，
而压成单文件会连 Mermaid / MathJax 的按需加载一起压掉。

已具备：打开 / 保存 / 另存为、**最近打开**（菜单里，最多 10 条）、原生菜单栏、**窗口位置与尺寸记忆**、标题栏显示文件名与未保存标记。

主进程还支持 `--selftest`：启动后截图到 `temp/` 再退出，用于无人值守验证。

> 打包成安装包（`electron-builder`）尚未配置。

## 快捷键

| 分类 | 快捷键 | 动作 |
|---|---|---|
| 段落 | `Ctrl+1`..`Ctrl+6` / `Ctrl+0` | 标题 1–6 / 正文 |
| 段落 | `Ctrl+=` / `Ctrl+-` | 升 / 降标题级别 |
| 段落 | `Ctrl+[` / `Ctrl+]` | 缩进 / 反缩进 |
| 段落 | `Ctrl+T` | 插入表格（弹出行列对话框） |
| 段落 | `Ctrl+Shift+K` / `Ctrl+Shift+Q` | 代码块 / 引用 |
| 段落 | `Ctrl+Shift+[` / `Ctrl+Shift+]` | 有序 / 无序列表 |
| 格式 | `Ctrl+B` / `Ctrl+I` / `Ctrl+K` / `Ctrl+`` ` `` | 加粗 / 斜体 / 链接 / 行内代码 |
| 格式 | `Alt+Shift+5` / `Ctrl+Shift+I` | 删除线 / 插入图片 |
| 编辑 | `Enter` / `Shift+Enter` | 新行（列表自动续项）/ 软换行（不续列表） |
| 编辑 | `Ctrl+D` / `Ctrl+Shift+D` | 选中词（再按选中下一处）/ 删除词 |
| 编辑 | `Ctrl+Home` / `Ctrl+End` / `Ctrl+J` | 文首 / 文末 / 把光标滚进视野 |
| 编辑 | `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` | 撤销 / 重做 |
| 编辑 | `Ctrl+A` / `Ctrl+\` | 全选 / 清除格式 |
| 查找 | `Ctrl+F` / `Ctrl+H` | 查找 / 查找替换 |
| 视图 | `Ctrl+/` | 整篇源码模式 |
| 视图 | `Ctrl+Shift+O` | 大纲侧栏 |
| 视图 | `F8` / `F9` | 专注模式 / 打字机模式 |
| 表格 | `Ctrl+E` / `Ctrl+L` / `Ctrl+Shift+Backspace` | 选单元格 / 选行 / 删行 |

## 目录结构

```
src/
├─ lib/                      纯函数层，零依赖，可单独测试
│  ├─ md-inline.ts           行内解析、行类型判定、字符列映射
│  ├─ md-editing.ts          编辑原语：插入 / 退格 / 回车 / 光标移动
│  ├─ md-commands.ts         命令层：包裹 / 插入块 / 表格 / 上下文
│  ├─ md-highlight.ts        源码模式的逐行语法着色
│  └─ parse-md-file.ts       frontmatter 拆解
├─ components/
│  ├─ MirrorEditor.tsx       编辑器主体：逐行渲染、自绘光标、事件编排
│  ├─ MarkdownFloats.tsx     浮层：格式气泡、右键菜单、插入表格对话框
│  └─ FindBar.tsx            查找替换面板
├─ App.tsx                   宿主页（网页版 / 桌面版共用）
├─ desktop-api.d.ts          桌面壳暴露接口的类型声明
├─ main.tsx                  入口
└─ index.css                 Tailwind v4 设计令牌与组件类
electron/                    桌面壳（Electron 主进程与预加载）
tests/                       纯函数单测
scripts/                     构建辅助脚本
```

## 技术路线

**整篇 Markdown 字符串是唯一真相。** 不建富文本文档模型，不用 `contenteditable`，不用 ProseMirror / Slate。

- **渲染**：整篇按行切成模型（行类型 + 可见片段 + 每段的源码列范围），再自绘成 DOM，每行一个元素。
- **输入**：键盘与输入法挂在一个隐藏 `<textarea>` 上（1px、几乎透明、真实可聚焦）。
- **光标**：自绘。点击落点与光标定位共用同一张「字符 ↔ 源码列」映射表，两边不会各算各的。
- **源码模式**：独立的纯文本 `<textarea>`，因为它是纯文本视图，不是所见即所得视图。

选这条路的原因是 Markdown 源码本身就是文档，不需要在「富文本模型 ↔ Markdown」之间来回序列化，也就不会有往返失真。

## 许可

**GNU Affero General Public License v3.0（AGPL-3.0）** —— 自由软件，强 copyleft。

- 你可以自由使用、修改、分发，**包括商业用途**；
- 但**衍生作品必须以同样的 AGPL-3.0 条款开源**；
- 并且**通过网络提供服务也算分发**：把它部署成在线服务供他人使用，也必须公开你修改后的源码。

完整条款见 [`LICENSE`](LICENSE)。

```
Copyright (C) 2026 @LiuCzj
```
