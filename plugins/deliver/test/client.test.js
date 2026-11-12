import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 在沙箱里跑一遍 client.js，拿到它注册的模块。
 *
 * 客户端插件是裸脚本（靠 `window.__ModuleLoader__.load` 装载），不能按 ESM 直接
 * import；这里给一个最简 loader、假 React 与假 document。假 React 的 `createElement`
 * 返回元素树，因此组件级用例可以直接调用组件检查渲染结果（真渲染仍走浏览器，手工验）。
 * @returns {object} 模块导出。
 * @param {{ fetch?: Function }} [options] - 可选替身：组件里的 HEAD 检查要看它。
 */
function loadClientModule(options = {}) {
  const source = readFileSync(join(here, "..", "client.js"), "utf8");
  let definition = null;
  const appended = [];
  const sandbox = {
    fetch: options.fetch,
    window: {
      ...(options.window ?? {}),
      __ModuleLoader__: {
        load(value) {
          definition = value;
        },
      },
    },
    // 只够 ensureStyle 用的最小 document；组件本身在测试里不会被渲染。
    document: {
      getElementById(id) {
        return appended.find((node) => node.id === id) ?? null;
      },
      createElement: () => ({ id: "", textContent: "" }),
      head: {
        appendChild(node) {
          appended.push(node);
        },
      },
    },
  };
  runInContext(source, createContext(sandbox));
  assert.notEqual(definition, null, "client.js 应当注册模块");
  const react = {
    // 返回一棵最简元素树，好让组件级用例能直接调用组件并检查结果。
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat() };
    },
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
  };
  const module = definition.factory((name) => (name === "react" ? react : undefined));
  module.__appended = appended;
  return module;
}

/**
 * 一个最小的 window 事件替身：够 notifyRevoked 派发、组件监听。
 * @returns {object} 带 addEventListener / removeEventListener / emit 的假 window。
 */
function createWindow() {
  const listeners = new Map();
  return {
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type, detail) {
      for (const listener of listeners.get(type) ?? []) listener({ type, detail });
    },
    dispatchEvent(event) {
      this.emit(event.type, event.detail);
    },
  };
}

/**
 * 用会真正执行 effect 的替身 React 挂一次组件。
 *
 * 静态调用组件验证不到 effect 里的接线（什么时候拉列表、setState 之后渲染成什么），
 * 而历史投递能不能看见全靠这层。这里给 useState 真 setter、按依赖去重地执行 effect，
 * 并在状态变化后重渲染到稳定为止。
 * @param {object} module - loadClientModule 的返回。
 * @param {Function} Component - 待挂载组件。
 * @param {object} props - 组件属性。
 * @returns {Promise<{tree: object | null, rerender: Function, unmount: Function}>} 渲染结果与控制器。
 */
async function mount(module, Component, props) {
  const react = module.__react;
  const stateSlots = [];
  const effectSlots = [];
  const cleanups = [];
  let cursor = 0;
  let dirty = false;
  let queued = [];

  react.useState = (initial) => {
    const index = cursor++;
    if (stateSlots[index] === undefined) {
      stateSlots[index] = { value: typeof initial === "function" ? initial() : initial };
    }
    const slot = stateSlots[index];
    return [
      slot.value,
      (next) => {
        const value = typeof next === "function" ? next(slot.value) : next;
        if (Object.is(value, slot.value)) return;
        slot.value = value;
        dirty = true;
      },
    ];
  };

  react.useEffect = (fn, deps) => {
    const index = cursor++;
    const previous = effectSlots[index];
    const changed =
      previous === undefined ||
      deps === undefined ||
      deps === null ||
      deps.length !== previous.length ||
      deps.some((value, position) => !Object.is(value, previous[position]));
    if (!changed) return;
    effectSlots[index] = deps ?? [];
    queued.push(fn);
  };

  async function render() {
    let tree = null;
    for (let round = 0; round < 8; round += 1) {
      cursor = 0;
      queued = [];
      dirty = false;
      tree = Component(props);
      for (const fn of queued) {
        const cleanup = fn();
        if (typeof cleanup === "function") cleanups.push(cleanup);
      }
      // 等 effect 里的 promise 链把 setState 送回来；setImmediate 排在微任务之后。
      await new Promise((resolve) => setImmediate(resolve));
      if (!dirty) return tree;
    }
    return tree;
  }

  const tree = await render();
  return {
    tree,
    rerender: render,
    unmount: () => {
      for (const cleanup of cleanups) cleanup();
    },
  };
}

