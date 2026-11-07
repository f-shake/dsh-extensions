import test from "node:test";
import assert from "node:assert/strict";

import {
  apply,
  delayForRetry,
  normalizeConfig,
  resolveDelay,
  totalAttempts,
} from "../index.js";

/**
 * 造一个只保留被测能力的 Cordis 上下文替身。
 * @returns {{ctx: object, handler: () => Function, effectDisposers: Function[]}} 上下文与取 handler 的入口。
 */
function fakeContext() {
  /** @type {Map<string, Function[]>} */
  const listeners = new Map();
  /** @type {Function[]} */
  const effectDisposers = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(eventName, callback) {
      const list = listeners.get(eventName) ?? [];
      list.push(callback);
      listeners.set(eventName, list);
      return () => {
        const current = listeners.get(eventName) ?? [];
        const index = current.indexOf(callback);
        if (index >= 0) current.splice(index, 1);
      };
    },
    effect(setup) {
      const dispose = setup();
      if (typeof dispose === "function") effectDisposers.push(dispose);
    },
  };
  const handler = () => listeners.get("agent/request-error")?.[0];
  return { ctx, handler, effectDisposers };
}

/**
 * 造一个记录事件的 agent。
 * @returns {{agent: object, events: Array<{type: string, data: object}>}} agent 与事件记录。
 */
function fakeAgent() {
  const events = [];
  return {
    events,
    agent: {
      session: {
        append(type, data) {
          events.push({ type, data });
        },
      },
    },
  };
}

/** 不被消耗的下游策略：真实 agent-loop 的 waterfall 终点返回 undefined。 */
async function terminal() {
  return undefined;
}

/** 等一轮宏任务，让等待中的定时器跑完。 */
function tick(ms = 5) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("默认配置就是 1s×5 → 2s×5 → 10s×100", () => {
  const config = normalizeConfig(undefined);
  assert.equal(totalAttempts(config.steps), 110);
  assert.deepEqual(
    config.steps.map((step) => [step.delayMs, step.attempts]),
    [
      [1000, 5],
      [2000, 5],
      [10000, 100],
    ],
  );
  assert.equal(config.jitterRatio, 0, "默认不加抖动，保证阶梯准时");
  assert.equal(config.retryAfter, "floor");
  assert.equal(config.enabled, true);
});

test("阶梯边界：第 5/6/10/11/110/111 次", () => {
  const { steps } = normalizeConfig(undefined);
  assert.equal(delayForRetry(steps, 1), 1000);
  assert.equal(delayForRetry(steps, 5), 1000);
  assert.equal(delayForRetry(steps, 6), 2000);
  assert.equal(delayForRetry(steps, 10), 2000);
  assert.equal(delayForRetry(steps, 11), 10000);
  assert.equal(delayForRetry(steps, 110), 10000);
  assert.equal(delayForRetry(steps, 111), undefined, "阶梯用尽后不再重试");
});

test("attempts 为 0 的档位被跳过", () => {
  const config = normalizeConfig({
    steps: [
      { delayMs: 500, attempts: 0 },
      { delayMs: 3000, attempts: 2 },
    ],
  });
  assert.equal(delayForRetry(config.steps, 1), 3000);
  assert.equal(delayForRetry(config.steps, 2), 3000);
  assert.equal(delayForRetry(config.steps, 3), undefined);
});

test("jitterRatio 为 0 时延迟精确，大于 0 时落在区间内", () => {
  const exact = normalizeConfig({ steps: [{ delayMs: 1000, attempts: 1 }] });
  assert.equal(resolveDelay(1000, undefined, exact, () => 0.5), 1000);

  const jittered = normalizeConfig({
    steps: [{ delayMs: 1000, attempts: 1 }],
    jitterRatio: 0.1,
  });
  assert.equal(resolveDelay(1000, undefined, jittered, () => 0), 900);
  assert.equal(resolveDelay(1000, undefined, jittered, () => 1), 1100);
});

