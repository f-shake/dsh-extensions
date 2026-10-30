package com.fshake.dshremote.web

import android.content.Context
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * 老 WebView 的兼容垫片。
 *
 * DSH 前端用了 Array.prototype.at、Object.hasOwn 等较新的 API（分别要 Chrome 92 / 93），
 * 国产 ROM 的系统 WebView 常年停留在出厂版本，缺这些 API 时页面会「闪一下 logo 再空白」，
 * 且不报任何可见错误。这里在页面脚本执行前补齐缺失的方法，缺什么补什么，新版 WebView 上等于空操作。
 */
object WebCompat {

    val documentStartScript: String = """
(function () {
  function def(target, name, fn) {
    if (!target[name]) {
      Object.defineProperty(target, name, { value: fn, writable: true, configurable: true });
    }
  }
  def(Array.prototype, 'at', function (i) {
    var n = this.length;
    if (n === 0) return undefined;
    i = Math.trunc(i) || 0;
    if (i < 0) i += n;
    return (i < 0 || i >= n) ? undefined : this[i];
  });
  def(String.prototype, 'at', function (i) {
    var s = String(this), n = s.length;
    i = Math.trunc(i) || 0;
    if (i < 0) i += n;
    return (i < 0 || i >= n) ? undefined : s.charAt(i);
  });
  def(Object, 'hasOwn', function (o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
  });
  def(Object, 'fromEntries', function (iterable) {
    var out = {};
    var entries = Array.isArray(iterable) ? iterable : Array.from(iterable);
    for (var i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
    return out;
  });
  def(Array.prototype, 'findLast', function (fn, thisArg) {
    for (var i = this.length - 1; i >= 0; i--) {
      if (fn.call(thisArg, this[i], i, this)) return this[i];
    }
    return undefined;
  });
  def(Array.prototype, 'findLastIndex', function (fn, thisArg) {
    for (var i = this.length - 1; i >= 0; i--) {
      if (fn.call(thisArg, this[i], i, this)) return i;
    }
    return -1;
  });
  def(String.prototype, 'replaceAll', function (pattern, replacement) {
    if (pattern instanceof RegExp) {
      if (!pattern.global) throw new TypeError('replaceAll must be called with a global RegExp');
      return this.replace(pattern, replacement);
    }
    var source = String(this);
    if (typeof replacement === 'function') {
      var escaped = String(pattern).replace(/[.*+?^${'$'}{}()|[\]\\]/g, '\\${'$'}&');
      return source.replace(new RegExp(escaped, 'g'), replacement);
    }
    return source.split(String(pattern)).join(String(replacement));
  });
  if (!window.__dshRemoteDiag) {
    window.__dshRemoteDiag = true;
    window.addEventListener('error', function (event) {
      var message = (event && event.message) || (event && event.error && event.error.stack) || 'unknown error';
      console.error('[diag] uncaught: ' + message + ' @' + ((event && event.filename) || '') + ':' + ((event && event.lineno) || 0));
    });
    window.addEventListener('unhandledrejection', function (event) {
      var reason = event && event.reason;
      console.error('[diag] unhandled rejection: ' + ((reason && (reason.stack || reason.message)) || reason));
    });
  }
  var layoutFixTimer = null;
  var observerInstalled = false;
  var vhTimer = null;
  var vhForce = false;
  var vhSignature = '';
  var vhHeight = 0;

  // 页面里所有 calc(100vh - …) / min(400px, 50vh) / 100dvh 都是按视口高度算的。
  // 而这类 WebView 的初始包含块高度是 0（window.innerHeight 正常，100vh 却是 0），
  // 于是菜单、展开的命令详情、确认框这些「按视口定高」的浮层全部塌成 0 高，
  // 表现为「点了没反应」「展开了但什么都没有」。
  // 与其一个个认类名，这里直接把所有样式表里的视口高度单位改写成真实像素。
  function vhToPx(value, h) {
    return value.replace(/(\d*\.?\d+)(dvh|svh|vh)\b/g, function (match, num) {
      return Math.round((parseFloat(num) * h) / 100) + 'px';
    });
  }

  // 样式表没变化、视口高度也没变化时，没必要再走一遍（这一趟要扫四千多条规则）。
  // @import 进来的表也算进来，否则它加载完成不会改变签名，里面的 vh 永远修不到。
  // 防环靠 depth：import 图最多两三层，走到头自然停，不用额外记已访问的表。
  function countRules(rules, depth) {
    var n = 0;
    for (var i = 0; i < rules.length; i++) {
      n++;
      if (depth <= 0) continue;
      var rule = rules[i];
      if (rule.cssRules) {
        n += countRules(rule.cssRules, depth - 1);
      } else if (rule.styleSheet) {
        try { n += countRules(rule.styleSheet.cssRules, depth - 1); } catch (e) { }
      }
    }
    return n;
  }

  function stylesheetSignature() {
    var sheets = 0;
    var rules = 0;
    for (var i = 0; i < document.styleSheets.length; i++) {
      var sheet = document.styleSheets[i];
      // 自己写的那张覆盖样式不算，否则每写一次签名就变一次，白跑一轮
      if (sheet.ownerNode && sheet.ownerNode.id === 'dsh-remote-vh') continue;
      sheets++;
      try { rules += countRules(sheet.cssRules, 4); } catch (e) { }
    }
    return sheets + ':' + rules;
  }

  function rebuildViewportUnits(force) {
    if (!document.head) return;
    var h = Math.round(window.innerHeight || 0);
    if (h <= 0) return;
    var signature = stylesheetSignature();
    if (!force && h === vhHeight && signature === vhSignature) return;
    var parts = [];
    // 媒体条件按层包起来，避免 sheet 的 media 和内层 @media 互相覆盖
    function wrap(css, conditions) {
      var out = css;
      for (var i = conditions.length - 1; i >= 0; i--) out = '@media ' + conditions[i] + '{' + out + '}';
      return out;
    }
    function walk(rules, conditions) {
      for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        // 原生 CSS 嵌套里的相对选择器不能直接搬到顶层，跳过
        if (rule.parentRule && rule.parentRule.type === 1) continue;
        if (rule.style) {
          var decls = '';
          for (var j = 0; j < rule.style.length; j++) {
            var name = rule.style[j];
            var value = rule.style.getPropertyValue(name);
            if (!/\d(dvh|svh|vh)\b/.test(value)) continue;
            // 别碰字符串和 url() 里的字样
            if (/url\(|["']/i.test(value)) continue;
            decls += name + ':' + vhToPx(value, h) + ' !important;';
          }
          if (decls && rule.selectorText) parts.push(wrap(rule.selectorText + '{' + decls + '}', conditions));
        }
        if (rule.cssRules) {
          // @media 保留条件，@supports 之类的丢弃条件（它本来就是靠检测视口单位才生效的）
          walk(rule.cssRules, rule.media ? conditions.concat([rule.media.mediaText]) : conditions);
        } else if (rule.styleSheet) {
          // @import 进来的表
          var next = rule.media && rule.media.mediaText ? conditions.concat([rule.media.mediaText]) : conditions;
          try { walk(rule.styleSheet.cssRules, next); } catch (e) { }
        }
      }
    }
    for (var s = 0; s < document.styleSheets.length; s++) {
      var sheet = document.styleSheets[s];
      if (sheet.disabled) continue;
      if (sheet.ownerNode && sheet.ownerNode.id === 'dsh-remote-vh') continue;
      var rules = null;
      try { rules = sheet.cssRules; } catch (e) { rules = null; }
      var conditions = sheet.media && sheet.media.mediaText ? [sheet.media.mediaText] : [];
      if (rules) walk(rules, conditions);
    }
    var style = document.getElementById('dsh-remote-vh');
    if (!style) {
      style = document.createElement('style');
      style.id = 'dsh-remote-vh';
      document.head.appendChild(style);
    }
    style.textContent = parts.join('\n');
    // 这张表必须排在 head 末尾：插件后注入的样式也带 !important，
    // 同优先级时靠文档顺序决胜，留在前面就会被插件里的 100dvh 兜底值压回去
    // （实测：设置弹窗 max-height 被算成 0，整框塌掉）。
    if (style.parentNode !== document.head || style !== document.head.lastElementChild) {
      document.head.appendChild(style);
    }
    vhSignature = signature;
    vhHeight = h;
  }

  function scheduleViewportUnits(force) {
    if (force) vhForce = true;
    if (vhTimer) return;
    vhTimer = setTimeout(function () {
      vhTimer = null;
      var forced = vhForce;
      vhForce = false;
      rebuildViewportUnits(forced);
    }, 300);
  }

  // 初始包含块高度是 0 的那类 WebView，html/body/#root 必须显式钉到真实像素。
  // 键盘让位（终局高度、动画）由原生侧负责，视口只在 resize 那一刻变一次，
  // 所以这里只要在真正变化时重钉一遍，不需要逐帧追。
  var pinnedHeight = 0;

  function pinLayoutHeight(force) {
    if (!document.head) return;
    var h = Math.round(window.innerHeight || 0);
    if (h <= 0) return;
    if (!force && h === pinnedHeight) return;
    pinnedHeight = h;
    var px = h + 'px';
    var style = document.getElementById('dsh-remote-layout-fix');
    if (!style) {
      style = document.createElement('style');
      style.id = 'dsh-remote-layout-fix';
      document.head.appendChild(style);
      style.textContent = 'html,body,#root{height:100%}';
    }
    var nodes = [document.documentElement, document.body, document.getElementById('root')];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el || !el.style) continue;
      el.style.setProperty('height', px, 'important');
      el.style.setProperty('min-height', px, 'important');
    }
  }

  // 样式表扫描要走四千多条规则，不能每次 resize 都做；钉高度只是三次样式写入。
  function applyLayoutFix() {
    pinLayoutHeight(true);
    rebuildViewportUnits();
    installObserver();
  }

  // 只盯样式表注入：插件会陆续往 head 里塞 <style>，那之后要重算一次。
  // 绝对不能全量监听 body——聊天流式输出时每秒上千次变更，扫一遍就会卡。
  function installObserver() {
    if (observerInstalled || !document.body) return;
    observerInstalled = true;
    try {
      var observer = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var added = records[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var node = added[j];
            if (node.nodeType !== 1) continue;
            // 自己写的那两张表会被自己搬位置（appendChild 是先移除再插入），
            // 不排除掉的话每次移表都会再触发一轮四千多条规则的全量扫描。
            if (node.id === 'dsh-remote-vh' || node.id === 'dsh-remote-layout-fix') continue;
            var tag = node.tagName;
            if (tag === 'STYLE') {
              scheduleViewportUnits(true);
              return;
            }
            if (tag === 'LINK') {
              // <link> 插进来时样式还没下载完，得等它 load 完再扫一次
              try {
                var rescan = function () { scheduleViewportUnits(true); };
                node.addEventListener('load', rescan, { once: true });
                node.addEventListener('error', rescan, { once: true });
              } catch (e) { }
              scheduleViewportUnits(true);
              return;
            }
          }
        }
      });
      observer.observe(document.head, { childList: true, subtree: true });
      observer.observe(document.body, { childList: true });
    } catch (e) { }
  }

  window.addEventListener('resize', function () {
    // resize 事件已经是本帧最早能拿到新视口高度的时机，这里同步钉一次；
    // 样式表扫描照旧防抖，避免每次键盘开合都扫四千多条规则。
    pinLayoutHeight(false);
    if (layoutFixTimer) clearTimeout(layoutFixTimer);
    layoutFixTimer = setTimeout(applyLayoutFix, 300);
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function () {
      pinLayoutHeight(false);
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyLayoutFix);
  } else {
    applyLayoutFix();
  }
  [500, 1500, 3000, 6000].forEach(function (delay) { setTimeout(applyLayoutFix, delay); });
})();
""".trimIndent()

