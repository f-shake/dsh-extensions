import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * client.js 是给 `window.__ModuleLoader__` 用的普通脚本，不是 ESM 模块。
 * 这里用 `new Function` 把一个假的 window 传进去执行它，再把 factory 取出来——
 * 这样测的就是真正会被浏览器加载的那份代码，而不是另抄一份逻辑。
 * @returns {{ apply: Function }} 插件对象。
 */
function loadPlugin() {
  const loaded = [];
  const fakeWindow = { __ModuleLoader__: { load: (module) => loaded.push(module) } };
  const source = readFileSync(fileURLToPath(new URL("../client.js", import.meta.url)), "utf8");
  new Function("window", source)(fakeWindow);
  assert.equal(loaded.length, 1, "client.js 应该注册一个模块");
  assert.equal(loaded[0].id, "@local/session-list-cache");
  return loaded[0].factory();
}

/** 记录 disposer 的 Cordis 上下文替身。 */
function fakeCtx() {
  const disposers = [];
  return {
    disposers,
    effect(factory) {
      disposers.push(factory());
    },
  };
}

/** 一次合法的会话列表 RPC 请求体。rpcId 每次请求都不同，客户端会校验它。 */
function listBody(args = { _request: {} }, rpcId = "11111111-1111-1111-1111-111111111111") {
  return JSON.stringify({
    type: "client-request",
    rpcId,
    method: "session/list",
    payload: { args },
  });
}

/** 列表端点的相对路径：客户端就是这么拼的，没有前导斜杠。 */
const LIST_URL = "api/session/list";

/** 会话列表缓存记录的键（与插件里的拼法一致）。 */
const LIST_KEY = 'dsh-list-cache:v1:session/list:{"_request":{}}';

/** 造一个 JSON 响应。 */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * 装一个可控的 fetch 替身，行为可以中途换掉。
 *
 * 中途不能 restore 再装新的：restore 会把插件包好的那一层也一起冲掉，
 * 后续调用就绕过被测代码了。
 * @param {(input: string, init: object, nth: number) => Promise<Response>} handler - 默认行为。
 * @returns {{ calls: Array<object>, setHandler: Function, restore: () => void }} 替换器与还原器。
 */
function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  let current = handler;
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    return current(input, init, calls.length);
  };
  return {
    calls,
    setHandler(next) {
      current = next;
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** 等后台回源那一路跑完（它是不被 await 的）。 */
async function settle() {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** 一个永远不 resolve 的 Promise，用来证明「命中缓存时不等网络」。 */
function never() {
  return new Promise(() => {});
}

/** 替换 localStorage；Node 默认的那个是「不可用」的访问器，直接赋值不可靠。 */
function setStorage(storage) {
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
}

/** 去掉测试装上的 localStorage。 */
function clearStorage() {
  Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true, writable: true });
}

/** 造一个 Map 支撑的 localStorage 替身。 */
function mapStorage(initial = []) {
  const entries = new Map(initial);
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key),
  };
}

test("非目标请求原样透传：GET 与别的端点都不碰", async () => {
  const fetchStub = stubFetch(async () => jsonResponse({ other: true }));
  const plugin = loadPlugin();
  const ctx = fakeCtx();
  plugin.apply(ctx, {});

  const first = await globalThis.fetch("api/session/create", { method: "POST", body: listBody() });
  const second = await globalThis.fetch(LIST_URL, { method: "GET" });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(fetchStub.calls.length, 2);
  ctx.disposers.forEach((dispose) => dispose());
  fetchStub.restore();
});

test("请求体不是会话列表时透传（method 字段不符）", async () => {
  const fetchStub = stubFetch(async () => jsonResponse({ ok: true }));
  const plugin = loadPlugin();
  const ctx = fakeCtx();
  plugin.apply(ctx, {});

  const body = JSON.stringify({ type: "client-request", rpcId: "x", method: "session/list2", payload: { args: {} } });
  await globalThis.fetch(LIST_URL, { method: "POST", body });
  assert.equal(fetchStub.calls.length, 1);
  ctx.disposers.forEach((dispose) => dispose());
  fetchStub.restore();
});

