/**
 * 宿主半边：git-panel 的状态与差异接口。
 *
 * 为什么不用 Remote 命名空间：客户端插件之间互相 import 类型要走 typert 注册，
 * 而这里只需要两个只读的 HTTP 接口；vibe-phase-bar 已经证明 `webServer.register`
 * 的 prefix 路由足够，且不随 Host 版本改变协议。
 *
 * 为什么不缓存：`git status` 的代价取决于仓库大小，缓存会让用户在看到刷新按钮
 * 之后仍读到旧列表；轮询由客户端控制，这里保持无状态，每次请求都是新快照。
 */

import { execFile } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const name = "git-panel";
/** 会话服务提供工作目录；没有它时插件不启动（Web 组合里总是存在）。 */
export const inject = ["sessions", "workingDirectory"];

const ROUTE_PREFIX = "/git-panel";
const GIT_TIMEOUT_MS = 20_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
/** 单次状态最多列出的文件数；超过的部分只计入 total。 */
const MAX_FILES = 1000;
/** 未跟踪文件的行数最多为多少个文件统计——读文件比 `git status` 贵得多。 */
const MAX_UNTRACKED_COUNTED = 20;
const MAX_UNTRACKED_BYTES = 256 * 1024;
/** 单次差异最多送回客户端的字符数。 */
const MAX_PATCH_CHARS = 2 * 1024 * 1024;
/** 单次差异最多送回的 diff 行数。 */
const MAX_DIFF_LINES = 4000;
/** 状态条目缓存的有效期：差异请求复用它来确认文件仍在改动列表里。 */
const STATUS_CACHE_MS = 5_000;

/** 以仓库根为键的最近一次 `git status` 条目。 */
const statusEntryCache = new Map();

/** 工作树/索引冲突的 XY 组合。 */
const CONFLICT_PAIRS = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

/**
 * 判断一个路径是否是存在的目录。
 * @param {unknown} value - 待检查的路径。
 * @returns {boolean} 是否为可用目录。
 */
function isDirectory(value) {
  if (typeof value !== "string" || value === "") return false;
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 判断目录本身是不是一个 Git 仓库。
 *
 * 用 `.git` 的存在性判断而不是跑 git：扫描候选仓库时会有几十上百个目录，
 * 每个都起一个进程不可接受。`.git` 既可能是目录（普通仓库）也可能是文件（worktree）。
 * @param {string} directory - 目录。
 * @returns {boolean} 是否为仓库根。
 */
export function isGitRepository(directory) {
  try {
    const stat = statSync(path.join(directory, ".git"));
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

/**
 * 在会话目录下找可以直接打开的 Git 仓库。
 *
 * 只下探两层：`D:\Programming` 这类工作区通常是「一级项目 + 仓库内再分子项目」
 * （如 `xmzhyp/backend`），再深就更多是依赖目录而不是用户想看的仓库。遇到仓库
 * 本身就不再往下走，避免把子模块当成并列候选。跳过 `node_modules` 与隐藏目录，
 * 并限制走访的目录总数，防止在大目录上卡住。
 * @param {string} cwd - 会话工作目录。
 * @param {{maxDepth?: number, limit?: number, maxVisited?: number}} [options] - 扫描上限。
 * @returns {{repos: Array<{path: string, name: string}>, truncated: boolean}} 候选仓库。
 */
export function findRepositories(cwd, options = {}) {
  const maxDepth = options.maxDepth ?? 2;
  const limit = options.limit ?? 200;
  const maxVisited = options.maxVisited ?? 2000;
  const repos = [];
  let truncated = false;
  let visited = 0;
  const queue = [{ directory: cwd, depth: 0 }];
  /** 提前返回（达到上限）与正常结束共用同一套排序。 */
  const finish = (isTruncated) => {
    repos.sort((left, right) => left.path.localeCompare(right.path));
    return { repos, truncated: isTruncated };
  };

  while (queue.length > 0) {
    const { directory, depth } = queue.shift();
    if (depth >= maxDepth) continue;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".")) continue;
      visited += 1;
      if (visited > maxVisited) {
        truncated = true;
        return finish(true);
      }
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(cwd, absolute).split(path.sep).join("/");
      if (isGitRepository(absolute)) {
        repos.push({ path: relative, name: entry.name });
        if (repos.length >= limit) return finish(true);
        continue;
      }
      if (depth + 1 < maxDepth) queue.push({ directory: absolute, depth: depth + 1 });
    }
  }

  return finish(truncated);
}

