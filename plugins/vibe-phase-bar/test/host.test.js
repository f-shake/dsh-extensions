import test from "node:test";
import assert from "node:assert/strict";
import { apply, createHandlers, createStore, createTool, sessionIdOf } from "../index.js";

const START = 1_000_000;

/**
 * 造一个最小 Cordis 上下文：只记录工具与路由的注册。
 * @returns {{ ctx: object, tools: object[], routes: object[], listeners: Map<string, Function> }} 测试夹具。
 */
function createHarness() {
  const tools = [];
  const routes = [];
  const listeners = new Map();
  const ctx = {
    tools: {
      register(tool) {
        tools.push(tool);
        return () => {};
      },
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    inject(_deps, callback) {
      callback(ctx);
    },
    effect(factory) {
      return factory();
    },
    on(event, listener) {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    logger: { warn() {}, info() {} },
  };
  return { ctx, tools, routes, listeners };
}

/**
 * 造一个假响应对象，把状态码与 JSON 载荷留在对象上。
 * @returns {object} 响应对象。
 */
function makeRes() {
  const res = { status: 0, body: null, headers: null };
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers;
  };
  res.end = (text) => {
    res.body = text === undefined || text === "" ? null : JSON.parse(text);
  };
  return res;
}

/**
 * 造一个 GET 请求。
 * @param {string} url - 路径与查询串。
 * @returns {object} 请求对象。
 */
function getReq(url) {
  return { method: "GET", url };
}

/**
 * 造一个带 JSON 体的 POST 请求（Node 的可迭代请求流）。
 * @param {string} url - 路径。
 * @param {object} payload - 载荷。
 * @returns {object} 请求对象。
 */
function postReq(url, payload) {
  const text = JSON.stringify(payload);
  return {
    method: "POST",
    url,
    // 路由只收 JSON：跨站表单发不出这个头，等于一道简易 CSRF 闸。
    headers: { "content-type": "application/json" },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text);
    },
  };
}

/**
 * 造一个记下每次 followup 的 agent。
 * @param {string} sessionId - 会话 id。
 * @returns {{ agent: object, followups: object[] }} agent 与调用记录。
 */
function makeAgent(sessionId) {
  const followups = [];
  return {
    followups,
    agent: {
      sessionId,
      // 真实 API 是同步入队、返回 void，这里照抄，别用 async 伪装成可等待。
      followup(message) {
        followups.push(message);
      },
    },
  };
}

/**
 * 把一次请求打给路由，返回响应。
 * @param {object} handler - 路由处理函数。
 * @param {object} req - 请求对象。
 * @returns {Promise<object>} 响应对象。
 */
async function call(handler, req) {
  const res = makeRes();
  await handler(req, res);
  return res;
}

test("apply 注册工具、路由与 agent 清理监听", () => {
  const { ctx, tools, routes, listeners } = createHarness();
  apply(ctx, {});
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "vibe_phase");
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, "prefix");
  assert.equal(routes[0].path, "/vibe-phase");
  assert.equal(typeof listeners.get("agent/disposed"), "function");
});

test("未知会话读取状态返回 null，而不是报错", async () => {
  const store = createStore();
  const handler = createHandlers({ store, clock: () => START }).handle;
  const res = await call(handler, getReq("/vibe-phase/state?session=nobody"));
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.state, null);
});

test("工具 enter 之后能读到当前阶段", async () => {
  const store = createStore();
  const tool = createTool({ store });
  const handler = createHandlers({ store, clock: () => START }).handle;
  const { agent } = makeAgent("s1");

  const result = await tool.execute({ action: "enter", phase: 2 }, { agent });
  assert.equal(result.text, "已进入阶段 2（开发）。");

  const res = await call(handler, getReq("/vibe-phase/state?session=s1"));
  assert.equal(res.body.state.phase, 2);
  assert.equal(res.body.state.pending, null);
});