test("retryAfter=floor 时听服务端的更久要求，ignore 时严格走阶梯", () => {
  const floor = normalizeConfig({
    steps: [{ delayMs: 1000, attempts: 1 }],
    retryAfterMaxMs: 60_000,
  });
  assert.equal(resolveDelay(1000, 30_000, floor), 30_000);
  assert.equal(resolveDelay(1000, 200, floor), 1000, "服务端要求更短时不提前");

  const ignore = normalizeConfig({
    steps: [{ delayMs: 1000, attempts: 1 }],
    retryAfter: "ignore",
  });
  assert.equal(resolveDelay(1000, 30_000, ignore), 1000);
});

test("服务端要求的等待超过容忍上限时放弃重试", () => {
  const strict = normalizeConfig({ steps: [{ delayMs: 1000, attempts: 5 }] });
  assert.equal(strict.retryAfterMaxMs, 1000, "默认上限就是阶梯最高档");
  assert.equal(resolveDelay(1000, 3600_000, strict), undefined, "一小时不该跟着等");
  assert.equal(resolveDelay(1000, 800, strict), 1000, "上限以内照听");
});

test("非法配置直接报错，不静默退回默认阶梯", () => {
  assert.throws(() => normalizeConfig({ steps: [] }), /steps 必须是非空数组/u);
  assert.throws(() => normalizeConfig({ steps: [{ delayMs: 0, attempts: 1 }] }), /delayMs/u);
  assert.throws(
    () => normalizeConfig({ steps: [{ delayMs: 100, attempts: 1.5 }] }),
    /attempts 必须是非负整数/u,
  );
  assert.throws(() => normalizeConfig({ jitterRatio: 2 }), /jitterRatio/u);
  assert.throws(() => normalizeConfig({ retryAfter: "later" }), /retryAfter/u);
});

test("拼错的配置键、非布尔 enabled、非数字字段一律报错", () => {
  assert.throws(() => normalizeConfig({ stepz: [] }), /未知配置键 "stepz"/u);
  assert.throws(() => normalizeConfig({ retryAfters: "floor" }), /未知配置键 "retryAfters"/u);
  assert.throws(
    () => normalizeConfig({ steps: [{ delayMs: 100, attempts: 1, comment: "x" }] }),
    /未知配置键 "comment"/u,
  );
  assert.throws(() => normalizeConfig({ enabled: "false" }), /enabled 必须是布尔值/u);
  assert.throws(
    () => normalizeConfig({ steps: [{ delayMs: "100", attempts: 1 }] }),
    /delayMs 必须是/u,
  );
  assert.throws(
    () => normalizeConfig({ steps: [{ delayMs: 100, attempts: true }] }),
    /attempts 必须是非负整数/u,
  );
  assert.throws(
    () => normalizeConfig({ retryAfterMaxMs: 0 }),
    /retryAfterMaxMs 必须是/u,
  );
});

test("可重试错误码默认与内置插件一致", () => {
  const config = normalizeConfig(undefined);
  assert.deepEqual([...config.retryableCodes], [
    "EMPTY_RESPONSE",
    "RATE_LIMIT",
    "SERVER",
    "TIMEOUT",
    "TRANSPORT",
  ]);
});

