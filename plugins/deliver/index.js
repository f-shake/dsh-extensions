/**
 * 宿主半边：把宿主上的文件变成一条登录态下可下载的链接，外加投递箱用的列表接口。
 *
 * 为什么不做免登录直链：那要在 VPS 的 nginx 上放行一条绕过 `auth_request` 的路径，
 * 等于把宿主文件对公网敞开。远程访问本来就要先登录 dsh，站内地址已经够用。
 *
 * 为什么下载时读原文件而不复制：交付的语义是「此刻这个文件」；复制一份几百 MB 的
 * 安装包只会让磁盘翻倍，还要额外维护清理策略。
 *
 * 为什么投递表放内存：它只服务当前活着的宿主进程。重启后内存表清空，旧链接会变成
 * 404「这条投递不存在」，卡片把它显示为「已失效」——这比落盘一份可能过期的路径表
 * 更安全，也不用处理清理。
 */

import { open, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, extname, isAbsolute, resolve } from "node:path";

const ROUTE_PREFIX = "/deliver";
const ID_BYTES = 16;
const DEFAULT_TTL_MINUTES = 720;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 ** 3;
const DEFAULT_MAX_FILES = 20;
const DEFAULT_MAX_DELIVERIES = 200;

/** 扩展名到 Content-Type。不在表里的一律按二进制下载，不让浏览器猜。 */
const MIME_TYPES = {
  ".apk": "application/vnd.android.package-archive",
  ".zip": "application/zip",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".exe": "application/vnd.microsoft.portable-executable",
  ".msi": "application/x-msi",
};

export const name = "deliver";
export const inject = ["tools"];

/**
 * 把扩展名翻成 Content-Type。
 * @param {string} fileName - 文件名。
 * @returns {string} MIME 类型；未知扩展名回退成二进制。
 */
export function mimeOf(fileName) {
  const ext = extname(String(fileName ?? "")).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

/**
 * 人看的文件大小。
 * @param {number} bytes - 字节数。
 * @returns {string} 形如 `2.1 MB`；非法输入回退成「未知大小」。
 */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "未知大小";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // 一位小数足够：用户关心的是量级，不是精确字节。
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/**
 * 本地时间的 `YYYY-MM-DD HH:mm`。
 * @param {number} ms - 毫秒时间戳。
 * @returns {string} 格式化结果；非法输入返回空串。
 */
export function formatClock(ms) {
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 解析 Range 头。
 *
 * 只服务第一段：多段请求按 RFC 允许服务端降级，返回 multipart 不值当。
 * 语法非法（`bytes=abc`）按「没有 Range」处理，交给调用方返回 200——这是 RFC 7233
 * 允许的宽松做法；只有语法合法但越界（`bytes=999-`）才算 416。
 * @param {string | undefined} header - Range 头原文。
 * @param {number} size - 文件总字节数。
 * @returns {{ kind: "none" } | { kind: "invalid" } | { kind: "unsatisfiable" } | { kind: "range", start: number, end: number }} 解析结果。
 */
export function parseRange(header, size) {
  if (typeof header !== "string" || header.trim() === "") return { kind: "none" };
  const match = /^bytes=(.+)$/i.exec(header.trim());
  if (match === null) return { kind: "invalid" };
  const first = match[1].split(",")[0].trim();
  const parts = /^(\d*)-(\d*)$/.exec(first);
  if (parts === null) return { kind: "invalid" };

  const [, rawStart, rawEnd] = parts;
  if (rawStart === "" && rawEnd === "") return { kind: "invalid" };

  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix < 0) return { kind: "invalid" };
    // RFC 7233：suffix-length 为 0 的 suffix-range 是「不可满足」，不是「没有 Range」。
    if (suffix === 0) return { kind: "unsatisfiable" };
    if (size === 0) return { kind: "unsatisfiable" };
    return { kind: "range", start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start)) return { kind: "invalid" };
  if (start >= size) return { kind: "unsatisfiable" };

  const end = rawEnd === "" ? size - 1 : Number(rawEnd);
  if (!Number.isSafeInteger(end) || end < start) return { kind: "invalid" };
  return { kind: "range", start, end: Math.min(end, size - 1) };
}

/**
 * ASCII 回退文件名：非 ASCII 与引号都换成下划线。
 * @param {string} fileName - 原文件名。
 * @returns {string} 可安全放进 `filename="…"` 的名字。
 */
function asciiFallback(fileName) {
  const replaced = String(fileName ?? "")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .trim();
  return replaced === "" ? "download" : replaced;
}