test("客户端模块：声明的注入服务与导出完整", () => {
  const module = loadClientModule();
  // 跨 realm 的数组原型不同，deepStrictEqual 会失败，先摊平成普通数组。
  assert.deepEqual([...module.inject], ["slots", "sidebarRightTabs", "sidebarRight"]);
  assert.equal(typeof module.apply, "function");
  assert.deepEqual([...Object.keys(module.__test)].sort(), [
    "ToolRow",
    "createComponents",
    "deliveriesInTurn",
    "deliveryIsLive",
    "encodeSegment",
    "errorText",
    "fileAddress",
    "fileExt",
    "loadTurnDeliveries",
    "notifyRevoked",
    "readMeta",
    "remainingText",
    "tileTone",
  ]);
});

test("客户端 apply：注册工具视图与投递箱页类型，样式只插一次", () => {
  const module = loadClientModule();
  const slots = [];
  const injected = [];
  const registered = [];
  let tabDefinition = null;
  const ctx = {
    effect(factory) {
      return factory();
    },
    slots: {
      inject(name, factory) {
        injected.push(name);
        factory();
      },
      register(definition, component) {
        slots.push(definition);
        registered.push(component);
        return () => {};
      },
    },
    sidebarRightTabs: {
      register(definition) {
        tabDefinition = definition;
        return () => {};
      },
    },
  };

  module.apply(ctx);

  assert.equal(tabDefinition.id, "@local/deliver");
  assert.equal(tabDefinition.kind, "deliver-box");
  assert.equal(tabDefinition.title(), "投递");
  assert.equal(tabDefinition.guide.length, 1);
  assert.equal(tabDefinition.guide[0].title(), "投递");

  const byName = new Map(slots.map((item) => [item.name, item]));

  const toolview = byName.get("tool.call.toolview");
  assert.equal(toolview.key, "deliver");

  // list 槽位只认 id：写成 key 的话条目永远不渲染，所以这两者必须分开断言。
  const tail = byName.get("conversation.chat.turnTail");
  assert.equal(tail.id, "@local/deliver/tail");
  assert.equal(tail.key, undefined);
  assert.equal(tail.order, 40);

  const tab = byName.get("sidebar.right.pane.tab");
  assert.equal(tab.key, "@local/deliver");

  // 槽名写错时注册回调永远不会被调用，界面里卡片与投递箱都不出现——
  // 所以注入时用的槽名本身必须是断言对象。
  assert.deepEqual(injected, [
    "tool.call.toolview",
    "conversation.chat.turnTail",
    "sidebar.right.pane.tab",
  ]);
  // 注册时传的组件必须是函数：传 undefined 时界面里什么都不渲染，而上面的断言照样通过。
  assert.equal(registered.length, 3);
  for (const component of registered) assert.equal(typeof component, "function");

  // 工具行必须什么都不画：交付只在回合末尾那一组条里出现，画了就是上下两遍。
  assert.equal(registered[0]({ phase: "result", block: { meta: {} } }), null);
  assert.equal(registered[0]({ phase: "preparing" }), null);
  // 失败是例外：没有投递成功时正文里没有条，错误要留在工具行里。
  const failed = registered[0]({ phase: "result", block: { isError: true, content: [{ type: "text", text: "没有可投递的文件。" }] } });
  assert.equal(failed.props.className, "dlv-err");
  assert.equal(failed.children[0], "没有可投递的文件。");

  // 样式内容也要有约束：删掉某条关键规则（色块 / 行 / 按钮 / 回合末尾的下载条）
  // 不会在别的断言里暴露。
  // 容器规则要连 `{` 一起断言：只写 `.dlv-bar` 的话 `.dlv-bar-name` 也能让它通过，
  // 删掉基础规则（边框/背景/padding）测试仍然全绿。
  const css = module.__appended[0].textContent;
  for (const rule of [".dlv-row", ".dlv-tile", ".dlv-btn", ".dlv-flag", ".dlv-act{", ".dlv-err{", ".dlv-tail{", ".dlv-bar{", ".dlv-bar-dead{"]) {
    assert.ok(css.includes(rule), `样式里缺少 ${rule}`);
  }

  // 显式加载一次样式；重复 apply 不应该再插一份。
  assert.equal(module.__appended.length, 1);
  module.apply(ctx);
  assert.equal(module.__appended.length, 1);
});

