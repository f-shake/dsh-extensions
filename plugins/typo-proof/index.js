/**
 * 宿主半边：一个工具、一份任务状态、三条路由。
 *
 * 工具（`typo_check`）是同步语义——调它就等结果；面板走同一套管线，
 * 但自己起任务、自己轮询状态，所以两者共用 `createJobStore`，只是等不等而已。
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { createCache } from "./lib/cache.js";
import { PROMPT_VERSION } from "./lib/prompts.js";
import { applySuggestions, runCheck } from "./lib/pipeline.js";

export const name = "typo-proof";
export const inject = ["tools"];

const ROUTE_PREFIX = "/typo-proof";
const DEFAULT_MIN_HANZI = 8;
const DEFAULT_SAMPLES = 3;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_REVIEW_CONCURRENCY = 2;

/**
 * 归一化 Loader 行配置。
 * @param {unknown} raw - 原始配置。
 * @returns {object} 归一化结果。
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const number = (value, fallback, min) => (Number.isFinite(Number(value)) && Number(value) >= min ? Number(value) : fallback);
  return {
    demo: source.demo === true,
    file: typeof source.file === "string" ? source.file : "",
    localProvider: typeof source.localProvider === "string" ? source.localProvider : "",
    localModel: typeof source.localModel === "string" ? source.localModel : "",
    reviewProvider: typeof source.reviewProvider === "string" ? source.reviewProvider : "",
    reviewModel: typeof source.reviewModel === "string" ? source.reviewModel : "",
    minHanzi: number(source.minHanzi, DEFAULT_MIN_HANZI, 1),
    samples: number(source.samples, DEFAULT_SAMPLES, 1),
    concurrency: number(source.concurrency, DEFAULT_CONCURRENCY, 1),
    reviewConcurrency: number(source.reviewConcurrency, DEFAULT_REVIEW_CONCURRENCY, 1),
    cacheDir: typeof source.cacheDir === "string" && source.cacheDir !== "" ? source.cacheDir : "",
  };
}

/**
 * 把一次模型调用收敛成一段文本。
 *
 * 只认 `text-delta`：思考过程（`reasoning-delta`）不算答案。结束原因必须是 `stop`，
 * 被截断（`max-tokens`）或出错都当成失败——半截句子比没有结果更危险。
 * @param {object} llm - `ctx.llm` 服务。
 * @param {{ provider: string, model: string, system: string, messages: object[], temperature: number, signal?: AbortSignal }} request - 请求。
 * @returns {Promise<string>} 模型输出。
 */
export async function completeText(llm, request) {
  if (llm === undefined || llm === null || typeof llm.stream !== "function") {
    throw new Error("模型服务不可用：宿主没有提供 ctx.llm");
  }
  let text = "";
  let finish = null;
  const stream = llm.stream({
    provider: request.provider,
    model: request.model,
    system: request.system,
    messages: request.messages,
    temperature: request.temperature,
    signal: request.signal,
  });
  for await (const chunk of stream) {
    if (chunk.type === "text-delta") text += chunk.text;
    else if (chunk.type === "finish") {
      finish = chunk.reason;
      break;
    }
  }
  if (finish === null) throw new Error("模型没有返回结束标记");
  if (finish.kind === "error") throw new Error(`模型返回错误：${finish.failure?.message ?? "未知"}`);
  if (finish.kind === "aborted") throw new Error("模型调用被中断");
  if (finish.kind !== "stop") throw new Error(`模型输出不完整（${finish.kind}）`);
  return text;
}

/**
 * 复核结论到面板四态的映射。
 * @param {string} status - confirmed / rejected / redirected / failed。
 * @returns {string} 面板用的状态。
 */
export function reviewToState(status) {
  if (status === "confirmed") return "confirmed";
  if (status === "redirected") return "disputed";
  if (status === "rejected") return "rejected";
  return "pending";
}

/**
 * 候选 → 面板条目。
 * @param {object[]} candidates - 候选。
 * @returns {object[]} 面板条目。
 */
