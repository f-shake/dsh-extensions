/**
 * 宿主半边：把「用户插话」变成「前台命令转后台」。
 *
 * 为什么必须包装 wait：DSH 没有「让正在等待的工具调用提前收手、但保留进程」
 * 的公开入口——前台 shell 调用只会在自己在 `ctx.jobs.wait` 上等到结算、超时
 * 或被中断时结束，中断会连带杀进程。要保留进程，只能把一次长等待切成短切片，
 * 在插话到来时停止等待并返回当前的 running 视图；工具自己的 promoted 分支
 * 会接手这件事：返回 job id 与已产生的输出，进程继续跑。
 *
 * 为什么释放后要等当前切片自然结束：每次切片都是一次真实的 wait，它会在
 * 原有实现里注册一个等待者；等待者还在时发生的结算会被标记为「已被取走」，
 * 完成通知就不再发给模型。等切片到点自己摘掉等待者，结算时 awaited 为
 * false，命令结束后模型仍能收到通知。
 */

/** 允许被转后台的任务类型：只覆盖 shell 工具，其他 job 的等待语义保持不变。 */
const DEFAULT_KINDS = ["pwsh", "bash"];

/**
 * 切片长度：正常情况下决定「插话到工具返回」的最大延迟，也是释放后的收尾等待上限。
 * 等待年龄不足最小等待年龄时，实际最坏是 最小等待年龄 + 一个切片。
 */
const DEFAULT_SLICE_MS = 250;

/** 切片长度的允许区间：太短会频繁唤醒等待者，太长会让插话有明显的延迟。 */
const MIN_SLICE_MS = 50;
const MAX_SLICE_MS = 1000;

/**
 * 工具侧的「前台等待被放手」标记。文案由 pwsh / bash 两个工具写死，
 * 这里只用来定位那段标记和取出 job id，不参与其他判断。
 */
const PROMOTED_PATTERN = /\[still running after [^\]\n]*?; moved to background job ([^\]\n]+)\]/;

/**
 * 插话释放记录的有效期：过了这段时间还没被对应工具调用取走，就当作没发生过，
 * 避免长会话里表无限增长，也避免误改同一 job id 的后续结果。
 */
const STEERED_TTL_MS = 60_000;

/**
 * 释放的最小等待年龄：任务刚注册时进程可能还没 spawn 出来，此时让工具拿到
 * running 视图会触发它自己的「准备期超时」分支并杀掉命令。等一小会儿再唤醒，
 * 让 spawn 有时间完成。只是缩小概率，不能保证（spawn 更慢时仍会命中）。
 */
const PREPARATION_GRACE_MS = 750;

/**
 * 校验并补全插件配置。配置来自 Loader 行，可能是空对象或非对象。
 * @param {unknown} raw - Loader 传入的原始配置。
 * @returns {{ enabled: boolean, kinds: string[], sliceMs: number }} 归一化后的配置。
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const kinds = Array.isArray(source.kinds)
    ? source.kinds.filter((kind) => typeof kind === "string" && kind !== "")
    : [];
  const slice = Number(source.sliceMs);
  return {
    enabled: source.enabled !== false,
    kinds: kinds.length > 0 ? kinds : [...DEFAULT_KINDS],
    sliceMs: Number.isFinite(slice)
      ? Math.min(Math.max(slice, MIN_SLICE_MS), MAX_SLICE_MS)
      : DEFAULT_SLICE_MS,
  };
}

/**
 * 判断一条会话事件是否代表「用户主动插话」。
 *
 * 只认 next-step 目标：next-turn 是排队，排队不该把命令转后台。只认用户来源：
 * goal、plan、子代理等内部插话同样会把消息塞进 inbox，它们不代表人不想等了。
 * @param {unknown} event - session/event 的负载。
 * @returns {boolean} 是否应当释放等待。
 */
