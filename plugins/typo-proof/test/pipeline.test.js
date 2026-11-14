import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createCache } from "../lib/cache.js";
import { mapLimit, mergeByPosition, runCheck, toCsv } from "../lib/pipeline.js";
import { readZip } from "../lib/zip.js";
import { createJobStore, normalizeConfig, panelState } from "../index.js";
import { miniDocx } from "./fixtures/mini-docx.js";

/**
 * 假模型：只认「睡的 → 睡得」这一处，其余原样返回。
 *
 * 这样既不需要 LM Studio，也保证断言看的是**位置与写入**，而不是模型本身。
 * @param {{ mode?: 'fix' | 'reject' | 'boom' | 'quoted', reviewMode?: 'fix' | 'reject' }} [options] - 行为。
 * @returns {object} 假客户端。
 */
function fakeClient(options = {}) {
  const mode = options.mode ?? "fix";
  const reviewMode = options.reviewMode ?? mode;
  const client = {
    calls: 0,
    sampleCalls: 0,
    reviewCalls: 0,
    async complete({ messages }) {
      client.calls += 1;
      if (mode === "boom") throw new Error("连不上本地模型");
      const text = messages[0].content[0].text;
      const marker = "要校对的一句：";
      const fromReview = text.lastIndexOf(marker);
      if (fromReview >= 0) client.reviewCalls += 1;
      else client.sampleCalls += 1;
      const sentence =
        fromReview >= 0
          ? text.slice(fromReview + marker.length).split("\n")[0]
          : text.split("\n").filter((line) => line.trim() !== "").at(-1);
      if (fromReview >= 0 && reviewMode === "reject") return sentence;
      const fixed = sentence.replace("睡的", "睡得");
      // 同一位置给出别的字：用来验 redirected 与 CSV 的口径是否一致。
      if (fromReview >= 0 && mode === "other") return sentence.replace("睡的", "睡底");
      // 复核模型常见的「带前缀 + 带引号」，必须能被清洗掉，否则位置整体偏移。
      if (fromReview >= 0 && mode === "quoted") return `改正后的句子：“${fixed}”`;
      return fixed;
    },
  };
  return client;
}

/**
 * 造一套「临时目录 + 小 docx + 缓存」。
 * @returns {Promise<{ dir: string, file: string, cache: object }>} 夹具。
 */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "typo-proof-pipe-"));
  const path = join(dir, "mini.docx");
  await writeFile(path, miniDocx());
  return { dir, file: path, cache: createCache({ dir: join(dir, "cache") }) };
}

test("pipeline：跑通一次，确认项写进副本，报告与 CSV 落盘", async () => {
  const { dir, file, cache } = await fixture();
  const result = await runCheck({ file, llm: fakeClient(), cache, localModel: "l", reviewModel: "r", minHanzi: 8, concurrency: 2 });

  assert.equal(result.candidates.length, 1, "只有那句话有改动");
  assert.equal(result.candidates[0].orig, "的");
  assert.equal(result.candidates[0].sugg, "得");
  assert.equal(result.candidates[0].review.status, "confirmed");

  const xml = readZip(await readFile(result.copyPath)).get("word/document.xml").toString("utf8");
  assert.match(xml, /<w:ins[^>]*>.*<w:t xml:space="preserve">得<\/w:t>/s);

  assert.ok(existsSync(result.reportPath));
  assert.ok(existsSync(result.csvPath));
  const csv = await readFile(result.csvPath, "utf8");
  assert.ok(csv.startsWith("\uFEFF"), "CSV 要带 BOM，Excel 打开中文才不乱码");
  assert.match(csv, /"得"/);

  const files = await readdir(dir);
  assert.ok(files.some((name) => name.includes("校对副本")));
});