test("DownloadBar：一行里给文件名、说明、预览与下载", () => {
  const { DownloadBar, DownloadButton, PreviewButton } = loadClientModule().__test.createComponents();
  const file = { index: 0, name: "周报.pdf", sizeText: "2 MB", url: "/deliver/x/0", absPath: "C:/tmp/周报.pdf" };

  const tree = DownloadBar({ file, sessionId: "s1", extra: "还有 11 小时" });
  assert.equal(tree.props.className, "dlv-bar");
  const [name, meta, act] = tree.children;
  assert.equal(name.props.className, "dlv-bar-name");
  assert.equal(name.children[0], "周报.pdf");
  assert.equal(meta.props.className, "dlv-bar-meta");
  assert.equal(meta.children[0], "2 MB · 还有 11 小时");
  // 预览在左、下载在右；工具行不再画卡片，这就是正文里唯一能点预览的地方。
  assert.equal(act.props.className, "dlv-act");
  assert.equal(act.children[0].type, PreviewButton);
  assert.equal(act.children[1].type, DownloadButton);

  // 老记录缺绝对路径、或拿不到会话 id 时只剩下载，不留一个按了没反应的按钮。
  assert.equal(DownloadBar({ file: { ...file, absPath: "" }, sessionId: "s1" }).children[2].children[0], null);
  assert.equal(DownloadBar({ file }).children[2].children[0], null);
  assert.equal(DownloadBar({ file, sessionId: "" }).children[2].children[0], null);

  // extra 为空或缺失时退回 sizeText，不留「2 MB · 」这种尾巴。
  for (const extra of [undefined, ""]) {
    assert.equal(DownloadBar({ file, sessionId: "s1", extra }).children[1].children[0], "2 MB");
  }
});

test("FileRow：预览与下载并排，disabled 时两个都不给", () => {
  const { FileRow, DownloadButton, PreviewButton } = loadClientModule().__test.createComponents();
  const file = { index: 0, name: "a.pdf", sizeText: "1 KB", url: "/deliver/x/0", absPath: "C:/tmp/a.pdf" };
  const actOf = (tree) =>
    tree.children.find(
      (child) => child !== null && typeof child === "object" && child.props?.className === "dlv-act",
    );

  const act = actOf(FileRow({ file, sessionId: "s1" }));
  assert.equal(act.children.length, 2);
  // 预览在左、下载在右，与需求里的「下载按钮左侧」一致。
  assert.equal(act.children[0].type, PreviewButton);
  assert.equal(act.children[1].type, DownloadButton);
  assert.equal(actOf(FileRow({ file, sessionId: "s1", disabled: true })), undefined);

  // 老记录（没有 absPath）或没有会话 id 时只剩下载，不留一个按了没反应的按钮。
  assert.equal(actOf(FileRow({ file: { ...file, absPath: "" }, sessionId: "s1" })).children[0], null);
  assert.equal(actOf(FileRow({ file, sessionId: "" })).children[0], null);
  // sessionId 是可选属性：没传时是 undefined，`undefined !== ''` 会把它放行。
  assert.equal(actOf(FileRow({ file })).children[0], null);

  // 说明行要带上额外信息（大小 · 剩余时间）。
  const info = FileRow({ file, extra: "还有 3 小时" }).children.find(
    (child) => child !== null && typeof child === "object" && child.props?.className === "dlv-info",
  );
  assert.equal(info.children[1].children[0], "1 KB · 还有 3 小时");
});

