import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../client.js", import.meta.url), "utf8");

/* ─────────────────────────── DOM 替身 ─────────────────────────── */

/** 极简选择器匹配：标签名、[attr]、[attr="value"]；逗号分隔任选其一。 */
function matches(node, selector) {
  return selector.split(",").some((part) => {
    const token = part.trim();
    const attrEq = /^\[([\w-]+)="([^"]*)"\]$/.exec(token);
    if (attrEq !== null) return node.attrs[attrEq[1]] === attrEq[2];
    const attr = /^\[([\w-]+)\]$/.exec(token);
    if (attr !== null) return Object.hasOwn(node.attrs, attr[1]);
    return node.tagName === token.toUpperCase();
  });
}

class FakeElement {
  constructor(tagName = "DIV") {
    this.tagName = tagName;
    this.attrs = {};
    this.parentElement = null;
    this.scrollWidth = 0;
    this.clientWidth = 0;
    this.overflowX = undefined;
    this.clicks = 0;
  }

  getAttribute(name) {
    return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null;
  }

  hasAttribute(name) {
    return Object.hasOwn(this.attrs, name);
  }

  closest(selector) {
    for (let node = this; node !== null; node = node.parentElement) {
      if (matches(node, selector)) return node;
    }
    return null;
  }

  click() {
    this.clicks += 1;
  }
}

/**
 * 造一个可注入的页面：选择器表、监听器表、布局开关计数。
 * @param {{ mask?: boolean, leftOpen?: boolean, rightOpen?: boolean, modal?: boolean, modalOwner?: string, otherModal?: boolean }} [options] - 场景。
 * @returns {object} 场景。
 */
function createScene(options = {}) {
  const { mask = true, leftOpen = false, rightOpen = false, modal = false, modalOwner = undefined, otherModal = false } = options;

  const frame = new FakeElement();
  if (!leftOpen) frame.attrs["data-sidebar-collapsed"] = "";

  const maskElement = new FakeElement();
  maskElement.parentElement = frame;

  const rightPanel = new FakeElement();
  const rightOpenButton = new FakeElement("BUTTON");
  const rightCloseButton = new FakeElement("BUTTON");

  const modalElement = modal ? new FakeElement() : null;
  if (modalElement !== null) {
    modalElement.attrs["aria-modal"] = "true";
    if (modalOwner !== undefined) modalElement.attrs["data-shortcut-modal"] = modalOwner;
  }

  /*
   * 第二个 aria-modal：模拟「抽屉开着 + 官方弹窗（经 createPortal 挂在 body 末尾）也开着」。
   * 顺序与真实 DOM 一致——抽屉在前，弹窗在后。
   */
  const modalElements = [];
  if (modalElement !== null) modalElements.push(modalElement);
  if (otherModal) {
    const other = new FakeElement();
    other.attrs["aria-modal"] = "true";
    other.attrs["data-shortcut-modal"] = "settings";
    modalElements.push(other);
  }

  const selectors = new Map();
  if (mask) selectors.set("[data-sidebar-mask]", maskElement);
  if (modalElement !== null) selectors.set('[aria-modal="true"]', modalElement);
  if (rightOpen) selectors.set("[data-sidebar-right-panel][data-sidebar-right-open]", rightPanel);
  selectors.set("[data-sidebar-right-expand]", rightOpenButton);
  selectors.set("[data-sidebar-right-toggle]", rightCloseButton);

  const listeners = [];
  const calls = { toggle: 0 };

  const document = {
    querySelector: (selector) => selectors.get(selector) ?? null,
    querySelectorAll: (selector) => (selector === '[aria-modal="true"]' ? modalElements : []),
    addEventListener(type, fn, opts) {
      listeners.push({ type, fn, opts });
    },
    removeEventListener(type, fn) {
      const index = listeners.findIndex((item) => item.type === type && item.fn === fn);
      if (index >= 0) listeners.splice(index, 1);
    },
  };

  const window = {
    innerWidth: 411,
    getComputedStyle: (element) => ({ overflowX: element.overflowX ?? "visible" }),
  };

  const context = { window, document, Element: FakeElement, HTMLElement: FakeElement };
  return { context, document, listeners, window, calls, rightOpenButton, rightCloseButton };
}

