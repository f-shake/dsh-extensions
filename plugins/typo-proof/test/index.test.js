import assert from "node:assert/strict";
import { test } from "node:test";

import { apply, completeText, createHandlers, describeProviders, normalizeConfig, panelState, reviewToState, sameOrigin, toItems } from "../index.js";

/**
 * 造一个只会吐固定片段的 llm 服务。
 * @param {object[]} chunks - 要吐的 StreamChunk。
 * @returns {{ stream: (options: object) => AsyncGenerator<object> }} 假服务。
 */
function fakeLlm(chunks) {
  return {
    stream() {
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

test("host：collectText 只拼 text-delta，跳过思考过程", async () => {
  const llm = fakeLlm([
    { type: "reasoning-delta", index: 0, text: "我觉得" },
    { type: "text-delta", index: 1, text: "我睡得" },
    { type: "text-delta", index: 1, text: "很晚。" },
    { type: "finish", reason: { kind: "stop" } },
  ]);
  assert.equal(await completeText(llm, { provider: "p", model: "m", system: "s", messages: [], temperature: 0.7 }), "我睡得很晚。");
});

test("host：结束原因不是 stop 的一律当失败", async () => {
  const errorLlm = fakeLlm([{ type: "finish", reason: { kind: "error", failure: { code: "x", message: "连接被拒" } } }]);
  await assert.rejects(() => completeText(errorLlm, { provider: "p", model: "m", system: "", messages: [] }), /连接被拒/);

  const truncated = fakeLlm([{ type: "text-delta", index: 0, text: "半句" }, { type: "finish", reason: { kind: "max-tokens" } }]);
  await assert.rejects(() => completeText(truncated, { provider: "p", model: "m", system: "", messages: [] }), /输出不完整/);

  const silent = fakeLlm([{ type: "text-delta", index: 0, text: "没有结束" }]);
  await assert.rejects(() => completeText(silent, { provider: "p", model: "m", system: "", messages: [] }), /没有返回结束标记/);

  await assert.rejects(() => completeText(undefined, { provider: "p", model: "m", system: "", messages: [] }), /模型服务不可用/);
});

test("host：复核结论映射到面板四态", () => {
  assert.equal(reviewToState("confirmed"), "confirmed");
  assert.equal(reviewToState("redirected"), "disputed");
  assert.equal(reviewToState("rejected"), "rejected");
  assert.equal(reviewToState("failed"), "pending");
});

test("host：redirected 的候选在面板上用复核建议的字", () => {
  const items = toItems([
    {
      paraIndex: 11,
      pos: 2,
      orig: "的",
      sugg: "得",
      votes: 2,
      samples: ["我睡得很晚。", "", "我睡的很晚。"],
      context: { before: "", text: "我睡的很晚。", after: "" },
      review: { status: "redirected", suggestion: "底", note: "复核模型改成「底」" },
    },
  ]);
  assert.equal(items[0].seg, 12);
  assert.equal(items[0].state, "disputed");
  assert.equal(items[0].corrected, "我睡底很晚。");
  assert.equal(items[0].samples[1], "我睡的很晚。", "空样本退回原句，不要给面板一个空行");
});

test("host：配置归一化，非法值退回默认", () => {
  const config = normalizeConfig({ minHanzi: 5, samples: 0, concurrency: "3", file: "C:/a.docx" });
  assert.equal(config.minHanzi, 5);
  assert.equal(config.samples, 3, "0 次采样没有意义，退回默认");
  assert.equal(config.concurrency, 3);
  assert.equal(config.file, "C:/a.docx");
  assert.equal(normalizeConfig(null).reviewProvider, "");
});

test("host：面板状态在没跑过时是 idle，跑完给两个下载地址", () => {
  const idle = panelState({ job: null, config: normalizeConfig({ file: "C:/日记/2011~2014.docx", minHanzi: 8 }) });
  assert.equal(idle.status, "idle");
  assert.equal(idle.file, "2011~2014.docx");
  // dirname 只切字符串，不把分隔符归一成反斜杠：配置里写什么，这里就是什么。
  assert.equal(idle.dir, "C:/日记");
  assert.equal(idle.downloadUrl, "");

  const done = panelState({
    job: {
      id: "job-1",
      status: "done",
      phase: "done",
      // 真实 job 的形状：progress 由若干次 emit 合并而来，采样/复核进度各自记在
      // sampling / review 上——不能只拼一个漂亮的 progress 就把问题藏过去。
      progress: { phase: "done", processed: 12, total: 12, paragraphs: 234, hanzi: 16902 },
      sampling: { done: 12, total: 12 },
      review: { done: 1, total: 1 },
      file: "C:/日记/2011~2014.docx",
      error: null,
      paused: false,
      result: {
        candidates: [],
        counts: { candidates: 0, confirmed: 0, redirected: 0, rejected: 0, failed: 0, written: 0 },
        copyPath: "C:/日记/x.docx",
        csvPath: "C:/日记/x.csv",
      },
    },
    config: normalizeConfig({}),
  });
  assert.equal(done.status, "done");
  assert.equal(done.segments, 234);
  assert.equal(done.hanzi, 16902, "段落数与字数不能在第一次 emit 之后就归零");
  assert.equal(done.progress.localDone, 12);
  assert.equal(done.progress.reviewDone, 1);
  assert.equal(done.downloadUrl, "/typo-proof/download?job=job-1");
  assert.equal(done.csvUrl, "/typo-proof/csv?job=job-1");
});

test("host：模型列表拼成人话，拿不到就说拿不到", async () => {
  const ctx = {
    get: () => ({ listProviders: async () => [{ id: "lmstudio", models: [{ id: "qwen3-4b" }, { id: "qwen3-8b" }] }, { id: "deepseek-official", models: [{ id: "deepseek-flash" }] }] }),
  };
  assert.equal(await describeProviders(ctx), "lmstudio（qwen3-4b、qwen3-8b）；deepseek-official（deepseek-flash）");

  const empty = { get: () => ({ listProviders: async () => [] }) };
  assert.equal(await describeProviders(empty), "模型栏里一个 provider 都没有");

  const broken = { get: () => ({ listProviders: async () => { throw new Error("挂了"); } }) };
  assert.match(await describeProviders(broken), /拿不到模型列表（挂了）/);
});


test("host：/action start 会等 async 的 start，失败时把原因回给面板", async () => {
  /**
   * 造一个够用的 req：能异步迭代，读得到 body。
   * @param {string} method - 方法。
   * @param {string} url - 路径。
   * @param {unknown} [body] - JSON 体。
   * @returns {object} 假请求。
   */
  function fakeReq(method, url, body) {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    return {
      method,
      url,
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk;
      },
    };
  }

  /** 造一个只记状态与响应体的 res。 */
  function fakeRes() {
    return {
      status: 0,
      payload: null,
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.payload = JSON.parse(body);
      },
    };
  }

  const jobs = { current: () => null, byId: () => null, pause: () => false, resume: () => false, stop: () => false };
  const handlers = createHandlers({ jobs, config: normalizeConfig({}), start: async () => ({ id: "job-9" }) });

  const ok = fakeRes();
  await handlers(fakeReq("POST", "/typo-proof/action", { action: "start" }), ok);
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.jobId, "job-9");

  const bad = createHandlers({ jobs, config: normalizeConfig({}), start: async () => { throw new Error("还没配本地模型"); } });
  const res = fakeRes();
  await bad(fakeReq("POST", "/typo-proof/action", { action: "start" }), res);
  assert.equal(res.status, 400);
  assert.match(res.payload.error, /还没配本地模型/);

  const statusRes = fakeRes();
  await handlers(fakeReq("GET", "/typo-proof/status"), statusRes);
  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.payload.status, "idle");
});