/**
 * 路径是否是相对于仓库根的安全相对路径。
 *
 * 拒绝绝对路径、Windows 盘符路径、`..` 与空段，避免把接口变成任意文件读取。
 * @param {unknown} value - 请求里的 path。
 * @returns {boolean} 是否可接受。
 */
export function isSafeRelative(value) {
  if (typeof value !== "string" || value === "" || value.includes("\0")) return false;
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  const segments = value.split(/[\\/]/u);
  return segments.every((segment) => segment !== "" && segment !== "..");
}

/**
 * 把仓库相对路径解析成绝对路径，并确认它仍在仓库内。
 * @param {string} root - 仓库根。
 * @param {string} relPath - 仓库相对路径。
 * @returns {string | undefined} 绝对路径；越界或非法时 undefined。
 */
export function resolveInside(root, relPath) {
  if (!isSafeRelative(relPath)) return undefined;
  const base = path.resolve(root);
  const resolved = path.resolve(base, relPath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return undefined;
  // 词法校验挡不住仓库内指向仓库外的符号链接；已存在的路径再用 realpath 确认一次。
  // 已删除或正在创建的目标 realpath 会失败，此时沿用词法结果（git 的 pathspec 仍在仓库内）。
  try {
    const realBase = realpathSync.native(base);
    const realResolved = realpathSync.native(resolved);
    if (realResolved !== realBase && !realResolved.startsWith(realBase + path.sep)) return undefined;
  } catch {
    // 目标不存在：保留词法校验的结果。
  }
  return resolved;
}

/**
 * 取一条错误文本的第一行，截短后放进响应。
 * @param {string} text - stderr 或异常信息。
 * @returns {string} 单行摘要。
 */
function firstLine(text) {
  const line = String(text ?? "")
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .find((item) => item !== "");
  if (line === undefined) return "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * 跑一条 git 命令。
 *
 * 所有调用都带 `-C <目录>`，不依赖进程 cwd；`GIT_OPTIONAL_LOCKS=0` 让只读命令
 * 不去抢索引锁，避免和用户自己的 git 操作互相等待。
 * @param {string} directory - 命令运行目录（通常是仓库根）。
 * @param {string[]} args - 不含 `git` 本身与 `-C` 的参数。
 * @returns {Promise<{ok: boolean, code: number | null, stdout: string, stderr: string, timeout: boolean, spawn: boolean}>} 结果。
 */
async function runGit(directory, args) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", directory, "-c", "core.quotepath=false", ...args],
      {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        windowsHide: true,
        encoding: "utf8",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      },
    );
    return { ok: true, code: 0, stdout, stderr: "", timeout: false, spawn: false };
  } catch (error) {
    const code = typeof error?.code === "number" ? error.code : null;
    return {
      ok: false,
      code,
      stdout: typeof error?.stdout === "string" ? error.stdout : "",
      stderr: typeof error?.stderr === "string" ? error.stderr : String(error?.message ?? ""),
      timeout: Boolean(error?.killed) || /timed?\s*out/iu.test(String(error?.message ?? "")),
      spawn: typeof error?.code === "string",
    };
  }
}

/**
 * 从工作目录向上找仓库根。
 * @param {string} cwd - 会话工作目录。
 * @returns {Promise<{isRepo: false} | {isRepo: true, root: string}>} 仓库信息。
 */
export async function discoverRepository(cwd) {
  const result = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!result.ok) return { isRepo: false };
  const root = path.resolve(result.stdout.trim());
  if (!isDirectory(root)) return { isRepo: false };
  return { isRepo: true, root };
}

/**
 * 解析 `git status --porcelain=v1 -z`。
 *
 * 每条记录以 NUL 结束；重命名/复制记录本身携带新路径，紧跟的下一段是旧路径。
 * @param {string} stdout - 命令输出。
 * @returns {Array<{path: string, origPath?: string, x: string, y: string, untracked: boolean, conflict: boolean}>} 文件列表。
 */