test("pipeline：缓存真的落盘——换一个 cache 实例仍然零采样", async () => {
  const { dir, file, cache } = await fixture();
  await runCheck({ file, llm: fakeClient(), cache, localModel: "m", minHanzi: 8 });
  assert.ok(existsSync(join(dir, "cache", "typo-cache.json")), "跑完必须把缓存写到磁盘上");

  // 换一个实例模拟「进程重启」：只有落盘了才可能命中。
  const reopened = createCache({ dir: join(dir, "cache") });
  const again = fakeClient();
  const result = await runCheck({ file, llm: again, cache: reopened, localModel: "m", minHanzi: 8 });
  assert.equal(again.sampleCalls, 0, "采样全部命中磁盘缓存");
  assert.equal(again.reviewCalls, 1, "复核不缓存：它要的是当下这个模型的判断");
  assert.equal(result.candidates.length, 1);
});

test("pipeline：复核走的是独立的 reviewLlm，不是本地那个", async () => {
  const { file, cache } = await fixture();
  const local = fakeClient();
  const remote = fakeClient();
  const result = await runCheck({ file, llm: local, reviewLlm: remote, cache, localModel: "l", reviewModel: "r", minHanzi: 8 });

  assert.equal(remote.reviewCalls, 1, "复核必须发给 reviewLlm");
  assert.equal(local.reviewCalls, 0, "本地模型不该被用来做复核");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].review.status, "confirmed");
});

test("pipeline：复核输出带前缀与引号也能对上位置", async () => {
  const { file, cache } = await fixture();
  const result = await runCheck({ file, llm: fakeClient({ mode: "quoted" }), cache, localModel: "m", minHanzi: 8 });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].review.status, "confirmed", "清洗后位置对得上，不该被判否决");
});

test("pipeline：复核否决时不生成副本", async () => {
  const { file, cache, dir } = await fixture();
  const result = await runCheck({ file, llm: fakeClient({ reviewMode: "reject" }), cache, localModel: "m", minHanzi: 8 });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].review.status, "rejected");
  assert.equal(result.copyPath, "");
  const files = await readdir(dir);
  assert.ok(!files.some((name) => name.includes("校对副本")), "没有确认项就不该有副本");
});

test("pipeline：有分歧时，CSV 与副本都用复核建议的那个字", async () => {
  const { file, cache } = await fixture();
  const result = await runCheck({ file, llm: fakeClient({ mode: "other" }), cache, localModel: "m", minHanzi: 8 });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].sugg, "得", "采样给的是「得」");
  assert.equal(result.candidates[0].review.status, "redirected");
  assert.equal(result.candidates[0].review.suggestion, "底");

  const csv = await readFile(result.csvPath, "utf8");
  assert.match(csv, /"底"/, "CSV 的新字列要用复核建议，不能写采样那个");
  const xml = readZip(await readFile(result.copyPath)).get("word/document.xml").toString("utf8");
  assert.match(xml, /<w:t xml:space="preserve">底<\/w:t>/, "副本里写的必须是复核建议");
  assert.doesNotMatch(xml, /<w:t xml:space="preserve">得<\/w:t>/, "被复核改掉的那个建议不该写进副本");
});

test("pipeline：采样中途失败，已经算出来的句子照样落盘", async () => {
  const { dir, file, cache } = await fixture();
  let calls = 0;
  const flaky = {
    async complete() {
      calls += 1;
      // 前三次（第一句）正常，之后一路失败，触发「连不上本地模型」那条中止路径。
      if (calls > 3) throw new Error("模型挂了");
      return "我喜欢看小说，那天我睡得很晚，第二天起来天还没亮。";
    },
  };
  await assert.rejects(() => runCheck({ file, llm: flaky, cache, localModel: "m", minHanzi: 8, concurrency: 1 }), /连不上本地模型/);

  const saved = await readFile(join(dir, "cache", "typo-cache.json"), "utf8");
  const entries = Object.keys(JSON.parse(saved).entries);
  assert.equal(entries.length, 1, "失败之前那一句必须已经落盘，否则中断就白跑了");
});

