import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { readDocument, runAt } from "../lib/docx-read.js";
import { readZip } from "../lib/zip.js";
import { MINI_DOCUMENT_XML } from "./fixtures/mini-docx.js";

/** 真实日记：只在它存在时才跑，仓库里不该依赖用户 OneDrive 上的文件。 */
const DIARY = "C:/Users/autod/OneDrive/旧事重提/日记/2011~2014.docx";

test("docx-read：段落、样式、表格、超链接都认得出来", () => {
  const { paragraphs, stats } = readDocument(MINI_DOCUMENT_XML);
  assert.equal(stats.paragraphs, 5, "w:sectPr 不算段落");
  assert.deepEqual(
    paragraphs.map((paragraph) => paragraph.text),
    ["我今天去了那个地方。", "目录条目", "表格里的字", "链接文字后面的正文。", "我喜欢看小说，那天我睡的很晚，第二天起来天还没亮。"],
  );

  assert.equal(paragraphs[1].style, "TOC1");
  assert.equal(paragraphs[2].inTable, true);
  assert.equal(paragraphs[2].writable, false, "表格里的段落不写修订");
  assert.equal(paragraphs[3].runs[0].inHyperlink, true);
  assert.equal(paragraphs[3].runs[1].inHyperlink, false);
  assert.equal(paragraphs[3].runs[0].start, 0);
  assert.equal(paragraphs[3].runs[0].end, 4);
  assert.equal(paragraphs[3].runs[1].start, 4);
  assert.equal(paragraphs[3].runs[1].end, 10);
  assert.equal(paragraphs[0].writable, true);
  assert.ok(paragraphs[0].runs[0].rPr.includes("w:sz"), "rPr 要原样带出来，写入时要复用");
});

test("docx-read：run 偏移自洽，段文本能按 run 还原", () => {
  const { paragraphs } = readDocument(MINI_DOCUMENT_XML);
  for (const paragraph of paragraphs) {
    const rebuilt = paragraph.runs.map((run) => run.text).join("");
    assert.equal(rebuilt, paragraph.text, `第 ${paragraph.index} 段`);
    for (const run of paragraph.runs) {
      assert.equal(run.text.length, [...run.text].length, "这些用例里没有代理对，长度与码点数一致");
    }
  }
});

test("docx-read：runAt 落在字符所属的 run 上", () => {
  const { paragraphs } = readDocument(MINI_DOCUMENT_XML);
  const paragraph = paragraphs[3];
  assert.equal(runAt(paragraph, 0), 0);
  assert.equal(runAt(paragraph, 3), 0);
  assert.equal(runAt(paragraph, 4), 1);
  assert.equal(runAt(paragraph, 10), 1);
});

test("docx-read：真实日记的规模与既有修订", { skip: existsSync(DIARY) ? false : "本机没有 2011~2014.docx" }, () => {
  const entries = readZip(readFileSync(DIARY));
  const xml = entries.get("word/document.xml").toString("utf8");
  const { paragraphs, stats } = readDocument(xml);
  assert.equal(stats.paragraphs, 234);
  assert.equal(stats.hanzi, 16902, "正文 w:t 里的汉字数（含目录）；文件里的域代码不算");
  assert.equal(paragraphs.filter((paragraph) => paragraph.hasRevision).length, 0, "这一版文档没有既有修订");
  assert.equal(paragraphs.filter((paragraph) => paragraph.inTable).length, 15);
  // 目录段占了 54 段，正文里真正可写的有 158 段（其余是空段或带域代码）。
  const bodyWritable = paragraphs.filter(
    (paragraph) => paragraph.writable && !(typeof paragraph.style === "string" && paragraph.style.startsWith("TOC")) && !paragraph.inTable,
  );
  assert.equal(bodyWritable.length, 158);
});
