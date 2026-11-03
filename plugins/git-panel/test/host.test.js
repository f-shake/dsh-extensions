import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  createHandlers,
  diffTargetMatches,
  findRepositories,
  httpStatusFor,
  isSafeRelative,
  parseBranchHeader,
  parseBranches,
  parseLog,
  parseNumstat,
  parseStatus,
  parseUnifiedDiff,
  readBranches,
  readCommits,
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

/**
 * 追加一个提交。
 * @param {string} directory - 仓库目录。
 * @param {string} name - 文件名。
 * @param {string} message - 提交信息。
 */
function commitFile(directory, name, message) {
  writeFileSync(path.join(directory, name), `${message}\n`);
  execFileSync("git", ["add", name], { cwd: directory, stdio: "ignore" });
  execFileSync("git", ["commit", "-qm", message], { cwd: directory, stdio: "ignore" });
}

test("parseBranches 跳过符号引用并标出当前分支", () => {
  const sha = "a".repeat(40);
  const stdout = [
    `refs/heads/main\u0000main\u0000${sha}\u0000initial\u0000Ada\u00001700000000\u0000origin/main\u0000*\u0000`,
    `refs/heads/topic\u0000topic\u0000${sha}\u0000topic work\u0000Ada\u00001700001000\u0000\u0000\u0000`,
    `refs/remotes/origin/main\u0000origin/main\u0000${sha}\u0000initial\u0000Ada\u00001700000000\u0000\u0000\u0000`,
    `refs/remotes/origin/HEAD\u0000origin/HEAD\u0000${sha}\u0000initial\u0000Ada\u00001700000000\u0000\u0000\u0000refs/remotes/origin/main`,
    "",
  ].join("\n");

  const branches = parseBranches(stdout);
  assert.equal(branches.length, 3);
  assert.deepEqual(
    branches.map((branch) => [branch.name, branch.kind, branch.current]),
    [
      ["main", "local", true],
      ["topic", "local", false],
      ["origin/main", "remote", false],
    ],
  );
  assert.equal(branches[0].shortSha, "aaaaaaa");
  assert.equal(branches[0].upstream, "origin/main");
  assert.equal(branches[2].upstream, null);
  assert.equal(branches[0].time, 1700000000);
});

test("parseLog 容忍正文换行、空正文与多父提交", () => {
  const sha = "a".repeat(40);
  const parents = `${"b".repeat(40)} ${"c".repeat(40)}`;
  const stdout = [
    `${sha}\x1fabcedef\x1fAda\x1f1700000000\x1f${parents}\x1fHEAD -> main, origin/main\x1fsubject line\x1fbody line 1\nbody line 2\x1e`,
    `${sha}\x1fabcedef\x1fAda\x1f1700000000\x1f\x1f\x1fsecond subject\x1f\x1e`,
  ].join("\n");

  const commits = parseLog(stdout);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].body, "body line 1\nbody line 2");
  assert.deepEqual(commits[0].parents, ["bbbbbbb", "ccccccc"]);
  assert.deepEqual(commits[0].refs, ["HEAD -> main", "origin/main"]);
  assert.equal(commits[0].subject, "subject line");
  assert.deepEqual(commits[1].parents, []);
  assert.deepEqual(commits[1].refs, []);
  assert.equal(commits[1].body, "");
});

test("parseLog 截断过长的正文", () => {
  const sha = "a".repeat(40);
  const stdout = `${sha}\x1fabcedef\x1fAda\x1f1700000000\x1f\x1f\x1fsubject\x1f${"x".repeat(1500)}\x1e`;
  const commits = parseLog(stdout);
  assert.equal(commits[0].bodyTruncated, true);
  assert.equal(commits[0].body.length, 1001);
});

test("readBranches 把当前分支排在首位，分离头时给出 detached", async () => {
  const directory = createRepository();
  execFileSync("git", ["branch", "topic"], { cwd: directory, stdio: "ignore" });

  const listed = await readBranches(directory);
  assert.equal(listed.ok, true);
  assert.equal(listed.branches[0].current, true);
  assert.ok(["master", "main"].includes(listed.branches[0].name));
  assert.equal(listed.current.detached, false);
  assert.equal(listed.current.name, listed.branches[0].name);

  execFileSync("git", ["checkout", "-q", "--detach", "HEAD"], { cwd: directory, stdio: "ignore" });
  const detached = await readBranches(directory);
  assert.equal(detached.ok, true);
  assert.equal(detached.current.detached, true);
  assert.equal(detached.current.name, null);
  assert.ok(detached.current.sha.length >= 7);
});

test("readBranches 对空仓库返回空列表", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "git-panel-unborn-"));
  temporaryRoots.push(directory);
  execFileSync("git", ["init", "-q"], { cwd: directory, stdio: "ignore" });
  const listed = await readBranches(directory);
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.branches, []);
  assert.equal(listed.current, null);
});

