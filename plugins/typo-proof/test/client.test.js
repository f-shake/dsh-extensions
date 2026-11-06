/**
 * 面板里那些纯函数。
 *
 * client.js 是浏览器模块（入口是 `window.__ModuleLoader__`），所以在 import 之前
 * 得把 window / document 与一个最小 React 摆好。这里只测不碰 DOM 的部分：
 * 状态规整、候选标识、演示数据源的状态机。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

/** 最小 React：createElement 建一棵能走的树，其余 hook 给空实现。 */
const FAKE_REACT = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  // 初始值按 initializer 真算：表单组件靠它拿 draft，返回 null 会直接崩。
  useState: (init) => [typeof init === "function" ? init() : init, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
};

/**
 * 把元素树里的文字拼起来，用来断言「渲染出了什么」。
 * @param {any} node - 节点。
 * @returns {string} 文本。
 */
function textOf(node) {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const children = Array.isArray(node.children) ? node.children : [];
  return children.map(textOf).join("");
}

/**
 * 把树摊平成节点列表，用来找按钮、选项这类具体元素。
 * @param {any} node - 节点。
 * @param {object[]} [out] - 收集器。
 * @returns {object[]} 所有元素节点。
 */
function nodesOf(node, out = []) {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) nodesOf(item, out);
    return out;
  }
  out.push(node);
  for (const child of node.children ?? []) nodesOf(child, out);
  return out;
}

globalThis.window = globalThis.window ?? {};
globalThis.window.__ModuleLoader__ = {
  load(module) {
    globalThis.__typoProofModule = module;
  },
};
globalThis.document = globalThis.document ?? {
  getElementById: () => null,
  createElement: () => ({ set id(value) {}, set textContent(value) {} }),
  head: { appendChild() {} },
};

await import("../client.js");
const plugin = globalThis.__typoProofModule.factory((name) => (name === "react" ? FAKE_REACT : undefined));
const { normalizeState, itemKey, viewOf, dirOf } = plugin.__test;
const { ToolCard, SettingsForm } = plugin.__components;

test("client：工具卡片先判错误，失败的调用不能一直显示“正在检查”", () => {
  const failed = textOf(
    ToolCard({ phase: "result", block: { isError: true, content: [{ type: "text", text: "Error: 连不上本地模型" }] } }),
  );
  assert.match(failed, /错别字检查失败/);
  assert.match(failed, /连不上本地模型/);
  assert.doesNotMatch(failed, /正在检查/);

  const pending = textOf(ToolCard({ phase: "call" }));
  assert.match(pending, /正在检查/);

  // 成功结果但没 meta：既不能当成失败，也不能继续显示“正在检查”。
  const bare = textOf(ToolCard({ phase: "result", block: {} }));
  assert.match(bare, /没有结果/);
});

test("client：正文视图的选择——失败的任务要落在 error 上，不能是空白", () => {
  assert.equal(viewOf({ status: "done" }, null), "active");
  assert.equal(viewOf({ status: "running" }, null), "active");
  assert.equal(viewOf({ status: "idle" }, null), "idle");
  assert.equal(viewOf({ status: "error" }, null), "error");
  assert.equal(viewOf({ status: "loading" }, null), "loading");
  assert.equal(viewOf({}, null), "loading");
  assert.equal(viewOf({ status: "error" }, { message: "拿不到状态" }), "failure");
});

test("client：面板状态必须带着两个下载地址，否则按钮永远是灰的", () => {
  const state = normalizeState({
    status: "done",
    file: "2011~2014.docx",
    downloadUrl: "/typo-proof/download?job=job-1",
    csvUrl: "/typo-proof/csv?job=job-1",
    items: [{ seg: 12, state: "confirmed" }],
  });
  assert.equal(state.downloadUrl, "/typo-proof/download?job=job-1");
  assert.equal(state.csvUrl, "/typo-proof/csv?job=job-1");
  assert.equal(state.counts.confirmed, 1);
});

test("client：字段缺失或类型不对时退回安全值", () => {
  const state = normalizeState({ status: "wat", downloadUrl: 42, items: null, progress: null });
  assert.equal(state.status, "idle");
  assert.equal(state.downloadUrl, "");
  assert.deepEqual(state.items, []);
  assert.equal(state.progress.localTotal, 0);
  assert.equal(normalizeState(null).file, "");
});

