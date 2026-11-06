import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 假元素：只实现手势判定用到的那些接口。 */
class FakeElement {
  /**
   * @param {object} [options] - 横向滚动区的尺寸与 overflow-x，或框架上的标记属性。
   * `directTable` 表示它的直接子节点是 `<table>`；`nestedTable` 表示表格只在其更深的某层
   * ——两者的区分正是被测代码 `:scope > table` 与 `table` 的区别。
   */
  constructor({ overflowX = "visible", scrollWidth = 0, clientWidth = 0, attrs = [], directTable = false, nestedTable = false } = {}) {
    this.scrollWidth = scrollWidth;
    this.clientWidth = clientWidth;
    this.scrollLeft = 0;
    this.style = { overflowX };
    this.attributes = new Set(attrs);
    this.parentElement = null;
    this.closestMatch = null;
    this.directTable = directTable;
    this.nestedTable = nestedTable;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  /** 被测代码只用它判断起点是不是输入框/可编辑区。 */
  closest() {
    return this.closestMatch;
  }

  /**
   * 被测代码只用它判断这一层是不是表格的直接包装。
   * 两种选择器分开答：`:scope > table` 只认直接子节点，`table` 任意后代都认——
   * 这样实现一旦放宽成祖先匹配，对应用例就会红。
   */
  querySelector(selector) {
    const found = this.directTable || this.nestedTable;
    if (selector === ":scope > table") return this.directTable ? {} : null;
    if (selector === "table") return found ? {} : null;
    return null;
  }

  /** 把自己挂到父节点下面，返回父节点，方便一串接一串地搭 DOM。 */
  appendTo(parent) {
    this.parentElement = parent;
    return parent;
  }
}

/** React 替身：effect 立刻执行，就当作一次挂载。 */
function fakeReact() {
  return {
    createElement: () => null,
    useRef: (value) => ({ current: value }),
    useEffect: (effect) => {
      effect();
    },
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useCallback: (callback) => callback,
  };
}

/**
 * client.js 是给 `window.__ModuleLoader__` 用的普通脚本，不是 ESM 模块。
 * 这里用假 window / document / Element 把它跑起来，拿到的就是浏览器里真正
 * 被加载的那份代码，而不是另抄一份手势逻辑。
 * @param {object} [options] - 覆盖默认的外壳状态。
 * @returns {{ plugin: object, handlers: Map<string, Function>, frame: FakeElement }}
 */
function loadPlugin({
  frameAttrs = ["data-msd-shell-frame", "data-sidebar-collapsed", "data-rightbar-collapsed"],
} = {}) {
  const loaded = [];
  const handlers = new Map();
  const frame = new FakeElement({ attrs: frameAttrs });
  const fakeDocument = {
    body: {},
    documentElement: new FakeElement(),
    querySelector(selector) {
      if (selector === "[data-msd-shell-frame]") return frame;
      return null;
    },
    addEventListener(type, handler) {
      handlers.set(type, handler);
    },
    removeEventListener(type) {
      handlers.delete(type);
    },
  };
  const fakeWindow = {
    __ModuleLoader__: { load: (module) => loaded.push(module) },
    innerWidth: 390,
    getComputedStyle: (node) => node.style,
    matchMedia: () => ({ matches: true }),
    requestAnimationFrame: (fn) => fn(),
    cancelAnimationFrame: () => {},
  };
  const source = readFileSync(fileURLToPath(new URL("../client.js", import.meta.url)), "utf8");
  new Function("window", "document", "Element", source)(fakeWindow, fakeDocument, FakeElement);
  assert.equal(loaded.length, 1, "client.js 应该注册一个模块");
  assert.equal(loaded[0].id, "@local/mobile-fit");
  const plugin = loaded[0].factory((name) => {
    if (name === "react") return fakeReact();
    throw new Error(`unexpected require: ${name}`);
  });
  return { plugin, handlers, frame };
}

/**
 * 挂上真正的手势钩子，返回派发触摸事件的函数。
 * @param {object} plugin - factory 的返回值。
 * @param {Map<string, Function>} handlers - 假 document 收下的监听器。
 * @returns {(type: string, x: number, y: number, target: object) => void} 派发器。
 */
function mount(plugin, handlers, actions = []) {
  plugin.internals.useSwipeGesture(true, (action) => actions.push(action));
  return (type, x, y, target) => {
    const handler = handlers.get(type);
    assert.ok(handler !== undefined, `${type} 应该已经挂上监听`);
    handler({ touches: [{ clientX: x, clientY: y }], target });
  };
}

/** 造一个横向滚动区，并把触摸目标挂在它下面。 */
function scrollerWithTarget({ overflowX, scrollWidth = 900, clientWidth = 390, directTable }) {
  const table = directTable ?? overflowX === "hidden";
  const scroller = new FakeElement({ overflowX, scrollWidth, clientWidth, directTable: table });
  const target = new FakeElement().appendTo(scroller);
  return { scroller, target };
}

test("宽表（overflow-x: hidden）上的横滑滚动表格，不开抽屉", () => {
  const { plugin, handlers } = loadPlugin();
  const actions = [];
  const fire = mount(plugin, handlers, actions);
  const { scroller, target } = scrollerWithTarget({ overflowX: "hidden" });

  fire("touchstart", 320, 200, target);
  fire("touchmove", 220, 202, target);

  assert.deepEqual(actions, [], "横向滚动区优先，抽屉不该被打开");
  assert.equal(scroller.scrollLeft, 100, "手指左滑 100px，表格应该跟着滚 100px");

  fire("touchmove", 120, 204, target);
  assert.deepEqual(actions, [], "判给滚动区之后，后续移动仍然不开抽屉");
  assert.equal(scroller.scrollLeft, 200);
});

test("原生可滚的容器交给浏览器，不叠加手动滚动", () => {
  const { plugin, handlers } = loadPlugin();
  const actions = [];
  const fire = mount(plugin, handlers, actions);
  const { scroller, target } = scrollerWithTarget({ overflowX: "auto" });

  fire("touchstart", 320, 200, target);
  fire("touchmove", 220, 200, target);

  assert.deepEqual(actions, []);
  assert.equal(scroller.scrollLeft, 0, "overflow-x: auto 由浏览器自己滚，插件不应再写一次");
});

test("表格滚到右端后继续左滑，抽屉仍然能打开", () => {
  const { plugin, handlers } = loadPlugin();
  const actions = [];
  const fire = mount(plugin, handlers, actions);
  const { scroller, target } = scrollerWithTarget({ overflowX: "hidden" });

  scroller.scrollLeft = 510; // scrollWidth - clientWidth，已经到头
  fire("touchstart", 320, 200, target);
  fire("touchmove", 220, 200, target);

  assert.deepEqual(actions, ["open-right"]);
  assert.equal(scroller.scrollLeft, 510, "到头了就不该再动");
});

test("表格已滚到左端时右滑，抽屉仍然能打开", () => {
  const { plugin, handlers } = loadPlugin();
  const actions = [];
  const fire = mount(plugin, handlers, actions);
  const { target } = scrollerWithTarget({ overflowX: "hidden" });

  fire("touchstart", 90, 200, target);
  fire("touchmove", 210, 202, target);

  assert.deepEqual(actions, ["open-left"]);
});

test("起点在表格里但滑动是竖向的：滚动区不接管，抽屉也不响应", () => {
  const { plugin, handlers } = loadPlugin();
  const actions = [];
  const fire = mount(plugin, handlers, actions);
  const { scroller, target } = scrollerWithTarget({ overflowX: "hidden" });

  /* dx 取 -60：够长，方向判定与抽屉阈值都得真的求值，才测得到竖向分支。 */
  fire("touchstart", 320, 120, target);
  fire("touchmove", 260, 500, target);

  assert.deepEqual(actions, []);
  assert.equal(scroller.scrollLeft, 0, "竖向拖动不该带着表格横移");
});

test("竖向拖动时几像素的横向抖动不会把表格蹭歪", () => {
  const { plugin, handlers } = loadPlugin();
  const actions = [];
  const fire = mount(plugin, handlers, actions);
  const { scroller, target } = scrollerWithTarget({ overflowX: "hidden" });

  fire("touchstart", 320, 120, target);
  fire("touchmove", 317, 122, target); // dx -3，dy 2：横向略占优的那一帧

  assert.equal(scroller.scrollLeft, 0, "起手抖动不该写 scrollLeft");
  assert.deepEqual(actions, []);
});

test("起手有余量、同一手势里滚到头也不换手", () => {
  const { plugin, handlers } = loadPlugin();
  const actions = [];
  const fire = mount(plugin, handlers, actions);
  const { scroller, target } = scrollerWithTarget({ overflowX: "hidden", scrollWidth: 600, clientWidth: 390 });

  fire("touchstart", 320, 200, target);
  fire("touchmove", 200, 200, target); // dx -120，表格还有余量
  fire("touchmove", 100, 200, target); // dx -220，表格被夹在右端（余量 210）

  assert.equal(scroller.scrollLeft, 210, "表格滚到尽头后就停住");
  assert.deepEqual(actions, [], "同一手势不换手，抽屉不弹出");
});

test("深层嵌套的滚动区仍然认得出（旧实现有 6 层上限）", () => {
  const { plugin, handlers, frame } = loadPlugin();
  const actions = [];
  const fire = mount(plugin, handlers, actions);
  const scroller = new FakeElement({ overflowX: "auto", scrollWidth: 900, clientWidth: 390 });

  let node = new FakeElement().appendTo(scroller);
  for (let depth = 0; depth < 8; depth += 1) node = new FakeElement().appendTo(node);
  node.appendTo(frame);

  fire("touchstart", 320, 200, node);
  fire("touchmove", 220, 200, node);

  assert.deepEqual(actions, [], "第 10 层才出现滚动区，也该认出来");
});

test("overflow: hidden 的普通裁剪容器不吞手势，抽屉照旧打开", () => {
  const { plugin, handlers } = loadPlugin();
  const actions = [];
  const fire = mount(plugin, handlers, actions);
  const { scroller, target } = scrollerWithTarget({ overflowX: "hidden", directTable: false });
  /* 停在中间、往有位移的方向滑：这样「被误当成滚动区」一定会写 scrollLeft，测得出来。 */
  scroller.scrollLeft = 200;

  fire("touchstart", 320, 200, target);
  fire("touchmove", 200, 200, target);

  assert.deepEqual(actions, ["open-right"]);
  assert.equal(scroller.scrollLeft, 200, "裁剪容器不是滚动区，不该被拖着动");
});

test("只是「里面某处有表格」的祖先不代滚，整个聊天区不会被拖着走", () => {
  const { plugin, handlers, frame } = loadPlugin();
  const actions = [];
  const fire = mount(plugin, handlers, actions);
  /* 会话列：overflow-x 裁剪、内容比屏宽，表格在它里面的某一层（不是直接子节点）。 */
  const column = new FakeElement({ overflowX: "hidden", scrollWidth: 900, clientWidth: 390, nestedTable: true });
  column.scrollLeft = 200;
  const tableBox = new FakeElement({ overflowX: "visible" });
  const cell = new FakeElement().appendTo(tableBox);
  tableBox.appendTo(column);
  column.appendTo(frame);

  fire("touchstart", 320, 200, cell);
  fire("touchmove", 200, 200, cell);

  assert.equal(column.scrollLeft, 200, "祖先只包含表格、不是表格包装，不能拖它");
  assert.deepEqual(actions, ["open-right"], "手势照旧归抽屉");
});

test("外壳框架之外的滚动容器不参与手势判定", () => {
  const { plugin, handlers, frame } = loadPlugin();
  const actions = [];
  const fire = mount(plugin, handlers, actions);
  /* 外壳外面还套着一层可横滚的容器：走到框架就该停，不能继续往上认。
     它停在中间位置，才分辨得出「没被收集」和「被收集了但正好在端点」。 */
  const outside = new FakeElement({ overflowX: "hidden", scrollWidth: 900, clientWidth: 390, directTable: true });
  outside.scrollLeft = 200;
  frame.appendTo(outside);
  const plain = new FakeElement().appendTo(frame);

  fire("touchstart", 320, 200, plain);
  fire("touchmove", 200, 200, plain);

  assert.equal(outside.scrollLeft, 200, "框架外的容器不该被拖");
  assert.deepEqual(actions, ["open-right"]);
});

test("比屏幕还宽的 hidden 容器不当代滚的表格包装", () => {
  const { plugin } = loadPlugin();
  const kind = plugin.internals.horizontalScrollerKind;
  const tableBox = new FakeElement({ overflowX: "hidden", scrollWidth: 900, clientWidth: 390, directTable: true });
  const widerThanViewport = new FakeElement({ overflowX: "hidden", scrollWidth: 1200, clientWidth: 500, directTable: true });

  assert.equal(kind(tableBox), "drag", "正常宽度的表格包装应该代滚");
  assert.equal(kind(widerThanViewport), null, "比视口还宽的是布局容器，不算");
});

test("普通位置上的左滑照旧开左抽屉", () => {
  const { plugin, handlers, frame } = loadPlugin();
  const actions = [];
  const fire = mount(plugin, handlers, actions);
  const plain = new FakeElement().appendTo(frame);

  fire("touchstart", 90, 200, plain);
  fire("touchmove", 210, 202, plain);

  assert.deepEqual(actions, ["open-left"]);
});

test("太小的一横滑（不到阈值）什么也不做", () => {
  const { plugin, handlers, frame } = loadPlugin();
  const actions = [];
  const fire = mount(plugin, handlers, actions);
  const plain = new FakeElement().appendTo(frame);

  fire("touchstart", 90, 200, plain);
  fire("touchmove", 130, 202, plain);

  assert.deepEqual(actions, []);
});
