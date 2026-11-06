/**
 * 句子切分、跳过规则、上下文拼装。
 *
 * 判定单位是**句**而不是段：4B 小模型在五百字的整段里漏检率高，短句更聚焦，
 * 也方便并发。段落仍然是上下文单位——复核时给的是「前一句 + 本句 + 后一句」。
 */

import { countHanzi } from "./xml.js";

/** 句末标点。分号也算：一句话两个分句经常各自独立出错。 */
const TERMINATORS = new Set(["。", "！", "？", "!", "?", "；", ";", "…", "\n"]);

/** 句末标点后面这些符号属于本句。 */
const TRAILING = new Set(["”", "’", "」", "』", "）", ")", "】", "》", "…", "。", "！", "？"]);

/** 单句硬上限。超过就切，否则一次采样要吐几百字，小模型更容易跑偏。 */
export const MAX_SENTENCE_LENGTH = 200;

/**
 * 把一段文字切成句子。
 *
 * 标点跟着前一句走（写 docx 修订时要保留句子边界），连续的省略号算一个终止符。
 * @param {string} text - 段落文本。
 * @returns {Array<{ start: number, end: number, text: string }>} 句子，偏移相对段落。
 */
export function splitSentences(text) {
  const chars = Array.from(String(text));
  const sentences = [];
  let start = 0;
  let index = 0;

  while (index < chars.length) {
    const char = chars[index];
    if (!TERMINATORS.has(char)) {
      index += 1;
      continue;
    }
    let end = index + 1;
    // 省略号、问叹号连写属于同一处停顿。
    while (end < chars.length && TERMINATORS.has(chars[end]) && chars[end] !== "\n") end += 1;
    while (end < chars.length && TRAILING.has(chars[end])) end += 1;
    const piece = chars.slice(start, end).join("");
    if (piece.trim() !== "") sentences.push({ start, end, text: piece });
    start = end;
    index = end;
  }

  if (start < chars.length) {
    const piece = chars.slice(start).join("");
    if (piece.trim() !== "") sentences.push({ start, end: chars.length, text: piece });
  }
  return sentences;
}

/**
 * 超长句按上限硬切。
 *
 * 优先切在空格和标点上，切不出来才在字上断——断在词中间会让两侧都变得不可判。
 * @param {{ start: number, end: number, text: string }} sentence - 原句。
 * @param {number} limit - 每段上限。
 * @returns {Array<{ start: number, end: number, text: string }>} 切完的句子。
 */
export function hardSplit(sentence, limit = MAX_SENTENCE_LENGTH) {
  const chars = Array.from(sentence.text);
  if (chars.length <= limit) return [sentence];
  const pieces = [];
  let offset = 0;
  while (offset < chars.length) {
    let size = Math.min(limit, chars.length - offset);
    if (offset + size < chars.length) {
      const window = chars.slice(offset, offset + size);
      const breakAt = Math.max(window.lastIndexOf("，"), window.lastIndexOf("、"), window.lastIndexOf(" "), window.lastIndexOf("："));
      if (breakAt > limit * 0.5) size = breakAt + 1;
    }
    pieces.push({
      start: sentence.start + offset,
      end: sentence.start + offset + size,
      text: chars.slice(offset, offset + size).join(""),
    });
    offset += size;
  }
  return pieces;
}

/**
 * 判断这一段落该不该整段跳过。
 *
 * 目录、表格、空段、纯符号段都不检：目录是自动生成的，表格里的短条目没有句子结构，
 * 空段没有任何可判内容。
 * @param {object} paragraph - `readDocument` 产出的段落。
 * @returns {string | null} 跳过原因；不该跳返回 null。
 */
export function paragraphSkipReason(paragraph) {
  if (paragraph.text.trim() === "") return "empty";
  if (paragraph.inTable) return "table";
  if (typeof paragraph.style === "string" && paragraph.style.startsWith("TOC")) return "toc";
  if (countHanzi(paragraph.text) < 4) return "nonChinese";
  return null;
}

/**
 * 选出要送检的句子，并带上前后句作为上下文。
 *
 * 加密段用 `##…##` 标出，可能跨段：从起始标记所在段落起，到下一个标记所在段落止，
 * 中间全部跳过。标记本身也跳过——那两段里一半是密文，位置对不上。
 * @param {object[]} paragraphs - `readDocument` 产出的段落。
 * @param {{ minHanzi?: number, maxLength?: number }} [options] - 最小汉字数与单句上限。
 * @returns {{ sentences: object[], skipped: object[], stats: object }} 结果。
 */
export function selectSentences(paragraphs, options = {}) {
  const minHanzi = Number.isFinite(options.minHanzi) ? Number(options.minHanzi) : 8;
  const maxLength = Number.isFinite(options.maxLength) ? Number(options.maxLength) : MAX_SENTENCE_LENGTH;
  const skipped = [];
  const flat = [];
  let encrypted = false;

  for (const paragraph of paragraphs) {
    const marker = paragraph.text.includes("##");
    if (marker) {
      // 开标记也跳，闭标记也跳：标记所在段里密文与明文混排，宁可不检。
      encrypted = !encrypted;
      skipped.push({ paraIndex: paragraph.index, reason: "encrypted" });
      continue;
    }
    if (encrypted) {
      skipped.push({ paraIndex: paragraph.index, reason: "encrypted" });
      continue;
    }

    const reason = paragraphSkipReason(paragraph);
    if (reason !== null) {
      skipped.push({ paraIndex: paragraph.index, reason });
      continue;
    }

    const pieces = splitSentences(paragraph.text).flatMap((sentence) => hardSplit(sentence, maxLength));
    let sentenceIndex = 0;
    for (const piece of pieces) {
      if (countHanzi(piece.text) < minHanzi) {
        skipped.push({ paraIndex: paragraph.index, reason: "short" });
        continue;
      }
      flat.push({
        paraIndex: paragraph.index,
        index: sentenceIndex,
        start: piece.start,
        end: piece.end,
        text: piece.text,
        hanzi: countHanzi(piece.text),
      });
      sentenceIndex += 1;
    }
  }

  for (let index = 0; index < flat.length; index += 1) {
    const sentence = flat[index];
    sentence.before = index > 0 ? flat[index - 1].text : "";
    sentence.after = index + 1 < flat.length ? flat[index + 1].text : "";
  }

  return {
    sentences: flat,
    skipped,
    stats: {
      paragraphs: paragraphs.length,
      sentences: flat.length,
      skippedParagraphs: skipped.length,
      skippedByReason: skipped.reduce((counts, item) => {
        counts[item.reason] = (counts[item.reason] ?? 0) + 1;
        return counts;
      }, {}),
    },
  };
}