test("工具 request 只挂起，不改当前阶段", async () => {
  const store = createStore();
  const tool = createTool({ store });
  const handler = createHandlers({ store, clock: () => START }).handle;
  const { agent } = makeAgent("s1");

  await tool.execute({ action: "enter", phase: 2 }, { agent });
  const result = await tool.execute({ action: "request", phase: 3 }, { agent });
  assert.match(result.text, /等待用户在阶段条上点击确认/);

  const res = await call(handler, getReq("/vibe-phase/state?session=s1"));
  assert.equal(res.body.state.phase, 2);
  assert.equal(res.body.state.pending, 3);
});

test("对当前或更早阶段发 request 会被拒绝成一句说明", async () => {
  const store = createStore();
  const tool = createTool({ store });
  const { agent } = makeAgent("s1");
  await tool.execute({ action: "enter", phase: 3 }, { agent });
  const result = await tool.execute({ action: "request", phase: 2 }, { agent });
  assert.match(result.text, /无需请求进入阶段 2/);
  assert.equal(store.get("s1").state.pending, null);
});

test("挂起等待确认时，工具 enter 越不过闸门", async () => {
  const store = createStore();
  const tool = createTool({ store });
  const handler = createHandlers({ store, clock: () => START }).handle;
  const { agent } = makeAgent("s1");

  await tool.execute({ action: "enter", phase: 2 }, { agent });
  await tool.execute({ action: "request", phase: 3 }, { agent });

  const blocked = await tool.execute({ action: "enter", phase: 3 }, { agent });
  assert.match(blocked.text, /确认前不能进入阶段 3/);
  assert.equal(store.get("s1").state.phase, 2);
  assert.equal(store.get("s1").state.pending, 3);

  // 用户点过之后才允许进入（确认路由已把 phase 推到 3，enter 变成幂等确认）
  await call(handler, postReq("/vibe-phase/confirm", { session: "s1", phase: 3 }));
  const allowed = await tool.execute({ action: "enter", phase: 3 }, { agent });
  assert.match(allowed.text, /已在阶段 3/);
  assert.equal(store.get("s1").state.phase, 3);
  assert.equal(store.get("s1").state.pending, null);
});

test("重复 enter 当前阶段不会擦掉等待确认的闪烁", async () => {
  const store = createStore();
  const tool = createTool({ store });
  const { agent } = makeAgent("s1");

  await tool.execute({ action: "enter", phase: 2 }, { agent });
  await tool.execute({ action: "request", phase: 3 }, { agent });

  const again = await tool.execute({ action: "enter", phase: 2 }, { agent });
  assert.match(again.text, /已在阶段 2/);
  assert.equal(store.get("s1").state.pending, 3);
});

test("工具拒绝非法参数", async () => {
  const store = createStore();
  const tool = createTool({ store });
  const { agent } = makeAgent("s1");
  await assert.rejects(() => tool.execute({ action: "jump", phase: 2 }, { agent }), /action/);
  await assert.rejects(() => tool.execute({ action: "enter", phase: 9 }, { agent }), /phase/);
  await assert.rejects(() => tool.execute({ action: "enter", phase: 2 }, {}), /会话上下文/);
});