test("loadTurnDeliveries：按会话查询、按回合窗筛选、失败给空数组", async () => {
  const calls = [];
  let status = 200;
  let payload = {
    ok: true,
    now: 2_500,
    deliveries: [
      { id: "in", createdAt: 1_500, expiresAt: 9_999, files: [{ index: 0, name: "a.txt", url: "/deliver/in/0" }] },
      { id: "before", createdAt: 500, expiresAt: 9_999, files: [{ index: 0, name: "b.txt", url: "/deliver/before/0" }] },
      { id: "empty", createdAt: 1_600, expiresAt: 9_999, files: [] },
    ],
  };
  const module = loadClientModule({
    fetch: async (url, init) => {
      calls.push([url, init]);
      if (status !== 200) return { ok: false, status, json: async () => ({}) };
      return { ok: true, status, json: async () => payload };
    },
  });
  const { loadTurnDeliveries } = module.__test;

  const inside = await loadTurnDeliveries({ start: 1_000, end: 2_000, sessionId: "s1" });
  assert.deepEqual([...inside].map((item) => item.id), ["in"]);
  // 会话过滤走查询参数，不要客户端自己筛：列表上限与顺序都由宿主定。
  assert.equal(calls[0][0], "/deliver/list?session=s1");
  assert.equal(calls[0][1].credentials, "same-origin");

  // 没有会话 id 时不带查询参数（不该拼出 ?session=）。
  await loadTurnDeliveries({ start: 1_000, end: 2_000, sessionId: "" });
  assert.equal(calls[1][0], "/deliver/list");

  // 请求失败或响应不是 JSON：正文里宁可不显示，也不抛给渲染层。
  status = 410;
  assert.deepEqual([...await loadTurnDeliveries({ start: 1_000, end: 2_000 })], []);
  status = 200;
  payload = { ok: true, now: 1, deliveries: "nope" };
  assert.deepEqual([...await loadTurnDeliveries({ start: 1_000, end: 2_000 })], []);
});

test("notifyRevoked：撤销后广播事件，带上被撤销的投递 id", () => {
  const events = [];
  const win = createWindow();
  win.dispatchEvent = (event) => events.push(event);
  const module = loadClientModule({ window: win });
  module.__test.notifyRevoked("abc");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "deliver:revoked");
  // 带上 id：工具行只对自己那条反应，别的投递被撤销不该把它画成失效。
  assert.equal(events[0].detail.deliveryId, "abc");

  // 没有事件接口的替身里不能抛：投递箱本身还要照常刷新。
  assert.doesNotThrow(() => loadClientModule().__test.notifyRevoked("abc"));
});

test("ToolRow：活着不画、失败出错误、失效退回 meta 画条", () => {
  const module = loadClientModule();
  const { ToolRow } = module.__test;
  const file = { index: 0, name: "a.txt", sizeText: "3 B", url: "/deliver/abc/0", absPath: "C:/tmp/a.txt" };
  const block = { meta: { deliveryId: "abc", sessionId: "s1", expiresAt: 9, files: [file] } };

  assert.equal(ToolRow({ phase: "preparing" }), null);
  // 还活着：交给回合末尾那组条，工具行一个字都不画。
  assert.equal(ToolRow({ phase: "result", block }), null);
  // 失败要留在原处：这时没有条可看。
  assert.equal(ToolRow({ phase: "result", block: { ...block, isError: true } }).props.className, "dlv-err");

  // 记录已不在宿主内存（重启、过期、撤销）：退回 meta 画同样的一行行，标「已失效」。
  module.__react.useState = () => [false, () => {}];
  const dead = ToolRow({ phase: "result", block });
  assert.equal(dead.props.className, "dlv-tail");
  const [name, meta, flag] = dead.children[0].children;
  assert.equal(name.children[0], "a.txt");
  assert.equal(meta.children[0], "3 B");
  assert.equal(flag.props.className, "dlv-bar-dead");
  assert.equal(flag.children[0], "已失效");
});

