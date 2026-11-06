/**
 * 字符级比较：只回答「哪几个字被换成了什么」。
 *
 * 模型只负责把句子改对，定位一律由这里的 LCS 算——不让模型自报位置，
 * 它给的偏移经常差一个字。
 */

/**
 * 最长公共子序列，返回对齐后的操作序列。
 * @param {string} before - 原文。
 * @param {string} after - 模型输出。
 * @returns {Array<{ kind: 'same' | 'del' | 'ins', text: string }>} 操作序列。
 */
export function diffOps(before, after) {
  const a = Array.from(String(before));
  const b = Array.from(String(after));
  const rows = a.length;
  const cols = b.length;
  const table = Array.from({ length: rows + 1 }, () => new Uint16Array(cols + 1));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const ops = [];
  const push = (kind, text) => {
    if (text === "") return;
    const last = ops.at(-1);
    if (last !== undefined && last.kind === kind) last.text += text;
    else ops.push({ kind, text });
  };

  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      push("del", a[i]);
      i += 1;
    } else {
      push("ins", b[j]);
      j += 1;
    }
  }
  if (i < rows) push("del", a.slice(i).join(""));
  if (j < cols) push("ins", b.slice(j).join(""));
  return ops;
}

/**
 * 从操作序列里取出「单字替换」。
 *
 * 只有「删一个字、紧接着补一个字」才算候选编辑。整词替换、增删短语都不算：
 * 那多半是模型在改写句子，不是改错别字。
 * @param {Array<{ kind: string, text: string }>} ops - 操作序列。
 * @returns {{ edits: Array<{ pos: number, orig: string, sugg: string }>, changed: number }} 编辑与改动字数。
 */
export function extractEdits(ops) {
  const edits = [];
  let position = 0;
  let deleted = 0;
  let inserted = 0;
  let pending = null;

  for (const op of ops) {
    if (op.kind === "same") {
      pending = null;
      position += Array.from(op.text).length;
      continue;
    }
    const chars = Array.from(op.text);
    if (op.kind === "del") {
      deleted += chars.length;
      pending = chars.length === 1 ? { pos: position, orig: chars[0] } : null;
      position += chars.length;
      continue;
    }
    // ins：只有紧跟在同位置的单字删除后面才算替换
    inserted += chars.length;
    if (pending !== null && pending.pos === position - 1 && chars.length === 1) {
      edits.push({ pos: pending.pos, orig: pending.orig, sugg: chars[0] });
    }
    pending = null;
  }

  // 改动量按「换了几处」算：一处替换记 1，不是记 2。
  // 记 2 的话，一句十二个字里错两个词就会被判成改写，而那正是最常见的输入。
  const leftover = deleted + inserted - edits.length * 2;
  return { edits, changed: edits.length + Math.max(0, leftover) };
}

/**
 * 一次比较的全部结果。
 * @param {string} before - 原文。
 * @param {string} after - 模型输出。
 * @returns {{ edits: Array<{ pos: number, orig: string, sugg: string }>, ops: object[], changed: number, similarity: number }} 结果。
 */
export function compare(before, after) {
  const ops = diffOps(before, after);
  const { edits, changed } = extractEdits(ops);
  const total = Math.max(Array.from(String(before)).length, Array.from(String(after)).length, 1);
  return { edits, ops, changed, similarity: 1 - changed / total };
}