test("首次请求走网络、原样返回响应，并把内容写进缓存", async () => {
  const payload = { result: { ok: true, value: { sessions: [{ id: "a" }] } } };
  const fetchStub = stubFetch(async () => jsonResponse(payload));
  const plugin = loadPlugin();
  const ctx = fakeCtx();
  plugin.apply(ctx, {});

  const response = await globalThis.fetch(LIST_URL, { method: "POST", body: listBody() });
  assert.deepEqual(await response.json(), payload);
  await settle();

  // 换成一个永不应答的网络：还能返回内容，就说明命中了缓存。
  fetchStub.setHandler(never);
  const cached = await globalThis.fetch(LIST_URL, { method: "POST", body: listBody() });
  assert.deepEqual((await cached.json()).result, payload.result);
  assert.equal(fetchStub.calls.length, 2, "命中缓存时仍应在后台发出一次真实请求");

  ctx.disposers.forEach((dispose) => dispose());
  fetchStub.restore();
});

test("命中缓存时用本次请求的 rpcId 重建信封", async () => {
  const result = { ok: true, value: { sessions: [] } };
  const fetchStub = stubFetch(async () => jsonResponse({ result }));
  const plugin = loadPlugin();
  const ctx = fakeCtx();
  plugin.apply(ctx, {});
  await globalThis.fetch(LIST_URL, { method: "POST", body: listBody({}, "rpc-first") });
  await settle();

  fetchStub.setHandler(never);
  const cached = await globalThis.fetch(LIST_URL, { method: "POST", body: listBody({}, "rpc-second") });
  const envelope = await cached.json();
  // 回放上次的 rpcId 会被客户端判为不一致并抛错，这里必须是本次的。
  assert.equal(envelope.rpcId, "rpc-second");
  assert.equal(envelope.type, "server-response");
  assert.deepEqual(envelope.result, result);

  ctx.disposers.forEach((dispose) => dispose());
  fetchStub.restore();
});

test("业务失败（result.ok=false）的 200 响应不写缓存", async () => {
  const failure = { result: { ok: false, error: { code: "gateway/internal", message: "boom", details: {} } } };
  const success = { result: { ok: true, fresh: true } };
  // 第二次换成成功：若失败信封被缓存下来，第二次会拿到旧失败而不是这条新内容。
  const fetchStub = stubFetch(async (input, init, nth) => jsonResponse(nth === 1 ? failure : success));
  const plugin = loadPlugin();
  const ctx = fakeCtx();
  plugin.apply(ctx, {});

  const first = await globalThis.fetch(LIST_URL, { method: "POST", body: listBody() });
  assert.equal((await first.json()).result.ok, false);
  await settle();

  const second = await globalThis.fetch(LIST_URL, { method: "POST", body: listBody() });
  assert.deepEqual((await second.json()).result, success.result, "失败信封不能进缓存");

  ctx.disposers.forEach((dispose) => dispose());
  fetchStub.restore();
});

test("命中缓存时不再等网络：网络挂住也能立刻拿到内容", async () => {
  const payload = { result: { ok: true } };
  const fetchStub = stubFetch(async () => jsonResponse(payload));
  const plugin = loadPlugin();
  const ctx = fakeCtx();
  plugin.apply(ctx, {});
  await globalThis.fetch(LIST_URL, { method: "POST", body: listBody() });
  await settle();

  fetchStub.setHandler(never);
  const started = Date.now();
  const response = await globalThis.fetch(LIST_URL, { method: "POST", body: listBody() });
  assert.deepEqual((await response.json()).result, payload.result);
  assert.ok(Date.now() - started < 50, "不应等待网络");

  ctx.disposers.forEach((dispose) => dispose());
  fetchStub.restore();
});

test("缓存记录版本不符时作废，走网络", async () => {
  const storage = mapStorage([[LIST_KEY, JSON.stringify({ v: 0, savedAt: 1, body: "{}" })]]);
  setStorage(storage);

  const payload = { result: { ok: true, fresh: true } };
  const fetchStub = stubFetch(async () => jsonResponse(payload));
  const plugin = loadPlugin();
  const ctx = fakeCtx();
  plugin.apply(ctx, {});

  const response = await globalThis.fetch(LIST_URL, { method: "POST", body: listBody() });
  assert.deepEqual(await response.json(), payload);
  assert.equal(fetchStub.calls.length, 1, "版本不符必须回源");

  ctx.disposers.forEach((dispose) => dispose());
  fetchStub.restore();
  clearStorage();
});

