import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCandidates, evaluateSample, sanitizeOutput } from "../lib/candidates.js";

const SENTENCE = { text: "我睡的很晚，他也睡的很晚。" };

test("candidates：三次都改同一处，票数为 3", () => {
  const { candidates, changedVotes } = buildCandidates(SENTENCE, [
    "我睡得很晚，他也睡的很晚。",
    "我睡得很晚，他也睡的很晚。",
    "我睡得很晚，他也睡的很晚。",
  ]);
  assert.equal(changedVotes, 3);
  assert.deepEqual(candidates, [{ pos: 2, orig: "的", sugg: "得", votes: 3 }]);
});

test("candidates：三次里只有两次改，仍然进候选", () => {
  const { candidates } = buildCandidates(SENTENCE, [
    "我睡得很晚，他也睡的很晚。",
    "我睡得很晚，他也睡的很晚。",
    "我睡的很晚，他也睡的很晚。",
  ]);
  assert.deepEqual(candidates, [{ pos: 2, orig: "的", sugg: "得", votes: 2 }]);
});

test("candidates：三次只改一次的不进候选", () => {
  const { candidates, changedVotes } = buildCandidates(SENTENCE, [
    "我睡得很晚，他也睡的很晚。",
    "我睡的很晚，他也睡的很晚。",
    "我睡的很晚，他也睡的很晚。",
  ]);
  assert.equal(changedVotes, 1);
  assert.deepEqual(candidates, []);
});

test("candidates：不同位置都进并集，各自带票数", () => {
  const { candidates } = buildCandidates(SENTENCE, [
    "我睡得很晚，他也睡的很晚。",
    "我睡得很晚，他也睡得很晚。",
    "我睡的很晚，他也睡的很晚。",
  ]);
  assert.deepEqual(candidates, [
    { pos: 2, orig: "的", sugg: "得", votes: 2 },
    { pos: 9, orig: "的", sugg: "得", votes: 1 },
  ]);
});

test("candidates：改标点不算错别字，该次采样作废", () => {
  const result = evaluateSample("我睡的很晚。", "我睡的很晚,");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "illegal-edit");
});

test("candidates：整句翻新的采样作废", () => {
  const result = evaluateSample("我睡的很晚。", "他昨天很早就上床睡觉了。");
  assert.equal(result.ok, false);
  assert.ok(["rewritten", "too-long"].includes(result.reason), `实际原因 ${result.reason}`);
});

test("candidates：空输出、超长输出都给明确原因", () => {
  assert.equal(evaluateSample("我睡的很晚。", "   ").reason, "empty");
  assert.equal(evaluateSample("我睡的很晚。", `${"我睡的很晚。".repeat(6)}`).reason, "too-long");
});

test("candidates：剥掉模型爱加的前缀、引号与代码围栏", () => {
  assert.equal(sanitizeOutput("改正后的句子：我睡得很晚。", "我睡的很晚。"), "我睡得很晚。");
  assert.equal(sanitizeOutput("“我睡得很晚。”", "我睡的很晚。"), "我睡得很晚。");
  assert.equal(sanitizeOutput("```\n我睡得很晚。\n```", "我睡的很晚。"), "我睡得很晚。");
});

test("candidates：多行输出取与原句最像的那一行", () => {
  const raw = "原句：我睡的很晚。\n改正后：我睡得很晚。\n说明：把「的」改成「得」。";
  assert.equal(sanitizeOutput(raw, "我睡的很晚。"), "我睡得很晚。");
});

test("candidates：一次采样改动超过 5 处作废（相似度还没跌破线）", () => {
  // 三十二个字里分开改六处：相似度 0.81 仍在线上，只能靠「改动处数」拦下来。
  const chars = Array.from("天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳");
  const replacement = Array.from("甲乙丙丁戊己庚辛壬癸");
  const changed = chars.slice();
  for (let index = 0; index < 6; index += 1) changed[index * 2] = replacement[index];
  const result = evaluateSample(chars.join(""), changed.join(""));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "too-many-edits");
});