export function toItems(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  return list.map((candidate) => {
    const suggestion = candidate.review?.status === "redirected" ? candidate.review.suggestion : candidate.sugg;
    const samples = Array.isArray(candidate.samples) ? candidate.samples : [];
    return {
      // 同一段里可能有好几条候选，key 不能只用段号——那样 React 会撞车。
      id: typeof candidate.id === "string" ? candidate.id : `${candidate.paraIndex}-${candidate.pos}`,
      seg: candidate.paraIndex + 1,
      original: candidate.context.text,
      corrected: applySuggestions(candidate.context.text, [{ pos: candidate.pos, sugg: suggestion }]),
      hits: candidate.votes,
      state: reviewToState(candidate.review?.status ?? "failed"),
      note: candidate.review?.note ?? "",
      prev: candidate.context.before,
      next: candidate.context.after,
      samples: samples.map((text) => (text === "" ? candidate.context.text : text)),
    };
  });
}

/**
 * 任务存储：同一时间只跑一个——单文件场景，两个任务只会互相抢本地模型。
 * @returns {object} 任务存储。
 */
export function createJobStore() {
  let current = null;
  let sequence = 0;

  function start(task) {
    sequence += 1;
    const controller = new AbortController();
    const job = {
      id: `job-${Date.now()}-${sequence}`,
      status: "running",
      phase: "parsing",
      progress: { phase: "parsing", processed: 0, total: 0 },
      // 两个阶段各自记进度：复核阶段的 total 是候选数，和采样的句数不是一回事，
      // 混用一个字段会让面板的进度条从 234 突然变成 9。
      sampling: { done: 0, total: 0 },
      review: { done: 0, total: 0 },
      startedAt: Date.now(),
      file: task.file,
      models: task.models,
      error: null,
      result: null,
      controller,
      paused: false,
      resume: null,
      gate: null,
    };

    job.gate = () => {
      if (!job.paused) return Promise.resolve();
      return new Promise((resolveGate) => {
        job.resume = () => {
          job.resume = null;
          resolveGate();
        };
      });
    };

    job.promise = runCheck({
      file: task.file,
      llm: task.llm,
      reviewLlm: task.reviewLlm,
      cache: task.cache,
      minHanzi: task.minHanzi,
      samples: task.samples,
      concurrency: task.concurrency,
      reviewConcurrency: task.reviewConcurrency,
      localModel: task.models.local,
      reviewModel: task.models.review,
      signal: controller.signal,
      gate: job.gate,
      onProgress: (progress) => {
        job.phase = progress.phase;
        // 合并而不是整体替换：段落数与字数是采样开始时算好的，
        // 后面每次只带变化的字段，替换会把它们冲掉。
        job.progress = { ...job.progress, ...progress };
        if (progress.phase === "sampling") {
          job.sampling = { done: progress.processed ?? 0, total: progress.total ?? 0 };
        } else if (progress.phase === "reviewing") {
          job.review = { done: progress.processed ?? 0, total: progress.total ?? 0 };
        }
      },
    })
      .then((result) => {
        job.status = "done";
        job.phase = "done";
        job.result = result;
        return result;
      })
      .catch((error) => {
        job.status = "error";
        job.error = String(error?.message ?? error);
        throw error;
      });

    // 工具那条路会 await promise；面板那条路不 await，这里必须把拒绝吃掉，
    // 否则会变成未处理的 rejection。
    job.promise.catch(() => {});

    current = job;
    return job;
  }

  return {
    start,
    current: () => current,
    byId: (id) => (current !== null && current.id === id ? current : null),
    stop() {
      if (current === null) return false;
      current.controller.abort();
      current.paused = false;
      current.resume?.();
      return true;
    },
    pause() {
      if (current === null || current.status !== "running") return false;
      current.paused = true;
      return true;
    },
    resume() {
      if (current === null) return false;
      current.paused = false;
      current.resume?.();
      return true;
    },
  };
}

/**
 * 生成面板状态。轮询接口直接返这个，客户端只做渲染。
 * @param {{ job: object | null, config: object }} input - 任务与配置。
 * @returns {object} 面板状态。
 */