test("命中阶梯：先落 llm/retry，等完再落 llm/retry-started，然后要求重试", async () => {
  const { ctx, handler } = fakeContext();
  apply(ctx, { steps: [{ delayMs: 1, attempts: 2 }] });
  const { agent, events } = fakeAgent();
  const failure = { code: "SERVER", message: "boom" };

  const decision = await handler()(
    { agent, turn: 1, step: 2, provider: "qwen-4b", failure },
    terminal,
  );

  assert.deepEqual(decision, { kind: "retry" });
  assert.deepEqual(
    events.map((event) => event.type),
    ["llm/retry", "llm/retry-started"],
  );
  const scheduled = events[0].data;
  assert.equal(scheduled.retry, 1);
  assert.equal(scheduled.turn, 1);
  assert.equal(scheduled.step, 2);
  assert.equal(scheduled.provider, "qwen-4b");
  assert.equal(scheduled.delayMs, 1);
  assert.equal(scheduled.mode, "normal");
  assert.equal(scheduled.maxRetries, 2);
  assert.equal(scheduled.failure, failure, "failure 必须原样透传，v0→v1 把它列为必填");
  assert.match(
    scheduled.retryId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    "retryId 必须是标准的 UUID 形状",
  );
  assert.deepEqual(events[1].data, {
    retryId: scheduled.retryId,
    turn: 1,
    step: 2,
    retry: 1,
  });
});

test("同一步内 retry 连续递增且 retryId 不变，换一步重新从 1 开始", async () => {
  const { ctx, handler } = fakeContext();
  apply(ctx, { steps: [{ delayMs: 1, attempts: 3 }] });
  const { agent, events } = fakeAgent();
  const fire = handler();

  const first = await fire(
    { agent, turn: 1, step: 1, provider: "p", failure: { code: "TIMEOUT" } },
    terminal,
  );
  const second = await fire(
    { agent, turn: 1, step: 1, provider: "p", failure: { code: "TIMEOUT" } },
    terminal,
  );
  assert.deepEqual(first, { kind: "retry" });
  assert.deepEqual(second, { kind: "retry" });

  const scheduled = events.filter((event) => event.type === "llm/retry").map((e) => e.data);
  assert.deepEqual(scheduled.map((data) => data.retry), [1, 2]);
  assert.equal(scheduled[0].retryId, scheduled[1].retryId);
  assert.equal(scheduled[0].policyKey, scheduled[1].policyKey, "同一条链的 policyKey 必须恒定");

  // 换到下一步：计数与 retryId 都重来
  await fire({ agent, turn: 1, step: 2, provider: "p", failure: { code: "TIMEOUT" } }, terminal);
  const third = events.filter((event) => event.type === "llm/retry").at(-1).data;
  assert.equal(third.retry, 1);
  assert.notEqual(third.retryId, scheduled[0].retryId);
});

test("不同 provider 各自计数", async () => {
  const { ctx, handler } = fakeContext();
  apply(ctx, { steps: [{ delayMs: 1, attempts: 5 }] });
  const { agent, events } = fakeAgent();
  const fire = handler();

  await fire({ agent, turn: 1, step: 1, provider: "a", failure: { code: "SERVER" } }, terminal);
  await fire({ agent, turn: 1, step: 1, provider: "b", failure: { code: "SERVER" } }, terminal);

  const retries = events.filter((event) => event.type === "llm/retry").map((e) => e.data.retry);
  assert.deepEqual(retries, [1, 1]);
});

test("阶梯用尽后交回下游，不再重试", async () => {
  const { ctx, handler } = fakeContext();
  apply(ctx, { steps: [{ delayMs: 1, attempts: 1 }] });
  const { agent, events } = fakeAgent();
  const fire = handler();

  await fire({ agent, turn: 1, step: 1, provider: "p", failure: { code: "SERVER" } }, terminal);
  let delegated = false;
  const decision = await fire(
    { agent, turn: 1, step: 1, provider: "p", failure: { code: "SERVER" } },
    async () => {
      delegated = true;
      return undefined;
    },
  );
  assert.equal(delegated, true);
  assert.equal(decision, undefined);
  assert.equal(events.filter((event) => event.type === "llm/retry").length, 1);
});

test("不可重试的错误码直接交给下游", async () => {
  const { ctx, handler } = fakeContext();
  apply(ctx, { steps: [{ delayMs: 1, attempts: 5 }] });
  const { agent, events } = fakeAgent();

  let delegated = false;
  const decision = await handler()(
    { agent, turn: 1, step: 1, provider: "p", failure: { code: "AUTH" } },
    async () => {
      delegated = true;
      return undefined;
    },
  );

  assert.equal(delegated, true);
  assert.equal(decision, undefined);
  assert.equal(events.length, 0, "不重试就不该发事件");
});

