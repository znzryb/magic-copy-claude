/*
 * content.js — 划词工具条 + 快捷键 + 写剪贴板。
 * UI 全部塞进 Shadow DOM，免得被 claude.ai 的 Tailwind 样式污染，也免得自己的 DOM
 * 被序列化器当成正文（额外挂了 data-magic-copy-ui 双保险）。
 */
(function () {
  'use strict';

  var OPTS = {
    enabled: true,
    showButton: true,
    hotkey: true,
    mathStyle: 'dollar',      // dollar: $x$ / $$x$$ ；paren: \(x\) / \[x\]
    bullet: '-',
    escapeText: true,
    keepLinks: true,
    keepImages: true,
    trailingSource: false     // 末尾附一行来源链接
  };

  var MATH_STYLES = {
    dollar: { mathInline: ['$', '$'], mathDisplay: ['$$', '$$'] },
    paren: { mathInline: ['\\(', '\\)'], mathDisplay: ['\\[', '\\]'] }
  };

  function loadOpts() {
    try {
      chrome.storage.sync.get(OPTS, function (v) {
        if (!chrome.runtime.lastError && v) Object.assign(OPTS, v);
      });
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'sync') return;
        Object.keys(changes).forEach(function (k) {
          if (k in OPTS) OPTS[k] = changes[k].newValue;
        });
        if (!OPTS.enabled || !OPTS.showButton) hideBar();
      });
    } catch (e) { /* storage 不可用就用默认值 */ }
  }

  function mdOpts() {
    var style = MATH_STYLES[OPTS.mathStyle] || MATH_STYLES.dollar;
    return {
      mathInline: style.mathInline,
      mathDisplay: style.mathDisplay,
      bullet: OPTS.bullet || '-',
      escapeText: !!OPTS.escapeText,
      keepLinks: !!OPTS.keepLinks,
      keepImages: !!OPTS.keepImages
    };
  }

  /* ----------------------------- 剪贴板 ----------------------------- */

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  // execCommand 兜底：会动选区，所以先存后恢复
  function legacyCopy(text) {
    var sel = window.getSelection();
    var saved = [];
    for (var i = 0; i < sel.rangeCount; i++) saved.push(sel.getRangeAt(i).cloneRange());

    var ta = document.createElement('textarea');
    ta.setAttribute('data-magic-copy-ui', '1');
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);

    sel.removeAllRanges();
    saved.forEach(function (r) { sel.addRange(r); });
    if (!ok) throw new Error('copy failed');
    return true;
  }

  /* ------------------------------- UI ------------------------------- */

  var host = null, shadow = null, bar = null, btn = null, toast = null, toastTimer = null;

  function ensureUI() {
    if (host) return;
    host = document.createElement('div');
    host.setAttribute('data-magic-copy-ui', '1');
    host.style.cssText = 'all:initial;position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647';
    shadow = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = [
      ':host{all:initial}',
      '.bar{position:fixed;display:none;align-items:center;gap:6px;padding:4px;',
      '  border-radius:10px;background:#1f1e1d;border:1px solid rgba(255,255,255,.14);',
      '  box-shadow:0 6px 20px rgba(0,0,0,.35);font:500 12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;}',
      '.bar.show{display:flex}',
      '.btn{display:flex;align-items:center;gap:5px;padding:6px 10px;border:0;border-radius:7px;',
      '  background:transparent;color:#f5f4f2;cursor:pointer;white-space:nowrap;font:inherit}',
      '.btn:hover{background:rgba(255,255,255,.10)}',
      '.btn:active{background:rgba(255,255,255,.18)}',
      '.btn .k{opacity:.45;font-size:11px}',
      '.toast{position:fixed;display:none;padding:7px 12px;border-radius:8px;background:#1f1e1d;',
      '  color:#f5f4f2;border:1px solid rgba(255,255,255,.14);box-shadow:0 6px 20px rgba(0,0,0,.35);',
      '  font:500 12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}',
      '.toast.show{display:block}',
      '.toast.err{color:#ffb4a8}',
      '@media (prefers-color-scheme: light){',
      '  .bar,.toast{background:#fff;border-color:rgba(0,0,0,.12);color:#1f1e1d}',
      '  .btn{color:#1f1e1d}.btn:hover{background:rgba(0,0,0,.06)}.btn:active{background:rgba(0,0,0,.12)}',
      '}'
    ].join('');

    bar = document.createElement('div');
    bar.className = 'bar';

    btn = document.createElement('button');
    btn.className = 'btn';
    btn.innerHTML = '<span>复制为 Markdown</span><span class="k">⌥⇧C</span>';
    // mousedown 会清掉选区，必须拦住
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      run();
    });

    toast = document.createElement('div');
    toast.className = 'toast';

    bar.appendChild(btn);
    shadow.appendChild(style);
    shadow.appendChild(bar);
    shadow.appendChild(toast);
    document.documentElement.appendChild(host);
  }

  function hideBar() { if (bar) bar.classList.remove('show'); }

  function showBarFor(rect) {
    ensureUI();
    bar.classList.add('show');
    var bw = bar.offsetWidth || 150;
    var bh = bar.offsetHeight || 30;
    var left = Math.min(Math.max(8, rect.left + rect.width / 2 - bw / 2), window.innerWidth - bw - 8);
    var top = rect.top - bh - 8;
    if (top < 8) top = Math.min(rect.bottom + 8, window.innerHeight - bh - 8);
    bar.style.left = left + 'px';
    bar.style.top = top + 'px';
  }

  function flash(msg, isErr) {
    ensureUI();
    toast.textContent = msg;
    toast.className = 'toast show' + (isErr ? ' err' : '');
    var w = toast.offsetWidth || 120;
    toast.style.left = Math.max(8, (window.innerWidth - w) / 2) + 'px';
    toast.style.top = '24px';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.className = 'toast'; }, 1400);
  }

  /* ----------------------------- 主流程 ----------------------------- */

  function currentSelection() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    if (!String(sel).trim()) return null;
    // 选区落在自己的 UI 或输入框里就不管
    var node = sel.anchorNode;
    var el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (el && el.closest && el.closest('[data-magic-copy-ui],input,textarea,[contenteditable="true"]')) return null;
    return sel;
  }

  function run() {
    var sel = currentSelection();
    if (!sel) { flash('没有选中内容', true); return; }
    var md = '';
    try {
      md = window.MagicCopyMD.fromSelection(sel, mdOpts());
    } catch (e) {
      console.error('[magic-copy] 转换失败', e);
      flash('转换失败，看控制台', true);
      return;
    }
    if (!md.trim()) { flash('选中的内容转不出 Markdown', true); return; }
    if (OPTS.trailingSource) md += '\n\n> 来源：' + location.href;

    copyText(md).then(function () {
      hideBar();
      flash('已复制为 Markdown ✓');
    }).catch(function (e) {
      console.error('[magic-copy] 写剪贴板失败', e);
      flash('写剪贴板失败', true);
    });
  }

  /* ------------------------------ 事件 ------------------------------ */

  var pending = null;

  function scheduleBar() {
    clearTimeout(pending);
    pending = setTimeout(function () {
      if (!OPTS.enabled || !OPTS.showButton) return;
      var sel = currentSelection();
      if (!sel) { hideBar(); return; }
      var rects = sel.getRangeAt(sel.rangeCount - 1).getClientRects();
      var rect = rects.length ? rects[rects.length - 1] : sel.getRangeAt(0).getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) { hideBar(); return; }
      showBarFor(rect);
    }, 10);
  }

  document.addEventListener('mouseup', scheduleBar, true);
  document.addEventListener('keyup', function (e) {
    if (e.shiftKey || e.key === 'Shift' || (e.key || '').indexOf('Arrow') === 0) scheduleBar();
  }, true);
  document.addEventListener('selectionchange', function () {
    if (!currentSelection()) hideBar();
  });
  document.addEventListener('mousedown', function (e) {
    if (!bar || !bar.classList.contains('show')) return;
    if (e.target && e.target.closest && e.target.closest('[data-magic-copy-ui]')) return;
    hideBar();
  }, true);
  window.addEventListener('scroll', hideBar, true);
  window.addEventListener('resize', hideBar);

  document.addEventListener('keydown', function (e) {
    if (!OPTS.enabled || !OPTS.hotkey) return;
    // ⌥⇧C / Alt+Shift+C —— 用 e.code 判，免得 Option 键把字符改成 Ç
    if (e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyC') {
      if (!currentSelection()) return;
      e.preventDefault();
      e.stopPropagation();
      run();
    }
    if (e.key === 'Escape') hideBar();
  }, true);

  loadOpts();
})();
