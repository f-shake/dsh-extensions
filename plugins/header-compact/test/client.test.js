import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * client.js 是给 `window.__ModuleLoader__` 用的普通脚本，不是 ESM 模块。
 * 这里用 `new Function` 把一个假的 window 传进去执行它，再取 factory 的返回值——
 * 测的就是真正会被浏览器加载的那份代码。
 * @param {object} [win] - 需要额外提供的 window 成员（matchMedia 等）。
 * @returns {{ plugin: object, window: object }} 插件对象与那个假 window。
 */
function loadPlugin(win = {}) {
  const loaded = [];
  const fakeWindow = { __ModuleLoader__: { load: (module) => loaded.push(module) }, ...win };
  const source = readFileSync(fileURLToPath(new URL("../client.js", import.meta.url)), "utf8");
  new Function("window", source)(fakeWindow);
  assert.equal(loaded.length, 1, "client.js 应该注册一个模块");
  assert.equal(loaded[0].id, "@local/header-compact");
  return { plugin: loaded[0].factory(), window: fakeWindow };
}

/** 假文本节点。 */
function makeText(value) {
  return { nodeType: 3, nodeValue: value, isConnected: true, parentElement: null };
}

/** 拆一个 `tag[attr]` 或 `[attr]` 选择器。 */
function parseSelector(selector) {
  const attributeOnly = /^\[([\w-]+)\]$/.exec(selector);
  if (attributeOnly !== null) return { tag: null, attribute: attributeOnly[1] };
  const withTag = /^([a-z]+)\[([\w-]+)\]$/.exec(selector);
  if (withTag === null) throw new Error(`unexpected selector: ${selector}`);
  return { tag: withTag[1].toUpperCase(), attribute: withTag[2] };
}

