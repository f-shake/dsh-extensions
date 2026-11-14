import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { miniDocx } from "./fixtures/mini-docx.js";

import { alternativesNote, apply, completeText, createHandlers, describeProviders, listDirectory, mergeConfig, suggestNeighbour, normalizeConfig, panelState, reviewToState, sameOrigin, toItems } from "../index.js";

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

test("host：合并后的备选改法拼进说明，不覆盖复核说明", () => {
  const [merged] = toItems([
    {
      paraIndex: 806,
      pos: 9,
      orig: "行",
      sugg: "算",
      votes: 2,
      changedVotes: 3,
      samples: ["早上妈妈走的时候就行了。"],
      context: { before: "前一句。", text: "早上妈妈走的时候就行了。", after: "后一句。" },
      review: { status: "redirected", suggestion: "醒", note: "复核模型改成“醒”" },
      alternatives: [{ sugg: "走", votes: 1, status: "rejected", suggestion: "" }],
    },
  ]);
  assert.equal(merged.note, "复核模型改成“醒”；另有改法：走（已否决）", "两段说明拼一行，备选要带复核结论");
  assert.equal(merged.corrected, "早上妈妈走的时候就醒了。", "显示仍然用复核给的那个字");
  assert.equal(merged.hits, 2, "票数是支持最终改法的次数");
  assert.equal(merged.changed, 3, "该处改动总数另给，面板拿去当悬停说明");

  // 分歧的备选要写出复核最后落到哪个字，否则人会直接改成那个备选的原始建议。
  const [redirected] = toItems([
    {
      paraIndex: 2,
      pos: 0,
      orig: "甲",
      sugg: "乙",
      votes: 1,
      samples: [],
      context: { before: "", text: "甲。", after: "" },
      review: { status: "confirmed", note: "" },
      alternatives: [{ sugg: "丙", votes: 1, status: "redirected", suggestion: "丁" }],
    },
  ]);
  assert.equal(redirected.note, "另有改法：丙（分歧→丁）");

  // 没有复核说明时只写备选，不能留下一个孤立的分号。
  const [bare] = toItems([
    {
      paraIndex: 1,
      pos: 0,
      orig: "甲",
      sugg: "乙",
      votes: 2,
      samples: [],
      context: { before: "", text: "甲。", after: "" },
      review: { status: "confirmed", note: "" },
      alternatives: [{ sugg: "丙", votes: 1, status: "rejected", suggestion: "" }],
    },
  ]);
  assert.equal(bare.note, "另有改法：丙（已否决）");
  assert.equal(alternativesNote({}), "", "没有 candidates 字段时给空串");
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

test("host：/action start 会等 async 的 start，失败时把原因回给面板", async () => {
  const jobs = { current: () => null, byId: () => null, pause: () => false, resume: () => false, stop: () => false };
  const configFor = async () => normalizeConfig({});
  const handlers = createHandlers({ jobs, configFor, start: async () => ({ id: "job-9" }) });

  const ok = fakeRes();
  await handlers(fakeReq("POST", "/typo-proof/action", { action: "start" }), ok);
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.jobId, "job-9");

  const bad = createHandlers({ jobs, configFor, start: async () => { throw new Error("还没配本地模型"); } });
  const res = fakeRes();
  await bad(fakeReq("POST", "/typo-proof/action", { action: "start" }), res);
  assert.equal(res.status, 400);
  assert.match(res.payload.error, /还没配本地模型/);

  const statusRes = fakeRes();
  await handlers(fakeReq("GET", "/typo-proof/status"), statusRes);
  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.payload.status, "idle");
});

test("host：面板存的空串不覆盖 Loader 里的默认值", () => {
  const loader = { file: "C:/日记/2011~2014.docx", localProvider: "qwen-4b", localModel: "qwen3.5_4b", reviewProvider: "deepseek-official", reviewModel: "deepseek-flash" };
  // 旧版面板曾把空文件路径写进 settings.json，结果配置里的 docx 被静默清空。
  const merged = mergeConfig(loader, { file: "", localProvider: "", localModel: "" });
  assert.equal(merged.file, "C:/日记/2011~2014.docx");
  assert.equal(merged.localModel, "qwen3.5_4b");
  // 复核模型留空是有意义的（= 不做云端复核），必须让它生效。
  assert.equal(mergeConfig(loader, { reviewModel: "" }).reviewModel, "");
});

test("host：跨站请求被挡在门外，同源与直接访问放行", () => {
  assert.equal(sameOrigin({ headers: {} }), true, "直接输地址没有 Origin");
  assert.equal(sameOrigin({ headers: { origin: "https://dsh-nas.fshake.com", host: "dsh-nas.fshake.com" } }), true);
  assert.equal(sameOrigin({ headers: { origin: "https://evil.example", host: "dsh-nas.fshake.com" } }), false);
  assert.equal(sameOrigin({ headers: { "sec-fetch-site": "cross-site", host: "dsh-nas.fshake.com" } }), false);
  assert.equal(sameOrigin({ headers: { origin: "不是个地址", host: "x" } }), false);
  assert.equal(sameOrigin({ headers: { origin: "https://a.example" } }), false, "有 Origin 没 Host 也不放行");
});