test("deliveryIsLive：列表比结果新就信它，比结果旧才重拉", async () => {
  let calls = 0;
  const module = loadClientModule({
    fetch: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ ok: true, now: 5_000, deliveries: [{ id: "a" }, { id: "c" }] }) };
    },
  });
  // 结果早于列表生成时间：缺这条就是真缺，不该再拉一次。
  assert.equal(await module.__test.deliveryIsLive("a", 4_000), true);
  assert.equal(await module.__test.deliveryIsLive("b", 4_000), false);
  assert.equal(calls, 1);

  // 列表拉不到：不把「不知道」当成「已失效」，否则活着的投递会多画一遍。
  const broken = loadClientModule({
    fetch: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(await broken.__test.deliveryIsLive("b", 1), true);
});

test("deliveryIsLive：列表比结果旧就重拉，新投的两条都能认出来", async () => {
  const lists = [
    { now: 100, ids: [] },
    { now: 200, ids: ["d1"] },
    { now: 400, ids: ["d1", "d2"] },
  ];
  let calls = 0;
  const module = loadClientModule({
    fetch: async () => {
      const list = lists[Math.min(calls, lists.length - 1)];
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ now: list.now, deliveries: list.ids.map((id) => ({ id })) }) };
    },
  });
  // 第一条：缓存比结果旧 → 重拉后认得。
  assert.equal(await module.__test.deliveryIsLive("d1", 150), true);
  // 第二条紧接着来：仍必须允许重拉，否则会把刚投的 d2 判成失效、和末尾那条重复。
  assert.equal(await module.__test.deliveryIsLive("d2", 300), true);
  assert.equal(calls, 3);
});

test("ToolRow：挂载后按列表判定，失效才画条", async () => {
  const file = { index: 0, name: "a.txt", sizeText: "3 B", url: "/deliver/abc/0", absPath: "C:/tmp/a.txt" };
  const block = { time: 1_000, meta: { deliveryId: "abc", sessionId: "s1", expiresAt: 9, files: [file] } };
  const reply = (ids) => async () => ({
    ok: true,
    status: 200,
    json: async () => ({ now: 5_000, deliveries: ids.map((id) => ({ id })) }),
  });

  const dead = loadClientModule({ fetch: reply(["other"]) });
  const deadView = await mount(dead, dead.__test.ToolRow, { phase: "result", block });
  assert.equal(deadView.tree.props.className, "dlv-tail");
  deadView.unmount();

  const live = loadClientModule({ fetch: reply(["abc"]) });
  const liveView = await mount(live, live.__test.ToolRow, { phase: "result", block });
  assert.equal(liveView.tree, null);
  liveView.unmount();
});

test("ToolRow：同页撤销后立刻改画已失效，不用等刷新", async () => {
  const win = createWindow();
  const module = loadClientModule({
    window: win,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ deliveries: [{ id: "abc" }] }) }),
  });
  const file = { index: 0, name: "a.txt", sizeText: "3 B", url: "/deliver/abc/0", absPath: "C:/tmp/a.txt" };
  const block = { meta: { deliveryId: "abc", sessionId: "s1", expiresAt: 9, files: [file] } };
  const view = await mount(module, module.__test.ToolRow, { phase: "result", block });
  assert.equal(view.tree, null);

  // 撤的是别的投递：自己还活着，不能被牵连。
  win.emit("deliver:revoked", { deliveryId: "other" });
  assert.equal(await view.rerender(), null);

  win.emit("deliver:revoked", { deliveryId: "abc" });
  const revoked = await view.rerender();
  assert.equal(revoked.props.className, "dlv-tail");
  view.unmount();
});