export function parseStatus(stdout) {
  const fields = String(stdout ?? "").split("\0");
  const files = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    // `--branch` 会在最前面加一条 `## ...` 头；它不是文件记录。
    if (field.startsWith("## ")) continue;
    // 最短的合法记录是 `XY p`。
    if (field.length < 4 || field[2] !== " ") continue;
    const x = field[0];
    const y = field[1];
    const filePath = field.slice(3);
    let origPath;
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const next = fields[index + 1];
      if (typeof next === "string" && next !== "") {
        origPath = next;
        index += 1;
      }
    }
    files.push({
      path: filePath,
      origPath,
      x,
      y,
      untracked: x === "?" && y === "?",
      conflict: CONFLICT_PAIRS.has(`${x}${y}`),
    });
  }
  return files;
}

/**
 * 解析 `git status --porcelain=v1 -z --branch` 的 `## ...` 头。
 *
 * 形如 `## master`、`## master...origin/master [ahead 1, behind 2]`、
 * `## HEAD (no branch)`、`## No commits yet on master`。把分支、上游、领先/落后
 * 一起取出来，就不必再单独跑 rev-parse 与 rev-list。
 * @param {string} stdout - 命令输出。
 * @returns {{name: string, detached: boolean, empty: boolean, upstream: string, ahead: number, behind: number}} 分支信息。
 */
export function parseBranchHeader(stdout) {
  const header = String(stdout ?? "")
    .split("\0")
    .find((field) => field.startsWith("## "));
  const result = { name: "", detached: false, empty: false, upstream: "", ahead: 0, behind: 0 };
  if (header === undefined) return result;
  const body = header.slice(3).trim();

  const empty = /^No commits yet on (.+)$/u.exec(body);
  if (empty !== null) {
    result.name = empty[1];
    result.empty = true;
    return result;
  }

  if (body === "HEAD (no branch)") {
    result.detached = true;
    return result;
  }

  const match = /^([^\s]+?)(?:\.\.\.([^\s\[]+))?(?:\s+\[([^\]]+)\])?$/u.exec(body);
  if (match === null) {
    result.name = body;
    return result;
  }
  result.name = match[1];
  if (match[2] !== undefined) result.upstream = match[2];
  const counts = match[3];
  if (counts !== undefined) {
    const ahead = /ahead (\d+)/u.exec(counts);
    const behind = /behind (\d+)/u.exec(counts);
    result.ahead = ahead === null ? 0 : Number(ahead[1]);
    result.behind = behind === null ? 0 : Number(behind[1]);
  }
  return result;
}

/**
 * 解析 `git diff [--cached] --numstat -z`。
 *
 * 普通记录是 `add\tdel\tpath`；重命名记录的 path 段为空，后面紧跟旧路径与新路径。
 * 二进制文件的两列都是 `-`。
 * @param {string} stdout - 命令输出。
 * @returns {Map<string, {additions: number, deletions: number, binary: boolean}>} 以新路径为键的统计。
 */
export function parseNumstat(stdout) {
  const fields = String(stdout ?? "").split("\0");
  const stats = new Map();
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === "") continue;
    const firstTab = field.indexOf("\t");
    const secondTab = field.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const addRaw = field.slice(0, firstTab);
    const delRaw = field.slice(firstTab + 1, secondTab);
    let filePath = field.slice(secondTab + 1);
    if (filePath === "") {
      const from = fields[index + 1];
      const to = fields[index + 2];
      if (typeof from !== "string" || typeof to !== "string") continue;
      index += 2;
      filePath = to;
    }
    const binary = addRaw === "-" || delRaw === "-";
    stats.set(filePath, {
      additions: binary ? 0 : Number(addRaw) || 0,
      deletions: binary ? 0 : Number(delRaw) || 0,
      binary,
    });
  }
  return stats;
}

/**
 * 解析 unified diff 为逐 hunk 的行模型。
 *
 * 只保留 hunk 内的行；`\ No newline at end of file` 与文件头都跳过。超过行数上限
 * 时截断并标记，避免把几万行文件塞进 Sidebar。
 * @param {string} text - diff 原文。
 * @param {number} [limit] - 最多保留的 diff 行数。
 * @returns {{hunks: object[], binary: boolean, conflict: boolean, truncated: boolean, additions: number, deletions: number}} 解析结果。
 */
