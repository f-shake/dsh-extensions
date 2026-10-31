/**
 * 宿主半边：vibe coding 五阶段流程的状态与工具。
 *
 * 为什么状态放在宿主内存、而不是会话投影：外部插件不允许写自定义会话事件
 * （`appendPluginRecord` 只对 packages/experimental 下的包开放），投影没有可折叠的
 * 依据。阶段只服务「当前活着的宿主进程」，重启后从图标重新开始是已知取舍。
 *
 * 为什么确认走 HTTP 而不是客户端直接提交：点击要同时做两件事——给模型发一条
 * 用户消息、把状态推进到目标阶段。放在宿主里两者才是一次原子动作，也不会覆盖
 * 用户正在写的草稿。启动则相反，必须走客户端提交，因为新会话还没有 agent。
 */

import { randomUUID } from "node:crypto";

/** 阶段短名。与 SKILL.md 的横幅、脚注用同一套词。 */
const PHASE_NAMES = Object.freeze({
  1: "计划",
  2: "开发",
  3: "复核",
  4: "验证",
  5: "提交",
});

const MIN_PHASE = 1;
const MAX_PHASE = 5;
const ROUTE_PREFIX = "/vibe-phase";
const DEFAULT_COOLDOWN_MS = 2000;
const MAX_BODY_BYTES = 8192;

export const name = "vibe-phase-bar";
export const inject = ["tools"];

/**
 * 阶段短名。
 * @param {number} phase - 阶段号。
 * @returns {string} 短名；越界时回退成「阶段N」。
 */
export function phaseName(phase) {
  return PHASE_NAMES[phase] ?? `阶段${phase}`;
}

/**
 * 阶段号是否合法。
 * @param {unknown} value - 待校验的值。
 * @returns {boolean} 是否为 1~5 的整数。
 */
export function isValidPhase(value) {
  return Number.isInteger(value) && value >= MIN_PHASE && value <= MAX_PHASE;
}

/**
 * 新建一份阶段状态。
 * @returns {object} 初始状态（停在阶段一）。
 */
export function createState() {
  return {
    phase: 1,
    pending: null,
    skipped: [],
    precommit: false,
    authorized: false,
    precommitAt: 0,
    version: 1,
  };
}

/**
 * 生成一次状态变更，并把版本号往前推一格。
 * 客户端按 version 判断要不要重渲染，所以每次真实变更都必须换 version。
 * @param {object} state - 旧状态。
 * @param {object} patch - 要覆盖的字段。
 * @returns {object} 新状态。
 */
function commit(state, patch) {
  return { ...state, ...patch, version: state.version + 1 };
}

/**
 * 进入某阶段。
 *
 * 进入阶段五时保留已有的预提交/授权标记：用户点了「提交」之后模型会照规矩调
 * enter(5)，如果这里清掉标记，第二次点击就不再是「授权提交」了。
 * @param {object} state - 旧状态。
 * @param {number} phase - 目标阶段。
 * @returns {object} 新状态。
 */
export function applyEnter(state, phase) {
  const keepCommitFlags = phase === MAX_PHASE;
  return commit(state, {
    phase,
    pending: null,
    skipped: state.skipped.filter((item) => item < phase),
    precommit: keepCommitFlags ? state.precommit : false,
    authorized: keepCommitFlags ? state.authorized : false,
    precommitAt: keepCommitFlags ? state.precommitAt : 0,
  });
}

/**
 * 请求进入某阶段：只挂起 pending，不动当前阶段。
 * @param {object} state - 旧状态。
 * @param {number} phase - 目标阶段。
 * @returns {object} 新状态；目标不晚于当前阶段时原样返回。
 */
export function applyRequest(state, phase) {
  if (phase <= state.phase) return state;
  return commit(state, { pending: phase });
}

/**
 * 一段连续的阶段号。
 * @param {number} from - 起点（含）。
 * @param {number} to - 终点（含）。
 * @returns {number[]} 阶段号列表；from > to 时为空。
 */
function range(from, to) {
  const items = [];
  for (let value = from; value <= to; value += 1) items.push(value);
  return items;
}

/**
 * 去重并保序。
 * @param {number[]} values - 阶段号列表。
 * @returns {number[]} 去重结果。
 */
function unique(values) {
  return [...new Set(values)];
}

/**
 * 进入预提交：列出清单但不提交。
 * @param {object} state - 旧状态。
 * @param {number} target - 目标阶段（恒为 5）。
 * @param {number[]} skipped - 跳过的阶段。
 * @param {number} now - 当前时间。
 * @returns {{ state: object, message: string }} 新状态与要发给模型的话。
 */