test("ToolRow：撤销先到、列表后到，晚到的结果不能把条撤回", async () => {
  const win = createWindow();
  let settle = null;
  const module = loadClientModule({
    window: win,
    fetch: () =>
      new Promise((resolve) => {
        // 手动控制返回时机：模拟「撤销发生在请求还在飞的时候」。
        settle = () =>
          resolve({ ok: true, status: 200, json: async () => ({ now: 5_000, deliveries: [{ id: "abc" }] }) });
      }),
  });
  const file = { index: 0, name: "a.txt", sizeText: "3 B", url: "/deliver/abc/0", absPath: "C:/tmp/a.txt" };
  const block = { time: 1_000, meta: { deliveryId: "abc", sessionId: "s1", expiresAt: 9, files: [file] } };

  const view = await mount(module, module.__test.ToolRow, { phase: "result", block });
  // 列表还没回来：先按活着处理。
  assert.equal(view.tree, null);

  win.emit("deliver:revoked", { deliveryId: "abc" });
  assert.equal((await view.rerender()).props.className, "dlv-tail");

  // 撤销之前发出的请求这才回来，内容里还有 abc——不能把状态翻回「活着」。
  // 走真实的撤销入口（记住 id 再派发），这才覆盖「在途请求晚到」的竞态。
  module.__test.notifyRevoked("abc");
  settle();
  assert.equal((await view.rerender()).props.className, "dlv-tail");
  view.unmount();
});

test("fileAddress：会话 + 绝对路径，盘符冒号保留、中文与空格逐段编码", () => {
  const { fileAddress } = loadClientModule().__test;
  assert.equal(
    fileAddress("s1", "C:\\Users\\autod\\报告 1.pdf"),
    "dsh-resource://file/session/s1/C:/Users/autod/%E6%8A%A5%E5%91%8A%201.pdf",
  );
  // POSIX 绝对路径：开头的空段要留住，否则地址会变成相对路径。
  assert.equal(fileAddress("s1", "/tmp/a#b.txt"), "dsh-resource://file/session/s1//tmp/a%23b.txt");
});

test("PreviewButton：HEAD 通过才交给内置预览，失效或缺路径都不打开", async () => {
  const calls = [];
  let response = { ok: true, status: 200 };
  const module = loadClientModule({
    fetch: async (url, init) => {
      assert.equal(url, "/deliver/x/0");
      assert.equal(init.method, "HEAD");
      return response;
    },
  });
  const { PreviewButton } = module.__test.createComponents({
    openPreview: (sessionId, file) => calls.push([sessionId, file.absPath]),
  });
  const file = { index: 0, name: "a.png", sizeText: "1 KB", url: "/deliver/x/0", absPath: "C:/tmp/a.png" };
  const button = PreviewButton({ file, sessionId: "s1" }).children[1];
  assert.equal(button.children[0], "预览");

  await button.props.onClick();
  assert.deepEqual(calls, [["s1", "C:/tmp/a.png"]]);

  // 撤销/过期：不打开。
  response = { ok: false, status: 410 };
  const gone = PreviewButton({ file, sessionId: "s1" });
  await gone.children[1].props.onClick();
  assert.equal(calls.length, 1);
  // 失效后的文案由重渲染给出（假 React 不会自己重渲染，这里直接把状态钉成 gone）。
  module.__react.useState = () => ["gone", () => {}];
  const goneTree = PreviewButton({ file, sessionId: "s1" });
  assert.equal(goneTree.children[0].children[0], "已失效");
  // 与下载按钮同一条约束：失效态不禁用（焦点要还回来），但告诉读屏「按了没用」。
  assert.equal(goneTree.children[1].props.disabled, false);
  assert.equal(goneTree.children[1].props["aria-disabled"], "true");

  // 老记录没有绝对路径：连 HEAD 都不发。
  const legacy = PreviewButton({ file: { ...file, absPath: "" }, sessionId: "s1" });
  await legacy.children[1].props.onClick();
  assert.equal(calls.length, 1);
});