export function parseUnifiedDiff(text, limit = MAX_DIFF_LINES) {
  const hunks = [];
  let binary = false;
  let conflict = false;
  let truncated = false;
  let multiFile = false;
  let sections = 0;
  let current = null;
  let oldNo = 0;
  let newNo = 0;
  let drawn = 0;
  let additions = 0;
  let deletions = 0;

  for (const line of String(text ?? "").split(/\r?\n/u)) {
    if (drawn >= limit) {
      truncated = true;
      break;
    }
    if (line.startsWith("diff --git ")) {
      sections += 1;
      // 一次请求同时带旧路径与新路径时，git 可能输出两段；把两段拼成一份会把
      // 第二段的文件头当成删除/新增行，行号与计数都会错。标记为不支持并丢弃内容。
      if (sections > 1) {
        multiFile = true;
        break;
      }
      current = null;
      continue;
    }
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      binary = true;
      continue;
    }
    if (line.startsWith("* Unmerged path")) {
      conflict = true;
      continue;
    }
    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/u.exec(line);
      if (match === null) {
        current = null;
        continue;
      }
      current = {
        header: line,
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      };
      oldNo = current.oldStart;
      newNo = current.newStart;
      hunks.push(current);
      continue;
    }
    if (current === null || line === "") continue;
    if (line.startsWith("\\")) continue;
    const sign = line[0];
    if (sign === "+") {
      current.lines.push({ type: "+", text: line.slice(1), oldNo: null, newNo });
      newNo += 1;
      additions += 1;
      drawn += 1;
    } else if (sign === "-") {
      current.lines.push({ type: "-", text: line.slice(1), oldNo, newNo: null });
      oldNo += 1;
      deletions += 1;
      drawn += 1;
    } else if (sign === " ") {
      current.lines.push({ type: " ", text: line.slice(1), oldNo, newNo });
      oldNo += 1;
      newNo += 1;
      drawn += 1;
    }
  }

  if (multiFile) {
    return {
      hunks: [],
      binary,
      conflict,
      truncated,
      multiFile: true,
      additions: 0,
      deletions: 0,
    };
  }

  return { hunks, binary, conflict, truncated, multiFile: false, additions, deletions };
}

/**
 * 统计一个未跟踪文件的行数。
 *
 * 只服务列表上的 +N 提示：文件过大、不是常规文件或不可读时返回 null，让客户端
 * 只显示「未跟踪」。二进制按 NUL 字节识别，与 git 的启发式保持一致。
 * @param {string} root - 仓库根。
 * @param {string} relPath - 仓库相对路径。
 * @returns {{additions: number, deletions: number, binary: boolean} | null} 统计结果。
 */
function countUntrackedFile(root, relPath) {
  const absolute = resolveInside(root, relPath);
  if (absolute === undefined) return null;
  try {
    const stat = statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_UNTRACKED_BYTES) return null;
    // 用 readFileSync 而不是 stat 后再定长读：文件在两次调用之间缩短时，
    // 定长缓冲区的尾部零字节会被误判成二进制内容。
    const buffer = readFileSync(absolute);
    if (buffer.length > MAX_UNTRACKED_BYTES) return null;
    if (buffer.includes(0)) return { additions: 0, deletions: 0, binary: true };
    let lines = 0;
    for (const byte of buffer) if (byte === 10) lines += 1;
    if (buffer.length > 0 && buffer[buffer.length - 1] !== 10) lines += 1;
    return { additions: lines, deletions: 0, binary: false };
  } catch {
    return null;
  }
}

/**
 * 读取一个目录（或其中指定的子仓库）的当前 Git 状态。
 * @param {string} cwd - 会话工作目录。
 * @param {string} [repo] - 相对会话目录的仓库路径；省略时从 cwd 向上找所在仓库。
 * @returns {Promise<object>} 状态快照。
 */
