/**
 * 送模型的提示词。改这里的文本就要同步升版本号——缓存键里有它。
 */

/** 提示词版本。改提示词不升版本，旧缓存会被当成新结果复用。 */
export const PROMPT_VERSION = "2026-11-06.1";

const SAMPLE_SYSTEM = [
  "你是中文文字校对工具。用户给你一句中文，你只输出改正错别字之后的整句。",
  "规则：",
  "1. 只改错别字，不改用词、语序、标点和语气。",
  "2. 没有错别字就原样输出。",
  "3. 不要解释，不要加引号，不要输出任何多余的字。",
].join("\n");

const REVIEW_SYSTEM = [
  "你是中文文字审校。用户给你一段日记的上下文，其中标着“要校对的一句：”的那一行才是要校对的句子，",
  "它前面是前一句，后面可能还有后一句——前后两句只用来帮你判断，不要改它们。",
  "你只输出“要校对的一句”校对后的样子，保持原意与标点。",
  "只改错别字；没有错别字就原样输出那一句。不要解释，不要加引号。",
].join("");

/**
 * 采样提示词。
 * @param {string} text - 待检句子。
 * @returns {{ system: string, messages: object[] }} 给 llm 的参数。
 */
export function buildSampleMessages(text) {
  return {
    system: SAMPLE_SYSTEM,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: `请改正下面这句话里的错别字，只输出改正后的句子：\n\n${text}` }],
      },
    ],
  };
}

/**
 * 盲复核提示词。
 *
 * 关键点：**不给候选**。把「A 改成 B 对不对」直接问模型，它会顺着说对；
 * 让它自己独立改一遍再和候选比，才拿得到真判断。
 * @param {{ before: string, text: string, after: string }} context - 前一句 / 本句 / 后一句。
 * @returns {{ system: string, messages: object[] }} 给 llm 的参数。
 */
export function buildReviewMessages(context) {
  const lines = [];
  if (context.before !== "") lines.push(`前一句：${context.before}`);
  lines.push(`要校对的一句：${context.text}`);
  if (context.after !== "") lines.push(`后一句：${context.after}`);
  return {
    system: REVIEW_SYSTEM,
    messages: [{ role: "user", content: [{ type: "text", text: lines.join("\n") }] }],
  };
}
