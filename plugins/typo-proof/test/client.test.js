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
  useState: () => [null, () => {}],
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
const { normalizeState, itemKey, viewOf, shouldUseDemo, createDemoSource, filterItems, countStates } = plugin.__test;
const { ToolCard } = plugin.__components;

test("client：宿主说演示模式时，面板要换成内置演示源", () => {
  assert.equal(shouldUseDemo({ demo: true }, "http"), true);
  assert.equal(shouldUseDemo({ demo: true }, "demo"), false, "已经是演示源就别再换");
  assert.equal(shouldUseDemo({ demo: false }, "http"), false);
  assert.equal(shouldUseDemo(null, "http"), false);
  assert.equal(shouldUseDemo({ demo: true, items: [] }, "http"), true, "空结果也要换，否则标记与内容矛盾");
});

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

test("client：演示源从空态走到完成，统计与列表一致", async () => {
  const source = createDemoSource({ preload: "done" });
  const state = await source.read();
  assert.equal(state.status, "done");
  assert.equal(state.demo, true);
  assert.equal(state.items.length, state.counts.candidates);
  assert.equal(
    state.counts.confirmed + state.counts.disputed + state.counts.rejected + (state.counts.pending ?? 0),
    state.counts.candidates,
  );
  const confirmed = filterItems(state.items, "confirmed");
  assert.equal(confirmed.length, countStates(state.items).confirmed);
  assert.ok(confirmed.every((item) => item.state === "confirmed"));
});

test("client：演示源能开始、暂停、停止", async () => {
  const source = createDemoSource();
  const seen = [];
  source.subscribe((next) => seen.push(next.status));
  source.start();
  const running = await source.read();
  assert.equal(running.status, "running");
  source.pause();
  assert.equal((await source.read()).note, "已暂停");
  source.stop();
  const stopped = await source.read();
  assert.equal(stopped.status, "idle");
  assert.ok(seen.includes("running"));
});
