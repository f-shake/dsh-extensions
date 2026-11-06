/**
 * 三次采样 → 候选编辑。
 *
 * 闸门（REQ-3 / REQ-4）：
 *  1. 一次采样里只认「单个汉字 → 单个汉字」的替换；
 *  2. 整句相似度 < 0.80，或一次采样改了超过 5 个字，这次采样作废（那是改写，不是校错）；
 *  3. 三次里**至少两次改动原文**，这句话才进复核；
 *  4. 进复核的是所有采样里出现过的改动的**并集**，每条带上票数。
 */

import { compare } from "./diff.js";
import { isHanzi } from "./xml.js";

/** 一次采样最多认可几处改动。超过就当成改写。 */
export const MAX_SAMPLE_EDITS = 5;
/** 整句相似度下限。 */
export const MIN_SIMILARITY = 0.8;
/** 进复核所需的最少「改过原文」的采样次数。 */
export const MIN_VOTES = 2;

/** 模型爱加的前缀。剥掉它们再比较，否则整句都对不上。 */
const PREFIX = /^\s*(?:改正后的句子|改正后|改后|修改后|答案|输出|结果)\s*[：:]\s*/;
/** 包在整句外面的引号。 */
const WRAPPING = /^[\s"'“”‘’「」『』]+|[\s"'“”‘’「」『』]+$/g;

/**
 * 把模型输出收拾成「一句话」。
 *
 * 小模型经常回一段带解释的文字、或者套一层引号。这里只做机械剥离：
 * 去掉代码围栏、前缀、外层引号，多行时取与原文最像的那一行。
 * @param {string} raw - 原始输出。
 * @param {string} original - 原句，用来挑行。
 * @returns {string} 收拾后的句子。
 */
export function sanitizeOutput(raw, original) {
  let text = String(raw ?? "").trim();
  text = text.replace(/^```[\w-]*\s*/m, "").replace(/```\s*$/m, "").trim();
  if (text.includes("\n")) {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim().replace(PREFIX, "").replace(WRAPPING, "").trim())
      .filter((line) => line !== "");
    if (lines.length > 1) {
      // 挑「改了一两处」的那一行，而不是「和原句最像」的那一行：
      // 模型常把原句原样抄一遍再给改正结果，抄的那行相似度是满分，会把真正的答案挤掉。
      let best = null;
      let bestScore = -1;
      for (const line of lines) {
        const { edits, similarity } = compare(original, line);
        const score = edits.length > 0 && edits.length <= MAX_SAMPLE_EDITS ? 2 + similarity : similarity;
        if (score > bestScore) {
          best = line;
          bestScore = score;
        }
      }
      text = best;
    }
  }
  return text.replace(PREFIX, "").replace(WRAPPING, "").trim();
}

/**
 * 判一次采样。
 * @param {string} original - 原句。
 * @param {string} raw - 模型输出。
 * @returns {{ ok: boolean, output: string, edits: object[], reason: string | null, changed: number, similarity: number }} 结果。
 */
export function evaluateSample(original, raw) {
  const output = sanitizeOutput(raw, original);
  if (output === "") return { ok: false, output, edits: [], reason: "empty", changed: 0, similarity: 0 };
  // 输出比原文长出一截，多半是带了解释而不是改错字。
  if (output.length > original.length * 1.2 + 10) {
    return { ok: false, output, edits: [], reason: "too-long", changed: 0, similarity: 0 };
  }

  const { edits, changed, similarity } = compare(original, output);
  const legal = edits.every((edit) => isHanzi(edit.orig) && isHanzi(edit.sugg));
  if (!legal) return { ok: false, output, edits: [], reason: "illegal-edit", changed, similarity };
  if (similarity < MIN_SIMILARITY) return { ok: false, output, edits: [], reason: "rewritten", changed, similarity };
  if (edits.length > MAX_SAMPLE_EDITS) {
    return { ok: false, output, edits: [], reason: "too-many-edits", changed, similarity };
  }
  return { ok: true, output, edits, reason: null, changed, similarity };
}

/**
 * 三次采样合成候选。
 * @param {{ text: string }} sentence - 句子（只需 text）。
 * @param {string[]} samples - 三次模型输出，顺序即采样序号。
 * @returns {{ candidates: object[], changedVotes: number, samples: object[] }} 候选与有效改动次数。
 */
export function buildCandidates(sentence, samples) {
  const original = sentence.text;
  const evaluated = samples.map((raw) => evaluateSample(original, raw));
  const changedVotes = evaluated.filter((item) => item.ok && item.edits.length > 0).length;
  if (changedVotes < MIN_VOTES) return { candidates: [], changedVotes, samples: evaluated };

  const tally = new Map();
  for (const item of evaluated) {
    if (!item.ok) continue;
    const seen = new Set();
    for (const edit of item.edits) {
      const key = `${edit.pos}:${edit.orig}:${edit.sugg}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = tally.get(key);
      if (entry === undefined) tally.set(key, { ...edit, votes: 1 });
      else entry.votes += 1;
    }
  }

  const candidates = [...tally.values()].sort((left, right) => left.pos - right.pos || left.sugg.localeCompare(right.sugg));
  return { candidates, changedVotes, samples: evaluated };
}