export function panelState(input) {
  const { job, config } = input;
  const localModel = config.localModel === "" ? "" : `${config.localProvider === "" ? "" : `${config.localProvider} / `}${config.localModel}`;
  const reviewModel = config.reviewModel === "" ? "" : `${config.reviewProvider === "" ? "" : `${config.reviewProvider} / `}${config.reviewModel}`;
  const base = {
    status: "idle",
    file: config.file === "" ? "" : basename(config.file),
    dir: config.file === "" ? "" : dirname(config.file),
    segments: 0,
    hanzi: 0,
    localModel,
    reviewModel,
    minHanzi: config.minHanzi,
    progress: {},
    items: [],
    counts: { candidates: 0, confirmed: 0, disputed: 0, rejected: 0 },
    error: "",
    note: "",
    downloadUrl: "",
    demo: config.demo,
  };
  if (job === null) return base;

  const progress = job.progress ?? {};
  const items = job.result !== null ? toItems(job.result.candidates) : [];
  const counts = job.result?.counts ?? null;
  return {
    ...base,
    status: job.status === "error" ? "error" : job.status === "done" ? "done" : "running",
    file: basename(job.file),
    dir: dirname(job.file),
    segments: progress.paragraphs ?? 0,
    hanzi: progress.hanzi ?? 0,
    progress: {
      localDone: job.sampling?.done ?? 0,
      localTotal: job.sampling?.total ?? 0,
      reviewDone: job.review?.done ?? 0,
      reviewTotal: job.review?.total ?? 0,
    },
    items,
    counts:
      counts ?? {
        candidates: items.length,
        confirmed: items.filter((item) => item.state === "confirmed").length,
        disputed: items.filter((item) => item.state === "disputed").length,
        rejected: items.filter((item) => item.state === "rejected").length,
      },
    error: job.error ?? "",
    note: job.paused ? "已暂停" : "",
    downloadUrl: job.status === "done" && job.result?.copyPath !== "" ? `${ROUTE_PREFIX}/download?job=${encodeURIComponent(job.id)}` : "",
    csvUrl: job.status === "done" && job.result?.csvPath !== "" ? `${ROUTE_PREFIX}/csv?job=${encodeURIComponent(job.id)}` : "",
  };
}

/**
 * 是否只可能是「本页自己」发出的请求。
 *
 * 这**不是鉴权**——宿主自述路由层的鉴权归反代管。这里挡的是跨站页面用浏览器带着
 * cookie 直接打 `/typo-proof/action` 那一类 CSRF：那种请求一定会带 Origin 或
 * `sec-fetch-site: cross-site`，而本站页面发起的同源请求 Origin 与 Host 一致。
 * 反代仍然必须把 `/typo-proof` 挡在登录之后，否则日志路径与候选正文就直接暴露了。
 * @param {object} req - 请求。
 * @returns {boolean} 是否放行。
 */
