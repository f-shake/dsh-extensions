/**
 * llm-retry-ladder：把模型请求重试从「指数退避」换成「分段常量阶梯」。
 *
 * 为什么需要另写一个：内置 `dsh-llm-retry` 的延迟恒为
 * `min(min(initialDelayMs · 2^(retry-1), maxDelayMs) × jitter, maxDelayMs)`，
 * 配置面只有 initial/max/jitter 三个旋钮。指数天然是 1×/2×/4×/8×，没有「同一档
 * 原地重复 N 次」的机制，所以「1 秒 5 次、2 秒 5 次、10 秒 100 次」这种分段阶梯
 * 无法用配置表达，只能换实现。
 *
 * 为什么仍然发 `llm/retry` 与 `llm/retry-started`：这两个事件是会话的一等
 * 词汇，不是日志装饰——
 *   - 会话格式迁移（v3→v4）校验「retry 连续递增、每个策略链只有一个 retryId、
 *     provider 与当前 request/header 一致」，字段集合也按 disposition 表固定；
 *   - 前端聊天区据此画重试节点；
 *   - token-meter 靠 `llm/retry-started` 清掉替换槽；不发的话，重试那次消耗的
 *     token 会被算成「替换上一次尝试」而不是累加，用量偏少。
 * 因此事件字段严格照 `dsh-llm-retry` 的形状发，`mode` 固定写 "normal"。
 * 注意 `maxRetries` 写的是阶梯总次数（默认 110），与内置「provider 配置值，未配时 5」
 * 数值不同——形状等价但数值不等价，前端会照着显示成「第 n/110 次」，这正是本插件的
 * 真实上限，不是笔误。
 *
 * 为什么计数只在内存里：重试发生在 agent-loop 的 `step()` 内部 `while` 循环，
 * 同一 (turn, step) 内 step 不递增，所以 (agent, provider, turn, step) 足以
 * 定位一条策略链。`dsh-llm-retry` 用 session projection 是为了跨进程恢复；
 * 这里进程一重启，那条请求本身也没了，没必要为此背一个 zod 依赖
 * （本插件零依赖、零构建，见同目录 README）。
 */

import { randomUUID } from "node:crypto";

/** 默认阶梯：1 秒 5 次、2 秒 5 次、10 秒 100 次。 */
const DEFAULT_STEPS = Object.freeze([
  Object.freeze({ delayMs: 1000, attempts: 5 }),
  Object.freeze({ delayMs: 2000, attempts: 5 }),
  Object.freeze({ delayMs: 10_000, attempts: 100 }),
]);

/** 与 dsh-llm 的默认可重试错误码保持一致。 */
const DEFAULT_RETRYABLE_CODES = Object.freeze([
  "EMPTY_RESPONSE",
  "RATE_LIMIT",
  "SERVER",
  "TIMEOUT",
  "TRANSPORT",
]);

/** setTimeout 的上限，超过会被 Node 静默改成 1 毫秒。 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** 服务端 Retry-After 的处理方式。 */
const RETRY_AFTER_MODES = Object.freeze(["floor", "ignore"]);

/** 插件配置允许出现的键；拼错要立刻报错，不能悄悄退回默认阶梯。 */
const CONFIG_KEYS = Object.freeze([
  "enabled",
  "steps",
  "retryableCodes",
  "jitterRatio",
  "retryAfter",
  "retryAfterMaxMs",
]);

/** 阶梯每一档允许出现的键。 */
const STEP_KEYS = Object.freeze(["delayMs", "attempts"]);