function planPrecommit(state, target, skipped, now) {
  const next = commit(state, {
    phase: MAX_PHASE,
    pending: null,
    skipped,
    precommit: true,
    authorized: false,
    precommitAt: now,
  });
  const jumped = target - state.phase > 1 && skipped.length > 0;
  const head = jumped
    ? `确认跳到阶段 5（提交），跳过阶段 ${skipped.join("、")}。`
    : `确认进入阶段 5（提交）。`;
  return {
    state: next,
    message: `${head}进入预提交：列出计划提交的文件和提交信息，不要执行 git commit。`,
  };
}

/**
 * 已在阶段五时的点击：未预提交则先进入预提交，预提交后冷却到期才授权提交。
 * @param {object} state - 当前状态。
 * @param {number} now - 当前时间。
 * @param {number} cooldownMs - 预提交到授权之间的最小间隔。
 * @returns {{ state: object, message: string | null, reason?: string }} 结果。
 */
function planCommitClick(state, now, cooldownMs) {
  if (state.authorized) return { state, message: null, reason: "already-authorized" };
  if (!state.precommit) return planPrecommit(state, MAX_PHASE, state.skipped, now);
  if (now - state.precommitAt < cooldownMs) return { state, message: null, reason: "cooldown" };
  return {
    state: commit(state, { authorized: true, pending: null }),
    message: "授权提交：按上面的提交信息执行 git commit。",
  };
}

/**
 * 把一次点击解释成「新状态 + 要发给模型的话」。
 *
 * 这是整条流程里唯一允许推进阶段状态的地方：工具只能 enter/request，确认只能
 * 来自用户在阶段条上的点击。纯函数，方便单测覆盖每种跳法。
 * @param {object} state - 当前状态。
 * @param {number} target - 被点击的阶段。
 * @param {number} [now] - 当前时间。
 * @param {number} [cooldownMs] - 预提交冷却。
 * @returns {{ state: object, message: string | null, reason?: string }} 结果。
 */
export function planConfirm(state, target, now = Date.now(), cooldownMs = DEFAULT_COOLDOWN_MS) {
  if (!isValidPhase(target)) return { state, message: null, reason: "invalid-phase" };

  if (target === state.phase) {
    if (target !== MAX_PHASE) return { state, message: null, reason: "same-phase" };
    return planCommitClick(state, now, cooldownMs);
  }

  if (target < state.phase) {
    const next = commit(state, {
      phase: target,
      pending: null,
      skipped: state.skipped.filter((item) => item < target),
      precommit: false,
      authorized: false,
      precommitAt: 0,
    });
    return { state: next, message: `回到阶段 ${target}（${phaseName(target)}）重新走。` };
  }

  const jumped = range(state.phase + 1, target - 1);
  const skipped = unique([...state.skipped.filter((item) => item < target), ...jumped]);

  if (target === MAX_PHASE) return planPrecommit(state, target, skipped, now);

  const next = commit(state, {
    phase: target,
    pending: null,
    skipped,
    precommit: false,
    authorized: false,
    precommitAt: 0,
  });
  const head =
    skipped.length > 0 && target - state.phase > 1
      ? `确认跳到阶段 ${target}（${phaseName(target)}），跳过阶段 ${skipped.join("、")}。`
      : `确认进入阶段 ${target}（${phaseName(target)}）。`;
  return { state: next, message: head };
}

/**
 * 投影给客户端的状态。只暴露 UI 需要的字段。
 * @param {object} state - 宿主内部状态。
 * @returns {object} 客户端可见状态。
 */
export function publicState(state) {
  return {
    phase: state.phase,
    pending: state.pending,
    skipped: state.skipped,
    precommit: state.precommit,
    authorized: state.authorized,
    version: state.version,
  };
}

/**
 * 会话到阶段状态的映射。条目里同时攥着该会话的 agent，确认点击时直接用它，
 * 省掉一次 id 到 agent 的解析。
 * @returns {object} 读写入口。
 */
export function createStore() {
  const items = new Map();
  return {
    /**
     * 读取条目。
     * @param {string} sessionId - 会话 id。
     * @returns {object | undefined} 条目。
     */
    get(sessionId) {
      return items.get(sessionId);
    },
    /**
     * 读取条目，不存在就按初始状态创建，并顺手记住 agent。
     * @param {string} sessionId - 会话 id。
     * @param {object} [agent] - 该会话的实时 agent。
     * @returns {object} 条目。
     */
    ensure(sessionId, agent) {
      let entry = items.get(sessionId);
      if (entry === undefined) {
        entry = { state: createState(), agent };
        items.set(sessionId, entry);
      }
      if (agent !== undefined && agent !== null) entry.agent = agent;
      return entry;
    },
    /**
     * 删除条目。
     * @param {string} sessionId - 会话 id。
     * @returns {boolean} 是否删掉了。
     */
    remove(sessionId) {
      return items.delete(sessionId);
    },
  };
}