test("pipeline：模型连续失败时给出可读错误，而不是跑完几千次超时", async () => {
  const { file, cache } = await fixture();
  await assert.rejects(
    () => runCheck({ file, llm: fakeClient({ mode: "boom" }), cache, localModel: "m", minHanzi: 8, concurrency: 1 }),
    /连不上本地模型/,
  );
});

test("pipeline：每次进度都带着段落数与字数，后一次 emit 不会把它们冲成 0", async () => {
  const { file, cache } = await fixture();
  const events = [];
  await runCheck({
    file,
    llm: fakeClient(),
    cache,
    localModel: "m",
    minHanzi: 8,
    onProgress: (progress) => events.push(progress),
  });
  const sampling = events.filter((event) => event.phase === "sampling");
  assert.ok(sampling.length > 1, "要有多次采样进度才有意义");
  const first = sampling[0];
  assert.ok(first.hanzi > 0, "第一次采样进度就该带字数");
  for (const event of sampling) {
    assert.equal(event.paragraphs, first.paragraphs, "段数要一直在");
    assert.equal(event.hanzi, first.hanzi, "字数要一直在");
  }
  // processed 必须单调递增：并发下用 index+1 会回退。
  const processed = sampling.map((event) => event.processed);
  assert.deepEqual(processed, [...processed].sort((left, right) => left - right));
});

test("pipeline：一个任务抛错后，其它并发槽位不再继续跑", async () => {
  const seen = [];
  await assert.rejects(
    () =>
      mapLimit(Array.from({ length: 20 }, (_, index) => index), 4, async (item) => {
        seen.push(item);
        if (item === 1) throw new Error("第一次失败");
        return item;
      }),
    /第一次失败/,
  );
  // 抛错之后不应该把剩下十几项全跑完：4 路并发最多再看几个。
  assert.ok(seen.length <= 8, `失败后还在继续跑，共处理 ${seen.length} 项`);
});

/**
 * 采样给出两种改法的假模型：同一句的第 1、2 次给「睡得」，第 3 次给「睡底」，复核统一判成「睡得」。
 *
 * 用来复现「同一处位置挂两条候选」：先是采样那两条，再是复核把其中一条重定向成另一个字。
 * 计数要按句子分开记——文档里有好几句，按全局调用次数记会落到错的句子上去。
 * @returns {object} 假客户端。
 */
function mixedClient() {
  const seen = new Map();
  const client = {
    reviewCalls: 0,
    async complete({ messages }) {
      const text = messages[0].content[0].text;
      const marker = "要校对的一句：";
      const fromReview = text.lastIndexOf(marker);
      if (fromReview >= 0) {
        client.reviewCalls += 1;
        const sentence = text.slice(fromReview + marker.length).split("\n")[0];
        return sentence.replace("睡的", "睡得");
      }
      const sentence = text.split("\n").filter((line) => line.trim() !== "").at(-1);
      const round = (seen.get(sentence) ?? 0) + 1;
      seen.set(sentence, round);
      return sentence.replace("睡的", round === 3 ? "睡底" : "睡得");
    },
  };
  return client;
}

test("pipeline：同一处位置的两种改法只出一条，票数各归各的，落选改法进备选", () => {
  const base = {
    paraIndex: 807,
    sentenceIndex: 0,
    pos: 9,
    paragraphPos: 9,
    orig: "行",
    sentence: "早上妈妈走的时候就行了。",
    context: { before: "", text: "早上妈妈走的时候就行了。", after: "" },
    samples: [],
  };
  const merged = mergeByPosition([
    { ...base, id: "807:0:9:算", sugg: "算", votes: 1, review: { status: "redirected", suggestion: "醒", note: "复核认为该改，但改成「醒」" } },
    { ...base, id: "807:0:9:走", sugg: "走", votes: 1, review: { status: "redirected", suggestion: "醒", note: "复核认为该改，但改成「醒」" } },
  ]);

  assert.equal(merged.length, 1, "同一位置必须只剩一条");
  assert.equal(merged[0].votes, 1, "票数仍是支持最终改法的票数，不是该处的改动总数");
  assert.equal(merged[0].changedVotes, 2, "该处被改动过的采样次数另存：两次采样都改过这里");
  assert.equal(merged[0].id, "807:0:9:算", "同档同票时按 id 稳定，取排在前面的那条");
  assert.equal(merged[0].review.status, "redirected");
  assert.deepEqual(
    merged[0].alternatives.map((item) => item.sugg),
    ["走"],
    "被并掉的改法不能丢，报告和 CSV 还要用",
  );
});

