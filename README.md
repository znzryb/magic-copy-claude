# Magic Copy for Claude

在 claude.ai 上**选中一段回复 → 一键复制成 Markdown**，其中 KaTeX 渲染的公式会还原成原始 LaTeX。

直接用浏览器复制的话，`$L-1$` 会变成渲染后的字形 `L−1`（还是 Unicode 减号），编号列表塌成纯文本，代码块的语言标记和缩进也全丢。这个插件解决的就是这件事。

## 效果

选中这样一段（含行内公式的段落 + 三条编号列表）：

```markdown
三件事同时成立，所以这一行**恰好贡献 $L-1$**：
1. 前缀里相邻两格颜色必不同（上一行交错，同时翻转后仍交错），所以前缀的每一格各自成块；
2. 前缀这 $L$ 格都与正上方异色，所以都是"新"的；
3. 边界那一格（第 $L$ 格）和右边照抄格同色，被吸走 —— 而且它只连到**一个**已有块，不会把两个旧块粘成一个。
```

粘进 Obsidian / Typora / Notion / Anki / `.md` 文件里，公式直接能渲染。

## 安装

```bash
git clone https://github.com/znzryb/magic-copy-claude.git
cd magic-copy-claude
./install.sh          # 同步到 ~/chrome-extensions/magic-copy-claude/
```

Chrome → `chrome://extensions` → 打开右上角「开发者模式」→「加载已解压的扩展程序」→ 选 `~/chrome-extensions/magic-copy-claude`。

> 改完代码要重新跑一遍 `./install.sh`，再去 `chrome://extensions` 点「重新加载」。Chrome 加载的是 `~/chrome-extensions/` 下那份，只改仓库不同步是不生效的。

## 用法

在 claude.ai 的对话正文里选中任意文字后，三选一：

- 直接按 <kbd>⌘</kbd><kbd>C</kbd>（<kbd>Ctrl</kbd><kbd>C</kbd>）—— 插件会拦截原生复制，剪贴板里就是 Markdown
- 点选区上方浮出的 **「复制为 Markdown」** 按钮
- 按 <kbd>⌥</kbd><kbd>⇧</kbd><kbd>C</kbd>（Windows/Linux 是 <kbd>Alt</kbd><kbd>Shift</kbd><kbd>C</kbd>）

原生复制拦截只在对话消息内生效（侧栏、输入框不受影响），粘贴到富文本编辑器时仍走原始的
`text/html`，行为不变；不想要的话可以在设置里关掉「接管普通复制」。

点插件图标可以改设置（公式定界符 `$…$` / `\(…\)`、列表符号、是否转义特殊字符、是否附来源链接等），改完即时生效，不用刷新页面。

## 支持的元素

| 元素 | 输出 |
| --- | --- |
| 行内公式 | `$L-1$`（原始 LaTeX，取自 KaTeX 的 `<annotation encoding="application/x-tex">`） |
| 行间公式 | `$$…$$` 独立成块 |
| 有序 / 无序列表 | 保留序号与嵌套缩进；只选中第 2、3 项时序号仍是 `2. 3.` |
| 代码块 | ```` ```cpp ```` 围栏 + 原样缩进，自动剔除「复制」按钮和语言标签工具条 |
| 行内代码 | `` `code` ``，内容含反引号时自动加长围栏 |
| 标题 / 引用 / 分隔线 / 表格 | `#`、`>`、`---`、GFM 表格（单元格里的 `|` 会转义） |
| 加粗 / 斜体 / 删除线 / 链接 / 图片 | `**` `*` `~~` `[…](…)` `![…](…)` |

## 实现要点

- **不用 `range.cloneContents()`**。克隆片段会丢祖先上下文——选中列表中间两项时，克隆出来的 DOM 里根本没有 `<ol>`，序号无从还原。这里改成从公共祖先往上爬到消息根节点，遍历**原始 DOM**，用 `range.intersectsNode()` 过滤、文本节点按 range 端点裁剪，于是列表 / 引用 / 表格的结构完整保留。
- **公式取 KaTeX 的 `<annotation>`**，那里存的就是 Claude 输出的原始 LaTeX，比从渲染后的 span 反推可靠。整块公式只要与选区相交就整体输出（半个公式没意义），并且拦在遍历入口，绝不会下钻到 `.katex-html` 把渲染字形抄进来。
- **原生复制走 copy 事件拦截**，与 KaTeX 官方 [copy-tex](https://github.com/KaTeX/KaTeX/tree/main/contrib/copy-tex) 插件同一套模式：重写 `clipboardData` 的 `text/plain`、保留 `text/html`、`preventDefault()`。不拦的话，浏览器原生复制会把 `.katex-mathml` 字形 + `<annotation>` 源码 + `.katex-html` 字形三份叠着抄出来（`$nm$` 变成 `nmnm nm`）。
- **`aria-hidden="true"` 的元素一律不进 Markdown**（KaTeX 用它标记 `.katex-html` 渲染字形，claude.ai 用它标记装饰图标），作为公式拦截之外的兜底。
- **UI 放 Shadow DOM**，不被 claude.ai 的 Tailwind 污染，也不会被自己的序列化器当成正文。

## 测试

```bash
~/miniconda3/bin/python test/run.py -v   # 13 条序列化用例（真实 Chromium + 仿 KaTeX DOM）
~/miniconda3/bin/python test/e2e.py      # 端到端：拖选 → 点按钮 / 原生 Ctrl+C → 读系统剪贴板
```

依赖 `playwright`（`pip install playwright && playwright install chromium`）。playwright 包版本和
已装浏览器不配套时，可用 `CHROMIUM_EXE=/path/to/chrome` 指定浏览器二进制。

## License

MIT