test("host：跨站请求被挡在门外，同源与直接访问放行", () => {
  assert.equal(sameOrigin({ headers: {} }), true, "直接输地址没有 Origin");
  assert.equal(sameOrigin({ headers: { origin: "https://dsh-nas.fshake.com", host: "dsh-nas.fshake.com" } }), true);
  assert.equal(sameOrigin({ headers: { origin: "https://evil.example", host: "dsh-nas.fshake.com" } }), false);
  assert.equal(sameOrigin({ headers: { "sec-fetch-site": "cross-site", host: "dsh-nas.fshake.com" } }), false);
  assert.equal(sameOrigin({ headers: { origin: "不是个地址", host: "x" } }), false);
  assert.equal(sameOrigin({ headers: { origin: "https://a.example" } }), false, "有 Origin 没 Host 也不放行");
});

test("host：apply 把工具与路由都注册上", () => {  const tools = [];
  const routes = [];
  const ctx = {
    effect(factory) {
      factory();
    },
    inject(_names, callback) {
      callback({
        effect(factory) {
          factory();
        },
        webServer: {
          register(spec) {
            routes.push(spec);
          },
        },
      });
    },
    tools: {
      register(definition) {
        tools.push(definition);
      },
    },
    get: () => undefined,
  };

  apply(ctx, { file: "C:/日记/2011~2014.docx", localModel: "qwen3-4b" });

  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "typo_check");
  assert.equal(tools[0].parameters.type, "object");
  assert.equal(typeof tools[0].execute, "function");
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, "/typo-proof");
  assert.equal(routes[0].kind, "prefix");
  assert.equal(typeof routes[0].handler, "function");
});