test("provider 配了 maxRetries: 0 时不重试", async () => {
  const { ctx, handler } = fakeContext();
  apply(ctx, { steps: [{ delayMs: 1, attempts: 5 }] });
  const { agent, events } = fakeAgent();

  let delegated = false;
  await handler()(
    {
      agent,
      turn: 1,
      step: 1,
      provider: "p",
      failure: { code: "SERVER" },
      retryPolicy: { mode: "normal", maxRetries: 0 },
    },
    async () => {
      delegated = true;
      return undefined;
    },
  );

  assert.equal(delegated, true);
  assert.equal(events.length, 0);
});

test("provider 的 retryableCodes 被尊重：不在表里的错误码不重试", async () => {
  const { ctx, handler } = fakeContext();
  apply(ctx, { steps: [{ delayMs: 1, attempts: 5 }] });
  const { agent, events } = fakeAgent();

  let delegated = false;
  await handler()(
    {
      agent,
      turn: 1,
      step: 1,
      provider: "p",
      failure: { code: "RATE_LIMIT" },
      retryPolicy: { mode: "normal", maxRetries: 5, retryableCodes: ["SERVER"] },
    },
    async () => {
      delegated = true;
      return undefined;
    },
  );

  assert.equal(delegated, true, "provider 只允许 SERVER，RATE_LIMIT 不该重试");
  assert.equal(events.length, 0);
});

test("provider 的 maxRetries 非 0 时仍由阶梯决定次数（刻意接管）", async () => {
  const { ctx, handler } = fakeContext();
  apply(ctx, { steps: [{ delayMs: 1, attempts: 3 }] });
  const { agent, events } = fakeAgent();
  const policy = { mode: "normal", maxRetries: 1, retryableCodes: ["SERVER"] };

  await handler()({ agent, turn: 1, step: 1, provider: "p", failure: { code: "SERVER" }, retryPolicy: policy }, terminal);
  await handler()({ agent, turn: 1, step: 1, provider: "p", failure: { code: "SERVER" }, retryPolicy: policy }, terminal);

  const scheduled = events.filter((event) => event.type === "llm/retry").map((e) => e.data);
  assert.deepEqual(scheduled.map((data) => data.retry), [1, 2], "次数由阶梯（3 次）决定，不是 provider 的 1 次");
  assert.equal(scheduled[0].maxRetries, 3);
});

test("mode: always 不看错误码，且只告警一次", async () => {
  const warnings = [];
  const { ctx, handler } = fakeContext();
  ctx.logger.warn = (message) => warnings.push(String(message));
  apply(ctx, { steps: [{ delayMs: 1, attempts: 2 }] });
  const { agent, events } = fakeAgent();
  const policy = { mode: "always" };

  const first = await handler()({ agent, turn: 1, step: 1, provider: "p", failure: { code: "AUTH" }, retryPolicy: policy }, terminal);
  await handler()({ agent, turn: 1, step: 1, provider: "p", failure: { code: "AUTH" }, retryPolicy: policy }, terminal);

  assert.deepEqual(first, { kind: "retry" }, "always 模式下 AUTH 也要重试");
  assert.equal(events.filter((event) => event.type === "llm/retry").length, 2);
  assert.equal(warnings.length, 1, "同一 provider 只告警一次");
  assert.match(warnings[0], /mode: always/u);
});

test("服务端要求的等待超出上限时放弃重试并交回下游", async () => {
  const { ctx, handler } = fakeContext();
  apply(ctx, { steps: [{ delayMs: 1, attempts: 5 }] });
  const { agent, events } = fakeAgent();

  let delegated = false;
  await handler()(
    {
      agent,
      turn: 1,
      step: 1,
      provider: "p",
      failure: { code: "SERVER", providerRetryAfterMs: 3_600_000 },
    },
    async () => {
      delegated = true;
      return undefined;
    },
  );

  assert.equal(delegated, true);
  assert.equal(events.length, 0, "放弃重试就不该留下 llm/retry 事件");
});

