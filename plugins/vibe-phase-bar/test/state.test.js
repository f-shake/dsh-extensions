import test from "node:test";
import assert from "node:assert/strict";
import {
  applyEnter,
  applyRequest,
  createState,
  isValidPhase,
  planConfirm,
  phaseName,
  publicState,
} from "../index.js";

const START = 1_000_000;

test("新建状态停在阶段一，没有挂起项", () => {
  const state = createState(START);
  assert.equal(state.phase, 1);
  assert.equal(state.pending, null);
  assert.deepEqual(state.skipped, []);
  assert.equal(state.precommit, false);
  assert.equal(state.authorized, false);
});

test("阶段名覆盖 1~5，越界回退为阶段N", () => {
  assert.equal(phaseName(1), "计划");
  assert.equal(phaseName(5), "提交");
  assert.equal(phaseName(6), "阶段6");
});

test("isValidPhase 只接受 1~5 的整数", () => {
  for (const value of [1, 2, 3, 4, 5]) assert.equal(isValidPhase(value), true);
  for (const value of [0, 6, -1, 2.5, "2", null, undefined]) assert.equal(isValidPhase(value), false);
});

test("enter 推进当前阶段并清掉挂起项", () => {
  let state = applyRequest(createState(START), 2, START);
  assert.equal(state.pending, 2);
  state = applyEnter(state, 2, START + 10);
  assert.equal(state.phase, 2);
  assert.equal(state.pending, null);
  assert.equal(state.version, 3);
});

test("离开阶段五时清掉预提交与授权标记，进入阶段五时保留", () => {
  let state = { ...createState(START), phase: 5, precommit: true, authorized: true, precommitAt: START };
  state = applyEnter(state, 5, START + 10);
  assert.equal(state.precommit, true);
  assert.equal(state.authorized, true);

  state = applyEnter(state, 2, START + 20);
  assert.equal(state.precommit, false);
  assert.equal(state.authorized, false);
  assert.equal(state.precommitAt, 0);
});

test("request 只挂起不推进；对不晚于当前阶段的请求不做任何事", () => {
  const base = applyEnter(createState(START), 2, START);
  const pending = applyRequest(base, 3, START + 5);
  assert.equal(pending.pending, 3);
  assert.equal(pending.phase, 2);
  assert.equal(applyRequest(base, 2, START + 5), base);
  assert.equal(applyRequest(base, 1, START + 5), base);
});

test("确认相邻阶段：发一句普通的进入消息", () => {
  const state = applyEnter(createState(START), 1, START);
  const result = planConfirm(state, 2, START + 10);
  assert.equal(result.state.phase, 2);
  assert.equal(result.state.pending, null);
  assert.equal(result.message, "确认进入阶段 2（开发）。");
  assert.deepEqual(result.state.skipped, []);
});

test("确认同一阶段（非阶段五）等于没点", () => {
  const state = applyEnter(createState(START), 2, START);
  const result = planConfirm(state, 2, START + 10);
  assert.equal(result.message, null);
  assert.equal(result.reason, "same-phase");
  assert.equal(result.state, state);
});

test("前跳记录被跳过的阶段并写进消息", () => {
  const state = applyEnter(createState(START), 2, START);
  const result = planConfirm(state, 4, START + 10);
  assert.equal(result.state.phase, 4);
  assert.deepEqual(result.state.skipped, [3]);
  assert.equal(result.message, "确认跳到阶段 4（验证），跳过阶段 3。");
});

test("直接点到阶段五：进入预提交，跳过项一并写明", () => {
  const state = applyEnter(createState(START), 2, START);
  const result = planConfirm(state, 5, START + 10);
  assert.equal(result.state.phase, 5);
  assert.equal(result.state.precommit, true);
  assert.equal(result.state.authorized, false);
  assert.deepEqual(result.state.skipped, [3, 4]);
  assert.match(result.message, /确认跳到阶段 5（提交），跳过阶段 3、4。/);
  assert.match(result.message, /进入预提交：列出计划提交的文件和提交信息，不要执行 git commit。/);
});

test("从阶段四正常进入阶段五同样先进预提交", () => {
  const state = applyEnter(createState(START), 4, START);
  const result = planConfirm(state, 5, START + 10);
  assert.equal(result.state.precommit, true);
  assert.equal(result.message, "确认进入阶段 5（提交）。进入预提交：列出计划提交的文件和提交信息，不要执行 git commit。");
});

test("预提交后的冷却期内再点一次不会授权", () => {
  let state = applyEnter(createState(START), 4, START);
  state = planConfirm(state, 5, START + 10).state;
  const result = planConfirm(state, 5, START + 10 + 1999);
  assert.equal(result.message, null);
  assert.equal(result.reason, "cooldown");
  assert.equal(result.state.authorized, false);
});

test("冷却到期后再点一次才授权，第三次点击无事发生", () => {
  let state = applyEnter(createState(START), 4, START);
  state = planConfirm(state, 5, START + 10).state;
  const authorized = planConfirm(state, 5, START + 10 + 2000);
  assert.equal(authorized.message, "授权提交：按上面的提交信息执行 git commit。");
  assert.equal(authorized.state.authorized, true);

  const again = planConfirm(authorized.state, 5, START + 10 + 4000);
  assert.equal(again.message, null);
  assert.equal(again.reason, "already-authorized");
});

test("已在阶段五但还没预提交时，第一次点击进入预提交", () => {
  const state = applyEnter(createState(START), 5, START);
  const result = planConfirm(state, 5, START + 10);
  assert.equal(result.state.precommit, true);
  assert.match(result.message, /进入预提交/);
});

test("回退清掉目标阶段之后的跳过标记", () => {
  let state = applyEnter(createState(START), 2, START);
  state = planConfirm(state, 4, START + 10).state;
  assert.deepEqual(state.skipped, [3]);
  const back = planConfirm(state, 2, START + 20);
  assert.equal(back.state.phase, 2);
  assert.equal(back.message, "回到阶段 2（开发）重新走。");
  assert.deepEqual(back.state.skipped, []);
});

test("非法阶段号不改变任何状态", () => {
  const state = applyEnter(createState(START), 2, START);
  for (const target of [0, 6, 2.5, "3", null]) {
    const result = planConfirm(state, target, START + 10);
    assert.equal(result.reason, "invalid-phase");
    assert.equal(result.state, state);
  }
});

test("publicState 不泄露内部字段", () => {
  const state = applyEnter(createState(START), 3, START);
  const view = publicState(state);
  assert.deepEqual(Object.keys(view).sort(), [
    "authorized",
    "pending",
    "phase",
    "precommit",
    "skipped",
    "version",
  ]);
  assert.equal(view.precommitAt, undefined);
  assert.equal(view.updatedAt, undefined);
});

test("version 每次真实变更都前进", () => {
  const start = createState(START);
  const entered = applyEnter(start, 2, START);
  const requested = applyRequest(entered, 3, START);
  assert.equal(entered.version, start.version + 1);
  assert.equal(requested.version, entered.version + 1);
  assert.equal(applyRequest(entered, 2, START), entered);
});