/**
 * 在 VM 里加载 bundle，返回 `__test`。
 * @param {object} scene - `createScene` 的产物。
 * @returns {object} `__test`。
 */
function loadClient(scene) {
  let exports;
  scene.window.__ModuleLoader__ = {
    load({ factory }) {
      exports = factory();
    },
  };
  vm.runInNewContext(SOURCE, scene.context);
  return exports.__test;
}

/** 依次派发 touchstart / touchmove，模拟一次滑动。 */
function swipe(scene, { fromX, toX, target = null, touches = 1 }) {
  const fire = (type, event) => {
    for (const item of scene.listeners) {
      if (item.type === type) item.fn(event);
    }
  };
  const element = new FakeElement();
  const eventTarget = target ?? element;
  fire("touchstart", {
    touches: Array.from({ length: touches }, () => ({ clientX: fromX, clientY: 10 })),
    target: eventTarget,
  });
  fire("touchmove", { touches: [{ clientX: toX, clientY: 10 }], target: eventTarget });
}

/* ─────────────────────────── 纯函数 ─────────────────────────── */

const { swipeIntent } = loadClient(createScene());

/** 一次标准手势：从 startX 起，横向 dx、纵向 dy、耗时 dt。 */
const gesture = (startX, dx, dy = 0, dt = 300) => ({ startX, dx, dy, dt });
const closed = () => ({ left: false, right: false });
const leftOpen = () => ({ left: true, right: false });
const rightOpen = () => ({ left: false, right: true });

test("左半屏向右滑：展开左抽屉", () => {
  assert.equal(swipeIntent(gesture(80, 90), closed, 411), "open-left");
});

test("右半屏向左滑：展开右栏", () => {
  assert.equal(swipeIntent(gesture(330, -90), closed, 411), "open-right");
});

test("左半屏向左滑：什么都不做", () => {
  assert.equal(swipeIntent(gesture(80, -90), closed, 411), null);
});

test("右半屏向右滑：什么都不做", () => {
  assert.equal(swipeIntent(gesture(330, 90), closed, 411), null);
});

test("左抽屉开着时向左滑：收起", () => {
  assert.equal(swipeIntent(gesture(200, -90), leftOpen, 411), "close-left");
});

test("左抽屉开着时向右滑：不动（不能顺手开右栏）", () => {
  assert.equal(swipeIntent(gesture(200, 90), leftOpen, 411), null);
});

test("右栏开着时向右滑：收起", () => {
  assert.equal(swipeIntent(gesture(200, 90), rightOpen, 411), "close-right");
});

test("竖直滑动不归抽屉管", () => {
  assert.equal(swipeIntent(gesture(80, 90, 90), closed, 411), null);
});

test("斜向但纵向占优时不算横向手势", () => {
  assert.equal(swipeIntent(gesture(80, 90, 70), closed, 411), null);
});

test("位移不足 56px 不触发", () => {
  assert.equal(swipeIntent(gesture(80, 55), closed, 411), null);
});

test("耗时超过 900ms 算拖拽，不触发", () => {
  assert.equal(swipeIntent(gesture(80, 90, 0, 901), closed, 411), null);
});

test("恰好在阈值上仍然触发", () => {
  assert.equal(swipeIntent(gesture(80, 56, 0, 900), closed, 411), "open-left");
});

test("起手点正好在屏幕中线时归左半屏", () => {
  assert.equal(swipeIntent(gesture(205.5, 90), closed, 411), "open-left");
});

/* ─────────────────────────── 安装层 ─────────────────────────── */

test("安装后挂 4 个监听，全部 passive", () => {
  const scene = createScene();
  loadClient(scene).install({ toggleSidebar: () => {} });
  assert.deepEqual(
    scene.listeners.map((item) => item.type).sort(),
    ["touchend", "touchmove", "touchstart", "touchcancel"].sort(),
  );
  for (const item of scene.listeners) assert.equal(item.opts?.passive, true);
});

test("卸载函数摘掉全部监听", () => {
  const scene = createScene();
  const uninstall = loadClient(scene).install({ toggleSidebar: () => {} });
  uninstall();
  assert.equal(scene.listeners.length, 0);
});

test("窄屏右滑：调用官方开关展开左抽屉", () => {
  const scene = createScene();
  loadClient(scene).install({ toggleSidebar: () => (scene.calls.toggle += 1) });
  swipe(scene, { fromX: 80, toX: 170 });
  assert.equal(scene.calls.toggle, 1);
});