test("缓存记录损坏时删除并走网络", async () => {
  const storage = mapStorage([[LIST_KEY, "{not json"]]);
  setStorage(storage);
  const fetchStub = stubFetch(async () => jsonResponse({ ok: true }));
  const plugin = loadPlugin();
  const ctx = fakeCtx();
  plugin.apply(ctx, {});

  const response = await globalThis.fetch(LIST_URL, { method: "POST", body: listBody() });
  assert.equal(response.status, 200);
  assert.equal(fetchStub.calls.length, 1);
  assert.equal(storage.entries.has(LIST_KEY), false, "坏记录应被清掉");

  ctx.disposers.forEach((dispose) => dispose());
  fetchStub.restore();
  clearStorage();
});

test("回源失败不覆盖旧缓存", async () => {
  const payload = { result: { ok: true, generation: 1 } };
  const fetchStub = stubFetch(async () => jsonResponse(payload));
  const plugin = loadPlugin();
  const ctx = fakeCtx();
  plugin.apply(ctx, {});
  await globalThis.fetch(LIST_URL, { method: "POST", body: listBody() });
  await settle();

  fetchStub.setHandler(async () => {
    throw new Error("网络断了");
  });
  // 命中缓存立刻返回；后台那一次失败，不能把缓存清掉。
  const cached = await globalThis.fetch(LIST_URL, { method: "POST", body: listBody() });
  assert.deepEqual((await cached.json()).result, payload.result);
  await settle();

  fetchStub.setHandler(never);
  const again = await globalThis.fetch(LIST_URL, { method: "POST", body: listBody() });
  assert.deepEqual((await again.json()).result, payload.result, "旧缓存必须还在");

  ctx.disposers.forEach((dispose) => dispose());
  fetchStub.restore();
});

test("非 2xx 的响应不写缓存", async () => {
  const fetchStub = stubFetch(async () => jsonResponse({ error: "boom" }, 500));
  const plugin = loadPlugin();
  const ctx = fakeCtx();
  plugin.apply(ctx, {});
  const first = await globalThis.fetch(LIST_URL, { method: "POST", body: listBody() });
  assert.equal(first.status, 500);
  await settle();

  const second = await globalThis.fetch(LIST_URL, { method: "POST", body: listBody() });
  assert.equal(second.status, 500);
  assert.equal(fetchStub.calls.length, 2, "没有缓存，第二次只能再回源");

  ctx.disposers.forEach((dispose) => dispose());
  fetchStub.restore();
});

test("非 JSON 响应不写缓存", async () => {
  const fetchStub = stubFetch(
    async () => new Response("<html>oops</html>", { status: 200, headers: { "content-type": "text/html" } }),
  );
  const plugin = loadPlugin();
  const ctx = fakeCtx();
  plugin.apply(ctx, {});
  await globalThis.fetch(LIST_URL, { method: "POST", body: listBody() });
  await settle();
  await globalThis.fetch(LIST_URL, { method: "POST", body: listBody() });
  assert.equal(fetchStub.calls.length, 2);

  ctx.disposers.forEach((dispose) => dispose());
  fetchStub.restore();
});

test("响应超过 maxBytes 时不缓存", async () => {
  const big = (generation) => ({ result: { ok: true, generation, padding: "x".repeat(2048) } });
  // 第二次返回不同内容：若超限记录被缓存，第二次会拿到 generation 1。
  const fetchStub = stubFetch(async (input, init, nth) => jsonResponse(big(nth)));
  const plugin = loadPlugin();
  const ctx = fakeCtx();
  plugin.apply(ctx, { maxBytes: 512 });
  await globalThis.fetch(LIST_URL, { method: "POST", body: listBody() });
  await settle();
  const second = await globalThis.fetch(LIST_URL, { method: "POST", body: listBody() });
  assert.equal((await second.json()).result.generation, 2, "超过上限的记录不能进缓存");

  ctx.disposers.forEach((dispose) => dispose());
  fetchStub.restore();
});

test("args 不同的两次调用互不覆盖", async () => {
  const fetchStub = stubFetch(async (input, init) => {
    const args = JSON.parse(init.body).payload.args;
    return jsonResponse({ result: { ok: true, args } });
  });
  const plugin = loadPlugin();
  const ctx = fakeCtx();
  plugin.apply(ctx, {});

  await globalThis.fetch(LIST_URL, { method: "POST", body: listBody({ _request: { limit: 10 } }) });
  await globalThis.fetch(LIST_URL, { method: "POST", body: listBody({ _request: { limit: 20 } }) });
  await settle();

  fetchStub.setHandler(never);
  const ten = await globalThis.fetch(LIST_URL, { method: "POST", body: listBody({ _request: { limit: 10 } }) });
  assert.deepEqual((await ten.json()).result.args, { _request: { limit: 10 } });

  ctx.disposers.forEach((dispose) => dispose());
  fetchStub.restore();
});

