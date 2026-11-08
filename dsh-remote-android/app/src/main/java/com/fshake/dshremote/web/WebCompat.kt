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
  // 100vh 是否为 0：null 表示还没测到（body 未就绪时不能下结论）
  var vhBroken = null;
  // 上次判定时的视口高度：判定要落在 resize 热路径上，高度没变就不该重新量
  var vhBrokenAt = -1;
  // 是否已经往页面写过补丁：写过就继续维护，不因判定翻转而撒手
  var vhPatched = false;
  // 每条被改写的声明：key 是那条款式声明对象，值是各属性的原值与优先级。
  // 改写后值里就不含 vh 了，重算必须拿原值算，不能把 px 再按比例算一遍。
  var vhSeen = new WeakMap();
  var vhRules = [];

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
      if (sheet.disabled) continue;
      sheets++;
      try { rules += countRules(sheet.cssRules, 4); } catch (e) { }
    }
    return sheets + ':' + rules;
  }

  // 100vh 是否不可用：这类 WebView 的初始包含块高度是 0，算出来就是 0；
  // 也可能被缓存成旋转前的旧高度。两种都算「坏」——判据是「与 window.innerHeight 对不上」，
  // 健康设备上两者相等，于是下面所有改写都会跳过。
  // 每次视口高度变化才重新量：探针要读 offsetHeight，那是强制整页同步布局，
  // 而判定会被 resize / visualViewport.resize 连续调用（键盘动画、旋转）。
  function viewportBroken() {
    if (!document.body) return false;
    var inner = Math.round(window.innerHeight || 0);
    // 量不到视口（body 还没显出来）就沿用上次结论，别把「没量准」当成「健康」
    if (inner <= 0) return vhBroken === true;
    if (vhBroken !== null && inner === vhBrokenAt) return vhBroken;
    var probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:100vh';
    var measured = -1;
    try {
      document.body.appendChild(probe);
      measured = probe.offsetHeight;
    } catch (e) {
      measured = -1;
    }
    if (probe.parentNode) probe.parentNode.removeChild(probe);
    if (measured < 0) return vhBroken === true;
    vhBroken = Math.abs(measured - inner) > 1;
    vhBrokenAt = inner;
    return vhBroken;
  }

  // 判定只决定「要不要开始修」。一旦开始修就必须继续维护：
  // 中途某次判定翻回健康就撒手，会把页面冻结在误判那一刻的尺寸上（旋转、键盘后不再更新）。
  function needsViewportFix() {
    return vhPatched || viewportBroken();
  }

  // 就地改写声明，不再另插一张覆盖表：层叠顺序、媒体查询、@layer 全部保持页面原样。
  // 早先的做法是把带 vh 的规则抄进一张 !important 覆盖表，等于用桌面规则覆盖所有宽度，
  // 把窄屏的「全屏抽屉」压成了 800px 的居中弹窗（移动端那条 height:100% 被顶掉）。
  function trackDeclaration(style, prop, value, priority) {
    var record = vhSeen.get(style);
    if (!record) {
      record = {};
      vhSeen.set(style, record);
    }
    record[prop] = { value: value, priority: priority };
    for (var i = 0; i < vhRules.length; i++) {
      if (vhRules[i].style === style && vhRules[i].prop === prop) return;
    }
    vhRules.push({ style: style, prop: prop });
  }

  function scanViewportUnits() {
    // 记录这一轮还能看到的声明对象：页面重建样式表之后，旧对象再也写不进页面，
    // 留在 vhRules 里只会让每次 resize 越扫越长（旧表被整张替换时尤其明显）。
    var live = typeof Set === 'function' ? new Set() : null;
    function walk(rules) {
      for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        if (rule.style) {
          var style = rule.style;
          if (live) live.add(style);
          for (var j = 0; j < style.length; j++) {
            var name = style[j];
            var value = style.getPropertyValue(name);
            if (!/\d(dvh|svh|vh)\b/.test(value)) continue;
            // 别碰字符串和 url() 里的字样
            if (/url\(|["']/i.test(value)) continue;
            trackDeclaration(style, name, value, style.getPropertyPriority(name));
          }
        }
        if (rule.cssRules) walk(rule.cssRules);
        else if (rule.styleSheet) { try { walk(rule.styleSheet.cssRules); } catch (e) { } }
      }
    }
    for (var s = 0; s < document.styleSheets.length; s++) {
      var sheet = document.styleSheets[s];
      // disabled 的表也要登记：它只是暂时不生效（切主题常这么干），
      // 按「本轮是否可见」剪枝会把原值一起删掉，重新启用时就再也接不上了。
      var rules = null;
      try { rules = sheet.cssRules; } catch (e) { rules = null; }
      if (rules) walk(rules);
    }
    if (!live) return;
    var kept = [];
    for (var k = 0; k < vhRules.length; k++) {
      if (live.has(vhRules[k].style)) {
        kept.push(vhRules[k]);
      } else {
        vhSeen.delete(vhRules[k].style);
      }
    }
    vhRules = kept;
  }

  function applyViewportUnits(h) {
    for (var i = 0; i < vhRules.length; i++) {
      var entry = vhRules[i];
      var record = vhSeen.get(entry.style);
      var original = record && record[entry.prop];
      if (!original) continue;
      try {
        entry.style.setProperty(entry.prop, vhToPx(original.value, h), original.priority);
      } catch (e) { }
    }
  }

  function rewriteViewportUnits(force) {
    if (!document.head) return;
    // 视口单位本身正常时一个字节都不改：页面自己的响应式规则就是对的
    if (!needsViewportFix()) return;
    var h = Math.round(window.innerHeight || 0);
    if (h <= 0) return;
    var signature = stylesheetSignature();
    var scanned = false;
    if (force || signature !== vhSignature) {
      scanViewportUnits();
      vhSignature = signature;
      scanned = true;
    }
    if (!scanned && h === vhHeight) return;
    applyViewportUnits(h);
    vhHeight = h;
    if (vhRules.length > 0) vhPatched = true;
  }

  function scheduleViewportUnits(force) {
    if (force) vhForce = true;
    if (vhTimer) return;
    vhTimer = setTimeout(function () {
      vhTimer = null;
      var forced = vhForce;
      vhForce = false;
      rewriteViewportUnits(forced);
    }, 300);
  }

  // 初始包含块高度是 0 的那类 WebView，html/body/#root 必须显式钉到真实像素。
  // 键盘让位（终局高度、动画）由原生侧负责，视口只在 resize 那一刻变一次，
  // 所以这里只要在真正变化时重钉一遍，不需要逐帧追。
  var pinnedHeight = 0;

  function pinLayoutHeight(force) {
    if (!document.head || !document.body) return;
    // 只在 100vh 确实坏掉时才碰根节点：健康设备保持页面自己的布局
    if (!needsViewportFix()) return;
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
    }
    // body 必须是定位祖先：设置浮层挂在 body 下，规则是 position:absolute + height:100%。
    // 没有定位祖先时这个百分比对着「初始包含块」解析，而它在这类 WebView 里高度正是 0，
    // 于是浮层塌成 0 高、里面的面板再被 flex 垂直居中，屏幕上只剩下半截。
    var css = 'html,body,#root{height:100%}body{position:relative}';
    if (style.textContent !== css) style.textContent = css;
    var nodes = [document.documentElement, document.body, document.getElementById('root')];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el || !el.style) continue;
      el.style.setProperty('height', px, 'important');
      el.style.setProperty('min-height', px, 'important');
    }
    vhPatched = true;
  }

  // 样式表扫描要走四千多条规则，不能每次 resize 都做；改写声明只是几十次属性写入。
  function applyLayoutFix() {
    pinLayoutHeight(true);
    rewriteViewportUnits();
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
          var record = records[i];
          // <link> 原地换 href / 切 media 也是换了一张表，旧声明对象同样作废
          if (record.type === 'attributes') {
            scheduleViewportUnits(true);
            return;
          }
          // 页面原地重写 <style> 的内容（CSS-in-JS 换主题、重建样式表）：改写过的声明全被冲掉，必须重扫。
          // 这种改写只会产生文本节点变更，element 判断接不住。
          if (record.type === 'characterData' &&
              record.target.parentNode && record.target.parentNode.tagName === 'STYLE') {
            scheduleViewportUnits(true);
            return;
          }
          var added = record.addedNodes;
          for (var j = 0; j < added.length; j++) {
            var node = added[j];
            // 整体替换 textContent 时新加进来的是文本节点，同样意味着旧声明作废
            if (node.nodeType === 3 && node.parentNode && node.parentNode.tagName === 'STYLE') {
              scheduleViewportUnits(true);
              return;
            }
            if (node.nodeType !== 1) continue;
            // 自己写的那张表只创建一次，排除掉避免自触发一轮全量扫描
            if (node.id === 'dsh-remote-layout-fix') continue;
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
      observer.observe(document.head, {
        childList: true,
        subtree: true,
        characterData: true,
        // 只盯这三类属性：head 里的节点可能带很多无关属性，全量监听会白扫
        attributes: true,
        attributeFilter: ['href', 'media', 'disabled'],
      });
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
     * 返回键的第一优先级：关掉页面上最上层的浮层，返回关掉的层名（没有浮层时 `none`）。
     *
     * DSH 的对话框、菜单、候选面板都实现了 Escape 关闭（在 document/window 上监听，
     * 按各自的层栈只处理最上层），所以这里不逐个点关闭按钮，只在检测到浮层时派发一次
     * Escape；侧栏、右栏、浮动面板没有 Escape 语义，按各自的官方标记点关闭控件。
     *
     * 选择器取自 DSH 0.2.2 的官方实现（布局 / 侧栏 / 右栏 / dockkit），
     * 与 plugins/swipe-sidebar 用的是同一组标记。
     */
    val backDismissScript: String = """
(function () {
  try {
    function visible(el) {
      if (!el || !el.getClientRects().length) return false;
      var cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
    }
    function top(selector) {
      var list = document.querySelectorAll(selector);
      for (var i = list.length - 1; i >= 0; i--) {
        if (visible(list[i])) return list[i];
      }
      return null;
    }
    function pressEscape() {
      var target = document.activeElement || document.body || document.documentElement;
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
        bubbles: true, cancelable: true, composed: true
      }));
    }
    // 1) 下拉菜单 / 右键菜单：portal 到 body，层级最高。
    if (top('[role="menu"]') !== null) { pressEscape(); return 'menu'; }
    // 2) 输入框候选 / 命令面板：React 挂在输入元素上，事件必须派给焦点元素。
    if (top('[role="listbox"]') !== null) { pressEscape(); return 'listbox'; }
    // 3) 模态对话框；左侧抽屉也带 aria-modal，留到后面用抽屉自己的方式关。
    if (top('[role="dialog"][aria-modal="true"]:not([data-shortcut-modal="sidebar"])') !== null) {
      pressEscape(); return 'dialog';
    }
    // 4) 左侧抽屉：遮罩常驻，收起时 frame 带 data-sidebar-collapsed。
    var mask = document.querySelector('[data-sidebar-mask]');
    if (mask !== null) {
      var frame = mask.parentElement;
      if (frame === null || !frame.hasAttribute('data-sidebar-collapsed')) {
        mask.click();
        return 'drawer';
      }
    }
    // 5) 浮动面板：收回停靠，不销毁标签页内容。
    var float = top('[data-dockkit-float]');
    if (float !== null) {
      var dock = float.querySelector('[data-dockkit-float-dock]');
      if (dock !== null) { dock.click(); return 'float'; }
    }
    // 6) 手机上的全屏右侧栏；停靠/推挤形态属于布局，不算浮层。
    var panel = document.querySelector('[data-sidebar-right-panel="fullscreen"][data-sidebar-right-open]');
    if (panel !== null) {
      var close = panel.querySelector('[data-sidebar-right-toggle]') ||
        document.querySelector('[data-sidebar-right-toggle]');
      if (close !== null) { close.click(); return 'right'; }
    }
    return 'none';
  } catch (e) {
    return 'none';
  }
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
    var root = document.getElementById('root');
    function info(el) {
      var cs = getComputedStyle(el);
      var r = el.getBoundingClientRect();
      var cls = '';
      try { cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || ''); } catch (e) { }
      return {
        tag: el.tagName, cls: String(cls).slice(0, 36),
        t: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width),
        cssH: cs.height, maxH: cs.maxHeight, pos: cs.position, disp: cs.display,
        ai: cs.alignItems, jc: cs.justifyContent
      };
    }
    function chain(el, up) {
      var out = [];
      var cur = el;
      while (cur && cur.nodeType === 1 && out.length < up) {
        out.push(info(cur));
        cur = cur.parentElement;
      }
      return out;
    }
    function offsetChain(el) {
      var out = [];
      var cur = el;
      while (cur && out.length < 6) { out.push(info(cur)); cur = cur.offsetParent; }
      return out;
    }
    // 这两个类名来自 DSH 当前构建（CSS Modules 哈希），前端换一版就会查不到；
    // 查不到时返回 null，只影响这条诊断项，不影响页面。
    var overlay = document.querySelector('.VOzbGW_overlay');
    var panel = document.querySelector('.VOzbGW_panel');
    return JSON.stringify({
      vh: measure('100vh'), innerH: innerHeight, innerW: innerWidth,
      vv: window.visualViewport ? Math.round(window.visualViewport.height) : -1,
      viewW: document.documentElement.clientWidth,
      viewH: document.documentElement.clientHeight,
      rootH: root ? Math.round(root.getBoundingClientRect().height) : -1,
      htmlInline: document.documentElement.getAttribute('style'),
      overlay: overlay ? info(overlay) : null,
      panel: panel ? info(panel) : null,
      overlayOffsetChain: overlay ? offsetChain(overlay) : null,
      overlayParents: overlay ? chain(overlay, 4) : null,
      layoutFixText: fixStyle ? fixStyle.textContent : null
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