test("等待期间被中断则不重试，也不落 llm/retry-started", async () => {
  const { ctx, handler } = fakeContext();
  apply(ctx, { steps: [{ delayMs: 50, attempts: 5 }] });
  const { agent, events } = fakeAgent();
  const controller = new AbortController();

  const pending = handler()(
    {
      agent,
      turn: 1,
      step: 1,
      provider: "p",
      failure: { code: "SERVER" },
      signal: controller.signal,
    },
    terminal,
  );
  controller.abort();
  const decision = await pending;

  assert.equal(decision, undefined);
  assert.deepEqual(
    events.map((event) => event.type),
    ["llm/retry"],
    "只留下待办事件，没有 started",
  );
});

test("卸载时中断进行中的等待并排干", async () => {
  const { ctx, handler, effectDisposers } = fakeContext();
  apply(ctx, { steps: [{ delayMs: 1000, attempts: 5 }] });
  const { agent } = fakeAgent();

  const pending = handler()(
    { agent, turn: 1, step: 1, provider: "p", failure: { code: "SERVER" } },
    terminal,
  );
  await tick();
  for (const dispose of effectDisposers) await dispose();

  assert.equal(await pending, undefined, "卸载后不再要求重试");
});

test("enabled: false 时不注册监听", () => {
  const { ctx, handler } = fakeContext();
  apply(ctx, { enabled: false });
  assert.equal(handler(), undefined);
});

test("两个 agent 各自计数，互不干扰", async () => {
  const { ctx, handler } = fakeContext();
  apply(ctx, { steps: [{ delayMs: 1, attempts: 5 }] });
  const a = fakeAgent();
  const b = fakeAgent();
  const fire = handler();

  await fire({ agent: a.agent, turn: 1, step: 1, provider: "p", failure: { code: "SERVER" } }, terminal);
  await fire({ agent: a.agent, turn: 1, step: 1, provider: "p", failure: { code: "SERVER" } }, terminal);
  await fire({ agent: b.agent, turn: 1, step: 1, provider: "p", failure: { code: "SERVER" } }, terminal);

  const retriesOf = (events) => events.filter((e) => e.type === "llm/retry").map((e) => e.data.retry);
  assert.deepEqual(retriesOf(a.events), [1, 2]);
  assert.deepEqual(retriesOf(b.events), [1], "另一个会话不该被前一个的计数带走");
});

test("缺 agent 时交回下游，不因 WeakMap 键非法而抛错", async () => {
  const { ctx, handler } = fakeContext();
  apply(ctx, { steps: [{ delayMs: 1, attempts: 5 }] });

  let delegated = false;
  const decision = await handler()(
    { turn: 1, step: 1, provider: "p", failure: { code: "SERVER" } },
    async () => {
      delegated = true;
      return undefined;
    },
  );

  assert.equal(delegated, true);
  assert.equal(decision, undefined);
});

test("failure 缺失 / 非对象 / code 非字符串时交回下游", async () => {
  const { ctx, handler } = fakeContext();
  apply(ctx, { steps: [{ delayMs: 1, attempts: 5 }] });
  const { agent, events } = fakeAgent();
  const fire = handler();
  let delegated = 0;
  const downstream = async () => {
    delegated += 1;
    return undefined;
  };

  for (const failure of [null, undefined, "boom", 42, {}, { code: 500 }]) {
    await fire({ agent, turn: 1, step: 1, provider: "p", failure }, downstream);
  }

  assert.equal(delegated, 6);
  assert.equal(events.length, 0);
});

