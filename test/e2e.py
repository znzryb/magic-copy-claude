#!/usr/bin/env python
"""端到端：真实鼠标拖选 → 划词按钮浮出 → 点击 → 校验系统剪贴板里的 Markdown。

跑的是 src/markdown.js + src/content.js 本体（注入到页面里），
覆盖 run.py 测不到的那部分：选区监听、Shadow DOM 工具条、剪贴板写入。

用法：~/miniconda3/bin/python test/e2e.py
"""
import functools
import http.server
import os
import pathlib
import socketserver
import sys
import threading

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
PORT = 8791
# playwright 包版本和已装浏览器不配套时，用 CHROMIUM_EXE 指定二进制
CHROMIUM_EXE = os.environ.get("CHROMIUM_EXE") or None


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    httpd = serve()
    problems = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=CHROMIUM_EXE)
            ctx = browser.new_context()
            ctx.grant_permissions(["clipboard-read", "clipboard-write"],
                                  origin=f"http://127.0.0.1:{PORT}")
            page = ctx.new_page()
            page.goto(f"http://127.0.0.1:{PORT}/test/fixture.html")
            page.add_script_tag(path=str(ROOT / "src" / "markdown.js"))
            page.add_script_tag(path=str(ROOT / "src" / "content.js"))

            # 从「三件事…」这段的开头，拖到第三条列表项的末尾（复刻用户截图里的选区）
            start = page.locator("#p-lede").bounding_box()
            end = page.locator("#li-3").bounding_box()
            page.mouse.move(start["x"] + 2, start["y"] + 6)
            page.mouse.down()
            page.mouse.move(end["x"] + end["width"] - 4, end["y"] + end["height"] - 6, steps=12)
            page.mouse.up()

            page.wait_for_timeout(120)
            selected = page.evaluate("String(getSelection())")
            if "三件事" not in selected:
                problems.append(f"拖选没选中预期文本，实际选到：{selected[:40]!r}")

            bar_shown = page.evaluate(
                "!!document.querySelector('[data-magic-copy-ui]')"
                "  ?.shadowRoot?.querySelector('.bar.show')"
            )
            print(("PASS" if bar_shown else "FAIL") + "  划词后浮动工具条出现")
            if not bar_shown:
                problems.append("工具条没出现")

            # Playwright 的 CSS 选择器能穿透 open shadow root
            page.click(".btn")
            page.wait_for_timeout(200)

            md = page.evaluate("navigator.clipboard.readText()")
            print("      ┌─ 剪贴板内容 ───────────────")
            for line in md.split("\n"):
                print("      │ " + line)
            print("      └───────────────────────────")

            for must in ["三件事同时成立", "**恰好贡献 $L-1$**", "1. 前缀里", "2. 前缀这 $L$ 格", "3. 边界那一格"]:
                if must not in md:
                    problems.append(f"剪贴板缺少 {must!r}")
            for bad in ["katex", "L−1"]:
                if bad in md:
                    problems.append(f"剪贴板混进了 {bad!r}")
            print(("PASS" if not problems else "FAIL") + "  剪贴板里是带 LaTeX 的 Markdown")

            toast = page.evaluate(
                "document.querySelector('[data-magic-copy-ui]')"
                "  ?.shadowRoot?.querySelector('.toast.show')?.textContent || ''"
            )
            ok_toast = "已复制" in toast
            print(("PASS" if ok_toast else "FAIL") + f"  复制后提示浮层：{toast!r}")
            if not ok_toast:
                problems.append("没弹出「已复制」提示")

            # —— 原生 Ctrl+C / ⌘C：copy 事件拦截（copy-tex 模式）也要产出 Markdown ——
            page.evaluate("navigator.clipboard.writeText('placeholder')")
            page.mouse.move(start["x"] + 2, start["y"] + 6)
            page.mouse.down()
            page.mouse.move(end["x"] + end["width"] - 4, end["y"] + end["height"] - 6, steps=12)
            page.mouse.up()
            page.wait_for_timeout(120)
            page.keyboard.press("ControlOrMeta+c")
            page.wait_for_timeout(200)

            md2 = page.evaluate("navigator.clipboard.readText()")
            native_problems = []
            for must in ["**恰好贡献 $L-1$**", "2. 前缀这 $L$ 格"]:
                if must not in md2:
                    native_problems.append(f"原生复制缺少 {must!r}")
            for bad in ["katex", "L−1"]:
                if bad in md2:
                    native_problems.append(f"原生复制混进了 {bad!r}")
            print(("PASS" if not native_problems else "FAIL") + "  原生 Ctrl+C 也复制成 Markdown")
            if native_problems:
                print("      ┌─ 剪贴板内容 ───────────────")
                for line in md2.split("\n"):
                    print("      │ " + line)
                print("      └───────────────────────────")
            problems.extend(native_problems)

            browser.close()
    finally:
        httpd.shutdown()

    print()
    if problems:
        for p in problems:
            print("✗ " + p)
        return 1
    print("端到端全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