export function isUserSteer(event) {
  if (event === null || typeof event !== "object" || event.type !== "agent/inbox/spliced") return false;
  const data = event.data;
  if (data === null || typeof data !== "object" || data.target !== "next-step") return false;
  const inserted = data.inserted;
  if (!Array.isArray(inserted) || inserted.length === 0) return false;
  return inserted.some((message) => message?.source?.kind === "user");
}

/**
 * 替换用的说明句：说清是用户插话让这次等待提前结束，而不是超时。
 * @param {string} jobId - 被转到后台的 job id。
 * @returns {string} 替换标记。
 */
function steeredMarker(jobId) {
  return `[the user sent a message, so this call stopped waiting; the command moved to background job ${jobId} and is still running — this is not a timeout]`;
}

/**
 * 把工具写的「等到了超时才转到后台」标记换成符合事实的说法。
 *
 * 工具侧无法区分「等满了超时」与「等待被提前放手」，两者走同一个 promoted 分支，
 * 文案固定写成 `[still running after {timeoutMs}ms; …]`，模型会误以为命令超时了。
 * 这里只在释放记录命中时改写；没命中就原样返回，工具以后换了文案也不会改坏结果。
 *
 * 逐处替换而不是只换第一处：被转后台的命令可能在输出里带上同格式的文字（读日志、读本文档），
 * 只认第一处会漏掉真正的标记，而真正的标记总在输出之后。
 * @param {unknown} text - 工具结果里的一段文本。
 * @param {(jobId: string) => boolean} isSteered - 该 job 是否由本次插话释放，调用即消费。
 * @returns {unknown} 改写后的文本；不需要改写时返回入参本身。
 */
export function relabelPromoted(text, isSteered) {
  if (typeof text !== "string" || typeof isSteered !== "function") return text;
  const pattern = new RegExp(PROMOTED_PATTERN.source, "g");
  let out = "";
  let cursor = 0;
  let changed = false;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (!isSteered(match[1])) continue;
    out += text.slice(cursor, match.index) + steeredMarker(match[1]);
    cursor = match.index + match[0].length;
    changed = true;
  }
  return changed ? out + text.slice(cursor) : text;
}

/**
 * 按块改写工具结果内容：只碰文本块，其他块原样保留；没有改动时返回原数组，
 * 让上层可以靠引用相等判断是否需要替换。
 * @param {unknown} content - 工具结果的内容块数组。
 * @param {(jobId: string) => boolean} isSteered - 释放记录的判定函数。
 * @returns {unknown} 可能被替换的内容数组。
 */
