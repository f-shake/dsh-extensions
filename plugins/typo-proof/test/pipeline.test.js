import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createCache } from "../lib/cache.js";
import { mapLimit, runCheck } from "../lib/pipeline.js";
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