/**
 * 从 agent 身上取会话 id。agent 与 session 共用同一个身份，这里对几种挂法都兜一下。
 * @param {object} agent - 实时 agent。
 * @returns {string | undefined} 会话 id。
 */
export function sessionIdOf(agent) {
  if (agent === null || agent === undefined) return undefined;
  if (typeof agent.sessionId === "string") return agent.sessionId;
  if (typeof agent.session?.id === "string") return agent.session.id;
  if (typeof agent.id === "string") return agent.id;
  return undefined;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

/**
 * 写一个 JSON 响应。
 * @param {object} res - 响应对象。
 * @param {number} status - 状态码。
 * @param {object} payload - 载荷。
 */
function send(res, status, payload) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(payload));
}

/**
 * 解析请求 URL。
 * @param {string | undefined} url - 原始 url。
 * @returns {URL | undefined} 解析结果。
 */
function parseUrl(url) {
  try {
    return new URL(url ?? "/", "http://localhost");
  } catch {
    return undefined;
  }
}

/**
 * 读取 JSON 请求体。超过上限或不是合法 JSON 都当作坏请求。
 * @param {object} req - 请求对象（Node 的可迭代流）。
 * @returns {Promise<object | undefined>} 解析结果。
 */
async function readJson(req) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return undefined;
      chunks.push(chunk);
    }
  } catch {
    return undefined;
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * 构造 HTTP 处理入口。路由只有三条：读状态、确认、关闭。
 * @param {object} options - 依赖。
 * @param {object} options.store - 状态表。
 * @param {() => number} [options.clock] - 时间来源。
 * @param {number} [options.cooldownMs] - 预提交冷却。
 * @returns {{ handle: (req: object, res: object) => Promise<void> }} 处理入口。
 */
export function createHandlers({ store, clock = Date.now, cooldownMs = DEFAULT_COOLDOWN_MS }) {
  return {
    async handle(req, res) {
      const url = parseUrl(req.url);
      if (url === undefined) return send(res, 400, { ok: false, error: "bad-url" });

      if (url.pathname === `${ROUTE_PREFIX}/state` && req.method === "GET") {
        const sessionId = url.searchParams.get("session") ?? "";
        const entry = store.get(sessionId);
        return send(res, 200, { ok: true, state: entry === undefined ? null : publicState(entry.state) });
      }

      if (url.pathname === `${ROUTE_PREFIX}/confirm` && req.method === "POST") {
        const body = await readJson(req);
        if (body === null || typeof body !== "object") return send(res, 400, { ok: false, error: "bad-body" });
        const sessionId = typeof body.session === "string" ? body.session : "";
        const entry = store.get(sessionId);
        if (entry === undefined) return send(res, 404, { ok: false, error: "unknown-session" });

        const plan = planConfirm(entry.state, body.phase, clock(), cooldownMs);
        if (plan.reason === "invalid-phase") return send(res, 400, { ok: false, error: "invalid-phase" });

        if (plan.message !== null) {
          const agent = entry.agent;
          if (agent === undefined || typeof agent.followup !== "function") {
            return send(res, 409, { ok: false, error: "agent-unavailable" });
          }
          try {
            // followup 收的是完整 UserMessage：缺 role/id 的消息会照原样写进历史，
            // 之后每个请求都会因「消息没有角色」被服务端拒绝（实测踩过一次）。
            // 它是同步入队、返回 void，所以这里只能接住同步抛错，观测不到投递结果。
            agent.followup({
              id: randomUUID(),
              role: "user",
              content: [{ type: "text", text: plan.message }],
              source: { kind: "user" },
            });
          } catch (error) {
            // 同步入队失败就不推进状态，免得条上显示已进入、模型却没收到。
            return send(res, 502, { ok: false, error: "followup-failed", detail: String(error) });
          }
        }

        entry.state = plan.state;
        return send(res, 200, {
          ok: true,
          state: publicState(plan.state),
          reason: plan.reason ?? null,
          quiet: plan.message === null,
        });
      }

      if (url.pathname === `${ROUTE_PREFIX}/reset` && req.method === "POST") {
        const body = await readJson(req);
        if (body === null || typeof body !== "object") return send(res, 400, { ok: false, error: "bad-body" });
        const sessionId = typeof body.session === "string" ? body.session : "";
        if (sessionId === "") return send(res, 400, { ok: false, error: "missing-session" });
        store.remove(sessionId);
        return send(res, 200, { ok: true, state: null });
      }

      return send(res, 404, { ok: false, error: "not-found" });
    },
  };
}

/**
 * 构造给模型的工具定义。
 * @param {object} options - 依赖。
 * @param {object} options.store - 状态表。
 * @returns {object} 工具定义。
 */
export function createTool({ store }) {
  return {
    name: "vibe_phase",
    description:
      "vibe coding 五阶段流程的阶段控制。进入某阶段后先调 enter；做完本阶段、停在闸门时调 request 请求用户确认进入下一阶段——用户会在输入框上方的阶段条上看到该阶段闪烁，点击即确认。调了 request 之后必须停下等用户点击，不得自行进入该阶段。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["enter", "request"],
          description: "enter=进入阶段；request=请求用户确认进入该阶段",
        },
        phase: {
          type: "integer",
          minimum: MIN_PHASE,
          maximum: MAX_PHASE,
          description: "阶段号：1 计划、2 开发、3 复核、4 验证、5 提交",
        },
      },
      required: ["action", "phase"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: "text", text: value.text }];
      },
    },
    async execute(args, exec) {
      const action = args?.action;
      const phase = args?.phase;
      if (action !== "enter" && action !== "request") throw new Error("action 必须是 enter 或 request");
      if (!isValidPhase(phase)) throw new Error("phase 必须是 1 到 5 的整数");

      const sessionId = sessionIdOf(exec?.agent);
      if (sessionId === undefined) throw new Error("vibe_phase 需要会话上下文");

      const entry = store.ensure(sessionId, exec.agent);

      if (action === "enter") {
        // 重复 enter 当前阶段是空操作：不能顺手把「等待确认」的闪烁擦掉。
        if (phase === entry.state.phase) {
          return { text: `已在阶段 ${phase}（${phaseName(phase)}）。` };
        }
        // 闸门在状态机层面兜底：已经请求、但用户还没点，就不许自己 enter 过去。
        // 只写进工具描述等于把闸门交给模型自觉，这段是它唯一绕不过去的地方。
        if (entry.state.pending !== null && phase > entry.state.phase) {
          return {
            text: `已请求进入阶段 ${entry.state.pending}，正在等用户在阶段条上点击确认；确认前不能进入阶段 ${phase}。`,
          };
        }
        entry.state = applyEnter(entry.state, phase);
        return { text: `已进入阶段 ${phase}（${phaseName(phase)}）。` };
      }

      if (phase <= entry.state.phase) {
        return {
          text: `当前已在阶段 ${entry.state.phase}（${phaseName(entry.state.phase)}），无需请求进入阶段 ${phase}。`,
        };
      }

      entry.state = applyRequest(entry.state, phase);
      return {
        text: `已请求进入阶段 ${phase}（${phaseName(phase)}），等待用户在阶段条上点击确认；点击前不要进入该阶段。`,
      };
    },
  };
}