/**
 * `Content-Disposition: attachment` 头，中文名走 RFC 5987。
 * @param {string} fileName - 下载时显示的文件名。
 * @returns {string} 头部值。
 */
export function contentDisposition(fileName) {
  const name = typeof fileName === "string" && fileName !== "" ? fileName : "download";
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiFallback(name)}"; filename*=UTF-8''${encoded}`;
}

/**
 * 把工具参数里的路径解析成可投递的文件。
 *
 * 单个文件失败不牵连其余：失败项进 `failed`，由工具结果原样报给模型。
 * 相对路径按会话工作目录解析——模型给的路径常常是相对的，硬要求绝对路径只会
 * 让它多绕一圈。
 * @param {Array<{ path?: unknown, name?: unknown }>} entries - 工具传入的文件列表。
 * @param {{ cwd?: string, maxFileBytes: number, maxFiles: number }} options - 上限与工作目录。
 * @returns {Promise<{ accepted: object[], failed: { path: string, reason: string }[] }>} 解析结果。
 */
export async function resolveFiles(entries, options) {
  const cwd = typeof options.cwd === "string" && options.cwd !== "" ? options.cwd : process.cwd();
  const maxFiles = Number.isInteger(options.maxFiles) ? options.maxFiles : DEFAULT_MAX_FILES;
  const maxFileBytes = Number.isFinite(options.maxFileBytes)
    ? options.maxFileBytes
    : DEFAULT_MAX_FILE_BYTES;

  const accepted = [];
  const failed = [];
  const seen = new Set();
  const list = Array.isArray(entries) ? entries : [];

  for (const entry of list) {
    const raw = entry !== null && typeof entry === "object" && typeof entry.path === "string"
      ? entry.path.trim()
      : "";
    if (raw === "") {
      failed.push({ path: "", reason: "缺少路径" });
      continue;
    }
    if (accepted.length >= maxFiles) {
      failed.push({ path: raw, reason: `一次最多投递 ${maxFiles} 个文件` });
      continue;
    }

    const absPath = isAbsolute(raw) ? raw : resolve(cwd, raw);
    // Windows 文件系统不区分大小写，同一个文件写成两种拼法也只该投一次；
    // 其他平台的 Report.pdf 与 report.pdf 是两个文件，不能按小写合并。
    const key = process.platform === "win32" ? absPath.toLowerCase() : absPath;
    if (seen.has(key)) {
      // 重复不是失败：模型把同一个文件写了两遍，投递一次就够了，报错只会制造噪音。
      continue;
    }
    seen.add(key);

    let info;
    try {
      info = await stat(absPath);
    } catch {
      failed.push({ path: raw, reason: "文件不存在" });
      continue;
    }
    if (info.isDirectory()) {
      failed.push({ path: raw, reason: "是目录，请先打包成文件" });
      continue;
    }
    if (!info.isFile()) {
      failed.push({ path: raw, reason: "不是普通文件" });
      continue;
    }
    if (info.size > maxFileBytes) {
      failed.push({ path: raw, reason: `超过上限 ${formatSize(maxFileBytes)}` });
      continue;
    }

    const custom = entry !== null && typeof entry === "object" && typeof entry.name === "string"
      ? entry.name.trim()
      : "";
    accepted.push({
      absPath,
      name: custom === "" ? basename(absPath) : custom,
      size: info.size,
    });
  }

  return { accepted, failed };
}

/**
 * 投递表。
 *
 * 撤销的记录不立刻删除：直接删掉的话，再用旧链接会变成「不存在」，用户分不清是
 * 过期、撤销还是打错了。留着墓碑一直到过期，才能回 410「已撤销」。
 * @param {{ ttlMs?: number, maxDeliveries?: number, clock?: () => number }} [options] - 有效期与容量。
 * @returns {object} 读写入口。
 */