export async function readStatus(cwd, repo) {
  const target = repo === undefined ? cwd : resolveInside(cwd, repo);
  if (target === undefined) return { ok: false, error: "invalid-repo" };
  if (repo !== undefined && !isGitRepository(target)) {
    return { ok: false, error: "not-a-repository" };
  }
  const discovered = await discoverRepository(target);
  if (!discovered.isRepo) {
    // 指定了子仓库却在这里找不到 .git，说明用户的选择已经失效；不退回扫描，
    // 让客户端清掉它并重新挑。
    if (repo !== undefined) return { ok: false, error: "not-a-repository" };
    return { ok: true, isRepo: false, cwd };
  }

  const root = repo === undefined ? discovered.root : target;
  const [porcelain, stagedNumstat, workNumstat] = await Promise.all([
    // --branch 把分支、上游、ahead/behind 一起放进同一条输出，省掉 4 个单独的 git 进程。
    runGit(root, ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"]),
    runGit(root, ["diff", "--cached", "--numstat", "-z", "--no-color", "--no-ext-diff"]),
    runGit(root, ["diff", "--numstat", "-z", "--no-color", "--no-ext-diff"]),
  ]);

  if (!porcelain.ok) {
    return {
      ok: false,
      error: porcelain.timeout ? "git-timeout" : "git-failed",
      detail: firstLine(porcelain.stderr),
    };
  }

  const branch = parseBranchHeader(porcelain.stdout);
  let sha = "";
  if (branch.detached) {
    const short = await runGit(root, ["rev-parse", "--short", "HEAD"]);
    if (short.ok) sha = short.stdout.trim();
  }
  if (branch.detached && sha === "") branch.empty = true;

  const entries = parseStatus(porcelain.stdout);
  statusEntryCache.set(root, { at: Date.now(), entries });
  const stagedStats = parseNumstat(stagedNumstat.stdout);
  const workStats = parseNumstat(workNumstat.stdout);
  let untrackedCounted = 0;

  const files = entries.slice(0, MAX_FILES).map((entry) => {
    const staged =
      !entry.untracked && entry.x !== " " && entry.x !== "."
        ? (stagedStats.get(entry.path) ?? { additions: 0, deletions: 0, binary: false })
        : null;
    let unstaged = null;
    if (entry.untracked) {
      if (untrackedCounted < MAX_UNTRACKED_COUNTED) {
        untrackedCounted += 1;
        unstaged = countUntrackedFile(root, entry.path);
      }
    } else if (entry.y !== " " && entry.y !== ".") {
      unstaged = workStats.get(entry.path) ?? { additions: 0, deletions: 0, binary: false };
    }
    return {
      path: entry.path,
      origPath: entry.origPath,
      x: entry.x,
      y: entry.y,
      untracked: entry.untracked,
      conflict: entry.conflict,
      staged,
      unstaged,
    };
  });

  return {
    ok: true,
    isRepo: true,
    cwd,
    root,
    repo: path.basename(root),
    branch: {
      name: branch.name,
      detached: branch.detached,
      empty: branch.empty,
      sha,
      upstream: branch.upstream,
      ahead: branch.ahead,
      behind: branch.behind,
    },
    total: entries.length,
    truncated: entries.length > files.length,
    files,
  };
}

/**
 * 读取一个仓库当前的改动条目，短时缓存。
 *
 * `/diff` 只接受这里列出的路径，避免把接口变成仓库内任意文件读取（例如
 * `.git/config` 或未列入改动的构建产物）。缓存同时让“刚看过状态再点文件”这一步
 * 不再重复起一个 `git status`。
 * @param {string} root - 仓库根。
 * @returns {Promise<object[] | undefined>} 条目；git 失败时 undefined。
 */
async function statusEntriesFor(root) {
  const cached = statusEntryCache.get(root);
  if (cached !== undefined && Date.now() - cached.at < STATUS_CACHE_MS) return cached.entries;
  const result = await runGit(root, ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"]);
  if (!result.ok) return undefined;
  const entries = parseStatus(result.stdout);
  statusEntryCache.set(root, { at: Date.now(), entries });
  return entries;
}

/**
 * 请求的差异目标是否仍在状态列表里，且与所请求的一侧匹配。
 * @param {object[]} entries - `parseStatus` 的结果。
 * @param {string} filePath - 请求的仓库相对路径。
 * @param {{staged?: boolean, untracked?: boolean, origPath?: string}} [options] - 请求的一侧。
 * @returns {boolean} 是否允许读取该差异。
 */
export function diffTargetMatches(entries, filePath, options = {}) {
  const entry = entries.find((item) => item.path === filePath);
  if (entry === undefined) return false;
  if (options.origPath !== undefined && entry.origPath !== options.origPath) return false;
  if (entry.untracked) return options.untracked === true;
  if (options.untracked === true) return false;
  if (entry.conflict) return true;
  if (options.staged === true) return entry.x !== " " && entry.x !== ".";
  return entry.y !== " " && entry.y !== ".";
}

/**
 * 读取一个文件的差异。
 * @param {string} root - 仓库根。
 * @param {string} relPath - 仓库相对路径。
 * @param {{staged?: boolean, untracked?: boolean}} [options] - 取索引差异还是工作树差异。
 * @returns {Promise<object>} 差异快照。
 */
export async function readDiff(root, relPath, options = {}) {
  const staged = options.staged === true;
  const untracked = options.untracked === true;
  const origPath =
    typeof options.origPath === "string" && isSafeRelative(options.origPath)
      ? options.origPath
      : undefined;
  const absolute = resolveInside(root, relPath);
  if (absolute === undefined) return { ok: false, error: "invalid-path" };

  if (untracked) {
    try {
      const stat = statSync(absolute);
      if (!stat.isFile()) return { ok: false, error: "invalid-path" };
      if (stat.size > MAX_PATCH_CHARS) {
        return {
          ok: true,
          path: relPath,
          staged: false,
          untracked: true,
          binary: false,
          conflict: false,
          oversized: true,
          truncated: false,
          hunks: [],
          additions: 0,
          deletions: 0,
        };
      }
    } catch {
      return { ok: false, error: "not-found" };
    }
  }

  // `--no-index` 在发现差异时退出码是 1，这不算失败；其余失败才上报。
  const args = untracked
    ? ["diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", `./${relPath}`]
    : [
        "diff",
        ...(staged ? ["--cached"] : []),
        "--no-color",
        "--no-ext-diff",
        "-U3",
        "--",
        // 只给新路径时 git 会把重命名当成新文件；带上旧路径才看得到 rename 差异。
        ...(origPath === undefined ? [] : [origPath]),
        relPath,
      ];
  const result = await runGit(root, args);
  if (!result.ok && !(untracked && result.code === 1)) {
    return {
      ok: false,
      error: result.timeout ? "git-timeout" : "git-failed",
      detail: firstLine(result.stderr),
    };
  }

  let text = result.stdout;
  let capped = false;
  if (text.length > MAX_PATCH_CHARS) {
    text = text.slice(0, MAX_PATCH_CHARS);
    capped = true;
  }
  const parsed = parseUnifiedDiff(text);
  return {
    ok: true,
    path: relPath,
    staged,
    untracked,
    oversized: false,
    ...parsed,
    truncated: capped || parsed.truncated,
  };
}

/**
 * 解析请求 URL。
 * @param {string | undefined} raw - req.url。
 * @returns {URL | undefined} 解析结果。
 */
function parseUrl(raw) {
  try {
    return new URL(raw ?? "/", "http://localhost");
  } catch {
    return undefined;
  }
}

/**
 * 写 JSON 响应。
 * @param {object} res - ServerResponse。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} payload - 响应体。
 */
function sendJson(res, status, payload) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(payload));
}