test("确认点击推进状态，并把一句话交给 agent.followup", async () => {
  const store = createStore();
  const tool = createTool({ store });
  const handler = createHandlers({ store, clock: () => START }).handle;
  const { agent, followups } = makeAgent("s1");

  await tool.execute({ action: "enter", phase: 1 }, { agent });
  await tool.execute({ action: "request", phase: 2 }, { agent });

  const res = await call(handler, postReq("/vibe-phase/confirm", { session: "s1", phase: 2 }));
  assert.equal(res.status, 200);
  assert.equal(res.body.state.phase, 2);
  assert.equal(res.body.state.pending, null);

  assert.equal(followups.length, 1);
  assert.deepEqual(followups[0].content, [{ type: "text", text: "确认进入阶段 2（开发）。" }]);
  assert.deepEqual(followups[0].source, { kind: "user" });
  // 回归：followup 收的是完整 UserMessage。2026-10-31 漏了 role，历史里多出一条
  // 无角色消息，之后每个请求都被服务端以 missing field `role` 拒绝。
  assert.equal(followups[0].role, "user");
  assert.match(followups[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("确认未知会话返回 404", async () => {
  const store = createStore();
  const handler = createHandlers({ store, clock: () => START }).handle;
  const res = await call(handler, postReq("/vibe-phase/confirm", { session: "nobody", phase: 2 }));
  assert.equal(res.status, 404);
  assert.equal(res.body.error, "unknown-session");
});

test("确认非法阶段返回 400 且不发消息", async () => {
  const store = createStore();
  const tool = createTool({ store });
  const handler = createHandlers({ store, clock: () => START }).handle;
  const { agent, followups } = makeAgent("s1");
  await tool.execute({ action: "enter", phase: 1 }, { agent });

  const res = await call(handler, postReq("/vibe-phase/confirm", { session: "s1", phase: 9 }));
  assert.equal(res.status, 400);
  assert.equal(followups.length, 0);
  assert.equal(store.get("s1").state.phase, 1);
});

test("会话没有可用 agent 时返回 409，状态不动", async () => {
  const store = createStore();
  const tool = createTool({ store });
  const handler = createHandlers({ store, clock: () => START }).handle;
  const { agent } = makeAgent("s1");
  await tool.execute({ action: "enter", phase: 1 }, { agent });

  store.get("s1").agent = undefined;
  const res = await call(handler, postReq("/vibe-phase/confirm", { session: "s1", phase: 2 }));
  assert.equal(res.status, 409);
  assert.equal(store.get("s1").state.phase, 1);
});

test("followup 失败时返回 502 并保持原状态", async () => {
  const store = createStore();
  const tool = createTool({ store });
  const handler = createHandlers({ store, clock: () => START }).handle;
  const { agent } = makeAgent("s1");
  agent.followup = () => {
    throw new Error("boom");
  };
  await tool.execute({ action: "enter", phase: 1 }, { agent });
  await tool.execute({ action: "request", phase: 2 }, { agent });

  const res = await call(handler, postReq("/vibe-phase/confirm", { session: "s1", phase: 2 }));
  assert.equal(res.status, 502);
  assert.equal(store.get("s1").state.phase, 1);
  assert.equal(store.get("s1").state.pending, 2);
});

test("冷却期内的确认请求是静默成功，不重复发消息", async () => {
  const store = createStore();
  const tool = createTool({ store });
  let now = START;
  const handler = createHandlers({ store, clock: () => now }).handle;
  const { agent, followups } = makeAgent("s1");

  await tool.execute({ action: "enter", phase: 4 }, { agent });
  const first = await call(handler, postReq("/vibe-phase/confirm", { session: "s1", phase: 5 }));
  assert.equal(first.body.state.precommit, true);

  now = START + 500;
  const second = await call(handler, postReq("/vibe-phase/confirm", { session: "s1", phase: 5 }));
  assert.equal(second.status, 200);
  assert.equal(second.body.quiet, true);
  assert.equal(second.body.state.authorized, false);
  assert.equal(followups.length, 1);

  now = START + 3000;
  const third = await call(handler, postReq("/vibe-phase/confirm", { session: "s1", phase: 5 }));
  assert.equal(third.body.state.authorized, true);
  assert.equal(followups.length, 2);
  assert.match(followups[1].content[0].text, /授权提交/);
});

test("reset 清掉会话状态", async () => {
  const store = createStore();
  const tool = createTool({ store });
  const handler = createHandlers({ store, clock: () => START }).handle;
  const { agent } = makeAgent("s1");
  await tool.execute({ action: "enter", phase: 2 }, { agent });

  const res = await call(handler, postReq("/vibe-phase/reset", { session: "s1" }));
  assert.equal(res.status, 200);
  assert.equal(res.body.state, null);

  const state = await call(handler, getReq("/vibe-phase/state?session=s1"));
  assert.equal(state.body.state, null);
});

test("坏 JSON 与未知路由各自返回 400 / 404", async () => {
  const store = createStore();
  const handler = createHandlers({ store, clock: () => START }).handle;

  const bad = { method: "POST", url: "/vibe-phase/confirm", async *[Symbol.asyncIterator]() { yield Buffer.from("{ nope"); } };
  const badRes = await call(handler, bad);
  assert.equal(badRes.status, 400);

  const missing = await call(handler, getReq("/vibe-phase/nope"));
  assert.equal(missing.status, 404);
});

test("agent 销毁时清掉它的阶段状态", async () => {
  const { ctx, tools, routes, listeners } = createHarness();
  apply(ctx, {});
  const tool = tools[0];
  const handler = routes[0].handler;
  const { agent } = makeAgent("s1");

  await tool.execute({ action: "enter", phase: 2 }, { agent });
  const before = await call(handler, getReq("/vibe-phase/state?session=s1"));
  assert.equal(before.body.state.phase, 2);

  listeners.get("agent/disposed")({ agent });
  const after = await call(handler, getReq("/vibe-phase/state?session=s1"));
  assert.equal(after.body.state, null);
});

test("sessionIdOf 兼容几种挂法", () => {
  assert.equal(sessionIdOf({ sessionId: "a" }), "a");
  assert.equal(sessionIdOf({ session: { id: "b" } }), "b");
  assert.equal(sessionIdOf({ id: "c" }), "c");
  assert.equal(sessionIdOf(undefined), undefined);
});

test("open 在没有流程时建出阶段一，且不发任何消息", async () => {
  const store = createStore();
  const handler = createHandlers({ store, clock: () => START }).handle;
  const { agent, followups } = makeAgent("s1");

  const res = await call(handler, postReq("/vibe-phase/open", { session: "s1" }));
  assert.equal(res.status, 200);
  assert.equal(res.body.state.phase, 1);
  assert.equal(followups.length, 0);

  store.ensure("s1", agent);
  assert.equal(store.get("s1").state.phase, 1);
});

test("open 对已有状态幂等，不会把阶段重置回一", async () => {
  const store = createStore();
  const tool = createTool({ store });
  const handler = createHandlers({ store, clock: () => START }).handle;
  const { agent } = makeAgent("s1");

  await tool.execute({ action: "enter", phase: 3 }, { agent });
  const res = await call(handler, postReq("/vibe-phase/open", { session: "s1" }));
  assert.equal(res.body.state.phase, 3);
});

test("open 缺会话 id 返回 400", async () => {
  const store = createStore();
  const handler = createHandlers({ store, clock: () => START }).handle;
  const res = await call(handler, postReq("/vibe-phase/open", {}));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "missing-session");
});

test("没有可用 agent 时点阶段返回 409，状态不动", async () => {
  const store = createStore();
  const handler = createHandlers({ store, clock: () => START }).handle;
  await call(handler, postReq("/vibe-phase/open", { session: "s1" }));

  const res = await call(handler, postReq("/vibe-phase/confirm", { session: "s1", phase: 2 }));
  assert.equal(res.status, 409);
  assert.equal(store.get("s1").state.phase, 1);
});

test("open 顺手挂上会话当前的 agent，开出来的条能直接点", async () => {
  const store = createStore();
  const { agent, followups } = makeAgent("s1");
  const handler = createHandlers({ store, clock: () => START, lookupAgent: (id) => (id === "s1" ? agent : undefined) }).handle;

  const opened = await call(handler, postReq("/vibe-phase/open", { session: "s1" }));
  assert.equal(opened.body.state.phase, 1);
  assert.equal(followups.length, 0);

  const res = await call(handler, postReq("/vibe-phase/confirm", { session: "s1", phase: 2 }));
  assert.equal(res.status, 200);
  assert.equal(followups.length, 1);
});

test("条目里的 agent 丢了也能从注册表补回来", async () => {
  const store = createStore();
  const tool = createTool({ store });
  const { agent, followups } = makeAgent("s1");
  await tool.execute({ action: "enter", phase: 1 }, { agent });

  const handler = createHandlers({ store, clock: () => START, lookupAgent: () => agent }).handle;
  store.get("s1").agent = undefined;

  const res = await call(handler, postReq("/vibe-phase/confirm", { session: "s1", phase: 2 }));
  assert.equal(res.status, 200);
  assert.equal(followups.length, 1);
  assert.equal(store.get("s1").agent, agent);
});

test("非 JSON 的 POST 一律 400，连体都不读", async () => {
  const store = createStore();
  const handler = createHandlers({ store, clock: () => START }).handle;
  const form = {
    method: "POST",
    url: "/vibe-phase/confirm",
    headers: { "content-type": "text/plain" },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ session: "s1", phase: 2 }));
    },
  };
  const res = await call(handler, form);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "bad-content-type");
});

