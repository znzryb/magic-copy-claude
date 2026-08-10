#!/usr/bin/env python
"""在真实 Chromium 里跑 src/markdown.js —— 构造选区、打印 Markdown、断言关键不变量。

用法：~/miniconda3/bin/python test/run.py [-v]
"""
import pathlib
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURE = (ROOT / "test" / "fixture.html").as_uri()
VERBOSE = "-v" in sys.argv

HELPERS = r"""
window.__t = {
  firstText(sel) {
    const el = document.querySelector(sel);
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    return w.nextNode();
  },
  lastText(sel) {
    const el = document.querySelector(sel);
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n = null, cur;
    while ((cur = w.nextNode())) n = cur;
    return n;
  },
  // 从 A 的第一个文本节点 offset a，到 B 的最后一个文本节点 offset b（b<0 表示到末尾）
  range(aSel, aOff, bSel, bOff) {
    const r = document.createRange();
    const a = this.firstText(aSel), b = this.lastText(bSel);
    r.setStart(a, aOff);
    r.setEnd(b, bOff < 0 ? b.nodeValue.length : bOff);
    return r;
  },
  contents(sel) {
    const r = document.createRange();
    r.selectNodeContents(document.querySelector(sel));
    return r;
  },
};
"""

# (名字, 造 range 的 JS 表达式, 必须出现的片段, 必须不出现的片段)
CASES = [
    (
        "截图里的那段选区：段落 + 三条编号列表（跨块、含行内公式）",
        "__t.range('#p-lede', 0, '#li-3', -1)",
        ["**恰好贡献 $L-1$**", "1. 前缀里相邻", "2. 前缀这 $L$ 格", "3. 边界那一格", "**一个**"],
        ["L−1", "katex"],
    ),
    (
        "只选列表第 2、3 项 —— 序号必须保持 2. 3.",
        "__t.range('#li-2', 0, '#li-3', -1)",
        ["2. 前缀这 $L$ 格", "3. 边界那一格"],
        ["1. "],
    ),
    (
        "文本节点中间起止：半句话必须精确裁剪",
        "__t.range('#li-1', 3, '#li-1', 10)",
        ["相邻两格颜色必"],
        ["前缀里", "1. "],
    ),
    (
        "行间公式（.katex-display）单独成块",
        "__t.contents('#display-math')",
        ["$$\n\\sum_{i=1}^{n} f(i) = \\binom{n}{2}\n$$"],
        [],
    ),
    (
        "代码块：语言标记 + 原样缩进，工具条 / Copy 按钮不能混进来",
        "__t.contents('#pre-code')",
        ["```cpp\nfor (int i = 0; i < n; i++) {\n    ans += a[i] * 2;   // 注意溢出\n}\n```"],
        ["Copy", "cpp\ncpp"],
    ),
    (
        "行内代码 + 链接",
        "__t.contents('#p-inline')",
        ["`std::vector<int>`", "[这份文档](https://example.com/doc?a=1&b=2)"],
        ["\\`"],
    ),
    (
        "引用块",
        "__t.contents('#bq')",
        ["> 注意：这里的 *L* 是前缀长度"],
        [],
    ),
    (
        "嵌套列表",
        "__t.contents('#ul-nested')",
        ["- 外层第一项\n  - 内层 A\n  - 内层 B\n- 外层第二项"],
        [],
    ),
    (
        "表格（单元格里的竖线要转义）",
        "__t.contents('#tbl')",
        ["| 做法 | 复杂度 |", "| --- | --- |", "| 前缀和 \\| 差分 | O(n) |"],
        [],
    ),
    (
        "正文里的 markdown 特殊字符要转义",
        "__t.contents('#p-escape')",
        ["\\*星号\\*", "\\[方括号\\]", "\\`反引号\\`"],
        [],
    ),
    (
        "本来就以减号开头的段落不能被当成列表",
        "__t.contents('#p-dash')",
        ["\\- 这一行"],
        [],
    ),
    (
        "跨越标题 / 代码块 / 段落的大范围选区",
        "__t.range('#h-code', 0, '#p-inline', -1)",
        ["### 参考实现", "```cpp", "`std::vector<int>`"],
        [],
    ),
]


def main():
    failures = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        page.goto(FIXTURE)
        page.add_script_tag(path=str(ROOT / "src" / "markdown.js"))
        page.evaluate(HELPERS)

        for name, expr, must, must_not in CASES:
            md = page.evaluate(
                "expr => window.MagicCopyMD.fromRange(eval(expr))", expr
            )
            problems = [f"缺少: {m!r}" for m in must if m not in md]
            problems += [f"不该出现: {m!r}" for m in must_not if m in md]
            ok = not problems
            print(f"{'PASS' if ok else 'FAIL'}  {name}")
            if VERBOSE or not ok:
                print("      ┌─ 实际输出 ─────────────────")
                for line in md.split("\n"):
                    print("      │ " + line)
                print("      └───────────────────────────")
            for p in problems:
                print("      ✗ " + p)
                failures.append((name, p))
        browser.close()

    print()
    total = len(CASES)
    print(f"{total - len({n for n, _ in failures})}/{total} 用例通过")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