export function createStore(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MINUTES * 60_000;
  const maxDeliveries = Number.isInteger(options.maxDeliveries) && options.maxDeliveries > 0
    ? options.maxDeliveries
    : DEFAULT_MAX_DELIVERIES;
  const clock = typeof options.clock === "function" ? options.clock : Date.now;
  const items = new Map();

  /**
   * 清掉已过期的记录。
   * @param {number} now - 当前时间。
   */
  function sweep(now) {
    for (const [id, record] of items) {
      if (record.expiresAt <= now) items.delete(id);
    }
  }

  /**
   * 查一条投递。
   * @param {string} id - 投递 id。
   * @returns {{ state: "ok" | "missing" | "expired" | "revoked", record: object | null }} 查询结果。
   */
  function get(id) {
    const record = items.get(id);
    if (record === undefined) return { state: "missing", record: null };
    if (record.expiresAt <= clock()) return { state: "expired", record };
    if (record.revokedAt !== null) return { state: "revoked", record };
    return { state: "ok", record };
  }

  return {
    /**
     * 建一条投递。
     * @param {object[]} files - 已解析的文件。
     * @param {string} [sessionId] - 发起投递的会话；只给回合末尾的卡片筛选用。
     * @returns {object} 新记录。
     */
    create(files, sessionId) {
      const now = clock();
      sweep(now);
      // 容量兜底：内存里的表不能被反复投递撑爆，满了先丢最旧的。
      while (items.size >= maxDeliveries) {
        const oldest = items.keys().next().value;
        items.delete(oldest);
      }
      const record = {
        id: randomBytes(ID_BYTES).toString("base64url"),
        sessionId: typeof sessionId === "string" ? sessionId : "",
        createdAt: now,
        expiresAt: now + ttlMs,
        revokedAt: null,
        files: files.map((file, index) => ({
          index,
          absPath: file.absPath,
          name: file.name,
          size: file.size,
        })),
      };
      items.set(record.id, record);
      return record;
    },
    /**
     * 查一条投递。
     * @param {string} id - 投递 id。
     * @returns {{ state: string, record: object | null }} 查询结果。
     */
    get,
    /**
     * 撤销一条投递。
     * @param {string} id - 投递 id。
     * @returns {"ok" | "revoked" | "missing" | "expired"} 撤销结果；重复撤销也算成功。
     */
    revoke(id) {
      const found = get(id);
      if (found.state === "ok") {
        found.record.revokedAt = clock();
        return "ok";
      }
      return found.state === "revoked" ? "revoked" : found.state;
    },
    /**
     * 投递箱用的列表：只给未过期、未撤销的，新的在前。
     * @param {string} [sessionId] - 只列这个会话投的；空串或省略表示全部。
     * @returns {object[]} 记录列表。
     */
    list(sessionId) {
      const now = clock();
      sweep(now);
      const only = typeof sessionId === "string" ? sessionId : "";
      const result = [];
      for (const record of items.values()) {
        if (record.revokedAt !== null) continue;
        if (record.expiresAt <= now) continue;
        if (only !== "" && record.sessionId !== only) continue;
        result.push(record);
      }
      result.sort((left, right) => right.createdAt - left.createdAt);
      return result;
    },
  };
}

/**
 * 从 agent 身上取会话 id。回合末尾的卡片按它筛出本会话的投递。
 * @param {object} agent - 实时 agent。
 * @returns {string | undefined} 会话 id。
 */
export function sessionIdOf(agent) {
  if (agent === null || agent === undefined) return undefined;
  if (typeof agent.id === "string") return agent.id;
  if (typeof agent.session?.id === "string") return agent.session.id;
  return undefined;
}

/**
 * 拼一条文件的下载地址。
 * @param {string} id - 投递 id。
 * @param {number} index - 文件序号。
 * @returns {string} 站内地址。
 */