test("pipeline：合并时确认优先于分歧，分歧优先于否决", () => {
  const base = {
    paraIndex: 1,
    sentenceIndex: 0,
    pos: 3,
    context: { before: "", text: "", after: "" },
    samples: [],
  };
  const merged = mergeByPosition([
    { ...base, id: "1:0:3:甲", sugg: "甲", votes: 3, review: { status: "rejected", note: "" } },
    { ...base, id: "1:0:3:乙", sugg: "乙", votes: 1, review: { status: "redirected", suggestion: "丙", note: "" } },
    { ...base, id: "1:0:3:丁", sugg: "丁", votes: 2, review: { status: "confirmed", note: "" } },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].sugg, "丁", "确认的改法优先，即便票数不是最高");
  assert.equal(merged[0].votes, 2, "票数跟着最终改法走");
  assert.equal(merged[0].changedVotes, 6, "三条票数相加才是该处被改动的次数");

  // 只有分歧与否决时取分歧；分歧的复核建议要留下来，别当成模型原始建议。
  const redirected = mergeByPosition([
    { ...base, id: "1:0:3:甲", sugg: "甲", votes: 1, review: { status: "rejected", note: "" } },
    { ...base, id: "1:0:3:乙", sugg: "乙", votes: 1, review: { status: "redirected", suggestion: "丙", note: "" } },
  ]);
  assert.equal(redirected[0].sugg, "乙");
  assert.equal(redirected[0].alternatives[0].sugg, "甲");
  assert.equal(redirected[0].alternatives[0].suggestion, "", "被否决的那条没有复核建议");
});

test("pipeline：不同位置不合并，单条原样返回，空输入不抛", () => {
  const one = { paraIndex: 3, sentenceIndex: 0, pos: 1, id: "3:0:1:甲", sugg: "甲", votes: 2, context: { before: "", text: "", after: "" }, review: { status: "confirmed", note: "" } };
  const two = { ...one, pos: 2, id: "3:0:2:乙", sugg: "乙" };
  const merged = mergeByPosition([two, one]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((item) => item.pos), [1, 2], "合并后按段/句/位置排序");
  assert.equal(merged[0], one, "单条候选原样返回，不复制一份");
  assert.deepEqual(mergeByPosition([]), []);
  assert.deepEqual(mergeByPosition(null), []);
  assert.deepEqual(mergeByPosition([null, 3, "x"]), [], "脏数据不能把整轮检查带崩");
});

test("pipeline：CSV 最后两列是改动次数与备选改法，前面各列位置不变", () => {
  const candidate = {
    paraIndex: 807,
    sentenceIndex: 0,
    pos: 9,
    orig: "行",
    sugg: "算",
    votes: 2,
    changedVotes: 3,
    sentence: "早上妈妈走的时候就行了。",
    context: { before: "前一句", text: "早上妈妈走的时候就行了。", after: "后一句" },
    review: { status: "redirected", suggestion: "醒", note: "复核改成醒" },
    alternatives: [{ sugg: "走", votes: 1, status: "redirected", suggestion: "醒" }],
  };
  const csv = toCsv([candidate]);
  const [header, row] = csv.replace("\uFEFF", "").trim().split("\r\n");
  assert.ok(header.endsWith('"改动次数","备选改法"'), "新列只能加在最后，别把前面十列挤错位");
  assert.ok(row.endsWith('"走（分歧→醒）"'), "备选改法带复核结论，不能只给一个字");
  assert.equal(row.split('","').length, 12, "列数与表头一致");
  const cells = row.split('","').map((cell) => cell.replace(/^"|"$/g, ""));
  assert.equal(cells[4], "2", "投票数＝支持最终改法的次数");
  assert.equal(cells[10], "3", "改动次数＝该处被改动的总次数");
  assert.equal(cells[3], "醒", "新字列仍然用复核给的字");
});

