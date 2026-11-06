/**
 * 编排：读文件 → 切句 → 三次采样 → 候选 → 盲复核 → 写副本 → 报告。
 *
 * 这里只管顺序与收敛，不直接碰 XML、也不直接调模型——那两个由 lib/docx-* 与传进来的
 * `llm` 负责。这样单测可以用假模型跑整条链路，不需要 LM Studio。
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import { cacheKey } from "./cache.js";
import { buildCandidates, sanitizeOutput } from "./candidates.js";
import { compare } from "./diff.js";
import { readDocument } from "./docx-read.js";
import { applyRevisions, writeRevisedCopy } from "./docx-write.js";
import { PROMPT_VERSION, buildReviewMessages, buildSampleMessages } from "./prompts.js";
import { selectSentences } from "./segment.js";
import { readZip } from "./zip.js";

/** 「连续失败几次就停下」。本地模型根本没起时，别傻等几千次超时。 */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * 限并发地跑一组任务，保持结果顺序。
 *
 * 任何一个任务抛错就立刻收手：其余并发槽位在下一次循环时看到 stopped 就退出。
 * 少了这个标志，第一个任务失败后别的槽位还会把剩下的句子全送进模型——调用方已经
 * 拿到失败了，后台还在烧本地模型。
 * @param {object[]} items - 输入。
 * @param {number} limit - 并发上限。
 * @param {(item: object, index: number) => Promise<any>} worker - 单个任务。
 * @returns {Promise<any[]>} 按输入顺序的结果。
 */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  let stopped = false;
  const size = Math.max(1, Math.min(limit, items.length));

  async function pump() {
    while (!stopped && cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  }

  await Promise.all(Array.from({ length: size }, () => pump()));
  return results;
}

/**
 * 把一条建议落到句子上。
 * @param {string} text - 原句。
 * @param {Array<{ pos: number, sugg: string }>} edits - 改动。
 * @returns {string} 改完的句子。
 */
export function applySuggestions(text, edits) {
  const chars = Array.from(text);
  for (const edit of edits) {
    if (edit.pos >= 0 && edit.pos < chars.length) chars[edit.pos] = edit.sugg;
  }
  return chars.join("");
}

/**
 * 文件名里用的时间戳。
 * @param {Date} date - 时间。
 * @returns {string} `yyyyMMdd-HHmm`。
 */
export function formatStamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/**
 * 复核一条候选。
 *
 * 判定只看「盲复核把这一句改成了什么」，不看模型怎么说。同一位置给出别的字，
 * 说明它也觉得这儿错、只是改法不同——记为 `redirected`，交给人定。
 * @param {{ client: object, candidate: object, context: object, signal?: AbortSignal }} input - 输入。
 * @returns {Promise<{ status: string, suggestion?: string, note: string }>} 结论。
 */
async function reviewCandidate(input) {
  const { client, candidate, context, signal } = input;
  const { system, messages } = buildReviewMessages(context);
  try {
    const raw = await client.complete({ system, messages, temperature: 0, signal });
    // 复核这一步同样要清洗：模型回「改正后：“……”」，引号会把位置整体挤偏一个字，
    // 于是每条候选都对不上位置、全被判成否决。
    const output = sanitizeOutput(raw, context.text);
    const { edits } = compare(context.text, output);
    const samePosition = edits.find((edit) => edit.pos === candidate.pos);
    if (samePosition === undefined) {
      const elsewhere =
        edits.length === 0
          ? "模型认为这句没有错别字"
          : `模型改的是别处（${edits.map((edit) => `第 ${edit.pos + 1} 字 ${edit.orig}→${edit.sugg}`).join("，")}）`;
      return { status: "rejected", note: elsewhere };
    }
    if (samePosition.sugg === candidate.sugg) {
      return { status: "confirmed", note: "复核模型独立得出了同样的改法" };
    }
    return {
      status: "redirected",
      suggestion: samePosition.sugg,
      note: `复核模型也认为这里错，但改成「${samePosition.sugg}」`,
    };
  } catch (error) {
    return { status: "failed", note: String(error?.message ?? error) };
  }
}

/**
 * 一条候选最终会写进文档的字。
 *
 * 分歧项写的是复核模型的建议，不是采样给的那个——面板、CSV、副本必须同一口径，
 * 否则 CSV 里的「新字」和 Word 里看到的不是一个字。
 * @param {object} candidate - 候选。
 * @returns {string} 实际采用的建议。
 */
export function finalSuggestion(candidate) {
  return candidate.review?.status === "redirected" && typeof candidate.review.suggestion === "string"
    ? candidate.review.suggestion
    : candidate.sugg;
}

/**
 * 跑一次完整检查。
 * @param {object} options - 参数与依赖。
 * @returns {Promise<object>} 结果。
 */