test("storage 不可用（隐私模式）时退化为内存，功能照常", async () => {
  setStorage({
    getItem() {
      throw new Error("SecurityError");
    },
    setItem() {
      throw new Error("SecurityError");
    },
    removeItem() {},
  });
  const payload = { result: { ok: true } };
  const fetchStub = stubFetch(async () => jsonResponse(payload));
  const plugin = loadPlugin();
  const ctx = fakeCtx();
  plugin.apply(ctx, {});
  assert.equal(globalThis.__dshSessionListCache(), "memory");

  await globalThis.fetch(LIST_URL, { method: "POST", body: listBody() });
  await settle();

  fetchStub.setHandler(never);
  const cached = await globalThis.fetch(LIST_URL, { method: "POST", body: listBody() });
  assert.deepEqual((await cached.json()).result, payload.result);

  ctx.disposers.forEach((dispose) => dispose());
  fetchStub.restore();
  clearStorage();
});

test("localStorage 可用时缓存能跨一次「重启」复用", async () => {
  const storage = mapStorage();
  setStorage(storage);
  const payload = { result: { ok: true, generation: 7 } };

  const fetchStub = stubFetch(async () => jsonResponse(payload));
  const first = loadPlugin();
  const firstCtx = fakeCtx();
  first.apply(firstCtx, {});
  await globalThis.fetch(LIST_URL, { method: "POST", body: listBody() });
  await settle();
  firstCtx.disposers.forEach((dispose) => dispose());

  // 第二次「启动」：全新的插件实例，网络挂住，仍应拿到上次的内容。
  fetchStub.setHandler(never);
  const second = loadPlugin();
  const secondCtx = fakeCtx();
  second.apply(secondCtx, {});
  const response = await globalThis.fetch(LIST_URL, { method: "POST", body: listBody(undefined, "rpc-restart") });
  assert.deepEqual((await response.json()).result, payload.result);

  secondCtx.disposers.forEach((dispose) => dispose());
  fetchStub.restore();
  clearStorage();
});

test("indexedDB 存在但打不开时退到 localStorage", async () => {
  const storage = mapStorage();
  setStorage(storage);
  Object.defineProperty(globalThis, "indexedDB", {
    value: {
      open() {
        throw new Error("blocked by policy");
      },
    },
    configurable: true,
    writable: true,
  });

  try {
    const payload = { result: { ok: true } };
    const fetchStub = stubFetch(async () => jsonResponse(payload));
    const plugin = loadPlugin();
    const ctx = fakeCtx();
    plugin.apply(ctx, {});

    await globalThis.fetch(LIST_URL, { method: "POST", body: listBody() });
    await settle();

    // 只判断「存在」不够：打不开就得退到下一档，否则缓存等于关闭。
    assert.equal(globalThis.__dshSessionListCache(), "localstorage");
    assert.ok(
      [...storage.entries.keys()].some((key) => key.startsWith("dsh-list-cache:v1:session/list:")),
      "记录应该真的写进 localStorage",
    );

    fetchStub.setHandler(never);
    const cached = await globalThis.fetch(LIST_URL, { method: "POST", body: listBody() });
    assert.deepEqual((await cached.json()).result, payload.result);

    ctx.disposers.forEach((dispose) => dispose());
    fetchStub.restore();
  } finally {
    Object.defineProperty(globalThis, "indexedDB", { value: undefined, configurable: true, writable: true });
    clearStorage();
  }
});

test("maxBytes 按 UTF-8 字节计，不是字符数", async () => {
  // 2048 个汉字在 UTF-8 下约 6 KB，但 String#length 只数到 2048。
  const payload = { result: { ok: true, padding: "中".repeat(2048) } };
  const fetchStub = stubFetch(async () => jsonResponse(payload));
  const plugin = loadPlugin();
  const ctx = fakeCtx();
  plugin.apply(ctx, { maxBytes: 4096 });
  await globalThis.fetch(LIST_URL, { method: "POST", body: listBody() });
  await settle();
  await globalThis.fetch(LIST_URL, { method: "POST", body: listBody() });
  assert.equal(fetchStub.calls.length, 2, "按字符数算会误判成没超限，必须按字节");

  ctx.disposers.forEach((dispose) => dispose());
  fetchStub.restore();
});

