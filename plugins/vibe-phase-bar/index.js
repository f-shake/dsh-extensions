/**
 * 宿主半边：vibe coding 五阶段流程的状态与工具。
 *
 * 为什么状态放在宿主内存、而不是会话投影：外部插件不允许写自定义会话事件
 * （`appendPluginRecord` 只对 packages/experimental 下的包开放），投影没有可折叠的
 * 依据。阶段只服务「当前活着的宿主进程」，重启后按钮回到「开始」是已知取舍。
 *
 * 为什么确认走 HTTP 而不是客户端直接提交：点击要同时做两件事——给模型发一条
 * 用户消息、把状态推进到目标阶段。放在宿主里两者才是一次原子动作，也不会覆盖
 * 用户正在写的草稿。「开条」则相反，它不需要发给模型任何东西，所以是另一条不发
 * 消息的路由，只把状态建出来。
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

/**
 * 阶段四的验证方式。顺序即弹框顺序、也是写进消息的顺序。
 * id 会存进状态并由客户端回显，属于稳定契约：改 id 等于改数据结构。
 *
 * `unit` 与 `unit-scope` 是同一维度的两种粒度：全量跑一遍，或只跑这次改动涉及模块的
 * 单测。两者可以同时勾（那等于全量），不额外拦——勾选的本来只是「跑哪几种」。
 */
const VERIFY_METHODS = Object.freeze([
  { id: "unit", label: "全量单元测试" },
  { id: "unit-scope", label: "改动相关单元测试" },
  { id: "e2e", label: "端到端验证" },
  { id: "release", label: "发布测试" },
]);

const VERIFY_IDS = VERIFY_METHODS.map((item) => item.id);

/** 分两步走时，第一步只做界面与演示数据——完整实现留给 2b。 */
const DEV_SPLIT_A_TEXT =
  "确认进入阶段 2a（开发·前端与设计）：这一轮只做界面与交互——布局、样式、演示数据把流程走通，做完停下来把设计给我看；完整实现与业务逻辑留到 2b。";

/** 2a 看完之后再点「开发」，进入完整实现。 */
const DEV_STEP_B_TEXT = "确认进入阶段 2b（开发·完整实现）：按已确认的设计一次性做完完整实现与单元测试。";
const ROUTE_PREFIX = "/vibe-phase";
const DEFAULT_COOLDOWN_MS = 2000;
const MAX_BODY_BYTES = 8192;