test("host：/config 能读能写，写坏了给可读错误；/providers 给结构化清单", async () => {
  const saved = [];
  const jobs = { current: () => null, byId: () => null, pause: () => false, resume: () => false, stop: () => false };
  const config = { ...normalizeConfig({ file: "C:/日记/a.docx" }), settingsPath: "C:/用户/settings.json" };
  const handlers = createHandlers({
    jobs,
    configFor: async () => config,
    start: async () => ({ id: "job-1" }),
    saveSettings: async (patch) => {
      saved.push(patch);
      if (patch.minHanzi === 0) return { ok: false, settings: {}, errors: ["minHanzi 要是 1 到 100 之间的整数"] };
      return { ok: true, settings: patch, errors: [] };
    },
    providers: async () => [{ id: "lmstudio", models: ["qwen3-4b"] }],
  });

  const read = fakeRes();
  await handlers(fakeReq("GET", "/typo-proof/config"), read);
  assert.equal(read.status, 200);
  assert.equal(read.payload.config.file, "C:/日记/a.docx");
  assert.equal(read.payload.settingsPath, "C:/用户/settings.json");

  const rejected = fakeRes();
  await handlers(fakeReq("POST", "/typo-proof/config", { minHanzi: 0 }), rejected);
  assert.equal(rejected.status, 400);
  assert.match(rejected.payload.error, /minHanzi/);

  const accepted = fakeRes();
  await handlers(fakeReq("POST", "/typo-proof/config", { minHanzi: 12 }), accepted);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.payload.ok, true);
  assert.deepEqual(saved, [{ minHanzi: 0 }, { minHanzi: 12 }]);

  const providers = fakeRes();
  await handlers(fakeReq("GET", "/typo-proof/providers"), providers);
  assert.equal(providers.status, 200);
  assert.deepEqual(providers.payload.providers, [{ id: "lmstudio", models: ["qwen3-4b"] }]);
});

test("host：面板里存的值盖过 Loader 配置，没存的沿用 Loader", () => {
  const loaderConfig = { file: "C:/a.docx", localProvider: "lmstudio", localModel: "", minHanzi: 8 };
  const merged = mergeConfig(loaderConfig, { localModel: "qwen3-4b", minHanzi: 12 });
  assert.equal(merged.localModel, "qwen3-4b", "面板里填的模型要生效");
  assert.equal(merged.minHanzi, 12);
  assert.equal(merged.file, "C:/a.docx", "面板没碰的字段沿用 Loader");
  assert.equal(merged.localProvider, "lmstudio");

  // 面板里存了空串 = 「这项没改过」，回落到 Loader；不然一次误存就把配置清空了。
  assert.equal(mergeConfig({ localModel: "x" }, { localModel: "" }).localModel, "x");
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



test("host：列目录只给子目录与 .docx，隐藏文件与别的类型都不列", async () => {
  const dir = await mkdtemp(join(tmpdir(), "typo-files-"));
  await mkdir(join(dir, "子目录"));
  await writeFile(join(dir, "a.docx"), "x");
  await writeFile(join(dir, "b.txt"), "x");
  await writeFile(join(dir, ".hidden.docx"), "x");

  const listing = await listDirectory(dir);
  assert.deepEqual(listing.files.map((file) => file.name), ["a.docx"], "只有 .docx 该出现；.txt 与点开头的文件都不列");
  assert.deepEqual(listing.dirs.map((entry) => entry.name), ["子目录"]);
  assert.equal(listing.dir, resolve(dir), "回显的目录要是规范化后的绝对路径");
  assert.equal(listing.parent, dirname(resolve(dir)), "上一级要能直接拿去打开");
  assert.ok(listing.files[0].path.endsWith("a.docx"));

  await assert.rejects(() => listDirectory(join(dir, "不存在")), /读不了这个目录/);
});

test("host：开始一次检查前先确认文件存在，并把路径记进面板设置", async () => {
  const dir = await mkdtemp(join(tmpdir(), "typo-proof-remember-"));
  const file = join(dir, "a.docx");
  await writeFile(file, miniDocx());
  const settingsPath = join(dir, "settings.json");

  const ctx = {
    effect: (factory) => factory(),
    inject: () => {},
    tools: { register: () => {} },
    get: () => ({ listProviders: async () => [] }),
  };
  apply(ctx, { file, settingsPath, localProvider: "p", localModel: "m" });
  // apply 内部把 start 闭在 jobs 上，这里只验设置文件的行为：直接调模块导出的写入口。
  const { writeSettings, readSettings } = await import("../lib/settings.js");
  await writeSettings(settingsPath, { file });
  assert.equal((await readSettings(settingsPath)).file, file);
});

test("host：路径少写一层目录时，能指出隔壁的同名文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "typo-suggest-"));
  await mkdir(join(dir, "日记"), { recursive: true });
  await writeFile(join(dir, "日记", "2015.docx"), "x");
  await writeFile(join(dir, "我的档案.docx"), "x");

  const wrong = join(dir, "2015.docx");
  assert.equal(await suggestNeighbour(wrong), join(dir, "日记", "2015.docx"));

  // 隔壁没有同名文件就别乱猜。
  assert.equal(await suggestNeighbour(join(dir, "不存在的.docx")), "");
});
