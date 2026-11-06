/**
 * 回归夹具：拿人工确认过的那几条真错，验整条管线能不能把它们捞出来并写对位置。
 *
 * 用假模型代替真的 4B：它只做「已知错词 → 正确写法」的替换。这样测的是
 * 切句、投票、定位、复核、写入这一整条链路，不掺模型能力的噪声。
 * 真模型的效果要靠真机跑（见 PLAN.md §11 的端到端）。
 *
 * 夹具里 5 条有 3 条在这版 docx 里已经改好了（原错式全文 0 次），召回目标只有剩下的 2 条。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createCache } from "../lib/cache.js";
import { readDocument } from "../lib/docx-read.js";
import { runCheck } from "../lib/pipeline.js";
import { readZip } from "../lib/zip.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/known-typos.json", import.meta.url), "utf8"));
const source = fixture.file;
const present = fixture.items.filter((item) => item.present === true);

/** 只认夹具里那些替换的假模型。 */
function fixtureClient() {
  return {
    async complete({ messages }) {
      const text = messages[0].content[0].text;
      const marker = "要校对的一句：";
      const at = text.lastIndexOf(marker);
      const sentence = at >= 0 ? text.slice(at + marker.length).split("\n")[0] : text.split("\n").filter((line) => line.trim() !== "").at(-1);
      let fixed = sentence;
      for (const item of fixture.items) fixed = fixed.split(item.pattern).join(item.fixed);
      return fixed;
    },
  };
}

test("known-typos：夹具与当前文档对得上（该在的还在、已修的不再出现）", { skip: existsSync(source) ? false : "本机没有 2011~2014.docx" }, () => {
  const xml = readZip(readFileSync(source)).get("word/document.xml").toString("utf8");
  const text = readDocument(xml).paragraphs.map((paragraph) => paragraph.text).join("\n");
  for (const item of fixture.items) {
    const wrong = text.split(item.pattern).length - 1;
    if (item.present) assert.ok(wrong > 0, `第 ${item.para} 段的「${item.pattern}」在文档里找不到，夹具过期了`);
    else assert.equal(wrong, 0, `第 ${item.para} 段的「${item.pattern}」又出现了，夹具里的 present 该改回 true`);
  }
});

test("known-typos：剩下的真错全部捞回并写到对应段", { skip: existsSync(source) && present.length > 0 ? false : "没有可用的夹具条目" }, async () => {
  // 先复制到临时目录：管线会往源文件旁边写副本与报告，不能动用户的日记目录。
  const dir = await mkdtemp(join(tmpdir(), "typo-proof-known-"));
  const file = join(dir, "2011~2014.docx");
  await copyFile(source, file);

  const result = await runCheck({ file, llm: fixtureClient(), cache: createCache({ dir: join(dir, "cache") }), localModel: "fixture", minHanzi: 8, concurrency: 4 });

  const found = present.filter((item) =>
    result.candidates.some((candidate) => candidate.paraIndex + 1 === item.para && candidate.orig === item.orig && candidate.sugg === item.sugg),
  );
  assert.equal(found.length, present.length, `只捞到 ${found.length}/${present.length} 条：${JSON.stringify(found.map((item) => item.para))}`);

  const confirmed = result.candidates.filter((candidate) => candidate.review.status === "confirmed");
  assert.ok(confirmed.length >= present.length, `确认 ${confirmed.length} 条`);

  const xml = readZip(await readFile(result.copyPath)).get("word/document.xml").toString("utf8");
  // 必须落到**那一 段**里验证：只断言「全文某处出现过这个字」的话，写错段也能过。
  const revised = readDocument(xml);
  for (const item of found) {
    const paragraph = revised.paragraphs[item.para - 1];
    assert.ok(paragraph !== undefined, `第 ${item.para} 段不存在`);
    assert.equal(paragraph.hasRevision, true, `第 ${item.para} 段没有留下修订`);
    assert.ok(paragraph.text.includes(item.fixed), `第 ${item.para} 段的正文里没有「${item.fixed}」`);
    assert.match(paragraph.xml, new RegExp(`<w:delText[^>]*>${item.orig}</w:delText>`), `第 ${item.para} 段的「${item.orig}」没写进修订`);
    assert.match(paragraph.xml, new RegExp(`<w:t[^>]*>${item.sugg}</w:t>`), `第 ${item.para} 段的「${item.sugg}」没写进修订`);
  }

  assert.equal(result.report.counts.failed, 0);
});