    /**
     * 页面内部状态探针：用来区分「DOM 根本没渲染」和「渲染了但看不见」。
     * 只在诊断时读取，不影响页面行为。
     */
    val probeScript: String = """
(function () {
  try {
    function rect(el) {
      if (!el) return null;
      var r = el.getBoundingClientRect();
      return { t: Math.round(r.top), l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) };
    }
    function info(el) {
      if (!el) return null;
      var cs = getComputedStyle(el);
      return {
        tag: el.tagName, cls: String(el.className || '').slice(0, 50),
        rect: rect(el), op: cs.opacity, disp: cs.display, vis: cs.visibility,
        pos: cs.position, z: cs.zIndex, bg: cs.backgroundColor
      };
    }
    var root = document.getElementById('root');
    var rootKids = root ? Array.prototype.slice.call(root.children, 0, 3).map(info) : [];
    var bodyKids = document.body ? Array.prototype.slice.call(document.body.children, 0, 5).map(info) : [];
    var all = document.querySelectorAll('*');
    var visible = 0;
    var biggest = null;
    var maxArea = 0;
    // 诊断用，只看前 1500 个就够判断白屏：整页 7000+ 节点全量度量会卡主线程
    var scanned = Math.min(all.length, 1500);
    for (var i = 0; i < scanned; i++) {
      var r = all[i].getBoundingClientRect();
      var cs = getComputedStyle(all[i]);
      if (r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.opacity !== '0' && cs.display !== 'none') visible++;
      var area = r.width * r.height;
      if (area > maxArea) { maxArea = area; biggest = all[i]; }
    }
    function at(x, y) {
      var e = document.elementFromPoint(x, y);
      return e ? (e.tagName + '.' + String(e.className || '').slice(0, 30)) : 'null';
    }
    var html = document.documentElement;
    var vv = window.visualViewport;
    return JSON.stringify({
      w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
      visualViewport: vv ? { w: Math.round(vv.width), h: Math.round(vv.height), s: Math.round(vv.scale * 100) / 100 } : null,
      htmlH: html.clientHeight,
      htmlCssH: getComputedStyle(html).height,
      htmlInline: html.getAttribute('style') || '',
      bodyH: document.body ? document.body.clientHeight : -1,
      rootH: root ? Math.round(root.getBoundingClientRect().height) : -1,
      rootCssH: root ? getComputedStyle(root).height : '',
      rootInline: root ? (root.getAttribute('style') || '') : '',
      bodyInline: document.body ? (document.body.getAttribute('style') || '') : '',
      bodyCssH: document.body ? getComputedStyle(document.body).height : '',
      bodyDisp: document.body ? getComputedStyle(document.body).display : '',
      bodyPos: document.body ? getComputedStyle(document.body).position : '',
      biggest: biggest ? info(biggest) : null,
      layoutFix: !!document.getElementById('dsh-remote-layout-fix'),
      total: all.length, visible: visible,
      rootKids: rootKids, bodyKids: bodyKids,
      atTopLeft: at(10, 10),
      atCenter: at(Math.floor(innerWidth / 2), Math.floor(innerHeight / 2)),
      atLower: at(Math.floor(innerWidth / 2), Math.floor(innerHeight * 0.85)),
      htmlClass: String(html.className || '').slice(0, 60),
      htmlTheme: html.getAttribute('data-theme') || '',
      colorScheme: getComputedStyle(html).colorScheme,
      scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
      bodyFont: getComputedStyle(document.body).fontSize,
      textLen: document.body ? document.body.innerText.length : -1
    });
  } catch (e) { return 'probe-error:' + e; }
})();
""".trimIndent()