test("pipeline：同一处两种改法跑完一整轮，面板/报告/CSV 都只剩一条", async () => {
  const { file, cache } = await fixture();
  const result = await runCheck({ file, llm: mixedClient(), cache, localModel: "m", minHanzi: 8, samples: 3, concurrency: 1 });

  assert.equal(result.candidates.length, 1, "同一位置的两种改法要合并成一条");
  const only = result.candidates[0];
  assert.equal(only.votes, 2, "两次采样支持最终这个字");
  assert.equal(only.changedVotes, 3, "三次采样都改过这处");
  assert.equal(only.review.status, "confirmed");
  assert.deepEqual(only.alternatives.map((item) => item.sugg), ["底"], "被并掉的「底」要留下来");

  assert.equal(result.counts.candidates, 1, "报告计数与面板一致");
  const csv = await readFile(result.csvPath, "utf8");
  assert.match(csv, /"底（分歧→得）"/, "CSV 的备选改法列要带上复核落点");
});

test("pipeline：暂停后不再推进，恢复后跑完", async () => {
  const { file, cache } = await fixture();
  const jobs = createJobStore();
  const job = jobs.start({
    file,
    llm: fakeClient(),
    cache,
    minHanzi: 8,
    samples: 3,
    concurrency: 1,
    reviewConcurrency: 1,
    models: { local: "m", review: "r" },
  });
  jobs.pause();
  const processed = job.sampling.done;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(job.sampling.done, processed, "暂停期间进度不该动");
  assert.equal(job.status, "running");

  jobs.resume();
  const result = await job.promise;
  assert.equal(result.candidates.length, 1);
  assert.equal(job.status, "done");
});

test("pipeline：中断后状态落到 error，不抛未处理拒绝", async () => {
  const { file, cache } = await fixture();
  const jobs = createJobStore();
  const job = jobs.start({
    file,
    llm: fakeClient(),
    cache,
    minHanzi: 8,
    samples: 3,
    concurrency: 1,
    reviewConcurrency: 1,
    models: { local: "m", review: "r" },
  });
  jobs.stop();
  await assert.rejects(() => job.promise);
  // 主动停止不是失败：状态记 stopped，面板那边会映射成 idle。
  assert.equal(job.status, "stopped");
});

test("pipeline：停止要报「已中断」，不能报成连不上模型", async () => {
  const { file, cache } = await fixture();
  const jobs = createJobStore();
  // 模型调用会一直挂着，直到被 abort 打断——正是用户点停止时的样子。
  const hanging = {
    async complete({ signal }) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("模型调用被中断"));
        });
      });
      return "随便";
    },
  };
  const job = jobs.start({ file, llm: hanging, cache, minHanzi: 8, samples: 3, concurrency: 1, reviewConcurrency: 1, models: { local: "m", review: "r" } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  jobs.stop();
  await assert.rejects(() => job.promise, /已中断/);
  assert.equal(job.status, "stopped", "主动停止不是错误");
  assert.equal(job.stopped, true);
  const state = panelState({ job, config: normalizeConfig({}) });
  assert.equal(state.status, "idle", "面板要回到空闲态");
  assert.equal(state.note, "已停止");
  assert.equal(state.error, "");
});
