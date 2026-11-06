/**
 * 把候选改动写成 Word 修订（tracked changes），落到副本里。
 *
 * 只改写有改动的那些 run：其余 XML 一个字节都不碰。属性顺序、rsid、命名空间前缀
 * 全部原样保留——Word 对这些很敏感，重新序列化一次就可能打不开。
 *
 * 形态：原字包成 `<w:del><w:r><w:delText>原字</w:delText></w:r></w:del>`，
 * 新字包成 `<w:ins><w:r><w:t>新字</w:t></w:r></w:ins>`，两者共用原 run 的 `w:rPr`。
 */

import { readFile, writeFile } from "node:fs/promises";
import { escapeXml, findElements } from "./xml.js";
import { readZip, writeZip } from "./zip.js";

/** 修订作者名。Word 审阅面板里按这个名字分组。 */
export const REVISION_AUTHOR = "typo-proof";

/**
 * 造一个修订元素的开始标签。
 * @param {'w:ins' | 'w:del'} kind - 元素名。
 * @param {number} id - 文档内唯一 id。
 * @param {string} date - ISO 时间。
 * @returns {string} 开始标签。
 */
function revisionTag(kind, id, date) {
  return `<${kind} w:id="${id}" w:author="${REVISION_AUTHOR}" w:date="${date}">`;
}

/**
 * 把段落文本按「正常 / 删除 / 插入」切成片段，并绑定到来源 run。
 * @param {object} paragraph - `readDocument` 的段落。
 * @param {Array<{ pos: number, orig: string, sugg: string }>} edits - 已按 pos 升序。
 * @returns {Array<{ runIndex: number, kind: 'text' | 'del' | 'ins', text: string }>} 片段。
 */
function sliceParagraph(paragraph, edits) {
  const chars = Array.from(paragraph.text);
  const byPos = new Map(edits.map((edit) => [edit.pos, edit]));
  const pieces = [];
  let runIndex = 0;
  let runEnd = paragraph.runs.length > 0 ? paragraph.runs[0].end : 0;

  for (let pos = 0; pos < chars.length; pos += 1) {
    while (runIndex < paragraph.runs.length - 1 && pos >= runEnd) {
      runIndex += 1;
      runEnd = paragraph.runs[runIndex].end;
    }
    const edit = byPos.get(pos);
    if (edit === undefined) {
      pieces.push({ runIndex, kind: "text", text: chars[pos] });
      continue;
    }
    pieces.push({ runIndex, kind: "del", text: chars[pos] });
    pieces.push({ runIndex, kind: "ins", text: edit.sugg });
  }
  return pieces;
}

/**
 * 把一个 run 的片段序列化成 XML。
 * @param {object} run - 原 run（要它的 rPr）。
 * @param {Array<{ kind: string, text: string }>} pieces - 属于这个 run 的片段。
 * @param {{ nextId: () => number, date: string }} options - id 生成器与时间。
 * @returns {string} XML。
 */
function renderRun(run, pieces, options) {
  const rPr = run.rPr ?? "";
  const out = [];
  let buffer = "";
  const flush = () => {
    if (buffer === "") return;
    out.push(`<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(buffer)}</w:t></w:r>`);
    buffer = "";
  };

  for (const piece of pieces) {
    if (piece.kind === "text") {
      buffer += piece.text;
      continue;
    }
    flush();
    if (piece.kind === "del") {
      out.push(
        `${revisionTag("w:del", options.nextId(), options.date)}<w:r>${rPr}<w:delText xml:space="preserve">${escapeXml(piece.text)}</w:delText></w:r></w:del>`,
      );
    } else if (piece.kind === "ins") {
      out.push(
        `${revisionTag("w:ins", options.nextId(), options.date)}<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(piece.text)}</w:t></w:r></w:ins>`,
      );
    }
  }
  flush();
  return out.join("");
}

/**
 * 重写一个段落。
 *
 * 片段按**原 run 的顺序**输出：同一段里相邻的修订因此落在原来的位置上，
 * 而不是被挪到段尾。
 * @param {object} paragraph - 段落。
 * @param {Array<{ pos: number, orig: string, sugg: string }>} edits - 改动。
 * @param {{ nextId: () => number, date: string }} options - id 与时间。
 * @returns {string} 新的段落 XML。
 */