test("client：同一段多条候选的 key 不会撞车", () => {
  const left = { id: "12:0:3:得", seg: 12, pos: 3 };
  const right = { id: "12:1:7:地", seg: 12, pos: 7 };
  assert.notEqual(itemKey(left), itemKey(right));
  assert.equal(itemKey(left), "12:0:3:得");
  // 没有 id 的老数据退回段号 + 位置。
  assert.equal(itemKey({ seg: 12, pos: 7 }), "12-7");
});

test("client：从文件路径取目录，不会把目录再切一层", () => {
  assert.equal(dirOf("C:\\a\\b\\2011.docx"), "C:\\a\\b");
  assert.equal(dirOf("C:/a/b/2011.docx"), "C:/a/b");
  assert.equal(dirOf("只有文件名.docx"), "");
  assert.equal(dirOf(""), "");
  // 「上一级」用的是 loadDir(parent)，不经这里——这里只吃文件路径。
  assert.equal(dirOf("C:\\a\\b"), "C:\\a", "目录当文件路径传进来会多切一层，所以目录必须走 loadDir");
});

test("client：设置表单带着当前值打开，保存时把数字真的转成数字", () => {
  const saved = [];
  const tree = SettingsForm({
    config: {
      file: "C:/日记/2011~2014.docx",
      localProvider: "lmstudio",
      localModel: "qwen3-4b",
      reviewProvider: "deepseek-official",
      reviewModel: "deepseek-flash",
      minHanzi: 9,
      samples: 3,
      concurrency: 4,
    },
    providers: [{ id: "lmstudio", models: ["qwen3-4b", "qwen3-8b"] }, { id: "deepseek-official", models: ["deepseek-flash"] }],
    error: "",
    saving: false,
    onSave: (patch) => saved.push(patch),
    onCancel: () => {},
  });

  const text = textOf(tree);
  assert.match(text, /采样 provider/);
  assert.match(text, /复核模型/);
  // 插件已经没有演示模式了，表单里不该再有这个开关。
  assert.doesNotMatch(text, /演示数据/);

  // 文件是一次运行的输入，不该出现在设置里。
  const inputs = nodesOf(tree).filter((node) => node.type === "input");
  const fileInput = inputs.find((node) => String(node.props.placeholder ?? "").includes("2011"));
  assert.equal(fileInput, undefined, "设置里不该再有 docx 路径输入框");
  const minHanzi = inputs.find((node) => node.props.type === "number" && node.props.value === "9");
  assert.ok(minHanzi !== undefined, "数字字段要带当前值");

  // 模型做成下拉：选项来自模型栏，用户不用手打。这里断言候选真的进了页面。
  const options = nodesOf(tree)
    .filter((node) => node.type === "option")
    .map((node) => node.props.value);
  assert.ok(options.includes("lmstudio"), "provider 要是下拉项");
  assert.ok(options.includes("qwen3-8b"), "模型要是下拉项");
  assert.ok(nodesOf(tree).some((node) => node.type === "select"), "要有 select，而不是让人手打");

  const save = nodesOf(tree).find((node) => node.type === "button" && textOf(node) === "保存");
  assert.ok(save !== undefined, "要有保存按钮");
  save.props.onClick();

  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0], {
    localProvider: "lmstudio",
    localModel: "qwen3-4b",
    reviewProvider: "deepseek-official",
    reviewModel: "deepseek-flash",
    minHanzi: 9,
    samples: 3,
    concurrency: 4,
  });
  // 数字字段必须是 number：传字符串过去服务端会当成非法值拒掉。
  assert.equal(typeof saved[0].minHanzi, "number");
});

test("client：设置保存失败时把原因显示在表单里", () => {
  const tree = SettingsForm({
    config: { file: "", minHanzi: 8, samples: 3, concurrency: 3 },
    providers: [],
    error: "minHanzi 要是不小于 1 的整数",
    saving: false,
    onSave: () => {},
    onCancel: () => {},
  });
  assert.match(textOf(tree), /minHanzi 要是不小于 1 的整数/);
});

