/**
 * 把 `word/document.xml` 读成「段落 → run」两层结构。
 *
 * 只解析到能定位、能改写的程度：段落原文、每段文本、每个 run 在段文本里的偏移。
 * 样式/表格/超链接/是否已有修订这些标记是为了让 segment 和 docx-write 知道哪些段该放过。
 */

import { attrValue, countHanzi, extractText, findElements, scanTags } from "./xml.js";

/** 允许出现在可改写 run 里的子元素。多一个就说明这个 run 里有制表符、图片或域代码。 */
const PLAIN_RUN_CHILDREN = new Set(["w:rPr", "w:t"]);

/**
 * run 的内层是否只有 rPr 与文本。
 *
 * 只看 **run 的直接子元素**：`w:rPr` 里面还有 rFonts/sz/lang 一堆，连带算进来会让
 * 每个 run 都“不干净”。有 `<w:tab/>`、`<w:br/>`、`<w:fldChar>`、`<w:drawing>` 的 run
 * 不能按字符切分——切出来的片段会丢元素，或者让制表符挪位。这类段落一律标成不可写，
 * 只做检查不做修订。
 * @param {string} inner - run 的内层 XML。
 * @returns {boolean} 是否可安全切分。
 */
function isPlainRun(inner) {
  let depth = 0;
  for (const tag of scanTags(inner)) {
    if (tag.kind === "self") {
      // 自动分页标记是渲染提示，丢掉不影响内容，算干净。
      if (depth === 0 && tag.name !== "w:t" && tag.name !== "w:lastRenderedPageBreak") return false;
      continue;
    }
    if (tag.kind === "open") {
      if (depth === 0 && !PLAIN_RUN_CHILDREN.has(tag.name)) return false;
      depth += 1;
    } else {
      depth -= 1;
    }
  }
  return true;
}

/**
 * 取段落的样式名。
 * @param {string} inner - 段落内层 XML。
 * @returns {string | null} `w:pStyle` 的 `w:val`。
 */
function paragraphStyle(inner) {
  const properties = findElements(inner, "w:pPr")[0];
  if (properties === undefined) return null;
  const style = findElements(inner.slice(properties.start, properties.end), "w:pStyle")[0];
  if (style === undefined) return null;
  return attrValue(style.openTag, "w:val");
}

/**
 * 读整篇文档。
 *
 * 只取最外层段落：文本框里的段落是嵌套的，算进来会让同一段文字被检查两遍，
 * 而且它们的位置在正文里根本对不上。
 * @param {string} documentXml - `word/document.xml` 的内容。
 * @returns {{ paragraphs: object[], stats: { paragraphs: number, hanzi: number, runs: number } }} 解析结果。
 */
export function readDocument(documentXml) {
  const xml = String(documentXml);
  const tableRanges = findElements(xml, "w:tbl").map((range) => ({ start: range.start, end: range.end }));
  const paragraphRanges = findElements(xml, "w:p");

  const paragraphs = [];
  let runCount = 0;
  let hanzi = 0;

  for (const range of paragraphRanges) {
    const inner = xml.slice(range.innerStart, range.innerEnd);
    const inTable = tableRanges.some((table) => range.start > table.start && range.start < table.end);
    const hasRevision = /<w:(ins|del|moveFrom|moveTo)\b/.test(inner);
    const hyperlinkRanges = findElements(inner, "w:hyperlink").map((link) => ({ start: link.start, end: link.end }));

    const runs = [];
    let text = "";
    // 偏移一律按**码点**数（不是 UTF-16 长度）：diff 与句子切分都用码点，
    // 三处口径不一致的话，句子里出现一个 emoji 之后所有位置都会错位。
    let charCount = 0;
    for (const runRange of findElements(inner, "w:r")) {
      const runInner = inner.slice(runRange.innerStart, runRange.innerEnd);
      const runText = extractText(runInner);
      const properties = findElements(runInner, "w:rPr")[0];
      const inHyperlink = hyperlinkRanges.some((link) => runRange.start > link.start && runRange.start < link.end);
      const runChars = [...runText].length;
      runs.push({
        index: runs.length,
        start: charCount,
        end: charCount + runChars,
        text: runText,
        rPr: properties === undefined ? null : runInner.slice(properties.start, properties.end),
        inHyperlink,
        plain: isPlainRun(runInner),
      });
      text += runText;
      charCount += runChars;
    }

    runCount += runs.length;
    hanzi += countHanzi(text);
    paragraphs.push({
      index: paragraphs.length,
      xml: xml.slice(range.start, range.end),
      openTag: range.openTag,
      inner,
      // 在整篇 document.xml 里的位置。写入时按它原地替换，不重排整篇。
      range: { start: range.start, end: range.end },
      text,
      style: paragraphStyle(inner),
      inTable,
      hasRevision,
      runs,
      // 可写 = 不在表格里、没有既有修订、每个 run 都只有文本。
      writable: !inTable && !hasRevision && runs.every((run) => run.plain),
    });
  }

  return {
    paragraphs,
    stats: { paragraphs: paragraphs.length, hanzi, runs: runCount },
  };
}

/**
 * 把段落文本按 run 切成片段，供写入时定位。
 * 单测用来验证偏移自洽：每个可见字符都恰好属于一个 run。
 * @param {{ runs: Array<{ start: number, end: number }> }} paragraph - 段落。
 * @param {number} position - 段文本里的偏移。
 * @returns {number} run 下标；落在 run 边界上时返回左侧那个。
 */
export function runAt(paragraph, position) {
  const runs = Array.isArray(paragraph?.runs) ? paragraph.runs : [];
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    if (position >= run.start && position < run.end) return index;
  }
  return Math.max(0, runs.length - 1);
}