export function fileUrl(id, index) {
  return `${ROUTE_PREFIX}/${id}/${index}`;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

/**
 * 解析请求 URL。
 * @param {string | undefined} url - 原始 url。
 * @returns {URL | undefined} 解析结果。
 */
function parseUrl(url) {
  try {
    return new URL(url ?? "/", "http://localhost");
  } catch {
    return undefined;
  }
}

/**
 * 写 JSON。
 * @param {object} res - 响应对象。
 * @param {number} status - 状态码。
 * @param {object} payload - 载荷。
 * @param {boolean} [headOnly] - 只写头不留体。
 */
function sendJson(res, status, payload, headOnly = false) {
  const body = headOnly ? undefined : JSON.stringify(payload);
  const headers = { ...JSON_HEADERS };
  if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
  res.writeHead(status, headers);
  res.end(body);
}

/**
 * HTML 转义。
 * @param {string} text - 原文。
 * @returns {string} 转义结果。
 */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 写一张说明页。失效、撤销、源文件不见了都走这里——用户是在手机浏览器里点开的，
 * 给他一行能读的中文比丢一个 JSON 强。
 * @param {object} res - 响应对象。
 * @param {number} status - 状态码。
 * @param {string} title - 标题。
 * @param {string} detail - 说明。
 */
function sendPage(res, status, title, detail) {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{margin:0;padding:48px 20px;background:#f6f7f9;color:#1d1f23;
font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;text-align:center}
main{max-width:420px;margin:0 auto;background:#fff;border:1px solid #e3e5e9;
border-radius:12px;padding:28px 24px}
h1{font-size:17px;margin:0 0 8px}
p{margin:0;color:#5b6068;font-size:13px}
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body>
</html>`;
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(Buffer.byteLength(html)),
    "cache-control": "no-store",
  });
  res.end(html);
}

/**
 * 把一条投递里的某个文件流给客户端。
 * @param {object} options - 依赖与请求信息。
 * @param {object} options.req - 请求对象。
 * @param {object} options.res - 响应对象。
 * @param {object} options.store - 投递表。
 * @param {string} options.id - 投递 id。
 * @param {number} options.index - 文件序号。
 * @param {boolean} options.headOnly - 是否只要响应头。
 */
async function serveFile({ req, res, store, id, index, headOnly, openFile = open }) {
  const found = store.get(id);
  if (found.state === "missing") {
    return sendPage(res, 404, "这条投递不存在", "可能已经被清理，或者链接不完整。");
  }
  if (found.state === "expired") {
    return sendPage(res, 410, "这条投递已过期", `有效期到 ${formatClock(found.record.expiresAt)}。`);
  }
  if (found.state === "revoked") {
    return sendPage(res, 410, "这条投递已撤销", "发起者已经取消了这次投递。");
  }

  const file = Number.isInteger(index) ? found.record.files[index] : undefined;
  if (file === undefined) {
    return sendPage(res, 404, "文件不存在", "这条投递里没有这个序号。");
  }

  // 先打开再发头：Windows 上文件被独占锁住时 open() 就失败了，这时还能回一张
  // 说明页；反过来先发 200 再断流，客户端只会看到一次「下载失败」，什么信息都没有。
  let handle;
  try {
    handle = await openFile(file.absPath, "r");
  } catch (error) {
    const code = error !== null && typeof error === "object" ? error.code : undefined;
    if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") {
      return sendPage(res, 404, "源文件已删除", `宿主上已经找不到 ${file.name}。`);
    }
    return sendPage(res, 500, "文件暂时读不出来", "文件被占用或没有读取权限，请稍后重试。");
  }

  // 用句柄自己的 stat：从 stat 到开流之间文件可能被换掉，以打开的这一份为准。
  let info;
  try {
    info = await handle.stat();
  } catch {
    await handle.close().catch(() => {});
    return sendPage(res, 404, "源文件已删除", `宿主上已经找不到 ${file.name}。`);
  }
  if (!info.isFile()) {
    await handle.close().catch(() => {});
    return sendPage(res, 404, "源文件已删除", `宿主上的 ${file.name} 已经不是普通文件。`);
  }

  const size = info.size;
  const range = parseRange(req.headers?.range, size);
  const headers = {
    "content-type": mimeOf(file.name),
    "content-disposition": contentDisposition(file.name),
    "accept-ranges": "bytes",
    // no-transform 让宿主的 gzip 层原样透传：否则下载响应会被压成 chunked，
    // 浏览器拿不到 Content-Length（进度条显示未知大小），对 zip/apk 这类已压缩
    // 文件更是白烧 CPU。dsh-host-webserver 明确对 no-transform 不做转换。
    "cache-control": "no-store, no-transform",
    "last-modified": new Date(info.mtimeMs).toUTCString(),
  };

  if (range.kind === "unsatisfiable") {
    await handle.close().catch(() => {});
    res.writeHead(416, { ...headers, "content-range": `bytes */${size}`, "content-length": "0" });
    res.end();
    return;
  }

  let start = 0;
  let end = size - 1;
  let status = 200;
  if (range.kind === "range") {
    start = range.start;
    end = range.end;
    status = 206;
    headers["content-range"] = `bytes ${start}-${end}/${size}`;
  }
  headers["content-length"] = String(Math.max(0, end - start + 1));
  res.writeHead(status, headers);

  if (headOnly || size === 0) {
    await handle.close().catch(() => {});
    res.end();
    return;
  }

  // FileHandle 的读流默认 autoClose，结束或出错都会把这个句柄关掉。
  const stream = handle.createReadStream({ start, end });
  // 客户端中途取消（切后台、断网）时立刻放掉句柄，否则大文件会一直占着。
  res.on("close", () => stream.destroy());
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

/**
 * 构造 HTTP 处理入口。三条路由：列表、撤销、下载。
 * @param {{ store: object, clock?: () => number, openFile?: Function }} options - 依赖。
 * @returns {{ handle: (req: object, res: object) => Promise<void> }} 处理入口。
 */
export function createHandlers({ store, clock = Date.now, openFile = open }) {
  return {
    async handle(req, res) {
      const url = parseUrl(req.url);
      if (url === undefined) return sendJson(res, 400, { ok: false, error: "bad-url" });

      const method = typeof req.method === "string" ? req.method : "GET";
      const segments = url.pathname.split("/").filter((segment) => segment !== "");
      if (segments[0] !== ROUTE_PREFIX.slice(1)) {
        return sendJson(res, 404, { ok: false, error: "not-found" });
      }

      const headOnly = method === "HEAD";
      const readable = method === "GET" || headOnly;

      if (segments.length === 2 && segments[1] === "list" && readable) {
        const now = clock();
        const session = url.searchParams.get("session") ?? "";
        const deliveries = store.list(session).map((record) => ({
          id: record.id,
          sessionId: record.sessionId,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
          files: record.files.map((file) => ({
            index: file.index,
            name: file.name,
            size: file.size,
            sizeText: formatSize(file.size),
            url: fileUrl(record.id, file.index),
            // 绝对路径是右侧栏预览的原料：内置预览按「会话 + 路径」认文件。
            absPath: file.absPath,
          })),
        }));
        return sendJson(res, 200, { ok: true, now, deliveries }, headOnly);
      }

      if (segments.length === 2 && method === "DELETE") {
        const result = store.revoke(segments[1]);
        if (result === "ok") return sendJson(res, 200, { ok: true });
        if (result === "revoked") return sendJson(res, 200, { ok: true, already: true });
        return sendJson(res, result === "missing" ? 404 : 410, { ok: false, error: result });
      }

      if (segments.length === 3 && readable) {
        return serveFile({
          req,
          res,
          store,
          id: segments[1],
          // 只认规范十进制序号：01、00、1e0、0x1 都是同一份文件的别名，不该存在。
          index: /^(0|[1-9]\d*)$/.test(segments[2]) ? Number(segments[2]) : Number.NaN,
          headOnly,
          openFile,
        });
      }

      return sendJson(res, 404, { ok: false, error: "not-found" });
    },
  };
}

/**
 * 构造给模型的工具定义。
 * @param {{ store: object, limits: { maxFileBytes: number, maxFiles: number }, resolveCwd: (exec: object) => Promise<string | undefined> }} options - 依赖。
 * @returns {object} 工具定义。
 */
export function createTool({ store, limits, resolveCwd }) {
  return {
    name: "deliver",
    description:
      "把宿主上的文件投递成可下载的条目：用户会在对话里的投递卡片上看到文件名、大小和下载按钮，点一下就从这台机器下载到他的手机或电脑。远程使用 dsh 时，凡是用户要「拿走」的产物（报告、导出数据、截图、安装包、日志）都用它；这些文件可能在仓库外，也可以给绝对路径。一次最多投递 20 个文件。投递有有效期，用户可随时撤销。",
    parameters: {
      type: "object",
      properties: {
        files: {
          type: "array",
          description: "要投递的文件；按给定顺序出现在卡片里",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "文件路径；相对路径按会话工作目录解析",
              },
              name: {
                type: "string",
                description: "下载时的文件名，默认取原文件名",
              },
            },
            required: ["path"],
            additionalProperties: false,
          },
        },
      },
      required: ["files"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          deliveryId: { type: "string" },
          sessionId: { type: "string" },
          expiresAt: { type: "number" },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                index: { type: "number" },
                name: { type: "string" },
                size: { type: "number" },
                sizeText: { type: "string" },
                url: { type: "string" },
                absPath: { type: "string" },
              },
              required: ["index", "name", "size", "sizeText", "url", "absPath"],
              additionalProperties: false,
            },
          },
          failed: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                reason: { type: "string" },
              },
              required: ["path", "reason"],
              additionalProperties: false,
            },
          },
        },
        required: ["deliveryId", "sessionId", "expiresAt", "files", "failed"],
        additionalProperties: false,
      },
      render(_args, value) {
        const lines = [
          `已投递 ${value.files.length} 个文件，有效期到 ${formatClock(value.expiresAt)}：`,
        ];
        for (const file of value.files) lines.push(`- ${file.name}（${file.sizeText}）`);
        if (value.failed.length > 0) {
          lines.push("以下文件没有投递：");
          for (const item of value.failed) {
            lines.push(`- ${item.path === "" ? "（空路径）" : item.path}：${item.reason}`);
          }
        }
        // 卡片才是下载入口；让模型把站内路径写进正文，会被渲染成文件链接而不是下载。
        lines.push("下载入口在对话里的投递卡片上，回复里不要贴这些路径。");
        return [{ type: "text", text: lines.join("\n") }];
      },
      presentationMeta(_args, value) {
        return {
          deliveryId: value.deliveryId,
          sessionId: value.sessionId,
          expiresAt: value.expiresAt,
          files: value.files,
        };
      },
    },
    async execute(args, exec) {
      const entries = Array.isArray(args?.files) ? args.files : [];
      if (entries.length === 0) throw new Error("files 不能为空");

      // 会话可能用 working_directory 换过目录，header.cwd 只是最初的项目目录，
      // 所以相对路径必须按当前工作目录解析，否则会投递出同名但不对的文件。
      const cwd = await (typeof resolveCwd === "function" ? resolveCwd(exec) : undefined);
      const { accepted, failed } = await resolveFiles(entries, {
        cwd,
        maxFileBytes: limits.maxFileBytes,
        maxFiles: limits.maxFiles,
      });
      if (accepted.length === 0) {
        const detail = failed
          .map((item) => `${item.path === "" ? "（空路径）" : item.path}：${item.reason}`)
          .join("；");
        throw new Error(`没有可投递的文件。${detail}`);
      }

      const record = store.create(accepted, sessionIdOf(exec?.agent));
      return {
        deliveryId: record.id,
        sessionId: record.sessionId ?? "",
        expiresAt: record.expiresAt,
        files: record.files.map((file) => ({
          index: file.index,
          name: file.name,
          size: file.size,
          sizeText: formatSize(file.size),
          url: fileUrl(record.id, file.index),
          absPath: file.absPath,
        })),
        failed,
      };
    },
  };
}

/**
 * 归一化 Loader 行配置。
 * @param {unknown} raw - 原始配置。
 * @returns {{ ttlMinutes: number, maxFileBytes: number, maxFiles: number, maxDeliveries: number }} 归一化结果。
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const ttl = Number(source.ttlMinutes);
  const maxBytes = Number(source.maxFileBytes);
  const maxFiles = Number(source.maxFiles);
  const maxDeliveries = Number(source.maxDeliveries);
  return {
    ttlMinutes: Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_MINUTES,
    maxFileBytes:
      Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_FILE_BYTES,
    maxFiles: Number.isInteger(maxFiles) && maxFiles > 0 ? maxFiles : DEFAULT_MAX_FILES,
    maxDeliveries:
      Number.isInteger(maxDeliveries) && maxDeliveries > 0
        ? maxDeliveries
        : DEFAULT_MAX_DELIVERIES,
  };
}

/**
 * 插件入口。
 * @param {object} ctx - Cordis 上下文。
 * @param {unknown} rawConfig - Loader 行配置。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const store = createStore({
    ttlMs: config.ttlMinutes * 60_000,
    maxDeliveries: config.maxDeliveries,
    clock: Date.now,
  });
  const limits = { maxFileBytes: config.maxFileBytes, maxFiles: config.maxFiles };

  // 取「这个会话此刻的工作目录」。
  // 不能直接读 ctx.workingDirectory：没写进 inject 的服务，Cordis 会在读取时抛
  // "cannot get property ... without inject"；ctx.get 拿不到时只返回 undefined。
  const resolveCwd = async (exec) => {
    const agent = exec?.agent;
    if (agent === undefined || agent === null) return undefined;
    const service = typeof ctx.get === "function" ? ctx.get("workingDirectory") : undefined;
    if (service === undefined || service === null || typeof service.ensure !== "function") {
      return undefined;
    }
    try {
      return await service.ensure(agent, exec.signal);
    } catch {
      return undefined;
    }
  };

  ctx.effect(
    () => ctx.tools.register(createTool({ store, limits, resolveCwd })),
    "deliver: tool",
  );

  const handlers = createHandlers({ store });
  ctx.inject(["webServer"], (scope) => {
    scope.effect(
      () =>
        scope.webServer.register({
          kind: "prefix",
          path: ROUTE_PREFIX,
          handler: handlers.handle,
        }),
      "deliver: routes",
    );
  });
}
