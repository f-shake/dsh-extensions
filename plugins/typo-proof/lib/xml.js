/**
 * 够用的 OOXML 词法工具：只做「找元素边界、取属性原值、取文本、转义」。
 *
 * 为什么不建 DOM：docx 的修订必须**字节级保留**原来的属性串（w:rsid*、命名空间前缀、
 * 属性书写顺序），任何解析再序列化都会重排属性。这里只在字符串上切片，
 * 改动的部分自己拼，其余原样带过。
 *
 * 局限（已知且会被上游判为「不可写」）：属性值里出现未转义的 `>` 会让标签扫描错位。
 * Word 自己写出来的文件不会这样，但第三方工具生成的有可能——所以 docx-read 会用一个
 * 结构自检把读出来不自洽的段落标成不可写。
 */

const TAG_PATTERN = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>/g;

/**
 * 扫出所有标签。
 * @param {string} xml - XML 文本。
 * @returns {Array<{ kind: 'open' | 'close' | 'self', name: string, start: number, end: number }>} 标签序列。
 */
export function scanTags(xml) {
  const tags = [];
  TAG_PATTERN.lastIndex = 0;
  let match = TAG_PATTERN.exec(xml);
  while (match !== null) {
    const closing = match[1] === "/";
    const selfClosing = match[4] === "/";
    tags.push({
      kind: closing ? "close" : selfClosing ? "self" : "open",
      name: match[2],
      start: match.index,
      end: match.index + match[0].length,
    });
    match = TAG_PATTERN.exec(xml);
  }
  return tags;
}

/**
 * 找某个元素的全部区间。同名元素允许嵌套（文本框里的 `<w:p>` 就是这样）。
 * @param {string} xml - XML 文本。
 * @param {string} tagName - 元素名，如 `w:p`。
 * @returns {Array<{ start: number, end: number, innerStart: number, innerEnd: number, selfClosing: boolean, openTag: string }>} 区间。
 */
export function findElements(xml, tagName) {
  const tags = scanTags(xml);
  const found = [];
  let open = null;
  let depth = 0;

  for (const tag of tags) {
    if (tag.name !== tagName) continue;
    if (tag.kind === "open") {
      if (depth === 0) open = tag;
      depth += 1;
    } else if (tag.kind === "self") {
      if (depth === 0) {
        found.push({
          start: tag.start,
          end: tag.end,
          innerStart: tag.end,
          innerEnd: tag.end,
          selfClosing: true,
          openTag: xml.slice(tag.start, tag.end),
        });
      }
    } else if (depth > 0) {
      depth -= 1;
      if (depth === 0 && open !== null) {
        found.push({
          start: open.start,
          end: tag.end,
          innerStart: open.end,
          innerEnd: tag.start,
          selfClosing: false,
          openTag: xml.slice(open.start, open.end),
        });
        open = null;
      }
    }
  }
  return found;
}

/**
 * 取属性原文（已反转义）。
 * @param {string} openTag - 开始标签原文，如 `<w:p w:rsidR="00A1">`。
 * @param {string} name - 属性名，如 `w:rsidR`。
 * @returns {string | null} 属性值；没有这个属性返回 null。
 */
export function attrValue(openTag, name) {
  const pattern = new RegExp(`(?:^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*("([^"]*)"|'([^']*)')`);
  const match = pattern.exec(openTag);
  if (match === null) return null;
  return unescapeXml(match[2] !== undefined ? match[2] : match[3]);
}

/**
 * 反转义 XML 实体。
 * @param {string} text - 原文。
 * @returns {string} 解码后的文本。
 */
export function unescapeXml(text) {
  return String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_all, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&");
}

/**
 * 转义成可放进 `<w:t>` 的文本。
 * @param {string} text - 明文。
 * @returns {string} 转义结果。
 */
export function escapeXml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 取一个片段里所有 `<w:t>` 的文本，按出现顺序拼接。
 * @param {string} fragment - XML 片段。
 * @returns {string} 拼接后的文本。
 */
export function extractText(fragment) {
  const tags = scanTags(fragment);
  let text = "";
  let open = null;
  for (const tag of tags) {
    if (tag.name !== "w:t") continue;
    if (tag.kind === "self") continue;
    if (tag.kind === "open") {
      if (open === null) open = tag;
      continue;
    }
    if (open !== null) {
      text += unescapeXml(fragment.slice(open.end, tag.start));
      open = null;
    }
  }
  return text;
}

/**
 * 汉字计数（只算 CJK 统一表意文字，含扩展 A 与兼容表）。
 *
 * 标点、数字、英文都不算：判定「这句值不值得检」看的是汉字量，
 * 一句「2015 年 3 月 14 日」不值得跑三次模型。
 * @param {string} text - 文本。
 * @returns {number} 汉字个数。
 */
export function countHanzi(text) {
  let count = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * 单个汉字的判定。候选过滤第一道闸就用它。
 * @param {string} char - 待判字符。
 * @returns {boolean} 是否是一个汉字。
 */
export function isHanzi(char) {
  if (typeof char !== "string" || [...char].length !== 1) return false;
  return countHanzi(char) === 1;
}