/**
 * 归一化 Loader 行配置。
 * @param {unknown} raw - 原始配置。
 * @returns {{ precommitCooldownMs: number }} 归一化结果。
 */
function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const cooldown = Number(source.precommitCooldownMs);
  return {
    precommitCooldownMs:
      Number.isFinite(cooldown) && cooldown >= 0 ? cooldown : DEFAULT_COOLDOWN_MS,
  };
}

/**
 * 插件入口。
 * @param {object} ctx - Cordis 上下文。
 * @param {unknown} rawConfig - Loader 行配置。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const store = createStore();
  const clock = Date.now;

  ctx.effect(() => ctx.tools.register(createTool({ store })), "vibe-phase-bar: tool");

  const handlers = createHandlers({ store, clock, cooldownMs: config.precommitCooldownMs });
  ctx.inject(["webServer"], (scope) => {
    scope.effect(
      () =>
        scope.webServer.register({
          kind: "prefix",
          path: ROUTE_PREFIX,
          handler: handlers.handle,
        }),
      "vibe-phase-bar: routes",
    );
  });

  if (typeof ctx.on === "function") {
    // agent 销毁后状态没有意义了；留着只会让条指向一个已经不在的会话。
    ctx.effect(
      () =>
        ctx.on("agent/disposed", (payload) => {
          const id =
            sessionIdOf(payload?.agent) ??
            (typeof payload?.sessionId === "string" ? payload.sessionId : undefined);
          if (id !== undefined) store.remove(id);
        }),
      "vibe-phase-bar: agent cleanup",
    );
  }
}
