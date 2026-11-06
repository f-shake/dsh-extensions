/**
 * 测试用的小 docx。不依赖任何外部文件，所有写入类用例都拿它当底稿。
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeZip } from "../../lib/zip.js";

/** 一份结构齐全的小正文：普通段、目录段、表格、超链接、长句。 */
export const MINI_DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p w:rsidR="00A1"><w:r><w:rPr><w:rFonts w:ascii="宋体"/><w:sz w:val="24"/></w:rPr><w:t>我今天去了那个地方。</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr><w:r><w:t>目录条目</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格里的字</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:hyperlink r:id="rId1"><w:r><w:t>链接文字</w:t></w:r></w:hyperlink><w:r><w:t>后面的正文。</w:t></w:r></w:p>
<w:p><w:r><w:t>我喜欢看小说，那天我睡的很晚，第二天起来天还没亮。</w:t></w:r></w:p>
<w:sectPr/>
</w:body></w:document>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

/**
 * 打包成 docx。
 * @param {string} [xml] - 正文，默认用 `MINI_DOCUMENT_XML`。
 * @returns {Buffer} docx 内容。
 */
export function miniDocx(xml = MINI_DOCUMENT_XML) {
  return writeZip([
    { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(RELS, "utf8") },
    { name: "word/document.xml", data: Buffer.from(xml, "utf8") },
  ]);
}

/**
 * 写到临时目录里，返回路径。
 * @param {string} [xml] - 正文。
 * @returns {Promise<{ dir: string, path: string }>} 目录与文件路径。
 */
export async function writeMiniDocx(xml = MINI_DOCUMENT_XML) {
  const dir = await mkdtemp(join(tmpdir(), "typo-proof-test-"));
  const path = join(dir, "mini.docx");
  await writeFile(path, miniDocx(xml));
  return { dir, path };
}
