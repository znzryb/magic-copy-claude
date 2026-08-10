/*
 * markdown.js — 把一段 DOM Range（用户的选区）序列化成 Markdown。
 *
 * 设计要点：
 *  1. 不用 range.cloneContents()。cloneContents 会丢失祖先上下文——选中列表中间两项时
 *     克隆出来的片段里没有 <ul>，于是没法还原 "1. 2. 3."。这里改成「从公共祖先往上爬到
 *     消息根节点，遍历原始 DOM，用 range.intersectsNode 过滤，文本节点按 range 端点裁剪」，
 *     列表 / 引用 / 表格的上下文因此完整保留。
 *  2. 公式走 KaTeX 的 <annotation encoding="application/x-tex"> —— 那里存的就是 Claude
 *     输出的原始 LaTeX，比从渲染后的 span 里反推可靠得多。整块公式一旦与选区相交就整体
 *     输出（半个公式没有意义），且拦在遍历入口，绝不会下钻到 .katex-html 把渲染字形抄进来。
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    mathInline: ['$', '$'],
    mathDisplay: ['$$', '$$'],
    bullet: '-',
    escapeText: true,
    keepImages: true,
    keepLinks: true
  };

  var BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT',
    'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'HEADER', 'HGROUP', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE',
    'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'
  ]);

  // 这些是 UI 外壳 / 不可见内容，永远不进 Markdown
  var SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'BUTTON', 'SELECT', 'TEXTAREA', 'SVG', 'CANVAS', 'IFRAME', 'VIDEO', 'AUDIO']);

  function isElement(n) { return n && n.nodeType === 1; }
  function isText(n) { return n && n.nodeType === 3; }
  function tag(n) { return isElement(n) ? n.tagName.toUpperCase() : ''; }

  function collapse(s) { return s.replace(/[\t\n\r\f\v ]+/g, ' '); }

  function escapeMd(s) {
    return s.replace(/([\\`*\[\]])/g, '\\$1');
  }

  // 行首的 markdown 结构字符要转义，否则一段普通文字会被当成列表 / 标题 / 引用
  function escapeLineStarts(s) {
    return s
      .replace(/^(\s*)([#>])/gm, '$1\\$2')
      .replace(/^(\s*)([-+*])(\s)/gm, '$1\\$2$3')
      .replace(/^(\s*)(\d+)([.)])(\s)/gm, '$1$2\\$3$4');
  }

  function repeat(s, n) { return new Array(n + 1).join(s); }

  function indentRest(text, pad) {
    return text.split('\n').map(function (line, i) {
      if (i === 0) return line;
      return line.length ? pad + line : line;
    }).join('\n');
  }

  /* ------------------------------------------------------------------ */

  function Serializer(range, opts) {
    this.range = range || null;
    this.o = Object.assign({}, DEFAULTS, opts || {});
  }

  // 只给「纯文本块」做行首转义。列表 / 引用的标记是我们自己生成的，绝不能被转义
  Serializer.prototype.textBlock = function (md) {
    return { kind: 'text', md: this.o.escapeText ? escapeLineStarts(md) : md };
  };

  Serializer.prototype.intersects = function (node) {
    if (!this.range) return true;
    try {
      return this.range.intersectsNode(node);
    } catch (e) {
      return true;
    }
  };

  // 文本节点按选区端点裁剪：只有真正被选中的那部分文字才输出
  Serializer.prototype.rawText = function (node) {
    var text = node.nodeValue || '';
    if (!this.range) return text;
    if (!this.intersects(node)) return '';
    var start = 0;
    var end = text.length;
    if (node === this.range.startContainer && this.range.startContainer.nodeType === 3) {
      start = this.range.startOffset;
    }
    if (node === this.range.endContainer && this.range.endContainer.nodeType === 3) {
      end = this.range.endOffset;
    }
    if (start >= end) return '';
    return text.slice(start, end);
  };

  Serializer.prototype.visible = function (node) {
    if (isText(node)) return true;
    if (!isElement(node)) return false;
    if (SKIP_TAGS.has(tag(node))) return false;
    if (node.hasAttribute('data-magic-copy-ui')) return false;
    // claude.ai 的代码块右上角有「复制 / 语言」工具条，元素本身是 div 不是 button
    if (node.getAttribute('role') === 'button' || node.getAttribute('role') === 'toolbar') return false;
    // aria-hidden 是对辅助技术隐藏的装饰性内容：KaTeX 的 .katex-html 渲染字形、图标等。
    // 公式正常走 mathKind 拦截，这里是兜底 —— 万一没拦住也绝不把渲染字形抄进来
    if (node.getAttribute('aria-hidden') === 'true') return false;
    var win = node.ownerDocument && node.ownerDocument.defaultView;
    if (win && win.getComputedStyle) {
      var st = win.getComputedStyle(node);
      if (st && (st.display === 'none' || st.visibility === 'hidden')) return false;
    }
    return true;
  };

  /* ------------------------------ 公式 ------------------------------ */

  Serializer.prototype.mathKind = function (el) {
    if (!isElement(el)) return null;
    var cl = el.classList;
    if (cl) {
      if (cl.contains('katex-display')) return 'display';
      if (cl.contains('katex')) {
        // 单独一行的公式，KaTeX 会包一层 .katex-display
        var p = el.parentElement;
        if (p && p.classList && p.classList.contains('katex-display')) return null; // 交给外层处理
        return 'inline';
      }
    }
    var t = tag(el);
    if (t === 'MJX-CONTAINER') return el.getAttribute('display') === 'true' ? 'display' : 'inline';
    if (t === 'MATH') {
      // 裸 MathML（少见），且不是 KaTeX 内部那份
      if (el.closest && el.closest('.katex')) return null;
      return el.getAttribute('display') === 'block' ? 'display' : 'inline';
    }
    return null;
  };

  Serializer.prototype.texOf = function (el) {
    var ann = el.querySelector && el.querySelector('annotation[encoding="application/x-tex"]');
    var tex = ann ? ann.textContent : null;
    if (tex == null && el.getAttribute) tex = el.getAttribute('data-latex');
    if (tex == null) {
      var m = el.querySelector && el.querySelector('math[alttext]');
      if (m) tex = m.getAttribute('alttext');
    }
    if (tex == null) {
      // 最后兜底：只取 MathML 那一份文本，避免把 .katex-html 的渲染字形也算进来
      var mm = el.querySelector && el.querySelector('.katex-mathml');
      tex = (mm || el).textContent || '';
    }
    return tex.replace(/\s+/g, ' ').trim();
  };

  Serializer.prototype.math = function (el, kind) {
    var tex = this.texOf(el);
    if (!tex) return '';
    var d = kind === 'display' ? this.o.mathDisplay : this.o.mathInline;
    if (kind === 'display') return d[0] + '\n' + tex + '\n' + d[1];
    return d[0] + tex + d[1];
  };

  /* ------------------------------ 行内 ------------------------------ */

  Serializer.prototype.inlineChildren = function (el) {
    var out = '';
    var kids = el.childNodes;
    for (var i = 0; i < kids.length; i++) {
      out += this.inlineNode(kids[i]);
    }
    return out;
  };

  Serializer.prototype.inlineNode = function (node) {
    if (isText(node)) {
      var t = collapse(this.rawText(node));
      return this.o.escapeText ? escapeMd(t) : t;
    }
    if (!isElement(node) || !this.visible(node) || !this.intersects(node)) return '';

    var kind = this.mathKind(node);
    if (kind) return this.math(node, kind === 'display' ? 'inline' : kind);

    var t = tag(node);
    switch (t) {
      case 'BR':
        return '  \n';
      case 'STRONG': case 'B': {
        var s = this.inlineChildren(node).trim();
        return s ? '**' + s + '**' : '';
      }
      case 'EM': case 'I': {
        var e = this.inlineChildren(node).trim();
        return e ? '*' + e + '*' : '';
      }
      case 'DEL': case 'S': case 'STRIKE': {
        var d = this.inlineChildren(node).trim();
        return d ? '~~' + d + '~~' : '';
      }
      case 'CODE': case 'KBD': case 'SAMP': {
        var raw = this.plainText(node);
        if (!raw.trim()) return '';
        var ticks = '`';
        while (raw.indexOf(ticks) !== -1) ticks += '`';
        var padSp = /^`|`$/.test(raw) ? ' ' : '';
        return ticks + padSp + raw + padSp + ticks;
      }
      case 'A': {
        var label = this.inlineChildren(node).trim();
        if (!label) return '';
        if (!this.o.keepLinks) return label;
        var href = node.getAttribute('href') || '';
        if (!href || href.charAt(0) === '#' || /^javascript:/i.test(href)) return label;
        return '[' + label + '](' + node.href + ')';
      }
      case 'IMG': {
        if (!this.o.keepImages) return '';
        var alt = node.getAttribute('alt') || '';
        var src = node.getAttribute('src') || '';
        if (!src) return '';
        return '![' + alt + '](' + src + ')';
      }
      case 'SUP': {
        var sup = this.inlineChildren(node).trim();
        return sup ? '^' + sup + '^' : '';
      }
      case 'SUB': {
        var sub = this.inlineChildren(node).trim();
        return sub ? '~' + sub + '~' : '';
      }
      default:
        return this.inlineChildren(node);
    }
  };

  // 代码 / 公式内部用的原样文本（保留空白，仍按选区裁剪）
  Serializer.prototype.plainText = function (el) {
    var self = this;
    var out = '';
    (function walk(node) {
      if (isText(node)) { out += self.rawText(node); return; }
      if (!isElement(node)) return;
      if (SKIP_TAGS.has(tag(node))) return;
      if (node.hasAttribute && node.hasAttribute('data-magic-copy-ui')) return;
      if (!self.intersects(node)) return;
      var kids = node.childNodes;
      for (var i = 0; i < kids.length; i++) walk(kids[i]);
    })(el);
    return out;
  };

  /* ------------------------------ 块级 ------------------------------ */

  // 返回 [{kind, md}]，kind 用于决定块之间是用一个还是两个换行
  Serializer.prototype.blocksOf = function (parent, ctx) {
    var out = [];
    var buf = '';
    var self = this;

    function flush() {
      var t = buf.replace(/[ \t]+$/, '');
      if (t.trim()) out.push(self.textBlock(t.trim()));
      buf = '';
    }

    var kids = parent.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var child = kids[i];
      if (isText(child)) { buf += this.inlineNode(child); continue; }
      if (!isElement(child)) continue;
      if (!this.visible(child) || !this.intersects(child)) continue;

      var kind = this.mathKind(child);
      if (kind === 'display') {
        flush();
        var dm = this.math(child, 'display');
        if (dm) out.push({ kind: 'math', md: dm });
        continue;
      }
      if (kind === 'inline') { buf += this.math(child, 'inline'); continue; }

      if (!BLOCK_TAGS.has(tag(child))) { buf += this.inlineNode(child); continue; }

      flush();
      var blocks = this.block(child, ctx);
      for (var j = 0; j < blocks.length; j++) out.push(blocks[j]);
    }
    flush();
    return out;
  };

  Serializer.prototype.block = function (el, ctx) {
    var t = tag(el);

    switch (t) {
      case 'P': {
        var p = this.inlineChildren(el).trim();
        return p ? [this.textBlock(p)] : [];
      }
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
        var h = this.inlineChildren(el).trim();
        return h ? [{ kind: 'text', md: repeat('#', +t.charAt(1)) + ' ' + h }] : [];
      }
      case 'HR':
        return [{ kind: 'rule', md: '---' }];
      case 'PRE':
        return this.pre(el);
      case 'UL': case 'OL':
        return this.list(el, ctx);
      case 'LI': {
        // 选区根节点正好是 li 的情况：补一个 bullet
        var inner = this.joinBlocks(this.blocksOf(el, ctx));
        return inner.trim() ? [{ kind: 'list', md: this.o.bullet + ' ' + indentRest(inner, '  ') }] : [];
      }
      case 'BLOCKQUOTE': {
        var q = this.joinBlocks(this.blocksOf(el, ctx));
        if (!q.trim()) return [];
        var quoted = q.split('\n').map(function (line) {
          return line.length ? '> ' + line : '>';
        }).join('\n');
        return [{ kind: 'quote', md: quoted }];
      }
      case 'TABLE':
        return this.table(el, ctx);
      case 'DL':
        return this.blocksOf(el, ctx);
      case 'DT': {
        var dt = this.inlineChildren(el).trim();
        return dt ? [{ kind: 'text', md: '**' + dt + '**' }] : [];
      }
      case 'DD': {
        var dd = this.joinBlocks(this.blocksOf(el, ctx));
        return dd.trim() ? [{ kind: 'text', md: ': ' + indentRest(dd, '  ') }] : [];
      }
      default:
        // div / section / article … 一律透传，claude.ai 的正文里这类包装层非常多
        return this.blocksOf(el, ctx);
    }
  };

  Serializer.prototype.pre = function (el) {
    var codeEl = el.querySelector('code') || el;
    var lang = '';
    var cls = (codeEl.getAttribute && codeEl.getAttribute('class')) || '';
    var m = cls.match(/(?:language|lang)-([\w+#.-]+)/);
    if (m) lang = m[1];
    if (!lang) {
      // claude.ai 把语言名放在代码块顶部的工具条里
      var header = el.querySelector('[class*="text-text-"], .code-block__header, header');
      if (header && header !== codeEl && !header.contains(codeEl)) {
        var ht = (header.textContent || '').trim();
        if (ht && ht.length < 20 && !/\s/.test(ht)) lang = ht.toLowerCase();
      }
    }
    var code = this.plainText(codeEl).replace(/\n+$/, '');
    if (!code.trim()) return [];
    var fence = '```';
    while (code.indexOf(fence) !== -1) fence += '`';
    return [{ kind: 'code', md: fence + lang + '\n' + code + '\n' + fence }];
  };

  // 选区是否从这个列表项的开头开始（用来判断"整项"还是"项里的半句话"）
  Serializer.prototype.startsAtBeginningOf = function (el) {
    if (!this.range) return true;
    try {
      var probe = el.ownerDocument.createRange();
      probe.selectNodeContents(el);
      probe.setEnd(this.range.startContainer, this.range.startOffset);
      return !probe.toString().trim();
    } catch (e) {
      return true;
    }
  };

  Serializer.prototype.list = function (el, ctx) {
    var ordered = tag(el) === 'OL';
    var idx = parseInt(el.getAttribute('start') || '1', 10);
    if (isNaN(idx)) idx = 1;
    var items = [];
    var picked = [];
    var kids = el.children;

    for (var i = 0; i < kids.length; i++) {
      var li = kids[i];
      if (tag(li) !== 'LI') continue;
      var marker = ordered ? (idx + '. ') : (this.o.bullet + ' ');
      idx++;
      // 没被选中的项跳过，但序号照样递增 —— 选中第 2、3 项时输出仍是 "2. 3."
      if (!this.visible(li) || !this.intersects(li)) continue;
      var inner = this.joinBlocks(this.blocksOf(li, Object.assign({}, ctx, { depth: (ctx.depth || 0) + 1 })));
      if (!inner.trim()) continue;
      picked.push(li);
      items.push({ marker: marker, inner: inner });
    }
    if (!items.length) return [];

    // 只框中了某一项中间的半句话 —— 这时套上 "1." / "-" 反而莫名其妙，当普通文字处理
    if (items.length === 1 && !this.startsAtBeginningOf(picked[0])) {
      return [this.textBlock(items[0].inner)];
    }

    var lines = items.map(function (it) {
      return it.marker + indentRest(it.inner, repeat(' ', it.marker.length));
    });
    return [{ kind: 'list', md: lines.join('\n') }];
  };

  Serializer.prototype.table = function (el, ctx) {
    var self = this;
    var rows = [];
    var trs = el.querySelectorAll('tr');
    for (var i = 0; i < trs.length; i++) {
      var tr = trs[i];
      if (!this.visible(tr) || !this.intersects(tr)) continue;
      var cells = [];
      var isHead = false;
      var tds = tr.children;
      for (var j = 0; j < tds.length; j++) {
        var td = tds[j];
        var tt = tag(td);
        if (tt !== 'TD' && tt !== 'TH') continue;
        if (tt === 'TH') isHead = true;
        var text = (this.visible(td) && this.intersects(td)) ? this.inlineChildren(td).trim() : '';
        cells.push(text.replace(/\|/g, '\\|').replace(/\n/g, ' '));
      }
      if (cells.length) rows.push({ head: isHead, cells: cells });
    }
    if (!rows.length) return [];

    var width = rows.reduce(function (w, r) { return Math.max(w, r.cells.length); }, 0);
    function line(cells) {
      var c = cells.slice();
      while (c.length < width) c.push('');
      return '| ' + c.join(' | ') + ' |';
    }
    var lines = [];
    var startIdx = 0;
    if (rows[0].head) {
      lines.push(line(rows[0].cells));
      startIdx = 1;
    } else {
      lines.push(line(new Array(width).fill('')));
    }
    lines.push('| ' + new Array(width).fill('---').join(' | ') + ' |');
    for (var k = startIdx; k < rows.length; k++) lines.push(line(rows[k].cells));
    void self; void ctx;
    return [{ kind: 'table', md: lines.join('\n') }];
  };

  // 块之间的空行策略：列表紧跟在列表 / 列表项文本后面时只用一个换行，保持紧凑列表
  Serializer.prototype.joinBlocks = function (blocks) {
    var out = '';
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (!b.md.trim()) continue;
      if (!out) { out = b.md; continue; }
      var prev = blocks[i - 1];
      var tight = b.kind === 'list' && prev && (prev.kind === 'list' || prev.kind === 'text');
      out += (tight ? '\n' : '\n\n') + b.md;
    }
    return out;
  };

  /* ------------------------------ 入口 ------------------------------ */

  // 从公共祖先往上爬：爬到消息根 / 最近的块级容器，好让列表、引用、表格的上下文完整
  function contextRoot(range) {
    var node = range.commonAncestorContainer;
    var el = isElement(node) ? node : node.parentElement;
    if (!el) return null;
    var stop = el.closest(
      '[data-testid="user-message"], .font-claude-response, [data-is-streaming], article, main'
    );
    if (stop) return stop;
    var cur = el;
    while (cur.parentElement && !BLOCK_TAGS.has(tag(cur))) cur = cur.parentElement;
    return cur.parentElement || cur;
  }

  function tidy(md) {
    return md
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+|\s+$/g, '');
  }

  function fromRange(range, opts) {
    if (!range || range.collapsed) return '';
    var root = contextRoot(range);
    if (!root) return '';
    var s = new Serializer(range, opts);
    return tidy(s.joinBlocks(s.blocksOf(root, { depth: 0 })));
  }

  function fromSelection(sel, opts) {
    sel = sel || (root.getSelection && root.getSelection());
    if (!sel || sel.rangeCount === 0) return '';
    var parts = [];
    for (var i = 0; i < sel.rangeCount; i++) {
      var md = fromRange(sel.getRangeAt(i), opts);
      if (md) parts.push(md);
    }
    return parts.join('\n\n');
  }

  function fromElement(el, opts) {
    var s = new Serializer(null, opts);
    return tidy(s.joinBlocks(s.blocksOf(el, { depth: 0 })));
  }

  var api = {
    fromRange: fromRange,
    fromSelection: fromSelection,
    fromElement: fromElement,
    DEFAULTS: DEFAULTS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MagicCopyMD = api;
})(typeof window !== 'undefined' ? window : globalThis);
