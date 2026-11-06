import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { applyRevisions, writeRevisedCopy } from "../lib/docx-write.js";
import { readDocument } from "../lib/docx-read.js";
import { readZip } from "../lib/zip.js";
import { MINI_DOCUMENT_XML, writeMiniDocx } from "./fixtures/mini-docx.js";

/** 「我今天去了那个地方。」里「那」的下标。 */
const NA = 5;

test("docx-write：单字改动写成 w:del + w:ins，并复用原 run 的 rPr", () => {
  const { paragraphs } = readDocument(MINI_DOCUMENT_XML);
  const { xml, applied, skipped } = applyRevisions({
    documentXml: MINI_DOCUMENT_XML,
    paragraphs,
    changes: [{ paraIndex: 0, pos: NA, orig: "那", sugg: "哪" }],
    date: "2026-11-06T10:00:00Z",
  });

  assert.equal(applied.length, 1);
  assert.deepEqual(skipped, []);
  assert.match(xml, /<w:del w:id="\d+" w:author="typo-proof" w:date="2026-11-06T10:00:00Z">/);
  assert.match(xml, /<w:delText xml:space="preserve">那<\/w:delText>/);
  assert.match(xml, /<w:ins w:id="\d+" w:author="typo-proof" w:date="2026-11-06T10:00:00Z">/);
  assert.match(xml, /<w:t xml:space="preserve">哪<\/w:t>/);
  // 原 run 的字体与字号必须带进修订里，否则 Word 里会跳成默认字体。
  assert.match(xml, /<w:del[^>]*><w:r><w:rPr><w:rFonts w:ascii="宋体"\/><w:sz w:val="24"\/><\/w:rPr>/);
  // 未改动的段落一字不差。
  assert.ok(xml.includes("<w:t>我喜欢看小说，那天我睡的很晚，第二天起来天还没亮。</w:t>"));
});

test("docx-write：改完的段落能重新解析，且只剩新字", () => {
  const { paragraphs } = readDocument(MINI_DOCUMENT_XML);
  const { xml } = applyRevisions({
    documentXml: MINI_DOCUMENT_XML,
    paragraphs,
    changes: [{ paraIndex: 0, pos: NA, orig: "那", sugg: "哪" }],
  });
  const again = readDocument(xml);
  assert.equal(again.paragraphs.length, 5);
  assert.equal(again.paragraphs[0].text, "我今天去了哪个地方。");
  assert.equal(again.paragraphs[0].hasRevision, true, "改过的段落要能被认出来是含修订的");
});

test("docx-write：超链接里的字不写，报告里留痕", () => {
  const { paragraphs } = readDocument(MINI_DOCUMENT_XML);
  const { applied, skipped } = applyRevisions({
    documentXml: MINI_DOCUMENT_XML,
    paragraphs,
    changes: [{ paraIndex: 3, pos: 0, orig: "链", sugg: "连" }],
  });
  assert.equal(applied.length, 0);
  assert.equal(skipped[0].reason, "hyperlink");
});

test("docx-write：表格里的段落不写", () => {
  const { paragraphs } = readDocument(MINI_DOCUMENT_XML);
  const { skipped } = applyRevisions({
    documentXml: MINI_DOCUMENT_XML,
    paragraphs,
    changes: [{ paraIndex: 2, pos: 0, orig: "表", sugg: "裱" }],
  });
  assert.equal(skipped[0].reason, "paragraph-not-writable");
});

test("docx-write：位置上的字对不上就跳过，绝不硬改", () => {
  const { paragraphs } = readDocument(MINI_DOCUMENT_XML);
  const { applied, skipped } = applyRevisions({
    documentXml: MINI_DOCUMENT_XML,
    paragraphs,
    changes: [{ paraIndex: 0, pos: NA, orig: "错", sugg: "对" }],
  });
  assert.equal(applied.length, 0);
  assert.equal(skipped[0].reason, "text-mismatch");
});

test("docx-write：同一位置两个建议只取第一个", () => {
  const { paragraphs } = readDocument(MINI_DOCUMENT_XML);
  const { applied, skipped } = applyRevisions({
    documentXml: MINI_DOCUMENT_XML,
    paragraphs,
    changes: [
      { paraIndex: 0, pos: NA, orig: "那", sugg: "哪" },
      { paraIndex: 0, pos: NA, orig: "那", sugg: "纳" },
    ],
  });
  assert.equal(applied.length, 1);
  assert.equal(skipped[0].reason, "conflict");
});

test("docx-write：多段同时改，后面的段落不受前面长度变化影响", () => {
  const { paragraphs } = readDocument(MINI_DOCUMENT_XML);
  const { xml, applied } = applyRevisions({
    documentXml: MINI_DOCUMENT_XML,
    paragraphs,
    changes: [
      { paraIndex: 0, pos: NA, orig: "那", sugg: "哪" },
      { paraIndex: 4, pos: 11, orig: "的", sugg: "得" },
    ],
  });
  assert.equal(applied.length, 2);
  const again = readDocument(xml);
  assert.equal(again.paragraphs[0].text, "我今天去了哪个地方。");
  assert.equal(again.paragraphs[4].text, "我喜欢看小说，那天我睡得很晚，第二天起来天还没亮。");
});

test("docx-write：写副本只换正文，其他条目原样，原文件不动", async () => {
  const { dir, path } = await writeMiniDocx();
  const before = createHash("sha256").update(await readFile(path)).digest("hex");
  const source = readZip(await readFile(path));
  const { paragraphs } = readDocument(source.get("word/document.xml").toString("utf8"));
  const { xml } = applyRevisions({
    documentXml: source.get("word/document.xml").toString("utf8"),
    paragraphs,
    changes: [{ paraIndex: 0, pos: NA, orig: "那", sugg: "哪" }],
  });

  const target = `${dir}/mini_校对副本.docx`;
  const { bytes } = await writeRevisedCopy({ sourcePath: path, targetPath: target, documentXml: xml });
  assert.ok(bytes > 0);

  const after = readZip(await readFile(target));
  assert.equal(after.size, source.size);
  assert.deepEqual(after.get("[Content_Types].xml"), source.get("[Content_Types].xml"));
  assert.deepEqual(after.get("_rels/.rels"), source.get("_rels/.rels"));
  assert.notDeepEqual(after.get("word/document.xml"), source.get("word/document.xml"));

  const hashAfter = createHash("sha256").update(await readFile(path)).digest("hex");
  assert.equal(hashAfter, before, "原文件必须一个字节都没变");
});