test("非抽屉模式（没有遮罩）不接手势", () => {
  const scene = createScene({ mask: false });
  loadSceneSwipe(scene, { fromX: 80, toX: 170 });
  assert.equal(scene.calls.toggle, 0);
});

test("真模态框（无 data-shortcut-modal）时手势让位", () => {
  const scene = createScene({ modal: true });
  loadSceneSwipe(scene, { fromX: 80, toX: 170 });
  assert.equal(scene.calls.toggle, 0);
});

test("其他快捷键弹窗（data-shortcut-modal=settings）也让位", () => {
  const scene = createScene({ modal: true, modalOwner: "settings" });
  loadSceneSwipe(scene, { fromX: 80, toX: 170 });
  assert.equal(scene.calls.toggle, 0);
});

test("左抽屉自己就是 aria-modal——反向滑动仍然能收起", () => {
  const scene = createScene({ modal: true, modalOwner: "sidebar", leftOpen: true });
  loadSceneSwipe(scene, { fromX: 200, toX: 90 });
  assert.equal(scene.calls.toggle, 1);
});

test("抽屉与官方弹窗同时开着时，手势让位给弹窗（不能穿过它收抽屉）", () => {
  const scene = createScene({ modal: true, modalOwner: "sidebar", otherModal: true, leftOpen: true });
  loadSceneSwipe(scene, { fromX: 200, toX: 90 });
  assert.equal(scene.calls.toggle, 0);
});

test("起手落在 textarea 里时不动", () => {
  const scene = createScene();
  loadSceneSwipe(scene, { fromX: 80, toX: 170, target: new FakeElement("TEXTAREA") });
  assert.equal(scene.calls.toggle, 0);
});

test("起手落在 contenteditable 宿主里时不动", () => {
  const scene = createScene();
  const editable = new FakeElement();
  editable.attrs.contenteditable = "true";
  loadSceneSwipe(scene, { fromX: 80, toX: 170, target: editable });
  assert.equal(scene.calls.toggle, 0);
});

test("起手落在输入框里时不动", () => {
  const scene = createScene();
  const input = new FakeElement("INPUT");
  loadSceneSwipe(scene, { fromX: 80, toX: 170, target: input });
  assert.equal(scene.calls.toggle, 0);
});

test("起手落在横向滚动容器里时不动", () => {
  const scene = createScene();
  const scroller = new FakeElement();
  scroller.scrollWidth = 400;
  scroller.clientWidth = 100;
  scroller.overflowX = "auto";
  loadSceneSwipe(scene, { fromX: 80, toX: 170, target: scroller });
  assert.equal(scene.calls.toggle, 0);
});

test("多点触控被忽略，之后也不会补触发", () => {
  const scene = createScene();
  loadSceneSwipe(scene, { fromX: 80, toX: 170, touches: 2 });
  assert.equal(scene.calls.toggle, 0);
});

test("右栏收起时右半屏左滑：点官方展开按钮", () => {
  const scene = createScene();
  loadClient(scene).install({ toggleSidebar: () => {} });
  swipe(scene, { fromX: 330, toX: 240 });
  assert.equal(scene.rightOpenButton.clicks, 1);
});

test("右栏展开时右半屏右滑：点官方收起按钮", () => {
  const scene = createScene({ rightOpen: true });
  loadClient(scene).install({ toggleSidebar: () => {} });
  swipe(scene, { fromX: 200, toX: 290 });
  assert.equal(scene.rightCloseButton.clicks, 1);
});

test("左抽屉开着时，向右滑不会顺带打开右栏", () => {
  const scene = createScene({ leftOpen: true });
  loadClient(scene).install({ toggleSidebar: () => (scene.calls.toggle += 1) });
  swipe(scene, { fromX: 200, toX: 290 });
  assert.equal(scene.calls.toggle, 0);
  assert.equal(scene.rightOpenButton.clicks, 0);
});

/** 装好后滑一次，返回场景便于断言布局调用。 */
function loadSceneSwipe(scene, gestureArgs) {
  loadClient(scene).install({ toggleSidebar: () => (scene.calls.toggle += 1) });
  swipe(scene, gestureArgs);
}