test("DownloadButton：文案恒为「下载」，提示区是常驻 live region，非检查期不禁用", () => {
  const { DownloadButton } = loadClientModule().__test.createComponents();
  const tree = DownloadButton({ url: "/deliver/x/0" });
  const [flag, button] = tree.children;

  assert.equal(flag.props.role, "status");
  assert.equal(flag.props["aria-live"], "polite");
  assert.equal(flag.children[0], "");

  assert.equal(button.type, "button");
  assert.equal(button.children[0], "下载");
  // 检查期之外不禁用：失效态仍要能拿回焦点。
  assert.equal(button.props.disabled, false);
  assert.equal(button.props["aria-busy"], undefined);
});

test("DownloadButton：检查中禁用并 aria-busy，失效态可聚焦且 aria-disabled", () => {
  const module = loadClientModule();
  const { DownloadButton } = module.__test.createComponents();
  const react = module.__react;

  react.useState = () => ["busy", () => {}];
  const busy = DownloadButton({ url: "/deliver/x/0" });
  assert.equal(busy.children[1].props.disabled, true);
  assert.equal(busy.children[1].props["aria-busy"], "true");
  assert.equal(busy.children[1].children[0], "下载");
  assert.equal(busy.children[0].children[0], "");

  react.useState = () => ["gone", () => {}];
  const gone = DownloadButton({ url: "/deliver/x/0" });
  // 保留可聚焦（焦点要从 busy 阶段还回来），但要告诉读屏「按了没用」。
  assert.equal(gone.children[1].props.disabled, false);
  assert.equal(gone.children[1].props["aria-disabled"], "true");
  assert.equal(gone.children[1].children[0], "下载");
  assert.equal(gone.children[0].children[0], "已失效");

  react.useState = () => ["error", () => {}];
  const failed = DownloadButton({ url: "/deliver/x/0" });
  assert.equal(failed.children[1].children[0], "下载");
  assert.equal(failed.children[0].children[0], "打不开");
  assert.equal(failed.children[1].props["aria-disabled"], undefined);
});

test("deliveriesInTurn：按回合时间窗筛选，窗外与没有文件的都排除", () => {
  const { deliveriesInTurn } = loadClientModule().__test;
  const items = [
    { id: "before", createdAt: 900, files: [{ index: 0 }] },
    { id: "at-start", createdAt: 1_000, files: [{ index: 0 }] },
    { id: "inside", createdAt: 1_500, files: [{ index: 0 }] },
    { id: "at-end", createdAt: 2_000, files: [{ index: 0 }] },
    { id: "after", createdAt: 2_100, files: [{ index: 0 }] },
    { id: "no-files", createdAt: 1_200, files: [] },
    { id: "broken", files: [{ index: 0 }] },
  ];
  // 跨 realm 的数组原型不同，deepStrictEqual 会失败，统一摊平成宿主数组再比。
  assert.deepEqual(
    [...deliveriesInTurn(items, { start: 1_000, end: 2_000 })].map((item) => item.id),
    ["at-start", "inside", "at-end"],
  );
  // 回合还没结束（没有 end）时上界视为无穷。
  assert.deepEqual(
    [...deliveriesInTurn(items, { start: 1_000 })].map((item) => item.id),
    ["at-start", "inside", "at-end", "after"],
  );
  assert.deepEqual([...deliveriesInTurn(items, {})], []);
  assert.deepEqual([...deliveriesInTurn(null, { start: 1 })], []);
});