export const name = "vibe-phase-bar";
export const inject = ["tools", "agents"];

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
    devMode: "single",
    devStep: null,
    verify: [],
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
  // 进入阶段一就是重开一轮：上一轮的跳过项与验证方式都不该跟着走，
  // 否则阶段四的悬停说明会一直挂着早已失效的「已选 …」。
  const restart = phase === MIN_PHASE;
  return commit(state, {
    phase,
    pending: null,
    skipped: restart ? [] : state.skipped.filter((item) => item < phase),
    precommit: keepCommitFlags ? state.precommit : false,
    authorized: keepCommitFlags ? state.authorized : false,
    precommitAt: keepCommitFlags ? state.precommitAt : 0,
    // 走法只能由用户在弹框里选出来，工具 enter 无从得知，所以一律按一次性完成记；
    // 保留旧值没有意义——能走到这里的 enter(2) 必然不是从 2a 里出来的。
    devMode: "single",
    devStep: null,
    verify: keepCommitFlags || restart ? [] : state.verify,
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
    devMode: "single",
    devStep: null,
    verify: [],
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
 * 把验证方式 id 翻成一句中文列举。
 * @param {string[]} ids - 已归一的 id 列表。
 * @returns {string} 顿号连接的显示名。
 */
export function verifyLabels(ids) {
  return ids
    .map((id) => VERIFY_METHODS.find((item) => item.id === id)?.label ?? id)
    .join("、");
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
 * @param {object} [options] - 弹框里选好的选项（`devSplit` / `verify`）。
 * @returns {{ state: object, message: string | null, reason?: string }} 结果。
 */
export function planConfirm(
  state,
  target,
  now = Date.now(),
  cooldownMs = DEFAULT_COOLDOWN_MS,
  options = {},
) {
  if (!isValidPhase(target)) return { state, message: null, reason: "invalid-phase" };

  if (target === state.phase) {
    // 停在 2a 再点「开发」：不再弹框，直接进 2b。
    if (target === 2 && state.devMode === "split" && state.devStep === "a") {
      return { state: commit(state, { pending: null, devStep: "b" }), message: DEV_STEP_B_TEXT };
    }
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
      devMode: "single",
      devStep: null,
      verify: [],
    });
    return { state: next, message: `回到阶段 ${target}（${phaseName(target)}）重新走。` };
  }

  const jumped = range(state.phase + 1, target - 1);
  const skipped = unique([...state.skipped.filter((item) => item < target), ...jumped]);
  const jumping = skipped.length > 0 && target - state.phase > 1;
  // 从 2a 直接走掉：2b 没做，但阶段二并不算「跳过」，所以只提一句，不进跳过集合。
  const stepNote = state.devStep === "a" && target > 2 ? "阶段 2b 未做。" : "";

  if (target === MAX_PHASE) {
    const plan = planPrecommit(state, target, skipped, now);
    return { ...plan, message: `${plan.message}${stepNote}` };
  }

  const head = jumping
    ? `确认跳到阶段 ${target}（${phaseName(target)}），跳过阶段 ${skipped.join("、")}。`
    : `确认进入阶段 ${target}（${phaseName(target)}）。`;
  const done = (extra, message) => ({
    state: commit(state, {
      phase: target,
      pending: null,
      skipped,
      precommit: false,
      authorized: false,
      precommitAt: 0,
      // 离开阶段二就复位走法：阶段 3 之后再有 2a/2b 的角标就是残留。
      ...(target === 2 ? {} : { devMode: "single", devStep: null }),
      ...extra,
    }),
    message: `${message}${stepNote}`,
  });

  if (target === 2) {
    if (options.devSplit === true) {
      return done({ devMode: "split", devStep: "a" }, DEV_SPLIT_A_TEXT);
    }
    return done({ devMode: "single", devStep: null }, head);
  }

  if (target === 4 && Array.isArray(options.verify) && options.verify.length > 0) {
    const lead = jumping
      ? `确认跳到阶段 4（验证），跳过阶段 ${skipped.join("、")}，`
      : "确认进入阶段 4（验证），";
    return done(
      { verify: [...options.verify] },
      `${lead}验证方式：${verifyLabels(options.verify)}。按选定方式执行，不要再问我选哪种。`,
    );
  }

  return done({}, head);
}

/**
 * 校验并归一化确认请求里的选项。
 *
 * 未提供与提供了非法值是两件事：前者表示「这次点击没有选项」，后者必须 400，
 * 否则客户端传错字段会被静默当成「用户没选」，弹框也就白弹了。
 * @param {unknown} raw - 请求体里的 options。
 * @returns {{ ok: boolean, options: object }} 校验结果。
 */
export function normalizeOptions(raw) {
  if (raw === undefined || raw === null) return { ok: true, options: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, options: {} };

  const options = {};
  if (raw.devSplit !== undefined) {
    if (typeof raw.devSplit !== "boolean") return { ok: false, options: {} };
    options.devSplit = raw.devSplit;
  }
  if (raw.verify !== undefined) {
    if (!Array.isArray(raw.verify)) return { ok: false, options: {} };
    const unknown = raw.verify.some((id) => typeof id !== "string" || !VERIFY_IDS.includes(id));
    if (unknown) return { ok: false, options: {} };
    // 去重并按固定顺序排，免得同样的选择写成两种状态、两个不同版本的条。
    const verify = VERIFY_METHODS.map((item) => item.id).filter((id) => raw.verify.includes(id));
    if (verify.length === 0) return { ok: false, options: {} };
    options.verify = verify;
  }
  return { ok: true, options };
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
    devMode: state.devMode,
    devStep: state.devStep,
    verify: state.verify,
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
 * 只收 JSON 请求体。跨站的普通表单发不出 application/json（它会先触发预检），
 * 这条挡的是拿 text/plain 直接打进来的伪造确认——那种请求能往对话里塞一条用户消息。
 * @param {object} req - 请求对象。
 * @returns {boolean} 是否为 JSON 请求。
 */
function isJsonRequest(req) {
  const type = req?.headers?.["content-type"] ?? "";
  return typeof type === "string" && type.toLowerCase().startsWith("application/json");
}

/**
 * 请求体必须是普通对象：数组的 typeof 也是 object，得单独挡。
 * @param {unknown} body - 解析结果。
 * @returns {boolean} 是否可用。
 */
function isPlainBody(body) {
  return body !== null && typeof body === "object" && !Array.isArray(body);
}

/**
 * 构造 HTTP 处理入口。四条路由：读状态、确认、开条、关闭。
 * @param {object} options - 依赖。
 * @param {object} options.store - 状态表。
 * @param {() => number} [options.clock] - 时间来源。
 * @param {number} [options.cooldownMs] - 预提交冷却。
 * @param {(sessionId: string) => object | undefined} [options.lookupAgent] - 取该会话当前的 agent。
 * @returns {{ handle: (req: object, res: object) => Promise<void> }} 处理入口。
 */
export function createHandlers({
  store,
  clock = Date.now,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  lookupAgent,
}) {
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
        if (!isJsonRequest(req)) return send(res, 400, { ok: false, error: "bad-content-type" });
        const body = await readJson(req);
        if (!isPlainBody(body)) return send(res, 400, { ok: false, error: "bad-body" });
        const sessionId = typeof body.session === "string" ? body.session : "";
        if (sessionId === "") return send(res, 400, { ok: false, error: "missing-session" });
        const entry = store.get(sessionId);
        if (entry === undefined) return send(res, 404, { ok: false, error: "unknown-session" });

        const parsed = normalizeOptions(body.options);
        if (!parsed.ok) return send(res, 400, { ok: false, error: "invalid-options" });

        const plan = planConfirm(entry.state, body.phase, clock(), cooldownMs, parsed.options);
        if (plan.reason === "invalid-phase") return send(res, 400, { ok: false, error: "invalid-phase" });

        if (plan.message !== null) {
          // 条目里可能压根没挂 agent（条是按钮开出来的），也可能已经过时；
          // 没挂时才向注册表回查一次并写回，实在拿不到就 409，让客户端提示用户。
          const agent = entry.agent ?? lookupAgent?.(sessionId);
          if (agent === undefined || typeof agent.followup !== "function") {
            return send(res, 409, { ok: false, error: "agent-unavailable" });
          }
          entry.agent = agent;
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

      // 按钮在没有流程时点一下：只建状态、不发消息，所以不能借用 confirm。
      if (url.pathname === `${ROUTE_PREFIX}/open` && req.method === "POST") {
        if (!isJsonRequest(req)) return send(res, 400, { ok: false, error: "bad-content-type" });
        const body = await readJson(req);
        if (!isPlainBody(body)) return send(res, 400, { ok: false, error: "bad-body" });
        const sessionId = typeof body.session === "string" ? body.session : "";
        if (sessionId === "") return send(res, 400, { ok: false, error: "missing-session" });
        // 已有条目时原样返回：重复点按钮不该把阶段重置回一。
        // 顺手挂上会话当前的 agent，否则这条刚开出来的条点哪儿都是 409。
        const entry = store.ensure(sessionId, lookupAgent?.(sessionId));
        // fresh：点「计划」重开时用——把状态清回阶段一，同样不发消息。
        // 保留条目里的 agent 绑定，用户发出命令后模型调 enter(1) 就能直接沿用。
        if (body.fresh === true) entry.state = createState();
        return send(res, 200, { ok: true, state: publicState(entry.state) });
      }

      if (url.pathname === `${ROUTE_PREFIX}/reset` && req.method === "POST") {
        if (!isJsonRequest(req)) return send(res, 400, { ok: false, error: "bad-content-type" });
        const body = await readJson(req);
        if (!isPlainBody(body)) return send(res, 400, { ok: false, error: "bad-body" });
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

  // 每次点击前向注册表要一次当前 agent：条目里存的可能已经过时，也可能根本没挂上
  // （条是按钮开出来的）。注册表不在时退回 undefined，让调用方照常走 409。
  const lookupAgent = (sessionId) => {
    const registry = ctx.agents;
    if (registry === undefined || registry === null || typeof registry.get !== "function") {
      return undefined;
    }
    return registry.get(sessionId);
  };

  const handlers = createHandlers({
    store,
    clock,
    cooldownMs: config.precommitCooldownMs,
    lookupAgent,
  });
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
