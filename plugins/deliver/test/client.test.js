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

test("客户端模块：声明的注入服务与导出完整", () => {
  const module = loadClientModule();
  // 跨 realm 的数组原型不同，deepStrictEqual 会失败，先摊平成普通数组。
  assert.deepEqual([...module.inject], ["slots", "sidebarRightTabs", "sidebarRight"]);
  assert.equal(typeof module.apply, "function");
  assert.deepEqual([...Object.keys(module.__test)].sort(), [
    "createComponents",
    "deliveriesInTurn",
    "encodeSegment",
    "errorText",
    "fileAddress",
    "fileExt",
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

  // 样式内容也要有约束：删掉某条关键规则（色块 / 行 / 按钮）不会在别的断言里暴露。
  const css = module.__appended[0].textContent;
  for (const rule of [".dlv-card", ".dlv-row", ".dlv-tile", ".dlv-btn", ".dlv-flag"]) {
    assert.ok(css.includes(rule), `样式里缺少 ${rule}`);
  }

  // 显式加载一次样式；重复 apply 不应该再插一份。
  assert.equal(module.__appended.length, 1);
  module.apply(ctx);
  assert.equal(module.__appended.length, 1);
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
  // 预览要的原料必须穿过投影，否则卡片上永远没有预览按钮可用。
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