export function sameOrigin(req) {
  const headers = req?.headers ?? {};
  if (String(headers["sec-fetch-site"] ?? "") === "cross-site") return false;
  const origin = headers.origin;
  if (typeof origin !== "string" || origin === "") return true;
  const host = headers.host;
  if (typeof host !== "string" || host === "") return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * 构造路由处理器。
 * @param {{ jobs: object, config: object, start: (models: object) => object }} deps - 依赖。
 * @returns {(req: object, res: object) => Promise<void>} 处理器。
 */
export function createHandlers(deps) {
  const { jobs, config, start } = deps;

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  }

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return {};
    }
  }

  return async function handle(req, res) {
    if (!sameOrigin(req)) {
      return sendJson(res, 403, { ok: false, error: "跨站请求已被拒绝" });
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.slice(ROUTE_PREFIX.length) || "/";
    const method = (req.method ?? "GET").toUpperCase();

    if (path === "/status" && method === "GET") {
      return sendJson(res, 200, panelState({ job: jobs.current(), config }));
    }

    if (path === "/action" && method === "POST") {
      const body = await readBody(req);
      if (body.action === "start") {
        if (jobs.current()?.status === "running") {
          return sendJson(res, 409, { ok: false, error: "已经有一个检查在跑" });
        }
        try {
          // start 是 async 的（要先校验配置），必须等它，否则拿到的是 Promise 不是任务。
          const job = await start({});
          return sendJson(res, 200, { ok: true, jobId: job.id });
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
      if (body.action === "pause") return sendJson(res, 200, { ok: jobs.pause() });
      if (body.action === "resume") return sendJson(res, 200, { ok: jobs.resume() });
      if (body.action === "stop") return sendJson(res, 200, { ok: jobs.stop() });
      return sendJson(res, 400, { ok: false, error: "未知动作" });
    }

    if ((path === "/download" || path === "/csv") && method === "GET") {
      const job = jobs.byId(url.searchParams.get("job") ?? "");
      if (job === null || job.status !== "done") return sendJson(res, 404, { ok: false, error: "没有可下载的结果" });
      const source = path === "/download" ? job.result.copyPath : job.result.csvPath;
      if (typeof source !== "string" || source === "") return sendJson(res, 404, { ok: false, error: "没有可下载的结果" });
      const info = await stat(source).catch(() => null);
      if (info === null) return sendJson(res, 404, { ok: false, error: "文件已被移动或删除" });
      res.writeHead(200, {
        "content-type":
          path === "/download"
            ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            : "text/csv; charset=utf-8",
        "content-length": String(info.size),
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(basename(source))}`,
        "cache-control": "no-store",
      });
      createReadStream(source).pipe(res);
      return undefined;
    }

    return sendJson(res, 404, { ok: false, error: "not-found" });
  };
}

/**
 * 插件入口。
 * @param {object} ctx - Cordis 上下文。
 * @param {unknown} rawConfig - Loader 行配置。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);

  const resolveFile = (input) => {
    const raw = typeof input === "string" && input !== "" ? input : config.file;
    if (raw === "") throw new Error("还没有指定要检查的 docx：请在插件配置里设 file，或调用工具时传 file");
    return isAbsolute(raw) ? resolve(raw) : resolve(process.cwd(), raw);
  };

  const makeClient = (models) => ({
    complete: ({ system, messages, temperature, signal }) => {
      const llm = typeof ctx.get === "function" ? ctx.get("llm") : ctx.llm;
      return completeText(llm, {
        provider: models.provider,
        model: models.model,
        system,
        messages,
        temperature,
        signal,
      });
    },
  });

  const cacheFor = (file) => {
    const dir = config.cacheDir === "" ? join(dirname(file), ".typo-proof-cache") : config.cacheDir;
    return createCache({ dir });
  };

  const jobs = createJobStore();

  const start = async (options) => {
    const file = resolveFile(options.file);
    if (config.localModel === "") {
      // 报错时把模型栏里现有的都列出来：不然用户只知道「没配」，不知道该填什么。
      const hint = await describeProviders(ctx);
      throw new Error(`还没有配置本地模型：请在插件配置里填 localProvider / localModel。模型栏里现在有：${hint}`);
    }
    const localClient = makeClient({ provider: config.localProvider, model: config.localModel });
    // 复核模型单独一个客户端；没配就退回本地那个（等于没有云端复核，报告里如实记着）。
    const reviewClient =
      config.reviewModel === "" ? localClient : makeClient({ provider: config.reviewProvider, model: config.reviewModel });
    return jobs.start({
      file,
      llm: localClient,
      reviewLlm: reviewClient,
      cache: cacheFor(file),
      minHanzi: Number.isFinite(Number(options.minHanzi)) ? Number(options.minHanzi) : config.minHanzi,
      samples: config.samples,
      concurrency: config.concurrency,
      reviewConcurrency: config.reviewConcurrency,
      models: { local: `${config.localProvider}/${config.localModel}`, review: `${config.reviewProvider}/${config.reviewModel}` },
    });
  };

  ctx.effect(
    () =>
      ctx.tools.register({
        name: "typo_check",
        description:
          "检查一个 .docx 里的错别字：逐句交给本地模型采样三次，只要三次里有两次改动了这句，就把这些改动（含只被改过一次的地方）交给云端模型盲复核，确认的改动以 Word 修订模式写进副本，原文件不改。适合日记、长文这类需要人工过一遍的稿子。",
        parameters: {
          type: "object",
          properties: {
            file: { type: "string", description: "docx 的绝对路径；不传就用插件配置里的 file" },
            minHanzi: { type: "number", description: "句子里少于这么多汉字就不检，默认 8" },
          },
          required: [],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: "object",
            properties: {
              file: { type: "string" },
              segments: { type: "number" },
              candidates: { type: "number" },
              confirmed: { type: "number" },
              disputed: { type: "number" },
              rejected: { type: "number" },
              copyPath: { type: "string" },
              reportPath: { type: "string" },
              csvPath: { type: "string" },
              downloadUrl: { type: "string" },
            },
            required: ["file", "segments", "candidates", "confirmed", "disputed", "rejected", "copyPath", "reportPath", "csvPath", "downloadUrl"],
            additionalProperties: false,
          },
          render(_args, value) {
            const lines = [`${basename(value.file)}：${value.segments} 段，${value.candidates} 条可疑，其中云端确认 ${value.confirmed} 条。`];
            if (value.disputed > 0) lines.push(`有 ${value.disputed} 条两边改法不一致，需要你定夺。`);
            if (value.copyPath !== "") lines.push(`带修订的副本：${value.copyPath}`);
            else lines.push("没有确认的改动，所以没有生成副本。");
            lines.push("下载入口在对话里的卡片上，回复里不要贴这些路径。");
            return [{ type: "text", text: lines.join("\n") }];
          },
          presentationMeta(_args, value) {
            return {
              file: basename(value.file),
              segments: value.segments,
              candidates: value.candidates,
              confirmed: value.confirmed,
              disputed: value.disputed,
              rejected: value.rejected,
              downloadUrl: value.downloadUrl,
            };
          },
        },
        async execute(args) {
          const job = await start({
            file: typeof args?.file === "string" ? args.file : "",
            minHanzi: args?.minHanzi,
          });
          const result = await job.promise;
          const confirmed = result.candidates.filter((item) => item.review?.status === "confirmed").length;
          const redirected = result.candidates.filter((item) => item.review?.status === "redirected").length;
          const rejected = result.candidates.filter((item) => item.review?.status === "rejected").length;
          return {
            file: result.file,
            segments: result.paragraphs.length,
            candidates: result.candidates.length,
            confirmed,
            disputed: redirected,
            rejected,
            copyPath: result.copyPath,
            reportPath: result.reportPath,
            csvPath: result.csvPath,
            downloadUrl: result.copyPath === "" ? "" : `${ROUTE_PREFIX}/download?job=${encodeURIComponent(job.id)}`,
          };
        },
      }),
    "typo-proof: tool",
  );

  ctx.inject(["webServer"], (scope) => {
    scope.effect(
      () =>
        scope.webServer.register({
          kind: "prefix",
          path: ROUTE_PREFIX,
          handler: createHandlers({ jobs, config, start }),
        }),
      "typo-proof: routes",
    );
  });
}

/**
 * 列出模型栏里现成的 provider 与模型，拼成一句人话。
 *
 * `listProviders()` 的返回结构随宿主版本可能变化，所以这里全程防御式读取，
 * 拿不到就老实说「现在拿不到」——不要编一个假的清单出来。
 * @param {object} ctx - Cordis 上下文。
 * @returns {Promise<string>} 像 `lmstudio（qwen3-4b、qwen3-8b）；deepseek-official（deepseek-flash）`。
 */
export async function describeProviders(ctx) {
  try {
    const llm = typeof ctx.get === "function" ? ctx.get("llm") : ctx.llm;
    if (llm === undefined || llm === null || typeof llm.listProviders !== "function") return "现在拿不到模型列表";
    const providers = await llm.listProviders();
    const list = Array.isArray(providers) ? providers : [];
    if (list.length === 0) return "模型栏里一个 provider 都没有";
    return list
      .map((provider) => {
        const name = provider?.id ?? provider?.name ?? "未命名";
        const models = Array.isArray(provider?.models) ? provider.models.map((model) => model?.id ?? model?.name ?? "") : [];
        const named = models.filter((model) => typeof model === "string" && model !== "");
        return named.length === 0 ? String(name) : `${String(name)}（${named.join("、")}）`;
      })
      .join("；");
  } catch (error) {
    return `现在拿不到模型列表（${String(error?.message ?? error)}）`;
  }
}

export { PROMPT_VERSION };