test("缺 session 与数组体的错误码三个路由一致", async () => {
  const store = createStore();
  const handler = createHandlers({ store, clock: () => START }).handle;

  const missing = await call(handler, postReq("/vibe-phase/confirm", { phase: 2 }));
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, "missing-session");

  const array = {
    method: "POST",
    url: "/vibe-phase/open",
    headers: { "content-type": "application/json" },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from("[1,2,3]");
    },
  };
  const bad = await call(handler, array);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "bad-body");
});

test("确认时带上分两步的选项，消息与状态都按 2a 走", async () => {
  const store = createStore();
  const tool = createTool({ store });
  const handler = createHandlers({ store, clock: () => START }).handle;
  const { agent, followups } = makeAgent("s1");
  await tool.execute({ action: "enter", phase: 1 }, { agent });

  const res = await call(
    handler,
    postReq("/vibe-phase/confirm", { session: "s1", phase: 2, options: { devSplit: true } }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.state.phase, 2);
  assert.equal(res.body.state.devMode, "split");
  assert.equal(res.body.state.devStep, "a");
  assert.match(followups[0].content[0].text, /确认进入阶段 2a/);
});

test("2a 之后再确认阶段二：进 2b，且不需要选项", async () => {
  const store = createStore();
  const tool = createTool({ store });
  const handler = createHandlers({ store, clock: () => START }).handle;
  const { agent, followups } = makeAgent("s1");
  await tool.execute({ action: "enter", phase: 1 }, { agent });
  await call(handler, postReq("/vibe-phase/confirm", { session: "s1", phase: 2, options: { devSplit: true } }));

  const res = await call(handler, postReq("/vibe-phase/confirm", { session: "s1", phase: 2 }));
  assert.equal(res.body.state.devStep, "b");
  assert.equal(followups.length, 2);
  assert.match(followups[1].content[0].text, /确认进入阶段 2b/);
});

test("确认时带上验证方式，消息列出方式且状态记住它", async () => {
  const store = createStore();
  const tool = createTool({ store });
  const handler = createHandlers({ store, clock: () => START }).handle;
  const { agent, followups } = makeAgent("s1");
  await tool.execute({ action: "enter", phase: 3 }, { agent });

  const res = await call(
    handler,
    postReq("/vibe-phase/confirm", { session: "s1", phase: 4, options: { verify: ["e2e", "unit"] } }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.state.verify, ["unit", "e2e"]);
  assert.match(followups[0].content[0].text, /验证方式：全量单元测试、端到端验证/);
});

test("非法的选项组合返回 400，不推进状态也不发消息", async () => {
  const store = createStore();
  const tool = createTool({ store });
  const handler = createHandlers({ store, clock: () => START }).handle;
  const { agent, followups } = makeAgent("s1");
  await tool.execute({ action: "enter", phase: 3 }, { agent });

  for (const options of [{ verify: [] }, { verify: ["nope"] }, { devSplit: "yes" }, []]) {
    const res = await call(handler, postReq("/vibe-phase/confirm", { session: "s1", phase: 4, options }));
    assert.equal(res.status, 400, JSON.stringify(options));
    assert.equal(res.body.error, "invalid-options");
  }
  assert.equal(followups.length, 0);
  assert.equal(store.get("s1").state.phase, 3);
});