test("IndexedDB 的 open 被 block 时按真实形状失败并降级到 localStorage", async () => {
  // 真实浏览器里失败走 onblocked / onerror 回调，不是同步抛出。
  let request = null;
  Object.defineProperty(globalThis, "indexedDB", {
    value: {
      open() {
        request = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
        return request;
      },
    },
    configurable: true,
    writable: true,
  });
  const storage = mapStorage();
  setStorage(storage);

  try {
    const payload = { result: { ok: true } };
    const fetchStub = stubFetch(async () => jsonResponse(payload));
    const plugin = loadPlugin();
    const ctx = fakeCtx();
    plugin.apply(ctx, {});

    const pending = globalThis.fetch(LIST_URL, { method: "POST", body: listBody() });
    assert.notEqual(request, null, "读取应已发起 IDB open");
    request.onblocked();

    const response = await pending;
    assert.deepEqual((await response.json()).result, payload.result);
    assert.equal(globalThis.__dshSessionListCache(), "localstorage", "block 之后应退到下一档");

    ctx.disposers.forEach((dispose) => dispose());
    fetchStub.restore();
  } finally {
    Object.defineProperty(globalThis, "indexedDB", { value: undefined, configurable: true, writable: true });
    clearStorage();
  }
});

test("enabled:false 时完全不包装 fetch", async () => {
  const fetchStub = stubFetch(async () => jsonResponse({ ok: true }));
  const before = globalThis.fetch;
  const plugin = loadPlugin();
  const ctx = fakeCtx();
  plugin.apply(ctx, { enabled: false });
  assert.equal(globalThis.fetch, before);
  assert.equal(ctx.disposers.length, 0);
  fetchStub.restore();
});

test("存储一直不回调时，读取超时后直接走网络（不挂住应用）", async () => {
  // IndexedDB 在隐私策略或建库异常时可能既不 success 也不 error。
  // 读取是「加速」手段，绝不能因为它把应用自己的列表请求挂死。
  Object.defineProperty(globalThis, "indexedDB", {
    value: {
      open() {
        return { result: undefined, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      },
    },
    configurable: true,
    writable: true,
  });

  try {
    const payload = { result: { ok: true } };
    const fetchStub = stubFetch(async () => jsonResponse(payload));
    const plugin = loadPlugin();
    const ctx = fakeCtx();
    plugin.apply(ctx, {});

    const started = Date.now();
    const response = await globalThis.fetch(LIST_URL, { method: "POST", body: listBody() });
    const elapsed = Date.now() - started;
    assert.deepEqual(await response.json(), payload);
    assert.equal(fetchStub.calls.length, 1, "超时之后必须回源");
    assert.ok(elapsed >= 200 && elapsed < 2000, `应在超时附近放行，实际 ${elapsed}ms`);

    // 超时不能只影响这一次：挂死的后端要被淘汰，否则每次请求都要再等一个超时。
    const secondStarted = Date.now();
    await globalThis.fetch(LIST_URL, { method: "POST", body: listBody() });
    const secondElapsed = Date.now() - secondStarted;
    assert.ok(secondElapsed < 150, `第二次不该再等超时，实际 ${secondElapsed}ms`);
    assert.equal(globalThis.__dshSessionListCache(), "memory", "超时后应退到下一档");

    ctx.disposers.forEach((dispose) => dispose());
    fetchStub.restore();
  } finally {
    Object.defineProperty(globalThis, "indexedDB", { value: undefined, configurable: true, writable: true });
  }
});

test("还原器把 fetch 换回原函数", async () => {
  const fetchStub = stubFetch(async () => jsonResponse({ ok: true }));
  const before = globalThis.fetch;
  const plugin = loadPlugin();
  const ctx = fakeCtx();
  plugin.apply(ctx, {});
  assert.notEqual(globalThis.fetch, before);

  ctx.disposers.forEach((dispose) => dispose());
  assert.equal(globalThis.fetch, before);
  assert.equal(globalThis.__dshSessionListCache, undefined);  fetchStub.restore();
});
