import assert from "node:assert/strict";
import { test } from "node:test";

import { compare, diffOps, extractEdits } from "../lib/diff.js";

test("diff：单字替换给出一个编辑，位置正确", () => {
  const { edits, similarity } = compare("我睡的很晚。", "我睡得很晚。");
  assert.deepEqual(edits, [{ pos: 2, orig: "的", sugg: "得" }]);
  assert.ok(similarity > 0.8, `相似度 ${similarity} 应该还在阈值以上`);
});

test("diff：位置按码点算，前面有 emoji 也不错位", () => {
  const before = "😀我睡的很晚";
  const after = "😀我睡得很晚";
  const { edits } = compare(before, after);
  assert.deepEqual(edits, [{ pos: 3, orig: "的", sugg: "得" }]);
});

test("diff：纯删除不产生候选（缺字不是错别字）", () => {
  const { edits } = compare("我们一起去吃饭吧", "我们一起去吃吧");
  assert.deepEqual(edits, []);
});

test("diff：纯插入不产生候选", () => {
  const { edits } = compare("我们一起去吃饭吧", "我们一起去吃饭了吧");
  assert.deepEqual(edits, []);
});

test("diff：整词改写不产生单字编辑，但会拉低相似度", () => {
  const { edits, similarity } = compare("他慢慢地走过来", "他缓缓地走过来");
  assert.deepEqual(edits, []);
  assert.ok(similarity < 1);
});

test("diff：多处替换各自给出编辑，顺序按下标", () => {
  const { edits } = compare("我睡的很晚，他也睡的很晚。", "我睡得很晚，他也睡得很晚。");
  assert.deepEqual(edits, [
    { pos: 2, orig: "的", sugg: "得" },
    { pos: 9, orig: "的", sugg: "得" },
  ]);
});

test("diff：extractEdits 只认相邻的「删一字 + 加一字」", () => {
  const ops = diffOps("甲乙丙", "甲丁丙");
  assert.deepEqual(extractEdits(ops).edits, [{ pos: 1, orig: "乙", sugg: "丁" }]);
});

