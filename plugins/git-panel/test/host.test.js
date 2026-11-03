import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  diffTargetMatches,
  findRepositories,
  isSafeRelative,
  parseBranchHeader,
  parseNumstat,
  parseStatus,
  parseUnifiedDiff,
  readDiff,
  readStatus,
  resolveInside,
} from "../index.js";

const temporaryRoots = [];

/**
 * 建一个临时仓库，写完常用配置与一个初始提交。
 * @returns {string} 仓库目录。
 */
function createRepository() {
  const directory = mkdtempSync(path.join(tmpdir(), "git-panel-test-"));
  temporaryRoots.push(directory);
  const git = (...args) => execFileSync("git", args, { cwd: directory, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "git-panel@test");
  git("config", "user.name", "git-panel");
  git("config", "core.autocrlf", "false");
  writeFileSync(path.join(directory, "tracked.txt"), "one\ntwo\n");
  writeFileSync(path.join(directory, "gone.txt"), "bye\n");
  git("add", ".");
  git("commit", "-qm", "initial");
  return directory;
}

after(() => {
  for (const directory of temporaryRoots) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Windows 上偶发占用时留给系统清理。
    }
  }
});

test("parseBranchHeader 解析普通、上游、分离头与空仓库", () => {
  assert.deepEqual(parseBranchHeader("## master\0"), {
    name: "master",
    detached: false,
    empty: false,
    upstream: "",
    ahead: 0,
    behind: 0,
  });
  assert.deepEqual(parseBranchHeader("## main...origin/main [ahead 2, behind 1]\0"), {
    name: "main",
    detached: false,
    empty: false,
    upstream: "origin/main",
    ahead: 2,
    behind: 1,
  });
  assert.deepEqual(parseBranchHeader("## HEAD (no branch)\0"), {
    name: "",
    detached: true,
    empty: false,
    upstream: "",
    ahead: 0,
    behind: 0,
  });
  assert.deepEqual(parseBranchHeader("## No commits yet on main\0"), {
    name: "main",
    detached: false,
    empty: true,
    upstream: "",
    ahead: 0,
    behind: 0,
  });
});

test("parseStatus 忽略 --branch 的头记录", () => {
  const files = parseStatus("## main\0 M one.txt\0");
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "one.txt");
});

test("diffTargetMatches 只接受状态里存在且侧别匹配的路径", () => {
  const entries = parseStatus(
    "M  staged.txt\0 M worktree.txt\0MM both.txt\0R  renamed.txt\0old.txt\0?? fresh.txt\0UU conflict.txt\0",
  );
  assert.equal(diffTargetMatches(entries, "staged.txt", { staged: true }), true);
  assert.equal(diffTargetMatches(entries, "staged.txt", { staged: false }), false);
  assert.equal(diffTargetMatches(entries, "worktree.txt", { staged: true }), false);
  assert.equal(diffTargetMatches(entries, "worktree.txt", { staged: false }), true);
  assert.equal(diffTargetMatches(entries, "both.txt", { staged: true }), true);
  assert.equal(diffTargetMatches(entries, "both.txt", { staged: false }), true);
  assert.equal(diffTargetMatches(entries, "renamed.txt", { staged: true, origPath: "old.txt" }), true);
  assert.equal(diffTargetMatches(entries, "renamed.txt", { staged: true, origPath: "other.txt" }), false);
  assert.equal(diffTargetMatches(entries, "fresh.txt", { untracked: true }), true);
  assert.equal(diffTargetMatches(entries, "fresh.txt", { staged: true }), false);
  assert.equal(diffTargetMatches(entries, "conflict.txt", { staged: false }), true);
  assert.equal(diffTargetMatches(entries, ".git/config", { untracked: true }), false);
});

test("isSafeRelative 拒绝绝对路径、盘符路径与上跳", () => {
  assert.equal(isSafeRelative("src/a.ts"), true);
  assert.equal(isSafeRelative("a b/c.txt"), true);
  assert.equal(isSafeRelative("../a"), false);
  assert.equal(isSafeRelative("a/../b"), false);
  assert.equal(isSafeRelative("C:/a"), false);
  assert.equal(isSafeRelative("/a"), false);
  assert.equal(isSafeRelative("a\0b"), false);
  assert.equal(isSafeRelative(""), false);
});

test("resolveInside 不允许逃出仓库", () => {
  const root = path.resolve(tmpdir(), "git-panel-root");
  assert.equal(resolveInside(root, "a/b.txt"), path.resolve(root, "a/b.txt"));
  assert.equal(resolveInside(root, "../b.txt"), undefined);
});