/**
 * 校验并补全插件配置。
 *
 * 未知键一律抛错：`steps` 拼成 `stepz` 时若静默走默认阶梯，用户会以为自己的
 * 配置生效了，实际跑的是 110 次——比直接报错难查得多。
 * @param {unknown} raw - Loader 传入的原始配置。
 * @returns {{
 *   enabled: boolean,
 *   steps: ReadonlyArray<{ delayMs: number, attempts: number }>,
 *   retryableCodes: readonly string[],
 *   codesOverride: boolean,
 *   jitterRatio: number,
 *   retryAfter: "floor" | "ignore",
 *   retryAfterMaxMs: number,
 * }} 归一化后的配置。
 * @throws {Error} 配置非法时抛出，让 Loader 直接报错而不是静默走默认阶梯。
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  rejectUnknownKeys(source, CONFIG_KEYS, "llm-retry-ladder");
  if (source.enabled !== undefined && typeof source.enabled !== "boolean") {
    throw new Error("llm-retry-ladder: enabled 必须是布尔值（YAML 里别写成字符串）");
  }
  const steps = normalizeSteps(source.steps);
  const codes = normalizeCodes(source.retryableCodes);
  const ratio = source.jitterRatio;
  if (ratio !== undefined && (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0 || ratio > 1)) {
    throw new Error("llm-retry-ladder: jitterRatio 必须是 0 到 1 之间的数");
  }
  const retryAfter = source.retryAfter ?? "floor";
  if (!RETRY_AFTER_MODES.includes(retryAfter)) {
    throw new Error(
      `llm-retry-ladder: retryAfter 只能是 ${RETRY_AFTER_MODES.join(" 或 ")}`,
    );
  }
  // 服务端 Retry-After 的容忍上限，默认取阶梯最高档：再等下去不如把错误交给人。
  const defaultRetryAfterMax = steps.reduce((max, step) => Math.max(max, step.delayMs), 0);
  const retryAfterMaxMs = source.retryAfterMaxMs ?? defaultRetryAfterMax;
  if (
    typeof retryAfterMaxMs !== "number"
    || !Number.isFinite(retryAfterMaxMs)
    || retryAfterMaxMs <= 0
    || retryAfterMaxMs > MAX_TIMER_DELAY_MS
  ) {
    throw new Error(
      `llm-retry-ladder: retryAfterMaxMs 必须是 1 到 ${MAX_TIMER_DELAY_MS} 之间的数`,
    );
  }
  return {
    enabled: source.enabled !== false,
    steps,
    retryableCodes: codes,
    // 适配器会用 resolveRetryPolicy 把 provider 的列表填满默认值，事后分不清
    // 「用户显式配的」和「默认填的」；所以在归一化这一步就把「插件级有没有显式写」
    // 记下来，否则插件级 retryableCodes 会被 provider 的默认五码永久盖住。
    codesOverride: source.retryableCodes !== undefined,
    jitterRatio: ratio ?? 0,
    retryAfter,
    retryAfterMaxMs,
  };
}

/**
 * 拒绝未知键。
 * @param {object} value - 待检查对象。
 * @param {readonly string[]} allowed - 允许的键。
 * @param {string} path - 报错用的位置名。
 */
function rejectUnknownKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${path}: 未知配置键 "${key}"`);
  }
}

/**
 * 归一化阶梯。省略时直接用共享的冻结常量（不复制，调用方只读）；给了就必须合法。
 * @param {unknown} raw - 原始 steps 配置。
 * @returns {ReadonlyArray<{ delayMs: number, attempts: number }>} 不可变阶梯。
 */
function normalizeSteps(raw) {
  if (raw === undefined) return DEFAULT_STEPS;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("llm-retry-ladder: steps 必须是非空数组");
  }
  const steps = raw.map((step, index) => {
    if (step === null || typeof step !== "object") {
      throw new Error(`llm-retry-ladder: steps[${index}] 必须是 { delayMs, attempts }`);
    }
    rejectUnknownKeys(step, STEP_KEYS, `llm-retry-ladder: steps[${index}]`);
    const { delayMs, attempts } = step;
    if (typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs <= 0 || delayMs > MAX_TIMER_DELAY_MS) {
      throw new Error(
        `llm-retry-ladder: steps[${index}].delayMs 必须是 1 到 ${MAX_TIMER_DELAY_MS} 之间的数`,
      );
    }
    if (typeof attempts !== "number" || !Number.isSafeInteger(attempts) || attempts < 0) {
      throw new Error(`llm-retry-ladder: steps[${index}].attempts 必须是非负整数`);
    }
    return Object.freeze({ delayMs, attempts });
  });
  if (steps.every((step) => step.attempts === 0)) {
    throw new Error("llm-retry-ladder: steps 至少要有一档 attempts 大于 0");
  }
  return Object.freeze(steps);
}

/**
 * 归一化可重试错误码。
 * @param {unknown} raw - 原始 retryableCodes 配置。
 * @returns {readonly string[]} 不可变错误码列表。
 */
function normalizeCodes(raw) {
  if (raw === undefined) return DEFAULT_RETRYABLE_CODES;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("llm-retry-ladder: retryableCodes 必须是非空数组");
  }
  const codes = raw.filter((code) => typeof code === "string" && code !== "");
  if (codes.length !== raw.length) {
    throw new Error("llm-retry-ladder: retryableCodes 只能包含非空字符串");
  }
  return Object.freeze([...codes]);
}

/**
 * 阶梯覆盖的总重试次数。
 * @param {ReadonlyArray<{ attempts: number }>} steps - 归一化后的阶梯。
 * @returns {number} 总次数。
 */
export function totalAttempts(steps) {
  return steps.reduce((sum, step) => sum + step.attempts, 0);
}

/**
 * 第 `retry` 次重试（1 起）落在哪一档。
 * @param {ReadonlyArray<{ delayMs: number, attempts: number }>} steps - 归一化后的阶梯。
 * @param {number} retry - 第几次重试，1 起。
 * @returns {number | undefined} 该档的基础延迟；超出阶梯返回 undefined。
 */
export function delayForRetry(steps, retry) {
  let remaining = retry;
  for (const step of steps) {
    if (remaining <= step.attempts) return step.delayMs;
    remaining -= step.attempts;
  }
  return undefined;
}

/**
 * 把基础延迟加上抖动，并处理服务端 Retry-After。
 *
 * `retryAfter: "floor"`（默认）取两者较大值——服务端明确要求等更久时不抢跑；
 * `"ignore"` 则严格按阶梯。但如果服务端要求的等待超过 `retryAfterMaxMs`
 * （默认等于阶梯最高档），返回 undefined 表示放弃这次重试：
 * 跟着等一小时等于让 turn 静默挂住，不如把错误交给用户——内置插件在
 * `providerRetryAfterMs > maxDelayMs` 时也是直接放弃。
 * @param {number} baseDelayMs - 阶梯给出的基础延迟。
 * @param {unknown} providerRetryAfterMs - 失败携带的服务端建议延迟。
 * @param {{ jitterRatio: number, retryAfter: "floor" | "ignore", retryAfterMaxMs: number }} config - 归一化配置。
 * @param {() => number} random - 随机源，测试可注入。
 * @returns {number | undefined} 最终等待毫秒数；undefined 表示不要重试。
 */
export function resolveDelay(baseDelayMs, providerRetryAfterMs, config, random = Math.random) {
  const jitter = 1 - config.jitterRatio + 2 * config.jitterRatio * random();
  const jittered = Math.max(1, Math.round(baseDelayMs * jitter));
  if (config.retryAfter === "ignore") return Math.min(jittered, MAX_TIMER_DELAY_MS);
  const asked = Number(providerRetryAfterMs);
  if (!Number.isFinite(asked) || asked <= 0) return Math.min(jittered, MAX_TIMER_DELAY_MS);
  if (asked > config.retryAfterMaxMs) return undefined;
  return Math.min(Math.max(jittered, Math.round(asked)), MAX_TIMER_DELAY_MS);
}

/**
 * 可被中断的等待。
 * @param {number} delayMs - 等待毫秒数。
 * @param {AbortSignal} signal - 融合信号。
 * @returns {Promise<boolean>} true 表示正常睡满，false 表示被中断。
 */
function cancellableDelay(delayMs, signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 策略链的身份：会话格式迁移按 (turn, step, provider, policyKey) 认一条链。
 * @param {ReadonlyArray<{ delayMs: number, attempts: number }>} steps - 归一化阶梯。
 * @returns {string} 稳定的链标识。
 */
function policyKeyOf(steps) {
  return `ladder:${JSON.stringify(steps.map((step) => [step.delayMs, step.attempts]))}`;
}

/**
 * 取（或在坐标变化时重建）某个 agent 上某个 provider 的计数器。
 *
 * 坐标 = (turn, step)。换一步就该从第 1 次重新数，所以坐标一变就换新对象；
 * 同一步内反复重试则沿用同一个 retryId，满足「一条链一个 retryId」。
 * @param {WeakMap<object, Map<string, {turn: number, step: number, retry: number, retryId: string | undefined}>>} counters - 计数器表。
 * @param {object} agent - 所属 agent。
 * @param {number} turn - 当前 turn。
 * @param {number} step - 当前 step。
 * @param {string} provider - provider 路由名。
 * @returns {{turn: number, step: number, retry: number, retryId: string | undefined}} 可变计数记录。
 */
function counterFor(counters, agent, turn, step, provider) {
  let byProvider = counters.get(agent);
  if (byProvider === undefined) {
    byProvider = new Map();
    counters.set(agent, byProvider);
  }
  const previous = byProvider.get(provider);
  if (previous === undefined || previous.turn !== turn || previous.step !== step) {
    const fresh = { turn, step, retry: 0, retryId: undefined };
    byProvider.set(provider, fresh);
    return fresh;
  }
  return previous;
}

export const name = "llm-retry-ladder";

/**
 * 宿主插件入口。
 * @param {object} ctx - Cordis 上下文。
 * @param {unknown} rawConfig - Loader 行配置。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  if (!config.enabled) return;
  const total = totalAttempts(config.steps);
  const policyKey = policyKeyOf(config.steps);
  const counters = new WeakMap();
  const warnedAlways = new Set();
  const lifetime = new AbortController();
  const active = new Set();

  /**
   * 跟踪一个进行中的恢复，便于卸载时排干。
   * @param {Promise<unknown>} operation - 待跟踪的操作。
   * @returns {Promise<unknown>} 同一结果。
   */
  function track(operation) {
    const tracked = operation.finally(() => active.delete(tracked));
    active.add(tracked);
    return tracked;
  }

  /**
   * 决定一次失败要不要重试，要的话先落事件、再等待、再落 started。
   * @param {object} payload - agent/request-error 的负载（含注入的 agent）。
   * @param {() => Promise<unknown>} next - 交给下游策略。
   * @returns {Promise<{kind: "retry"} | unknown>} 决策或下游结果。
   */
  async function recover(payload, next) {
    const { agent, turn, step, provider, failure, retryPolicy, signal } = payload ?? {};
    if (failure === null || typeof failure !== "object") return next();
    // 已被取消的请求不再重试；返回 undefined 与内置插件一致（否决链路，不递进下游）。
    // 这一步放在 always 告警之前，免得取消掉的请求也刷一行 warning。
    if (signal?.aborted === true || lifetime.signal.aborted) return undefined;
    const always = retryPolicy?.mode === "always";
    if (!always) {
      // 单个 provider 的显式关闭开关：内置插件把 maxRetries: 0 当作「不重试」，
      // 这里沿用同一约定，方便临时掐掉某个 provider 的重试而不改本插件。
      if (retryPolicy?.mode === "normal" && retryPolicy.maxRetries === 0) return next();
      // 错误码的归属分两种情况：插件级显式配置过就全局接管（改一处管所有 provider），
      // 没配过就听 provider 的——适配器总用 resolveRetryPolicy 填满，所以这里拿到的
      // 要么是用户给 provider 显式配的列表，要么是同一套默认五码。
      const providerCodes = retryPolicy?.retryableCodes;
      const codes = config.codesOverride
        ? config.retryableCodes
        : Array.isArray(providerCodes) && providerCodes.length > 0
          ? providerCodes
          : config.retryableCodes;
      if (typeof failure.code !== "string" || !codes.includes(failure.code)) return next();
    } else if (!warnedAlways.has(provider)) {
      // always 语义是「任何失败都重试」，所以不看错误码；但次数仍受阶梯约束。
      warnedAlways.add(provider);
      ctx.logger?.warn?.(
        `llm-retry-ladder: provider "${provider}" 配置了 mode: always，这里仍按阶梯上限 ${total} 次执行`,
      );
    }
    // 计数器以 agent 对象为 WeakMap 键，拿不到对象就没法按会话隔离；
    // 这种情况交回下游，宁可少重试也不能把两个 agent 的计数混在一起。
    if (agent === null || typeof agent !== "object") return next();

    const counter = counterFor(counters, agent, turn, step, provider);
    const retry = counter.retry + 1;
    const base = delayForRetry(config.steps, retry);
    if (base === undefined) return next();

    const delayMs = resolveDelay(base, failure.providerRetryAfterMs, config, Math.random);
    // 服务端要求的等待超过容忍上限：放弃重试，把错误原样交给上层报给用户。
    if (delayMs === undefined) return next();
    const retryId = counter.retryId ?? randomUUID();
    counter.retry = retry;
    counter.retryId = retryId;

    const fused = AbortSignal.any([signal, lifetime.signal].filter((item) => item !== undefined));
    // 先落事件再等：崩溃重启后日志仍能解释「上一次请求为什么还没回来」。
    agent?.session?.append?.("llm/retry", {
      retryId,
      turn,
      step,
      provider,
      mode: "normal",
      policyKey,
      retry,
      maxRetries: total,
      delayMs,
      failure,
    });
    if (!(await cancellableDelay(delayMs, fused))) return undefined;
    agent?.session?.append?.("llm/retry-started", { retryId, turn, step, retry });
    return { kind: "retry" };
  }

  const disposeListener = ctx.on("agent/request-error", (payload, next) => {
    if (lifetime.signal.aborted) return Promise.resolve(undefined);
    return track(recover(payload, next));
  });
  ctx.effect(
    () => async () => {
      disposeListener();
      lifetime.abort(new Error("llm-retry-ladder plugin disposed"));
      await Promise.allSettled([...active]);
    },
    "llm-retry-ladder: abort and drain active recovery",
  );
}
