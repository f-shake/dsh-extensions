/**
 * 端到端验证：用真实组件跑一遍「失败 → 阶梯等待 → 重试 → 事件落盘」。
 *
 * 为什么这样验而不是跑单测：单测用假的 ctx 和假的 agent，证明不了三件事——
 *   1. 真实 Cordis 的 waterfall 会不会按预期把负载递给我的监听器、`next` 语义对不对；
 *   2. 等待是不是真的在真实定时器上发生（而不是被 await 吞掉）；
 *   3. 我发出去的事件，能不能通过 DSH 自己的会话格式校验器。
 * 所以这里全部用真货：cordis 的 Context、context.waterfall、插件的 apply、
 * 真实的 setTimeout，以及 @deepseek-ai/dsh-session-format 的载荷断言。
 *
 * 运行：node plugins/llm-retry-ladder/e2e/run.mjs
 */

import { Context } from "file:///C:/Running/dsh/node_modules/@deepseek-ai/cordis/lib/index.js";
import { agentEvents } from "file:///C:/Running/dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js";
import { assertReleasedEventPayload } from "file:///C:/Running/dsh/node_modules/@deepseek-ai/dsh-session-format-v0-to-v1/lib/index.js";
import { apply } from "../index.js";

const failures = [];
const record = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${detail}`}`);
  if (!ok) failures.push(label);
};

/** 真实 Cordis 上下文；缺 effect 时直接失败，避免用假货蒙混过关。 */
const ctx = new Context();
record("真实 Context 提供了 effect", typeof ctx.effect === "function");
record("真实 Context 提供了 on", typeof ctx.on === "function");

/** 记录事件，并按会话原始格式补上 seq/time，好喂给格式校验器。 */
const events = [];
let seq = 0;
const agent = {
  id: "e2e-agent",
  session: {
    append(type, data) {
      seq += 1;
      events.push({ type, seq, time: Date.now(), data });
    },
  },
};

// 真实派发器：agent-loop 用的就是它，它负责把 agent 注入每条负载。
// 直接调 ctx.waterfall 会漏掉这一步注入，插件就读不到 agent。
const dispatch = agentEvents(ctx, agent);

apply(ctx, {
  steps: [
    { delayMs: 60, attempts: 2 },
    { delayMs: 120, attempts: 2 },
  ],
  retryAfter: "ignore",
});

const terminal = () => Promise.resolve(undefined);
const failure = { code: "SERVER", message: "端到端注入的失败" };

let turn = 3;
let step = 7;
const elapsed = [];
let attempts = 0;

// 反复触发失败，直到插件不再要求重试；每次记下真实耗时。
for (;;) {
  attempts += 1;
  const startedAt = Date.now();
  const decision = await dispatch.waterfall(
    "agent/request-error",
    { turn, step, provider: "e2e-provider", failure, retryPolicy: undefined },
    terminal,
  );
  elapsed.push(Date.now() - startedAt);
  if (decision?.kind !== "retry") {
    record(`第 ${attempts} 次失败后停止重试`, true, `返回 ${JSON.stringify(decision)}`);
    break;
  }
  if (attempts > 10) {
    record("阶梯必须在上限内耗尽", false, "重试次数超过 10");
    break;
  }
}

// 1) 阶梯形状：2 次 60ms + 2 次 120ms，允许定时器误差。
const expected = [60, 60, 120, 120];
const shape = elapsed.slice(0, 4);
record(
  "四次重试的真实等待符合阶梯 60/60/120/120",
  shape.every((ms, index) => Math.abs(ms - expected[index]) <= 40),
  `实测 ${shape.join("/")} ms`,
);
record("第 5 次失败不再重试", attempts === 5, `共 ${attempts} 次调用`);

// 2) 事件序列：每次重试一条 llm/retry + 一条 llm/retry-started，交错有序。
const types = events.map((event) => event.type);
const expectedTypes = ["llm/retry", "llm/retry-started", "llm/retry", "llm/retry-started", "llm/retry", "llm/retry-started", "llm/retry", "llm/retry-started"];
record("事件序列是 4 组 retry/started 交错", JSON.stringify(types) === JSON.stringify(expectedTypes), types.join(","));

// 3) 链路连续性：retry 从 1 连续、retryId 全程不变、坐标与 provider 一致。
const scheduled = events.filter((event) => event.type === "llm/retry").map((event) => event.data);
record("retry 从 1 连续递增到 4", JSON.stringify(scheduled.map((data) => data.retry)) === "[1,2,3,4]");
record("同一条链只有一个 retryId", new Set(scheduled.map((data) => data.retryId)).size === 1);
record("坐标与 provider 全程一致", scheduled.every((data) => data.turn === turn && data.step === step && data.provider === "e2e-provider"));
record("每次的 delayMs 与阶梯档位一致", JSON.stringify(scheduled.map((data) => data.delayMs)) === "[60,60,120,120]");

// 4) 最硬的一条：把事件喂进 DSH 自己的会话格式校验器（v0/v1 载荷与字段集约束）。
let payloadOk = true;
let payloadDetail = "";
for (const event of events) {
  try {
    assertReleasedEventPayload(event, 1);
  } catch (error) {
    payloadOk = false;
    payloadDetail = `${event.type} seq=${event.seq}: ${error.message}`;
    break;
  }
}
record("全部事件通过真实会话格式校验器", payloadOk, payloadDetail || `${events.length} 条`);

// 5) 中断路径：等待期间 abort 必须立刻放弃，且不落 retry-started。
const eventsBefore = events.length;
const controller = new AbortController();
const abortRun = dispatch.waterfall(
  "agent/request-error",
  { turn: 9, step: 1, provider: "e2e-provider", failure, signal: controller.signal },
  terminal,
);
setTimeout(() => controller.abort(), 10);
const abortDecision = await abortRun;
record("等待期间中断后不再要求重试", abortDecision === undefined, `返回 ${JSON.stringify(abortDecision)}`);
const tail = events.slice(eventsBefore).map((event) => event.type);
record("中断只留下 llm/retry，没有 retry-started", JSON.stringify(tail) === JSON.stringify(["llm/retry"]), tail.join(","));

console.log(`\n结论：${failures.length === 0 ? "全部通过" : `失败 ${failures.length} 项：${failures.join("、")}`}`);
process.exit(failures.length === 0 ? 0 : 1);