export function relabelContent(content, isSteered) {
  if (!Array.isArray(content) || typeof isSteered !== "function") return content;
  let changed = false;
  const next = content.map((block) => {
    if (block === null || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") return block;
    const text = relabelPromoted(block.text, isSteered);
    if (text === block.text) return block;
    changed = true;
    return { ...block, text };
  });
  return changed ? next : content;
}

/**
 * 包装一个 job 注册表的 wait，使「有等待者的任务」可以在不杀进程的前提下被提前放手。
 *
 * 语义边界：除了新增的 release，四条出口与原来的 wait 一致——结算返回终态视图、
 * 超时返回当时视图、中断照旧抛错、非法超时交给原实现抛它自己的错误。
 * @param {object} options - 依赖注入。
 * @param {object} options.jobs - 真实的 job 注册表（需要 get 与 wait）。
 * @param {string[]} [options.kinds] - 允许释放的任务类型。
 * @param {number} [options.sliceMs] - 切片长度。
 * @param {number} [options.preparationGraceMs] - 释放前的最小等待年龄。
 * @param {() => number} [options.now] - 记录时间戳用的时钟；切片计时仍用真实时间，因为那量的是实际等待。
 * @returns {{ install: () => void, release: (owner?: string) => number, consumeSteered: (jobId: unknown, owner?: string) => boolean, dispose: () => void, waiterIds: () => string[] }} 安装、释放、改写判定、卸载与诊断入口。
 */
export function createWaitTap({
  jobs,
  kinds = DEFAULT_KINDS,
  sliceMs = DEFAULT_SLICE_MS,
  preparationGraceMs = PREPARATION_GRACE_MS,
  now = Date.now,
} = {}) {
  if (jobs === null || typeof jobs !== "object") throw new Error("background-send：缺少 jobs 服务");
  const original = jobs.wait;
  if (typeof original !== "function") throw new Error("background-send：jobs.wait 不可调用");

  const allowed = new Set(kinds);
  const waiters = new Map();
  /** 最近因为插话被放手的 job：job id → { owner, at }，供结果改写核对。 */
  const steered = new Map();
  const graceTimers = new Set();
  const ownsWait = Object.prototype.hasOwnProperty.call(jobs, "wait");
  let installed = false;

  /**
   * 一次包装后的 wait。切片循环把「长等待」拆成可被打断的短等待。
   * @param {string} id - job id。
   * @param {number} timeoutMs - 总等待上限。
   * @param {string} [caller] - 读取方会话 id。
   * @param {AbortSignal} [signal] - 调用方取消信号。
   * @returns {Promise<object>} job 视图。
   */
  async function tapWait(id, timeoutMs, caller, signal) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return original.call(jobs, id, timeoutMs, caller, signal);
    }
    const key = String(id);
    const current = jobs.get(id, caller);
    if (current.status !== "running" && current.status !== "stopping") return current;
    if (signal !== undefined && signal.aborted) throw new Error("wait aborted");

    let release;
    const released = new Promise((resolve) => {
      release = () => resolve();
    });
    const record = {
      owner: caller === undefined || caller === null ? undefined : String(caller),
      kind: current.kind,
      release,
      startedAt: now(),
    };
    waiters.set(key, record);
    try {
      let remaining = timeoutMs;
      for (;;) {
        if (remaining <= 0) return jobs.get(id, caller);
        const slice = Math.min(remaining, sliceMs);
        const startedAt = Date.now();
        const sliceWait = original.call(jobs, id, slice, caller, signal);
        const outcome = await Promise.race([
          sliceWait.then((view) => ({ type: "view", view })),
          released.then(() => ({ type: "released" })),
        ]);
        remaining -= Date.now() - startedAt;
        if (outcome.type === "view") {
          if (outcome.view.status !== "running" && outcome.view.status !== "stopping") return outcome.view;
          if (remaining <= 0) return outcome.view;
          continue;
        }
        // 释放：等这一片自己结束，让原实现摘掉等待者，结算才能被判定为「未取走」。
        // 不吞掉拒绝：中止信号若在这段时间内到达，这里继续抛出，工具仍会按原有路径杀掉命令。
        const settled = await sliceWait;
        if (settled !== undefined && settled.status !== "running" && settled.status !== "stopping") return settled;
        return jobs.get(id, caller);
      }
    } finally {
      if (waiters.get(key) === record) waiters.delete(key);
      release();
    }
  }

  return {
    install() {
      if (installed) return;
      jobs.wait = tapWait;
      installed = true;
    },
    /**
     * 放掉一个会话正在等待的 shell 任务。
     * @param {string} [owner] - 会话 id；缺省时不做任何事，避免误放别人的等待。
     * @returns {number} 本次实际放手的等待数。
     */
    release(owner) {
      if (owner === undefined || owner === null) return 0;
      const target = String(owner);
      const released = [];
      const at = now();
      for (const [key, record] of [...steered]) {
        if (at - record.at > STEERED_TTL_MS) steered.delete(key);
      }
      for (const [key, record] of [...waiters]) {
        if (record.owner !== target) continue;
        if (!allowed.has(record.kind)) continue;
        const age = at - record.startedAt;
        if (age < preparationGraceMs) {
          // 进程可能还在准备中：稍后再唤醒，避免工具走「准备期超时」把命令杀掉。
          // 定时器必须记下来：宽限期内插件被卸载时，dispose 要能撤掉它，否则会在卸载后
          // 唤醒一个本该随插件一起消失的等待。
          const timer = setTimeout(() => {
            graceTimers.delete(timer);
            record.release();
          }, preparationGraceMs - age);
          graceTimers.add(timer);
        } else {
          record.release();
        }
        // 记下这次放手，供工具结果改写核对：只有真的被插话放手的等待才改写文案。
        steered.set(key, { owner: target, at });
        released.push(key);
      }
      // 立刻从表里摘除：释放是幂等的，同一会话的第二次插话不该再算一遍。
      for (const key of released) waiters.delete(key);
      return released.length;
    },
    /**
     * 判定某个 job 是否由插话释放，并把这条记录消费掉（一次性）。
     * @param {unknown} jobId - 工具结果里写出的 job id。
     * @param {string} [owner] - 读取方的会话 id。
     * @returns {boolean} 是否由插话释放。
     */
    consumeSteered(jobId, owner) {
      if (jobId === undefined || jobId === null) return false;
      const key = String(jobId);
      const record = steered.get(key);
      if (record === undefined) return false;
      if (now() - record.at > STEERED_TTL_MS) {
        steered.delete(key);
        return false;
      }
      if (owner === undefined || owner === null) return false;
      if (record.owner !== String(owner)) return false;
      steered.delete(key);
      return true;
    },
    dispose() {
      if (!installed) return;
      if (ownsWait) jobs.wait = original;
      else delete jobs.wait;
      installed = false;
      waiters.clear();
      steered.clear();
      for (const timer of graceTimers) clearTimeout(timer);
      graceTimers.clear();
    },
    /** 当前正在等待的 job id，供自检与测试使用。 */
    waiterIds() {
      return [...waiters.keys()];
    },
  };
}