/**
 * 写错误响应。
 * @param {object} res - ServerResponse。
 * @param {number} status - HTTP 状态码。
 * @param {string} error - 稳定错误码。
 * @param {string} [detail] - 排查用文本。
 */
function sendError(res, status, error, detail) {
  sendJson(res, status, detail === undefined ? { ok: false, error } : { ok: false, error, detail });
}

/**
 * 从会话拿当前工作目录。
 *
 * 用 workingDirectory 服务的投影值，而不是会话头的原始项目目录：agent 在会话里
 * 改过目录之后，面板要跟着看新目录。也正因如此，绝不接受客户端传来的 cwd——
 * 那会把接口变成任意目录读取。
 * @param {object} ctx - 宿主上下文。
 * @param {string} sessionId - 会话 id。
 * @returns {string | undefined} 工作目录；会话不存在或目录无效时 undefined。
 */
function resolveCwd(ctx, sessionId) {
  let session;
  try {
    session = ctx.sessions.get(sessionId);
  } catch {
    return undefined;
  }
  if (session === undefined) return undefined;
  try {
    const current = ctx.workingDirectory.get(session);
    if (isDirectory(current)) return current;
  } catch {
    // 投影尚未提交时退回原始项目目录。
  }
  return isDirectory(session.header?.cwd) ? session.header.cwd : undefined;
}

