import assert from "node:assert/strict";
import { test } from "node:test";

import { hardSplit, selectSentences, splitSentences } from "../lib/segment.js";
import { readDocument } from "../lib/docx-read.js";
import { MINI_DOCUMENT_XML } from "./fixtures/mini-docx.js";

test("segment：按句末标点切，标点跟着前一句", () => {
  const sentences = splitSentences("我今天去了那里。他很高兴！你呢？");
  assert.deepEqual(
    sentences.map((sentence) => sentence.text),
    ["我今天去了那里。", "他很高兴！", "你呢？"],
  );
  assert.equal(sentences[0].start, 0);
  assert.equal(sentences[1].start, 8);
});

test("segment：右引号与省略号不算丢句", () => {
  const sentences = splitSentences("他说：“走吧。”我点了点头……然后我们都笑了。");
  assert.deepEqual(
    sentences.map((sentence) => sentence.text),
    ["他说：“走吧。”", "我点了点头……", "然后我们都笑了。"],
  );
});

test("segment：超长句按上限硬切，优先切在逗号上", () => {
  const long = `${"甲".repeat(60)}，${"乙".repeat(60)}，${"丙".repeat(60)}。`;
  const pieces = hardSplit({ start: 0, end: long.length, text: long }, 100);
  assert.ok(pieces.length >= 2);
  assert.ok(pieces[0].text.endsWith("，"), "第一段切在逗号后面");
  assert.equal(pieces.map((piece) => piece.text).join(""), long, "切完拼回去必须等于原句");
});

test("segment：目录 / 表格 / 空段 / 非中文段都跳过", () => {
  const { paragraphs } = readDocument(MINI_DOCUMENT_XML);
  const { sentences, skipped } = selectSentences(paragraphs, { minHanzi: 4 });
  const reasons = new Map(skipped.map((item) => [item.paraIndex, item.reason]));
  assert.equal(reasons.get(1), "toc");
  assert.equal(reasons.get(2), "table");
  assert.deepEqual(
    sentences.map((sentence) => sentence.paraIndex),
    [0, 3, 4],
    "普通段、超链接段、长句段都要检",
  );
});

test("segment：句级最小长度按汉字算，不足的不计入", () => {
  const paragraphs = readDocument(MINI_DOCUMENT_XML).paragraphs;
  assert.equal(selectSentences(paragraphs, { minHanzi: 20 }).sentences.length, 1, "只有那句长的够 20 个汉字");
  assert.equal(selectSentences(paragraphs, { minHanzi: 4 }).sentences.length, 3);
});

test("segment：加密段成对出现时，中间整段跳过", () => {
  const xml = `<w:body>
<w:p><w:r><w:t>正常的一段话，足够长了吧。</w:t></w:r></w:p>
<w:p><w:r><w:t>##密文开始</w:t></w:r></w:p>
<w:p><w:r><w:t>这里面也是密文，不该被检查。</w:t></w:r></w:p>
<w:p><w:r><w:t>##密文结束</w:t></w:r></w:p>
<w:p><w:r><w:t>后面又是正常的一段话。</w:t></w:r></w:p>
</w:body>`;
  const { paragraphs } = readDocument(xml);
  const { sentences, skipped } = selectSentences(paragraphs, { minHanzi: 4 });
  assert.deepEqual(
    sentences.map((sentence) => sentence.paraIndex),
    [0, 4],
  );
  assert.deepEqual(
    skipped.filter((item) => item.reason === "encrypted").map((item) => item.paraIndex),
    [1, 2, 3],
  );
});

test("segment：上下文取紧邻的句子，句子首尾不给空串", () => {
  const xml = `<w:body>
<w:p><w:r><w:t>第一句话有十个汉字。</w:t></w:r></w:p>
<w:p><w:r><w:t>第二句话也有十个汉字。</w:t></w:r></w:p>
</w:body>`;
  const { paragraphs } = readDocument(xml);
  const { sentences } = selectSentences(paragraphs, { minHanzi: 4 });
  assert.equal(sentences[0].before, "");
  assert.equal(sentences[0].after, "第二句话也有十个汉字。");
  assert.equal(sentences[1].before, "第一句话有十个汉字。");
  assert.equal(sentences[1].after, "");
});