    /** 量一次真实的 100vh：为 0 说明布局视口被缓存成了 0，需要重载。 */
    val viewportProbeScript: String = """(function () {
  try {
    var probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:100vh';
    document.body.appendChild(probe);
    var vh = probe.offsetHeight;
    probe.parentNode.removeChild(probe);
    return vh;
  } catch (e) { return -1; }
})();
""".trimIndent()

    /**
     * 点「诊断信息」时现场跑一次：看视口单位是否可用，以及页面上那个菜单浮层的实际尺寸。
     */
    val liveProbeScript: String = """
(function () {
  try {
    function measure(unit) {
      var probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:' + unit;
      document.body.appendChild(probe);
      var h = probe.offsetHeight;
      probe.parentNode.removeChild(probe);
      return h;
    }
    var fixStyle = document.getElementById('dsh-remote-layout-fix');
    var vhStyle = document.getElementById('dsh-remote-vh');
    var surface = document.querySelector('div[class*="_surface"][class*="_menu"]');
    var surfaceInfo = null;
    if (surface) {
      var out = [];
      (function scan(el, depth) {
        if (out.length >= 8) return;
        var cs = getComputedStyle(el);
        var r = el.getBoundingClientRect();
        out.push({
          d: depth, cls: String(el.className || '').slice(0, 30), tag: el.tagName,
          h: Math.round(r.height), w: Math.round(r.width),
          cssH: cs.height, maxH: cs.maxHeight, minH: cs.minHeight,
          pad: cs.paddingTop + '/' + cs.paddingBottom, ov: cs.overflowY, disp: cs.display
        });
        if (depth < 3) {
          for (var i = 0; i < el.children.length; i++) scan(el.children[i], depth + 1);
        }
      })(surface, 0);
      surfaceInfo = out;
    }
    var root = document.getElementById('root');
    return JSON.stringify({
      vh: measure('100vh'), innerH: innerHeight,
      rootH: root ? Math.round(root.getBoundingClientRect().height) : -1,
      surface: surfaceInfo,
      fixText: fixStyle ? fixStyle.textContent.slice(0, 80) : null,
      vhDecls: vhStyle ? (vhStyle.textContent.match(/!important/g) || []).length : -1
    });
  } catch (e) { return 'live-probe-error:' + e; }
})();
""".trimIndent()

    fun webViewVersion(context: Context): String = try {
        val packageInfo = WebViewCompat.getCurrentWebViewPackage(context)
        if (packageInfo == null) {
            "未知"
        } else {
            "${packageInfo.packageName} ${packageInfo.versionName}"
        }
    } catch (_: Exception) {
        "未知"
    }

    fun supportsDocumentStartScript(): Boolean = try {
        WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
    } catch (_: Exception) {
        false
    }
}