export const name = "background-send";
export const inject = ["jobs"];

/**
 * 宿主插件入口：安装 wait 包装，并在用户插话时释放本会话的前台 shell 等待。
 * @param {object} ctx - Cordis 上下文。
 * @param {unknown} rawConfig - Loader 行配置。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  if (!config.enabled) return;
  ctx.inject(["jobs"], (scope) => {
    const jobs = scope.jobs;
    let tap;
    try {
      tap = createWaitTap({ jobs, kinds: config.kinds, sliceMs: config.sliceMs });
    } catch (error) {
      ctx.logger?.warn?.(`background-send：未安装等待包装（${String(error)}）`);
      return;
    }
    tap.install();
    scope.effect(() => () => tap.dispose(), "background-send: wait tap");
    const stop = ctx.on("session/event", (session, event) => {
      if (!isUserSteer(event)) return;
      const released = tap.release(session?.id);
      if (released > 0) ctx.logger?.info?.(`background-send：插话转后台 ${released} 个任务`);
    });
    scope.effect(() => stop, "background-send: steer watcher");
    const allowed = new Set(config.kinds);
    /**
     * 改写那段固定文案。必须挂在 tools/post-execute 上而不是 tools/execute：
     * 后者返回的结果会被注册表按工具返回值重新渲染（normalizeDispatchResult），
     * 改写会丢；post-execute 的 {kind:"accept", content} 是注册表认可的替换出口。
     * 工具分不清「超时」和「插话放手」，只有本插件知道自己放走过哪条等待。
     */
    const stopPost = ctx.on("tools/post-execute", async (exec, result, next) => {
      const decision = await next();
      if (exec === null || typeof exec !== "object" || !allowed.has(exec.name)) return decision;
      if (result === null || typeof result !== "object" || result.isError === true) return decision;
      if (decision === null || typeof decision !== "object" || decision.kind !== "accept") return decision;
      if (decision.value !== undefined) return decision;
      const content = decision.content !== undefined ? decision.content : result.content;
      const relabeled = relabelContent(content, (jobId) => tap.consumeSteered(jobId, exec.agent?.id));
      return relabeled === content ? decision : { ...decision, content: relabeled };
    });
    scope.effect(() => stopPost, "background-send: promoted relabel");
  });
}