/** 从根节点向下找符合选择器的元素（被测代码只用属性选择器）。 */
function select(root, selector) {
  const { tag, attribute } = parseSelector(selector);
  const found = [];
  const walk = (node) => {
    for (const child of node.childNodes ?? []) {
      if (child.nodeType !== 1) continue;
      if (child.hasAttribute(attribute) && (tag === null || child.tagName === tag)) found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

/** 假元素节点：只实现被测代码用到的那几个接口。 */
function makeElement(tag, children = [], attributes = {}) {
  const attrs = new Map(Object.entries(attributes));
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    isConnected: true,
    removed: false,
    dataset: {},
    textContent: "",
    childNodes: children,
    parentElement: null,
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    setAttribute: (name, value) => {
      attrs.set(name, String(value));
    },
    hasAttribute: (name) => attrs.has(name),
    matches(selector) {
      const { tag: wanted, attribute } = parseSelector(selector);
      return node.hasAttribute(attribute) && (wanted === null || node.tagName === wanted);
    },
    querySelector(selector) {
      return select(node, selector)[0] ?? null;
    },
    querySelectorAll: (selector) => select(node, selector),
    contains(candidate) {
      let found = false;
      const walk = (current) => {
        if (current === candidate) found = true;
        for (const child of current.childNodes ?? []) {
          if (found) return;
          walk(child);
        }
      };
      walk(node);
      return found;
    },
    appendChild(child) {
      node.childNodes.push(child);
      child.parentElement = node;
      return child;
    },
    remove() {
      node.removed = true;
      node.isConnected = false;
    },
  };
  for (const child of children) child.parentElement = node;
  return node;
}

/**
 * 造一条会话标题行：子智能体按钮、后台任务按钮、一个「更多操作」按钮（不该被碰）。
 * @returns {object} 行与行内各个节点。
 */
function headerRow() {
  const subLabel = makeText("3 个子智能体");
  const subButton = makeElement(
    "button",
    [
      makeElement("span", [makeElement("svg", [])]),
      makeElement("span", [subLabel]),
      makeElement("svg", []),
    ],
    { "aria-label": "3 个子智能体，正在运行" },
  );
  const jobLabel = makeText("1 个后台任务运行中");
  const jobButton = makeElement(
    "button",
    [
      makeElement("span", [makeElement("svg", [])]),
      makeElement("span", [jobLabel]),
      makeElement("svg", []),
    ],
    { "aria-label": "1 个后台任务运行中" },
  );
  const moreLabel = makeText("更多操作");
  const more = makeElement("button", [moreLabel], { "aria-label": "更多操作" });
  const row = makeElement("div", [subButton, jobButton, more]);
  return { row, subButton, subLabel, jobButton, jobLabel, more, moreLabel };
}

/** 干净的登记簿。 */
function newOriginals() {
  return { texts: new Map(), labels: new Map() };
}

test("中文计数文案：可见文案换成数量后置的短写法", () => {
  const { plugin } = loadPlugin();
  const { shortenCountLabel } = plugin.internals;
  assert.equal(shortenCountLabel("3 个子智能体", false), "智能体 3");
  assert.equal(shortenCountLabel("1 个后台任务", false), "后台 1");
  assert.equal(shortenCountLabel("3 个子智能体，正在运行", false), "智能体 3");
  assert.equal(shortenCountLabel("1 个后台任务运行中", false), "后台 1");
});

test("中文计数文案：aria 保留运行后缀，标点沿用原文", () => {
  const { plugin } = loadPlugin();
  const { shortenCountLabel } = plugin.internals;
  assert.equal(shortenCountLabel("3 个子智能体，正在运行", true), "智能体 3，正在运行");
  assert.equal(shortenCountLabel("1 个后台任务运行中", true), "后台 1 运行中");
  assert.equal(shortenCountLabel("3 个子智能体", true), "智能体 3");
});

test("数量与「个」之间没有空格、以及多位数都认", () => {
  const { plugin } = loadPlugin();
  const { shortenCountLabel } = plugin.internals;
  assert.equal(shortenCountLabel("12个后台任务", false), "后台 12");
  assert.equal(shortenCountLabel("0 个子智能体", false), "智能体 0");
  assert.equal(shortenCountLabel("999 个子智能体", false), "智能体 999");
});

test("英文只换名词、保持英文自身语序与单复数", () => {
  const { plugin } = loadPlugin();
  const { shortenCountLabel } = plugin.internals;
  assert.equal(shortenCountLabel("1 subagent", true), "1 agent");
  assert.equal(shortenCountLabel("3 subagents", true), "3 agents");
  assert.equal(shortenCountLabel("3 subagents running", true), "3 agents running");
  assert.equal(shortenCountLabel("3 subagents running", false), "3 agents");
  assert.equal(shortenCountLabel("1 background job", true), "1 job");
  assert.equal(shortenCountLabel("3 background jobs", true), "3 jobs");
  assert.equal(shortenCountLabel("2 background jobs running", true), "2 jobs running");
});

test("不认识的内容一律返回 null，交给调用方原样不动", () => {
  const { plugin } = loadPlugin();
  const { shortenCountLabel } = plugin.internals;
  for (const text of ["更多操作", "3 个文件", "", "  ", "智能体 3", "后台 1", "dsh-nas", "3 个后台任务已结束"]) {
    assert.equal(shortenCountLabel(text, true), null, `不该改：${JSON.stringify(text)}`);
  }
  assert.equal(shortenCountLabel(undefined, true), null);
  assert.equal(shortenCountLabel(null, false), null);
});

test("重复收紧是幂等的：短文案不会被再改一次", () => {
  const { plugin } = loadPlugin();
  const { shortenCountLabel } = plugin.internals;
  const once = shortenCountLabel("3 个子智能体", false);
  assert.equal(shortenCountLabel(once, false), null);
});

test("改写标题行：两个计数按钮变短，图标与不相干的按钮不动", () => {
  const { plugin } = loadPlugin();
  const { patchHeader } = plugin.internals;
  const { row, subButton, subLabel, jobButton, jobLabel, moreLabel } = headerRow();
  const originals = newOriginals();

  patchHeader(row, originals);

  assert.equal(subLabel.nodeValue, "智能体 3");
  assert.equal(jobLabel.nodeValue, "后台 1");
  assert.equal(subButton.getAttribute("aria-label"), "智能体 3，正在运行");
  assert.equal(jobButton.getAttribute("aria-label"), "后台 1 运行中");
  assert.equal(subButton.childNodes.length, 3, "按钮的子节点结构不该被换掉");
  assert.equal(moreLabel.nodeValue, "更多操作", "不相干的按钮必须原样");
});

test("改写后再收紧一遍不会重复登记，也不会把短文案改坏", () => {
  const { plugin } = loadPlugin();
  const { patchHeader } = plugin.internals;
  const { row, subLabel } = headerRow();
  const originals = newOriginals();

  patchHeader(row, originals);
  patchHeader(row, originals);

  assert.equal(subLabel.nodeValue, "智能体 3");
  assert.equal(originals.texts.size, 2);
  assert.equal(originals.labels.size, 2);
});

test("还原逐字写回原文，含运行后缀", () => {
  const { plugin } = loadPlugin();
  const { patchHeader, restoreHeader } = plugin.internals;
  const { row, subButton, subLabel, jobButton, jobLabel } = headerRow();
  const originals = newOriginals();

  patchHeader(row, originals);
  restoreHeader(originals);

  assert.equal(subLabel.nodeValue, "3 个子智能体");
  assert.equal(jobLabel.nodeValue, "1 个后台任务运行中");
  assert.equal(subButton.getAttribute("aria-label"), "3 个子智能体，正在运行");
  assert.equal(jobButton.getAttribute("aria-label"), "1 个后台任务运行中");
  assert.equal(originals.texts.size, 0);
});

test("节点已被换掉时还原跳过，不写回脱离文档的节点", () => {
  const { plugin } = loadPlugin();
  const { patchHeader, restoreHeader } = plugin.internals;
  const { row, subButton, subLabel } = headerRow();
  const originals = newOriginals();

  patchHeader(row, originals);
  subLabel.isConnected = false;
  restoreHeader(originals);

  assert.equal(subLabel.nodeValue, "智能体 3", "脱离文档的节点不该被写回");
  assert.equal(subButton.getAttribute("aria-label"), "3 个子智能体，正在运行");
});

test("切换会话后登记簿剪掉脱离文档的节点，在文档里的留着", () => {
  const { plugin } = loadPlugin();
  const { patchHeader, pruneHeader } = plugin.internals;
  const { row, subLabel, jobButton, jobLabel } = headerRow();
  const originals = newOriginals();

  patchHeader(row, originals);
  assert.equal(originals.texts.size, 2);
  subLabel.isConnected = false;
  jobButton.isConnected = false;
  pruneHeader(originals);

  assert.equal(originals.texts.has(subLabel), false, "卸载掉的标题行不该继续占着登记簿");
  assert.equal(originals.labels.has(jobButton), false);
  assert.equal(originals.texts.has(jobLabel), true, "还在文档里的节点要留着，之后好还原");
});

test("样式只动会话标题行里的「在本地打开」，且限定手机宽度", () => {
  const { plugin } = loadPlugin();
  const { css } = plugin.internals;
  assert.match(css, /max-width: 767\.98px/);
  assert.match(css, /\[data-conversation-header-corner\]/);
  assert.match(css, /\[data-open-target="directory"\]/);
  assert.match(css, /display: none !important/);
});

/** 装一套假环境，供 installHeaderCompact 的整合测试用。 */
function fakeEnvironment() {
  const { row, ...nodes } = headerRow();
  const corner = makeElement("div", [], { "data-conversation-header-corner": "" });
  corner.parentElement = row;
  const listeners = [];
  const mql = {
    matches: true,
    addEventListener: (type, handler) => listeners.push(handler),
    removeEventListener: (type, handler) => {
      const index = listeners.indexOf(handler);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
  const instances = [];
  class FakeObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      instances.push(this);
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
    /** 模拟浏览器把一批变更记录送进来。 */
    emit(records) {
      if (!this.disconnected) this.callback(records);
    }
  }
  const head = makeElement("head", []);
  const doc = {
    body: makeElement("body", [row]),
    head,
    style: null,
    querySelector: () => doc.style,
    querySelectorAll: (selector) => (selector === "[data-conversation-header-corner]" ? [corner] : []),
    createElement: (tag) => makeElement(tag, []),
  };
  const frames = new Map();
  const cancelled = [];
  let nextFrame = 1;
  const window = {
    matchMedia: () => mql,
    requestAnimationFrame: (callback) => {
      const id = nextFrame;
      nextFrame += 1;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id) => {
      cancelled.push(id);
      frames.delete(id);
    },
  };
  return {
    ...nodes,
    row,
    corner,
    listeners,
    mql,
    doc,
    head,
    window,
    instances,
    frames,
    cancelled,
    FakeObserver,
    observer: () => instances[instances.length - 1],
    queued: () => frames.size,
    /** 执行排队中的帧，模拟浏览器下一次绘制。 */
    flush() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback();
    },
  };
}

/** 一条只带目标节点的 DOM 变化记录。 */
function record(target, extra = {}) {
  return { target, addedNodes: [], removedNodes: [], ...extra };
}

/** 在假 document/MutationObserver 下跑一段，跑完还原全局。 */
function withEnvironment(env, run) {
  const previousDocument = globalThis.document;
  const previousObserver = globalThis.MutationObserver;
  globalThis.document = env.doc;
  globalThis.MutationObserver = env.FakeObserver;
  try {
    run();
  } finally {
    globalThis.document = previousDocument;
    globalThis.MutationObserver = previousObserver;
  }
}

test("窄屏时装上就收紧，跨回宽屏还原，再进窄屏重新收紧", () => {
  const env = fakeEnvironment();
  withEnvironment(env, () => {
    const { plugin } = loadPlugin(env.window);
    const dispose = plugin.internals.installHeaderCompact();

    assert.equal(env.subLabel.nodeValue, "智能体 3");
    assert.equal(env.jobLabel.nodeValue, "后台 1");
    assert.equal(env.subButton.getAttribute("aria-label"), "智能体 3，正在运行");

    env.mql.matches = false;
    for (const listener of [...env.listeners]) listener();
    assert.equal(env.subLabel.nodeValue, "3 个子智能体");
    assert.equal(env.jobLabel.nodeValue, "1 个后台任务运行中");

    env.mql.matches = true;
    for (const listener of [...env.listeners]) listener();
    assert.equal(env.subLabel.nodeValue, "智能体 3");

    dispose();
    assert.equal(env.subLabel.nodeValue, "3 个子智能体", "卸载要把文案还回去");
    assert.equal(env.observer().disconnected, true, "卸载要断开观察器");
    assert.equal(env.listeners.length, 0, "卸载要摘掉阈值监听");
  });
});

test("宽屏启动时一个字都不改", () => {
  const env = fakeEnvironment();
  env.mql.matches = false;
  withEnvironment(env, () => {
    const { plugin } = loadPlugin(env.window);
    const dispose = plugin.internals.installHeaderCompact();
    assert.equal(env.subLabel.nodeValue, "3 个子智能体");
    assert.equal(env.jobLabel.nodeValue, "1 个后台任务运行中");
    dispose();
    assert.equal(env.subLabel.nodeValue, "3 个子智能体");
  });
});

test("环境缺 matchMedia 时只返回 disposer，不改任何文案", () => {
  const env = fakeEnvironment();
  withEnvironment(env, () => {
    const { plugin } = loadPlugin({});
    const dispose = plugin.internals.installHeaderCompact();
    assert.equal(typeof dispose, "function");
    assert.equal(env.subLabel.nodeValue, "3 个子智能体");
    dispose();
    assert.equal(env.subLabel.nodeValue, "3 个子智能体");
  });
});

test("apply 注册样式与标题行两项，卸载时样式表被摘掉", () => {
  const env = fakeEnvironment();
  withEnvironment(env, () => {
    const { plugin } = loadPlugin(env.window);
    const effects = [];
    const ctx = {
      effect(factory) {
        effects.push(factory());
      },
    };
    plugin.apply(ctx);
    assert.equal(effects.length, 2, "样式与标题行各挂一次");
    assert.equal(env.head.childNodes.length, 1, "样式表应该挂到 head 上");
    assert.match(env.head.childNodes[0].textContent, /data-conversation-header-corner/);
    assert.equal(env.subLabel.nodeValue, "智能体 3");

    for (const dispose of effects) dispose();
    assert.equal(env.head.childNodes[0].removed, true, "卸载要摘掉样式表");
    assert.equal(env.subLabel.nodeValue, "3 个子智能体");
  });
});

test("宿主改写文案后观察器再收紧一次，还原用的是最新原文", () => {
  const env = fakeEnvironment();
  withEnvironment(env, () => {
    const { plugin } = loadPlugin(env.window);
    const dispose = plugin.internals.installHeaderCompact();
    assert.equal(env.subLabel.nodeValue, "智能体 3");

    // 模拟宿主重新渲染：React 把新的长文案写回同一个文本节点。
    env.subLabel.nodeValue = "4 个子智能体";
    env.observer().emit([record(env.subLabel)]);
    env.flush();
    assert.equal(env.subLabel.nodeValue, "智能体 4");

    dispose();
    assert.equal(env.subLabel.nodeValue, "4 个子智能体", "还原要写回最新的原文，不是登记的旧值");
  });
});

test("与标题行无关的 DOM 变化不排帧", () => {
  const env = fakeEnvironment();
  withEnvironment(env, () => {
    const { plugin } = loadPlugin(env.window);
    const dispose = plugin.internals.installHeaderCompact();
    const outside = makeElement("div", [makeText("模型在这里流式输出")]);

    env.observer().emit([record(outside)]);
    assert.equal(env.queued(), 0, "聊天区变化不该触发标题行扫描");

    dispose();
  });
});

test("同一帧内的多次变化只排一次帧", () => {
  const env = fakeEnvironment();
  withEnvironment(env, () => {
    const { plugin } = loadPlugin(env.window);
    const dispose = plugin.internals.installHeaderCompact();

    env.observer().emit([record(env.subLabel)]);
    env.observer().emit([record(env.jobLabel)]);
    assert.equal(env.queued(), 1, "两次变化应合并成一帧");

    env.flush();
    assert.equal(env.queued(), 0);
    dispose();
  });
});

test("新增带标题行标记的子树会重新扫描", () => {
  const env = fakeEnvironment();
  withEnvironment(env, () => {
    const { plugin } = loadPlugin(env.window);
    const dispose = plugin.internals.installHeaderCompact();

    // 目标容器与标题行无关，靠「新增子树里带标记」这一条分支才该排帧；
    // 若这里退化成 body，related 会在第一行就短路，这条测试就空转了。
    const elsewhere = makeElement("div", [makeText("聊天区")]);
    const fresh = makeElement("div", [makeElement("div", [], { "data-conversation-header-corner": "" })]);
    env.observer().emit([record(elsewhere, { addedNodes: [fresh] })]);
    assert.equal(env.queued(), 1, "换标题行时必须重扫");

    env.flush();
    dispose();
  });
});

test("标题行祖先容器发生变化时也重扫", () => {
  const env = fakeEnvironment();
  withEnvironment(env, () => {
    const { plugin } = loadPlugin(env.window);
    const dispose = plugin.internals.installHeaderCompact();

    const wrapper = makeElement("div", [env.row]);
    env.observer().emit([record(wrapper)]);
    assert.equal(env.queued(), 1, "外面套了一层容器也要重扫");

    env.flush();
    dispose();
  });
});

test("宽屏时不排帧，回到窄屏才收紧", () => {
  const env = fakeEnvironment();
  env.mql.matches = false;
  withEnvironment(env, () => {
    const { plugin } = loadPlugin(env.window);
    const dispose = plugin.internals.installHeaderCompact();

    env.observer().emit([record(env.subLabel)]);
    assert.equal(env.queued(), 0, "宽屏下不该为标题行做任何排帧");
    assert.equal(env.subLabel.nodeValue, "3 个子智能体");

    env.mql.matches = true;
    for (const listener of [...env.listeners]) listener();
    assert.equal(env.subLabel.nodeValue, "智能体 3");

    dispose();
    assert.equal(env.subLabel.nodeValue, "3 个子智能体");
  });
});

test("卸载时取消已排队的帧", () => {
  const env = fakeEnvironment();
  withEnvironment(env, () => {
    const { plugin } = loadPlugin(env.window);
    const dispose = plugin.internals.installHeaderCompact();

    env.observer().emit([record(env.subLabel)]);
    const [pending] = [...env.frames.keys()];
    dispose();

    assert.ok(env.cancelled.includes(pending), "排队的帧要被取消");
    assert.equal(env.queued(), 0);
  });
});

test("环境缺 MutationObserver 时静默不生效", () => {
  const env = fakeEnvironment();
  const previousDocument = globalThis.document;
  const previousObserver = globalThis.MutationObserver;
  globalThis.document = env.doc;
  globalThis.MutationObserver = undefined;
  try {
    const { plugin } = loadPlugin(env.window);
    const dispose = plugin.internals.installHeaderCompact();
    assert.equal(typeof dispose, "function");
    assert.equal(env.subLabel.nodeValue, "3 个子智能体");
    dispose();
    assert.equal(env.subLabel.nodeValue, "3 个子智能体");
  } finally {
    globalThis.document = previousDocument;
    globalThis.MutationObserver = previousObserver;
  }
});

test("只有 addListener 的旧接口也能收到阈值变化", () => {
  const env = fakeEnvironment();
  delete env.mql.addEventListener;
  delete env.mql.removeEventListener;
  env.mql.addListener = (handler) => env.listeners.push(handler);
  env.mql.removeListener = (handler) => {
    const index = env.listeners.indexOf(handler);
    if (index >= 0) env.listeners.splice(index, 1);
  };
  withEnvironment(env, () => {
    const { plugin } = loadPlugin(env.window);
    const dispose = plugin.internals.installHeaderCompact();
    assert.equal(env.subLabel.nodeValue, "智能体 3");

    env.mql.matches = false;
    for (const listener of [...env.listeners]) listener();
    assert.equal(env.subLabel.nodeValue, "3 个子智能体");

    dispose();
    assert.equal(env.listeners.length, 0, "卸载要摘掉旧接口的监听");
  });
});

test("已有同名样式表时不再重复插入，卸载也不动它", () => {
  const env = fakeEnvironment();
  const existing = makeElement("style", [], { "data-plugin-css": "header-compact" });
  env.doc.style = existing;
  withEnvironment(env, () => {
    const { plugin } = loadPlugin(env.window);
    const effects = [];
    plugin.apply({
      effect(factory) {
        effects.push(factory());
      },
    });
    assert.equal(env.head.childNodes.length, 0, "已有样式表时不该再插一份");
    assert.equal(existing.removed, false);

    for (const dispose of effects) dispose();
    assert.equal(existing.removed, false, "卸载不该摘掉别人挂的那份");
  });
});