export function rewriteParagraph(paragraph, edits, options) {
  const pieces = sliceParagraph(paragraph, edits);
  const grouped = paragraph.runs.map(() => []);
  for (const piece of pieces) {
    const bucket = grouped[piece.runIndex];
    if (bucket !== undefined) bucket.push(piece);
  }

  const ranges = findElements(paragraph.inner, "w:r");
  let output = "";
  let cursor = 0;
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    output += paragraph.inner.slice(cursor, range.start);
    output += renderRun(paragraph.runs[index], grouped[index] ?? [], options);
    cursor = range.end;
  }
  output += paragraph.inner.slice(cursor);
  return `${paragraph.openTag}${output}</w:p>`;
}

/**
 * 把一批改动写进整篇 document.xml。
 *
 * 写入前逐条校验：段落可写、位置落在段内、位置上确实是那个原字。任何一条不满足就跳过
 * 并记账——宁可不改，也不能在文档里改错位置。
 * 同一段的多处改动按位置升序重建整段（位置天然稳定）；同一位置出现两个不同建议时
 * **取先到的那条**，后到的记 `conflict` 跳过。上游已经把 accepted 按票数降序排过，
 * 所以「先到」= 票数不低：这里不需要、也不应该知道 votes。
 * @param {{ documentXml: string, paragraphs: object[], changes: object[], date?: string, startId?: number }} input - 输入。
 * @returns {{ xml: string, applied: object[], skipped: object[] }} 结果。
 */
export function applyRevisions(input) {
  const date = typeof input.date === "string" ? input.date : new Date().toISOString();
  let id = Number.isFinite(input.startId) ? Number(input.startId) : 9_000_000;
  const options = { nextId: () => (id += 1), date };

  const byParagraph = new Map();
  const skipped = [];
  const applied = [];

  for (const change of input.changes) {
    const paragraph = input.paragraphs[change.paraIndex];
    if (paragraph === undefined) {
      skipped.push({ ...change, reason: "missing-paragraph" });
      continue;
    }
    if (!paragraph.writable) {
      skipped.push({ ...change, reason: "paragraph-not-writable" });
      continue;
    }
    const chars = Array.from(paragraph.text);
    if (change.pos < 0 || change.pos >= chars.length) {
      skipped.push({ ...change, reason: "out-of-range" });
      continue;
    }
    if (chars[change.pos] !== change.orig) {
      skipped.push({ ...change, reason: "text-mismatch" });
      continue;
    }
    const target = paragraph.runs.find((run) => change.pos >= run.start && change.pos < run.end);
    if (target === undefined || target.inHyperlink) {
      skipped.push({ ...change, reason: target === undefined ? "no-run" : "hyperlink" });
      continue;
    }
    const list = byParagraph.get(change.paraIndex) ?? [];
    if (list.some((item) => item.pos === change.pos)) {
      skipped.push({ ...change, reason: "conflict" });
      continue;
    }
    list.push(change);
    byParagraph.set(change.paraIndex, list);
  }

  let xml = String(input.documentXml);
  // 从后往前改：改前面的段落会让后面段落的偏移全部失效。
  const indexes = [...byParagraph.keys()].sort((left, right) => right - left);
  for (const paraIndex of indexes) {
    const paragraph = input.paragraphs[paraIndex];
    const edits = byParagraph.get(paraIndex).sort((left, right) => left.pos - right.pos);
    const rewritten = rewriteParagraph(paragraph, edits, options);
    xml = xml.slice(0, paragraph.range.start) + rewritten + xml.slice(paragraph.range.end);
    applied.push(...edits.map((edit) => ({ ...edit, paraIndex })));
  }

  return { xml, applied, skipped };
}

/**
 * 写副本：只替换 `word/document.xml`，其余条目原样搬过去。
 * @param {{ sourcePath: string, targetPath: string, documentXml: string }} input - 源、目标与新正文。
 * @returns {Promise<{ bytes: number }>} 写出的字节数。
 */
export async function writeRevisedCopy(input) {
  const buffer = await readFile(input.sourcePath);
  const entries = readZip(buffer);
  if (!entries.has("word/document.xml")) {
    throw new Error("这个 docx 里没有 word/document.xml");
  }
  entries.set("word/document.xml", Buffer.from(input.documentXml, "utf8"));
  const output = writeZip([...entries].map(([name, data]) => ({ name, data })));
  await writeFile(input.targetPath, output);
  return { bytes: output.length };
}