test("readCommits 分页、hasMore 与白名单", async () => {
  const directory = createRepository();
  commitFile(directory, "a.txt", "second");
  commitFile(directory, "b.txt", "third");
  const branch = (await readBranches(directory)).current.name;
  const allowed = new Set([branch]);

  const first = await readCommits(directory, branch, { allowed, limit: 2 });
  assert.equal(first.ok, true);
  assert.equal(first.commits.length, 2);
  assert.equal(first.commits[0].subject, "third");
  assert.equal(first.hasMore, true);

  const second = await readCommits(directory, branch, { allowed, limit: 2, skip: 2 });
  assert.equal(second.commits.length, 1);
  assert.equal(second.commits[0].subject, "initial");
  assert.equal(second.hasMore, false);

  const beyond = await readCommits(directory, branch, { allowed, limit: 2, skip: 50 });
  assert.deepEqual(beyond.commits, []);
  assert.equal(beyond.hasMore, false);

  const denied = await readCommits(directory, "nope", { allowed });
  assert.deepEqual(denied, { ok: false, error: "unknown-branch" });

  const head = await readCommits(directory, "HEAD", { allowed, limit: 1 });
  assert.equal(head.ok, true);
  assert.equal(head.commits.length, 1);
});

test("createHandlers 的 branches 与 commits 路由映射错误码", async () => {
  const directory = createRepository();
  const session = { header: { cwd: directory } };
  const ctx = {
    sessions: { get: (id) => (id === "session-1" ? session : undefined) },
    workingDirectory: { get: () => directory },
  };
  const { handle } = createHandlers({ ctx });
  const call = (url) =>
    new Promise((resolve) => {
      const res = {
        statusCode: 0,
        writeHead(status) {
          this.statusCode = status;
          return this;
        },
        end(text) {
          resolve({ status: this.statusCode, body: text === undefined ? null : JSON.parse(text) });
        },
      };
      handle({ method: "GET", url }, res);
    });

  const branches = await call("/git-panel/branches?session=session-1");
  assert.equal(branches.status, 200);
  assert.equal(branches.body.ok, true);
  assert.ok(Array.isArray(branches.body.branches));

  const missing = await call("/git-panel/commits?session=session-1");
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, "missing-branch");

  const invalid = await call("/git-panel/commits?session=session-1&branch=-x");
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, "invalid-branch");

  const unknown = await call("/git-panel/commits?session=session-1&branch=nope");
  assert.equal(unknown.status, 409);
  assert.equal(unknown.body.error, "unknown-branch");

  const name = (await readBranches(directory)).current.name;
  const ok = await call(`/git-panel/commits?session=session-1&branch=${encodeURIComponent(name)}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.commits.length, 1);
  assert.equal(ok.body.commits[0].subject, "initial");

  const noSession = await call("/git-panel/branches?session=missing");
  assert.equal(noSession.status, 404);
  assert.equal(noSession.body.error, "session-unavailable");
});

test("parseBranches 与 parseLog 对空输出与畸形行返回空表", () => {
  assert.deepEqual(parseBranches(""), []);
  assert.deepEqual(parseBranches("garbage\n\n"), []);
  assert.deepEqual(parseBranches("refs/heads/x\u0000x\u0000sha"), []);
  assert.deepEqual(parseLog(""), []);
  assert.deepEqual(parseLog("not-a-record"), []);
});

test("readBranches 超过 200 个分支时截断并标记", async () => {
  const directory = createRepository();
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
  const lines = [];
  for (let index = 0; index < 205; index += 1) lines.push(`create refs/heads/b${index} ${sha}`);
  execFileSync("git", ["update-ref", "--stdin"], { cwd: directory, input: `${lines.join("\n")}\n` });

  const listed = await readBranches(directory);
  assert.equal(listed.ok, true);
  assert.equal(listed.truncated, true);
  assert.equal(listed.branches.length, 200);
  assert.equal(listed.branches[0].current, true);
});

test("readCommits 把 limit 钳在 1..100", async () => {
  const directory = createRepository();
  commitFile(directory, "a.txt", "second");
  const branch = (await readBranches(directory)).current.name;
  const allowed = new Set([branch]);

  const zero = await readCommits(directory, branch, { allowed, limit: 0 });
  assert.equal(zero.commits.length, 1);
  assert.equal(zero.limit, 1);

  const huge = await readCommits(directory, branch, { allowed, limit: 100000 });
  assert.equal(huge.limit, 100);
  assert.equal(huge.commits.length, 2);
});

test("httpStatusFor 只映射实际会走到的三个错误码", () => {
  assert.equal(httpStatusFor("unknown-branch"), 409);
  assert.equal(httpStatusFor("git-timeout"), 504);
  assert.equal(httpStatusFor("git-failed"), 500);
  assert.equal(httpStatusFor("internal-error"), 500);
});

test("branches / commits 路由对非法 repo 返回 400、对非仓库返回 404", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "git-panel-route-"));
  const plain = path.join(workspace, "plain");
  mkdirSync(plain);
  temporaryRoots.push(workspace);
  const session = { header: { cwd: workspace } };
  const ctx = {
    sessions: { get: (id) => (id === "session-1" ? session : undefined) },
    workingDirectory: { get: () => workspace },
  };
  const { handle } = createHandlers({ ctx });
  const call = (url) =>
    new Promise((resolve) => {
      const res = {
        statusCode: 0,
        writeHead(status) {
          this.statusCode = status;
          return this;
        },
        end(text) {
          resolve({ status: this.statusCode, body: text === undefined ? null : JSON.parse(text) });
        },
      };
      handle({ method: "GET", url }, res);
    });

  const escaped = await call("/git-panel/branches?session=session-1&repo=..");
  assert.equal(escaped.status, 400);
  assert.equal(escaped.body.error, "invalid-repo");

  const plainRepo = await call("/git-panel/commits?session=session-1&repo=plain&branch=main");
  assert.equal(plainRepo.status, 404);
  assert.equal(plainRepo.body.error, "not-a-repository");
});