/**
 * 构造路由处理入口。
 * @param {{ctx: object}} options - 依赖。
 * @returns {{handle: (req: object, res: object) => Promise<void>}} 处理入口。
 */
export function createHandlers({ ctx }) {
  return {
    async handle(req, res) {
      const url = parseUrl(req.url);
      if (url === undefined) return sendError(res, 400, "bad-url");
      if (req.method !== "GET") return sendError(res, 405, "method-not-allowed");

      const sessionId = url.searchParams.get("session") ?? "";
      if (sessionId === "") return sendError(res, 400, "missing-session");
      const cwd = resolveCwd(ctx, sessionId);
      if (cwd === undefined) return sendError(res, 404, "session-unavailable");

      try {
        const repoParam = url.searchParams.get("repo");
        const repo = repoParam === null || repoParam === "" ? undefined : repoParam;

        if (url.pathname === `${ROUTE_PREFIX}/status`) {
          const status = await readStatus(cwd, repo);
          if (status.ok !== true) {
            const code = status.error ?? "git-failed";
            const httpStatus =
              code === "invalid-repo" || code === "not-a-repository"
                ? 404
                : code === "git-timeout"
                  ? 504
                  : 500;
            return sendError(res, httpStatus, code, status.detail);
          }
          return sendJson(res, 200, status);
        }
        if (url.pathname === `${ROUTE_PREFIX}/repos`) {
          const found = findRepositories(cwd);
          return sendJson(res, 200, { ok: true, cwd, ...found });
        }
        if (url.pathname === `${ROUTE_PREFIX}/diff`) {
          const filePath = url.searchParams.get("path") ?? "";
          if (!isSafeRelative(filePath)) return sendError(res, 400, "invalid-path");
          let root;
          if (repo === undefined) {
            const discovered = await discoverRepository(cwd);
            if (!discovered.isRepo) return sendError(res, 404, "not-a-repository");
            root = discovered.root;
          } else {
            const selected = resolveInside(cwd, repo);
            if (selected === undefined) return sendError(res, 400, "invalid-repo");
            if (!isGitRepository(selected)) return sendError(res, 404, "not-a-repository");
            root = selected;
          }
          const options = {
            staged: url.searchParams.get("staged") === "1",
            untracked: url.searchParams.get("untracked") === "1",
            origPath: url.searchParams.get("orig") || undefined,
          };
          // 只允许读当前状态列表里的文件：否则同一个接口也能读 .git/config 或
          // 任何未改动的仓库文件。
          const entries = await statusEntriesFor(root);
          if (entries === undefined) return sendError(res, 500, "git-failed");
          if (!diffTargetMatches(entries, filePath, options)) {
            return sendError(res, 409, "not-in-status");
          }
          const diff = await readDiff(root, filePath, options);
          return sendJson(res, diff.ok ? 200 : 400, diff);
        }
        return sendError(res, 404, "not-found");
      } catch (error) {
        return sendError(res, 500, "internal-error", String(error?.message ?? error));
      }
    },
  };
}

/**
 * 插件入口。
 * @param {object} ctx - Cordis 上下文。
 */
export function apply(ctx) {
  const handlers = createHandlers({ ctx });
  ctx.inject(["webServer"], (scope) => {
    scope.effect(
      () =>
        scope.webServer.register({
          kind: "prefix",
          path: ROUTE_PREFIX,
          handler: handlers.handle,
        }),
      "git-panel: routes",
    );
  });
}