export async function runCheck(options) {
  const startedAt = Date.now();
  const file = String(options.file);
  const client = options.llm;
  // 复核走单独一个客户端：本地模型只负责「三采样」，云端模型只负责「判对错」。
  // 只给一个客户端的话，配置里的 reviewModel 永远不会被调用，盲复核就成了本地模型自审。
  const reviewClient = options.reviewLlm ?? client;
  const cache = options.cache;
  const samples = Number.isFinite(options.samples) ? Number(options.samples) : 3;
  const minHanzi = Number.isFinite(options.minHanzi) ? Number(options.minHanzi) : 8;
  const concurrency = Number.isFinite(options.concurrency) ? Number(options.concurrency) : 3;
  const reviewConcurrency = Number.isFinite(options.reviewConcurrency) ? Number(options.reviewConcurrency) : 2;
  const localModel = String(options.localModel ?? "");
  const reviewModel = String(options.reviewModel ?? "");
  const signal = options.signal;
  // 暂停闸门：每处理一句之前等一次。放在这里而不是包住整个循环，
  // 是因为暂停要能让正在跑的并发任务先跑完，而不是被硬生生掐断。
  const gate = typeof options.gate === "function" ? options.gate : async () => {};
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const emit = (patch) => onProgress({ file, startedAt, ...patch });

  emit({ phase: "parsing", processed: 0, total: 0 });

  const buffer = await readFile(file);
  const fileHash = createHash("sha256").update(buffer).digest("hex");
  const entries = readZip(buffer);
  const documentEntry = entries.get("word/document.xml");
  if (documentEntry === undefined) throw new Error("这个 docx 里没有 word/document.xml，可能不是 .docx 文件");
  const documentXml = documentEntry.toString("utf8");
  const { paragraphs, stats: docStats } = readDocument(documentXml);
  const { sentences, skipped, stats: segmentStats } = selectSentences(paragraphs, { minHanzi });

  // 段数与字数在整轮里不变，每次都带上：进度对象是整体替换的，
  // 只在第一次带的话，面板头部过几秒就变成「0 段 · 0 字」。
  const scope = { paragraphs: paragraphs.length, hanzi: docStats.hanzi };
  emit({ phase: "sampling", processed: 0, total: sentences.length, ...scope, skipped: segmentStats.skippedParagraphs });

  let consecutiveFailures = 0;
  let sampleFailures = 0;
  let found = 0;
  let processed = 0;
  let results;
  try {
    results = await mapLimit(sentences, concurrency, async (sentence) => {
    if (signal?.aborted === true) return { sentence, outputs: [], candidates: [], changedVotes: 0, error: "aborted" };
    await gate();
    const key = cacheKey({ model: localModel, promptVersion: PROMPT_VERSION, text: sentence.text });
    const cached = await cache.get(key);
    let outputs = cached !== null && Array.isArray(cached.outputs) ? cached.outputs : null;

    if (outputs === null) {
      const { system, messages } = buildSampleMessages(sentence.text);
      outputs = [];
      let allOk = true;
      for (let round = 0; round < samples; round += 1) {
        try {
          outputs.push(await client.complete({ system, messages, temperature: 0.7, signal }));
          consecutiveFailures = 0;
        } catch (error) {
          allOk = false;
          sampleFailures += 1;
          consecutiveFailures += 1;
          outputs.push("");
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && sampleFailures >= MAX_CONSECUTIVE_FAILURES) {
            throw new Error(`连不上本地模型：${String(error?.message ?? error)}`);
          }
        }
      }
      // 有失败就不写缓存：否则这句在缓存活着的期间永远只有那几次空采样，
      // 模型恢复之后也不会再被重算。
      if (allOk) await cache.set(key, { outputs, at: Date.now() });
    }

    const built = buildCandidates(sentence, outputs);
    found += built.candidates.length;
    processed += 1;
    // 每 50 句落一次盘：全量要跑十几分钟，进程被关掉时不能把已经花掉的调用全丢掉。
    if (processed % 50 === 0) await cache.flush();
    emit({ phase: "sampling", processed, total: sentences.length, candidates: found, ...scope });
    return { sentence, outputs, candidates: built.candidates, changedVotes: built.changedVotes, error: null };
    });
  } catch (error) {
    // 采样中途失败（连不上模型、用户点了停止）也要把已经算出来的落盘，
    // 否则「中断后能续跑」在最常见的打断场景下就是一句空话。
    await cache.flush();
    throw error;
  }

  // 先落盘再判中断：中断那条路同样要留下已完成的句子。
  await cache.flush();
  if (signal?.aborted === true) throw new Error("已中断");

  const candidates = [];
  for (const result of results) {
    for (const candidate of result.candidates) {
      candidates.push({
        id: `${result.sentence.paraIndex}:${result.sentence.index}:${candidate.pos}:${candidate.sugg}`,
        paraIndex: result.sentence.paraIndex,
        sentenceIndex: result.sentence.index,
        // pos 是句内偏移，diff 与面板显示都用它；
        // paragraphPos 才是写入用的段内偏移——两者差一个 sentence.start，
        // 少加这一项就会把字改到同一段的前一句里去。
        pos: candidate.pos,
        paragraphPos: result.sentence.start + candidate.pos,
        orig: candidate.orig,
        sugg: candidate.sugg,
        votes: candidate.votes,
        sentence: result.sentence.text,
        context: { before: result.sentence.before, text: result.sentence.text, after: result.sentence.after },
        samples: result.outputs,
        review: null,
      });
    }
  }
  candidates.sort((left, right) => left.paraIndex - right.paraIndex || left.sentenceIndex - right.sentenceIndex || left.pos - right.pos);

  emit({ phase: "reviewing", processed: 0, total: candidates.length, ...scope });

  let reviewed = 0;
  await mapLimit(candidates, reviewConcurrency, async (candidate) => {
    if (signal?.aborted === true) {
      candidate.review = { status: "failed", note: "已中断" };
      return;
    }
    await gate();
    candidate.review = await reviewCandidate({ client: reviewClient, candidate, context: candidate.context, signal });
    reviewed += 1;
    emit({
      phase: "reviewing",
      processed: reviewed,
      total: candidates.length,
      confirmed: candidates.filter((item) => item.review?.status === "confirmed").length,
      ...scope,
    });
  });

  if (signal?.aborted === true) throw new Error("已中断");

  emit({ phase: "writing", processed: candidates.length, total: candidates.length, ...scope });

  const accepted = candidates.filter((candidate) => candidate.review?.status === "confirmed" || candidate.review?.status === "redirected");
  // 写入层遇到「同一位置两条建议」只取先到的那条，所以这里要先排好：
  // 票数高的在前，同票按 id（段号/句序/位置/字）稳定。排序放在这里而不是写入层，
  // 是为了让写入层不必知道 votes 这件事。
  accepted.sort((left, right) => right.votes - left.votes || left.id.localeCompare(right.id));
  const changes = accepted.map((candidate) => ({
    paraIndex: candidate.paraIndex,
    pos: candidate.paragraphPos,
    orig: candidate.orig,
    sugg: finalSuggestion(candidate),
    candidateId: candidate.id,
  }));

  const { xml: revisedXml, applied, skipped: writeSkipped } = applyRevisions({
    documentXml,
    paragraphs,
    changes,
    date: new Date().toISOString(),
  });

  const stamp = formatStamp(new Date());
  const dir = dirname(file);
  const base = basename(file, extname(file));
  const copyPath = join(dir, `${base}_校对副本_${stamp}.docx`);
  const reportPath = join(dir, `${base}_校对报告_${stamp}.json`);
  const csvPath = join(dir, `${base}_校对候选_${stamp}.csv`);
  const bytes = applied.length > 0 ? (await writeRevisedCopy({ sourcePath: file, targetPath: copyPath, documentXml: revisedXml })).bytes : 0;

  const durationMs = Date.now() - startedAt;
  const report = {
    file,
    fileHash,
    generatedAt: new Date().toISOString(),
    durationMs,
    models: { local: localModel, review: reviewModel },
    document: docStats,
    segments: segmentStats,
    skippedParagraphs: skipped,
    counts: {
      sentences: sentences.length,
      candidates: candidates.length,
      confirmed: candidates.filter((item) => item.review?.status === "confirmed").length,
      redirected: candidates.filter((item) => item.review?.status === "redirected").length,
      rejected: candidates.filter((item) => item.review?.status === "rejected").length,
      failed: candidates.filter((item) => item.review?.status === "failed").length,
      written: applied.length,
    },
    copyPath: applied.length > 0 ? copyPath : "",
    copyBytes: bytes,
    writeSkipped,
    candidates,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(csvPath, toCsv(candidates), "utf8");
  await cache.flush();

  emit({ phase: "done", processed: candidates.length, total: candidates.length, ...scope });

  return {
    file,
    documentXml,
    paragraphs,
    sentences,
    candidates,
    report,
    reportPath,
    csvPath,
    copyPath: applied.length > 0 ? copyPath : "",
    bytes,
    durationMs,
    counts: report.counts,
  };
}

/**
 * 候选导成 CSV。Excel 打开中文需要 BOM。
 * @param {object[]} candidates - 候选。
 * @returns {string} CSV 文本。
 */
export function toCsv(candidates) {
  const escape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const lines = [["段号", "句序", "原字", "新字", "投票数", "复核结论", "复核说明", "原句", "前一句", "后一句"].map(escape).join(",")];
  for (const candidate of candidates) {
    lines.push(
      [
        candidate.paraIndex + 1,
        candidate.sentenceIndex + 1,
        candidate.orig,
        // 与副本实际写入的字保持一致（分歧项取复核建议）。
        finalSuggestion(candidate),
        candidate.votes,
        candidate.review?.status ?? "",
        candidate.review?.note ?? "",
        candidate.context.text,
        candidate.context.before,
        candidate.context.after,
      ]
        .map(escape)
        .join(","),
    );
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