test("parseStatus 解析修改、重命名、未跟踪与冲突", () => {
  const files = parseStatus(
    "M  one.txt\0R  renamed.txt\0old.txt\0?? new.txt\0UU conflict.txt\0",
  );
  assert.deepEqual(files[0], {
    path: "one.txt",
    origPath: undefined,
    x: "M",
    y: " ",
    untracked: false,
    conflict: false,
  });
  assert.equal(files[1].path, "renamed.txt");
  assert.equal(files[1].origPath, "old.txt");
  assert.equal(files[2].untracked, true);
  assert.equal(files[3].conflict, true);
});

test("parseNumstat 解析普通、二进制与重命名记录", () => {
  const stats = parseNumstat("2\t1\ta.txt\0-\t-\tbin.dat\0" + "0\t0\t\0old.txt\0new.txt\0");
  assert.deepEqual(stats.get("a.txt"), { additions: 2, deletions: 1, binary: false });
  assert.deepEqual(stats.get("bin.dat"), { additions: 0, deletions: 0, binary: true });
  assert.deepEqual(stats.get("new.txt"), { additions: 0, deletions: 0, binary: false });
});

test("parseUnifiedDiff 生成行号并跳过无换行标记", () => {
  const parsed = parseUnifiedDiff(
    [
      "diff --git a/a.txt b/a.txt",
      "index 111..222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,3 +1,4 @@ heading",
      " one",
      "-two",
      "+two changed",
      "+three",
      "\\ No newline at end of file",
      "",
    ].join("\n"),
  );
  assert.equal(parsed.hunks.length, 1);
  assert.equal(parsed.additions, 2);
  assert.equal(parsed.deletions, 1);
  const lines = parsed.hunks[0].lines;
  assert.deepEqual(lines[0], { type: " ", text: "one", oldNo: 1, newNo: 1 });
  assert.deepEqual(lines[1], { type: "-", text: "two", oldNo: 2, newNo: null });
  assert.deepEqual(lines[2], { type: "+", text: "two changed", oldNo: null, newNo: 2 });
  assert.deepEqual(lines[3], { type: "+", text: "three", oldNo: null, newNo: 3 });
});

test("parseUnifiedDiff 标记二进制与冲突", () => {
  const binary = parseUnifiedDiff("Binary files a/x and b/x differ");
  assert.equal(binary.binary, true);
  assert.equal(binary.hunks.length, 0);
  const conflict = parseUnifiedDiff("* Unmerged path a.txt");
  assert.equal(conflict.conflict, true);
});

test("parseUnifiedDiff 检测到第二段文件头时标记 multiFile", () => {
  const parsed = parseUnifiedDiff(
    [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/b.txt b/b.txt",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n"),
  );
  assert.equal(parsed.multiFile, true);
  assert.equal(parsed.hunks.length, 0);
});

test("readStatus 对空仓库返回 empty 而不是 detached", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "git-panel-empty-"));
  temporaryRoots.push(directory);
  execFileSync("git", ["init", "-q"], { cwd: directory, stdio: "ignore" });
  const status = await readStatus(directory);
  assert.equal(status.ok, true);
  assert.equal(status.isRepo, true);
  assert.equal(status.branch.empty, true);
  assert.equal(status.branch.detached, false);
  assert.ok(["master", "main"].includes(status.branch.name));
  assert.deepEqual(status.files, []);
});

test("resolveInside 拒绝指向仓库外的符号链接", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "git-panel-link-"));
  const outside = mkdtempSync(path.join(tmpdir(), "git-panel-outside-"));
  temporaryRoots.push(root, outside);
  writeFileSync(path.join(outside, "secret.txt"), "secret\n");
  try {
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"), "file");
  } catch {
    t.skip("当前 Windows 会话不允许创建符号链接");
    return;
  }
  assert.equal(resolveInside(root, "link.txt"), undefined);
});

test("readStatus 汇总暂存、未暂存与未跟踪文件", async () => {
  const directory = createRepository();
  const tracked = path.join(directory, "tracked.txt");
  writeFileSync(tracked, "one\ntwo\nthree\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: directory, stdio: "ignore" });
  writeFileSync(tracked, "one\ntwo\nthree\nfour\n");
  writeFileSync(path.join(directory, "fresh.txt"), "alpha\nbeta\n");
  rmSync(path.join(directory, "gone.txt"));

  const status = await readStatus(directory);
  assert.equal(status.ok, true);
  assert.equal(status.isRepo, true);
  assert.equal(status.branch.detached, false);
  assert.ok(["master", "main"].includes(status.branch.name));
  assert.ok(status.files.length >= 3);

  const trackedFile = status.files.find((file) => file.path === "tracked.txt");
  assert.deepEqual(trackedFile.staged, { additions: 1, deletions: 0, binary: false });
  assert.deepEqual(trackedFile.unstaged, { additions: 1, deletions: 0, binary: false });

  const freshFile = status.files.find((file) => file.path === "fresh.txt");
  assert.equal(freshFile.untracked, true);
  assert.deepEqual(freshFile.unstaged, { additions: 2, deletions: 0, binary: false });

  const goneFile = status.files.find((file) => file.path === "gone.txt");
  assert.equal(goneFile.y, "D");
  assert.deepEqual(goneFile.unstaged, { additions: 0, deletions: 1, binary: false });
});

test("readStatus 对非仓库返回 isRepo=false", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "git-panel-plain-"));
  temporaryRoots.push(directory);
  const status = await readStatus(directory);
  assert.deepEqual(status, { ok: true, isRepo: false, cwd: directory });
});