test("agent 没有 session 时不崩，仍按阶梯要求重试", async () => {
  const { ctx, handler } = fakeContext();
  apply(ctx, { steps: [{ delayMs: 1, attempts: 5 }] });

  const decision = await handler()(
    { agent: {}, turn: 1, step: 1, provider: "p", failure: { code: "SERVER" } },
    terminal,
  );

  assert.deepEqual(decision, { kind: "retry" });
});

test("signal 已中止时直接否决链路，不发任何事件、也不递进下游", async () => {
  const { ctx, handler } = fakeContext();
  apply(ctx, { steps: [{ delayMs: 1, attempts: 5 }] });
  const { agent, events } = fakeAgent();
  const controller = new AbortController();
  controller.abort();

  let delegated = false;
  const decision = await handler()(
    {
      agent,
      turn: 1,
      step: 1,
      provider: "p",
      failure: { code: "SERVER" },
      signal: controller.signal,
    },
    async () => {
      delegated = true;
      return undefined;
    },
  );

  assert.equal(delegated, false, "被取消的请求不该再进下游策略");
  assert.equal(decision, undefined);
  assert.equal(events.length, 0);
});

test("极端阶梯：总数上千、最后一次仍落在末档", () => {
  const config = normalizeConfig({
    steps: [
      { delayMs: 1, attempts: 1 },
      { delayMs: 2, attempts: 999 },
    ],
  });
  assert.equal(totalAttempts(config.steps), 1000);
  assert.equal(delayForRetry(config.steps, 1), 1);
  assert.equal(delayForRetry(config.steps, 2), 2);
  assert.equal(delayForRetry(config.steps, 1000), 2);
  assert.equal(delayForRetry(config.steps, 1001), undefined);
});

test("延迟被夹在 setTimeout 上限内，不会退化成 1ms", () => {
  const config = normalizeConfig({
    steps: [{ delayMs: 1000, attempts: 1 }],
    retryAfter: "floor",
    retryAfterMaxMs: 2_147_483_647,
  });
  assert.equal(resolveDelay(1000, 2_147_483_647, config), 2_147_483_647);
});

test("插件级 retryableCodes 显式配置后全局接管，能真正收窄 provider 的默认五码", async () => {
  const { ctx, handler } = fakeContext();
  apply(ctx, { steps: [{ delayMs: 1, attempts: 5 }], retryableCodes: ["SERVER"] });
  const { agent, events } = fakeAgent();
  const fire = handler();
  // 适配器总会把默认五码填进 retryPolicy，所以这里模拟「provider 没显式配」的样子。
  const providerPolicy = {
    mode: "normal",
    maxRetries: 5,
    retryableCodes: ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"],
  };

  let delegated = 0;
  const downstream = async () => {
    delegated += 1;
    return undefined;
  };
  await fire(
    { agent, turn: 1, step: 1, provider: "p", failure: { code: "RATE_LIMIT" }, retryPolicy: providerPolicy },
    downstream,
  );
  assert.equal(delegated, 1, "插件级列表收窄后 RATE_LIMIT 不该再重试");
  assert.equal(events.length, 0);

  const decision = await fire(
    { agent, turn: 1, step: 1, provider: "p", failure: { code: "SERVER" }, retryPolicy: providerPolicy },
    downstream,
  );
  assert.deepEqual(decision, { kind: "retry" });
  assert.deepEqual(
    events.map((event) => event.type),
    ["llm/retry", "llm/retry-started"],
    "收窄后 SERVER 仍要真的落事件，不能只返回 retry",
  );
});

test("codesOverride 只在显式配置 retryableCodes 时为真", () => {
  assert.equal(normalizeConfig(undefined).codesOverride, false);
  assert.equal(normalizeConfig({ steps: [{ delayMs: 1, attempts: 1 }] }).codesOverride, false);
  assert.equal(
    normalizeConfig({ steps: [{ delayMs: 1, attempts: 1 }], retryableCodes: ["SERVER"] }).codesOverride,
    true,
  );
});