test("fileExt / tileTone：色块标签与底色", () => {
  const { fileExt, tileTone } = loadClientModule().__test;
  assert.equal(fileExt("README.md"), "MD");
  assert.equal(fileExt("报告.PDF"), "PDF");
  assert.equal(fileExt("noext"), "FILE");
  assert.equal(fileExt(".gitignore"), "FILE");
  assert.equal(fileExt("archive."), "FILE");
  assert.equal(fileExt("something.verylong"), "VERY");
  assert.equal(fileExt(null), "FILE");
  assert.equal(tileTone("md"), "#3b6fd4");
  assert.equal(tileTone("MD"), "#3b6fd4");
  assert.equal(tileTone("png"), "#1f7a52");
  assert.equal(tileTone("json"), "#8a6508");
  assert.equal(tileTone("zip"), "#6d3fd0");
  assert.equal(tileTone("unknown"), "#4a4a52");
});

test("remainingText：分钟、小时、天与失效边界", () => {
  const { remainingText } = loadClientModule().__test;
  const now = 1_000_000;
  assert.equal(remainingText(now + 30_000, now), "还有 1 分钟");
  assert.equal(remainingText(now + 30 * 60_000, now), "还有 30 分钟");
  assert.equal(remainingText(now + 3 * 3600_000, now), "还有 3 小时");
  assert.equal(remainingText(now + 2 * 86_400_000, now), "还有 2 天");
  assert.equal(remainingText(now, now), "已失效");
  assert.equal(remainingText(now - 1, now), "已失效");
  assert.equal(remainingText(Number.NaN, now), "已失效");
});

test("errorText：拼正文、空正文回退、超长截断", () => {
  const { errorText } = loadClientModule().__test;
  assert.equal(
    errorText({ content: [{ type: "text", text: "没有可投递的文件。" }] }),
    "没有可投递的文件。",
  );
  assert.equal(errorText({ content: [] }), "投递失败");
  assert.equal(errorText({}), "投递失败");
  const long = errorText({ content: [{ type: "text", text: "x".repeat(500) }] });
  assert.equal(long.length, 300);
});

test("readMeta：合法结构读出列表，缺字段或形状不对返回 null", () => {
  const { readMeta } = loadClientModule().__test;
  const meta = readMeta({
    meta: {
      deliveryId: "abc",
      sessionId: "s1",
      expiresAt: 1234,
      files: [
        {
          index: 0,
          name: "a.txt",
          size: 3,
          sizeText: "3 B",
          url: "/deliver/abc/0",
          absPath: "C:/tmp/a.txt",
        },
      ],
    },
  });
  assert.equal(meta.deliveryId, "abc");
  assert.equal(meta.sessionId, "s1");
  assert.equal(meta.files.length, 1);
  assert.equal(meta.files[0].sizeText, "3 B");
  assert.equal(meta.files[0].absPath, "C:/tmp/a.txt");

  assert.equal(readMeta({}), null);
  assert.equal(readMeta({ meta: null }), null);
  assert.equal(readMeta({ meta: { deliveryId: "", files: [] } }), null);
  assert.equal(readMeta({ meta: { deliveryId: "abc", files: [] } }), null);
  assert.equal(readMeta({ meta: { deliveryId: "abc", files: [{ name: "a" }] } }), null);
});

test("readMeta：老记录缺 sizeText 时给空串而不是崩", () => {
  const { readMeta } = loadClientModule().__test;
  const meta = readMeta({
    meta: { deliveryId: "abc", files: [{ name: "a", url: "/deliver/abc/0" }] },
  });
  assert.equal(meta.files[0].sizeText, "");
  assert.equal(meta.files[0].index, 0);
  // 老记录没有绝对路径：给空串，预览按钮据此不发明地址。
  assert.equal(meta.files[0].absPath, "");
  assert.equal(meta.sessionId, "");
  assert.equal(meta.expiresAt, 0);
});