test("readDiff 返回带行号的 hunk，未跟踪文件走新文件差异", async () => {
  const directory = createRepository();
  const tracked = path.join(directory, "tracked.txt");
  writeFileSync(tracked, "one\ntwo\nthree\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: directory, stdio: "ignore" });
  writeFileSync(path.join(directory, "fresh.txt"), "alpha\nbeta\n");

  const staged = await readDiff(directory, "tracked.txt", { staged: true });
  assert.equal(staged.ok, true);
  assert.equal(staged.hunks.length, 1);
  assert.equal(staged.hunks[0].lines.at(-1).type, "+");
  assert.equal(staged.hunks[0].lines.at(-1).text, "three");

  const untracked = await readDiff(directory, "fresh.txt", { untracked: true });
  assert.equal(untracked.ok, true);
  assert.equal(untracked.hunks.length, 1);
  assert.deepEqual(
    untracked.hunks[0].lines.map((line) => line.text),
    ["alpha", "beta"],
  );

  const missing = await readDiff(directory, "nope.txt", { untracked: true });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "not-found");
});

test("readStatus 支持指定会话目录下的子仓库", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "git-panel-workspace-"));
  temporaryRoots.push(workspace);
  const alpha = path.join(workspace, "alpha");
  const nested = path.join(workspace, "alpha", "nested");
  const beta = path.join(workspace, "beta");
  const groupChild = path.join(workspace, "group", "child");
  for (const directory of [alpha, nested, beta, groupChild]) {
    mkdirSync(directory, { recursive: true });
  }
  for (const directory of [alpha, nested, beta, groupChild]) {
    execFileSync("git", ["init", "-q"], { cwd: directory, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "git-panel@test"], { cwd: directory, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "git-panel"], { cwd: directory, stdio: "ignore" });
    execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: directory, stdio: "ignore" });
    writeFileSync(path.join(directory, "file.txt"), "one\n");
    execFileSync("git", ["add", "."], { cwd: directory, stdio: "ignore" });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: directory, stdio: "ignore" });
  }

  const found = findRepositories(workspace);
  assert.deepEqual(
    found.repos.map((repo) => repo.path),
    ["alpha", "beta", "group/child"],
  );
  assert.equal(found.truncated, false);

  const outer = await readStatus(workspace);
  assert.equal(outer.isRepo, false);

  const selected = await readStatus(workspace, "group/child");
  assert.equal(selected.ok, true);
  assert.equal(selected.isRepo, true);
  assert.equal(selected.root, groupChild);
  assert.equal(selected.branch.detached, false);

  const missing = await readStatus(workspace, "missing");
  assert.deepEqual(missing, { ok: false, error: "not-a-repository" });
  const escape = await readStatus(workspace, "../alpha");
  assert.deepEqual(escape, { ok: false, error: "invalid-repo" });
});

test("readDiff 拒绝仓库外的路径", async () => {
  const directory = createRepository();
  const result = await readDiff(directory, "../outside.txt", { untracked: true });
  assert.deepEqual(result, { ok: false, error: "invalid-path" });
});

test("readDiff 带 origPath 时按重命名比较两侧", async () => {
  const directory = createRepository();
  const to = path.join(directory, "renamed.txt");
  execFileSync("git", ["mv", "tracked.txt", "renamed.txt"], { cwd: directory, stdio: "ignore" });
  writeFileSync(to, "one\ntwo\nthree\n");
  execFileSync("git", ["add", "-A"], { cwd: directory, stdio: "ignore" });

  const renamed = await readDiff(directory, "renamed.txt", {
    staged: true,
    origPath: "tracked.txt",
  });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.hunks.length, 1);
  assert.equal(renamed.additions, 1);
  assert.equal(renamed.hunks[0].lines.at(-1).text, "three");
  assert.equal(renamed.hunks[0].lines.at(-1).type, "+");

  // 没有 origPath 时 git 把新路径整个当成新文件。
  const withoutOrig = await readDiff(directory, "renamed.txt", { staged: true });
  assert.equal(withoutOrig.ok, true);
  assert.equal(withoutOrig.additions, 3);
});
