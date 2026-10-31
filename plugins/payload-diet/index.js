/**
 * 宿主半边：把 Web 首屏要下载的字节数压下来，不碰任何界面代码。
 *
 * 背景（2026-10-30 headless Edge + CDP 逐请求实测）：
 * - 一次冷加载约 5.4 MB，其中 4.5 MB 是两个「插件 combo」脚本；
 * - 这 4.5 MB 里有 2.47 MB 是 `ui-settings-account` / `ui-plugin-manager` 把插画
 *   以 `data:image/webp;base64,` 内联进 bundle 的体积——base64 比重接近 1:1，
 *   gzip 压不动，而它们只在账号浮层打开时才需要；
 * - 另一处浪费是 `dsh-host-frontend-static` 给 `/assets/*` 只写 content-type，
 *   没有 Cache-Control/ETag，内容哈希命名的 `index-*.js`（312 KB）、
 *   `vendor-*.js`（205 KB）每次刷新都整份重下。
 *
 * 这个插件做三件事（都是宿主侧，客户端 bundle 一个字节都不加）：
 * 1. 改写 index.html 里的 combo 地址，把请求引到本插件的前缀；
 * 2. 在 combo 响应里把大块 base64 图片换成 `/dsh-diet/asset/<sha256>`，
 *    字节留在按内容寻址的内存池里，浏览器真要渲染那张图时才来取；
 * 3. 自己接管 `/assets/*`，补 `immutable`（仅限内容哈希命名的文件）+ ETag/304。
 *
 * 为什么必须改 HTML 里的 URL：`webServer.match()` 的前缀规则是
 * `pathname === prefix || pathname.startsWith(prefix + "/")`，而 combo 路径是
 * `/plugins/??@deepseek-ai/...`——`??` 后面跟的是 `@` 不是 `/`，所以任何
 * `/plugins/??` 形式的前缀都匹配不上；同时 `/plugins` 已被 client-modules 占用，
 * 二次注册同名路由会直接抛错。因此只能把自己的前缀写进 HTML，再在自己的路由里
 * 回源到 `clientModules.bundleResource`——拼装、rev、排序全部沿用上游实现。
 *
 * 两条必须守住的正确性约束：
 * - combo 响应带一年 `immutable`，浏览器不会再回来取；所以外置图池不能只靠
 *   「请 求时顺带填充」——宿主重启后池会空，而浏览器还揣着旧 combo，那些图就会
 *   404。插件启动时会按当前 compo sition 重建一遍池（内容寻址，哈希与原来一致）。
 * - `/assets` 前缀会整体顶掉上游 frontend-static 的处理，所以它只服务
 *   `<dist>/assets/` 子树，绝不放行 `%2e%2e%2f` 这类能走到 dist 根（例如
 *   index.html）的路径——那是上游要过鉴权的文件。
 *
 * 失败姿态：改写抛错、池满、上游异常都退回上游原样字节或透传状态，网页优先于省流量。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve, sep } from "node:path";

export const name = "payload-diet";

/** 路由与 index tap 都挂在 webServer 上，回源要 clientModules。 */
export const inject = ["webServer", "clientModules"];

/** 内容哈希命名的资源可以永久缓存；与 client-modules 的取值保持一致。 */
const IMMUTABLE = "public, max-age=31536000, immutable";

/** 非内容哈希命名的资源：允许存，但每次都要用 ETag 复验。 */
const REVALIDATE = "no-cache";

/** 自己的 combo 前缀：HTML 里的 `plugins/??` 会被改写成它。 */
const COMBO_ROUTE = "/dsh-diet/combo";

/** 外置图片的取用前缀。 */
const ASSET_ROUTE = "/dsh-diet/asset";

/** 上游 combo 的真实前缀，回源时要拼回去。 */
const UPSTREAM_PREFIX = "/plugins";

/** 上游在 HTML 里使用的写法。 */
const UPSTREAM_MARK = "plugins/??";

/** 改写后的写法。 */
const DIET_MARK = "dsh-diet/combo/??";

/** 默认只外置解码后 ≥ 2 KB 的图：小图标留在原地比多一次请求划算。 */
const DEFAULT_MIN_ASSET_BYTES = 2048;

/** base64 载荷字符数的廉价预筛，避免对每个小图标都做一次解码。 */
const PAYLOAD_PREFILTER_CHARS = 1024;

/** combo 结果缓存条数上限：正常的 batch URL 只有个位数，单模块 URL 也只有几十条；
 *  取 8 是为了让最坏情况下的常驻内存（每条 1~4 MB 解压后的 JS）保持在几十 MB 以内。 */
const COMBO_CACHE_LIMIT = 8;

/** 外置图片池的默认上限；超限不再收新图，宁可少省流量也不能丢图。 */
const DEFAULT_ASSET_POOL_BYTES = 64 * 1024 * 1024;

/** 缺资产日志的条数上限，避免刷屏。 */
const MISSING_ASSET_LOG_LIMIT = 5;

/**
 * 内联资源识别式。只认 base64 的 data URI，允许中间夹 `charset=` 之类的可选参数；
 * 非 base64（如 `data:image/svg+xml,%3Csvg`）不碰，那类本来就能被 gzip 压。
 */
const DATA_URL = /data:([a-z]+\/[a-z0-9.+-]+)(?:;[a-z0-9=._+-]+)*;base64,([A-Za-z0-9+/=]+)/gi;

/** 允许外置的类型：只收图片与字体。其他类型留在内联，避免把可执行文档变成同源 URL。 */
const MIME_EXT = {
  "image/webp": ".webp",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "image/avif": ".avif",
  "image/x-icon": ".ico",
  "font/woff": ".woff",
  "font/woff2": ".woff2",
  "font/ttf": ".ttf",
};

/** dist 目录里常见后缀的 Content-Type（与上游 frontend-static 的 MIME 表对齐）。 */
const SHELL_MIME = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".gz": "application/gzip",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};

/** 形如 `index-CN7NIWNw.js`、`montserrat-medium-B4OyO9CN.woff2` 的内容哈希命名。 */
const HASHED_NAME = /[-.][A-Za-z0-9_-]{8}\.[a-z0-9]+$/i;

/**
 * 数字型配置项的归一化：null、空串、布尔、非有限数一律退回默认值。
 * `Number(null) === 0`、`Number("") === 0`，直接比较会把「没填」当成「填了 0」，
 * 而 0 在这里等于关掉功能，症状还伪装成正常回退。
 * @param {unknown} value - 原始配置值。
 * @param {number} fallback - 默认值。
 * @returns {number} 归一化后的非负整数。
 */
function numberOption(value, fallback) {
  if (typeof value !== "number" && typeof value !== "string") return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

/**
 * 校验并补全插件配置。配置来自 Loader 行，可能是空对象或非对象。
 * @param {unknown} raw - Loader 传入的原始配置。
 * @returns {{ enabled: boolean, minAssetBytes: number, assetPoolBytes: number, shellCache: boolean, shellRoot: string | undefined }} 归一化后的配置。
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  return {
    enabled: source.enabled !== false,
    minAssetBytes: numberOption(source.minAssetBytes, DEFAULT_MIN_ASSET_BYTES),
    assetPoolBytes: numberOption(source.assetPoolBytes, DEFAULT_ASSET_POOL_BYTES),
    shellCache: source.shellCache !== false,
    shellRoot:
      typeof source.shellRoot === "string" && source.shellRoot.trim() !== ""
        ? resolve(source.shellRoot.trim())
        : undefined,
  };
}

/**
 * 把 HTML 里所有 `plugins/??` 指到本插件的 combo 路由。
 *
 * 只改这一种写法：`__DSH_BOOT__` 的 entry URL、两个 `<link rel=preload>`、以及
 * bootstrap 那段 `<script src>` 都长这样；`assets/...` 不在此列。替换是幂等的，
 * 插件热重载导致的重复 apply 不会叠加改写。
 * @param {string} html - 上游渲染好的 index.html。
 * @returns {string} 改写过地址的 HTML。
 */
export function rewriteIndexHtml(html) {
  if (typeof html !== "string" || !html.includes(UPSTREAM_MARK)) return html;
  return html.split(UPSTREAM_MARK).join(DIET_MARK);
}

/**
 * 按内容寻址生成文件名：同一张图在任何 bundle 里都会落到同一个名字，
 * 于是多份重复内联自然去重，浏览器也能永久缓存，宿主重启后重建也落在同一个名字上。
 * @param {string} mime - data URI 里的 MIME。
 * @param {Buffer} bytes - 解码后的原始字节。
 * @returns {string} `<sha256 前 16 位><后缀>`。
 */
export function assetFileName(mime, bytes) {
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  return `${hash}${MIME_EXT[mime.toLowerCase()] ?? ".bin"}`;
}

/**
 * 把 bundle 里的大块 base64 图片换成取用 URL，其余字节原样保留。
 *
 * 只替换 data URI 本身，不碰它外面的引号或 `url(...)`：无论是 `<img src="...">`、
 * CSS `background-image` 还是 JS 模板串，换成一个同源绝对路径后语义都不变，
 * 只是从「随 bundle 一起到」变成「渲染时才取」。
 *
 * 三种情况主动放弃替换、保留内联：类型不在白名单、载荷后面紧跟字母表字符
 * （说明 base64 被换行或 base64url 截断，替换会把图改坏甚至造出语法错误）、
 * 以及 `shouldExternalize` 返回 false（池满等策略性拒绝）。
 * @param {string} source - combo 脚本源码。
 * @param {object} [options] - 阈值与回调。
 * @param {number} [options.minBytes] - 解码后小于它的图保持内联。
 * @param {number} [options.payloadPrefilterChars] - base64 载荷的廉价预筛长度。
 * @param {(asset: { file: string, mime: string, bytes: Buffer }) => boolean} [options.shouldExternalize] - 返回 false 则保留内联。
 * @returns {{ code: string, assets: Array<{ file: string, mime: string, bytes: Buffer }>, savedBytes: number, skipped: number }} 改写结果。
 */
export function externalizeDataUrls(source, options = {}) {
  const text = String(source);
  const minBytes = options.minBytes ?? DEFAULT_MIN_ASSET_BYTES;
  const prefilter = options.payloadPrefilterChars ?? PAYLOAD_PREFILTER_CHARS;
  const shouldExternalize = options.shouldExternalize;
  const assets = [];
  let savedBytes = 0;
  let skipped = 0;
  const code = text.replace(DATA_URL, (match, mime, payload, offset) => {
    if (MIME_EXT[mime.toLowerCase()] === undefined) return match;
    if (payload.length < prefilter) return match;
    // 载荷后面（可以隔着换行）还接着字母表字符，说明 base64 被折行或用了 base64url，
    // 继续替换只会把图改坏、甚至留下裸字符串把整段脚本变成语法错误。
    // 阈值取 16：被折行的 base64 续行动辄上千字符，而正常的 `"\ndata:...` 接续只有几个字母。
    const continued = /^\s*[A-Za-z0-9+/=_-]{16,}/.test(text.slice(offset + match.length, offset + match.length + 256));
    if (continued) {
      skipped += 1;
      return match;
    }
    const bytes = Buffer.from(payload, "base64");
    if (bytes.length < minBytes) return match;
    const file = assetFileName(mime, bytes);
    if (shouldExternalize !== undefined && shouldExternalize({ file, mime, bytes }) === false) {
      skipped += 1;
      return match;
    }
    const url = `${ASSET_ROUTE}/${file}`;
    assets.push({ file, mime, bytes });
    savedBytes += Buffer.byteLength(match, "utf8") - Buffer.byteLength(url, "utf8");
    return url;
  });
  return { code, assets, savedBytes, skipped };
}

/**
 * 推断前端 dist 目录。
 *
 * 解析顺序刻意与上游 `dsh-web-app` 一致：先定位 `dsh-web-app` 包，再从它那里解析
 * `@deepseek-ai/dsh-web-frontend`。直接拿 CLI 入口当锚点，在 pnpm 隔离安装或 profile
 * 自带 node_modules 的布局下可能解析到另一份副本——那样 index.html 引用的哈希文件名
 * 与这里读到的文件对不上，`/assets/*` 会整批 404。
 * @param {{ shellRoot?: string }} [config] - 归一化配置。
 * @param {string} [anchorPath] - 起始解析锚点，默认取 dsh CLI 入口。
 * @returns {string | undefined} 存在的 dist 目录；解析不到时 undefined。
 */
export function resolveShellRoot(config = {}, anchorPath = process.argv[1]) {
  // 显式配置也要有 index.html 才算 dist 目录：路径写错时宁可退回上游默认的静态服务
  //（没有缓存头但能正常出页面），也不要让 /assets 路由把整站资源 404 掉。
  if (config.shellRoot !== undefined) {
    return existsSync(join(config.shellRoot, "index.html")) ? config.shellRoot : undefined;
  }
  if (typeof anchorPath !== "string" || anchorPath === "") return undefined;
  try {
    const fromBin = createRequire(anchorPath);
    let fromWebApp = fromBin;
    try {
      fromWebApp = createRequire(fromBin.resolve("@deepseek-ai/dsh-web-app/package.json"));
    } catch {
      /* 没有 web-app 包时退回 CLI 锚点，行为与旧版本一致 */
    }
    const pkg = fromWebApp.resolve("@deepseek-ai/dsh-web-frontend/package.json");
    const root = join(dirname(pkg), "dist");
    return existsSync(join(root, "index.html")) ? root : undefined;
  } catch {
    return undefined;
  }
}

/** 不带 body 地收掉一个响应。 */
function finish(res, status) {
  res.writeHead(status, { "content-length": "0" });
  res.end();
}

/** 405 必须带上 Allow，否则中间层与客户端都无从判断支持哪些方法。 */
function methodNotAllowed(res) {
  res.writeHead(405, { "content-length": "0", allow: "GET, HEAD" });
  res.end();
}

/** 写响应；HEAD 只写头。 */
function send(res, method, status, headers, body) {
  const finalHeaders = body === undefined ? headers : { "content-length": String(body.length), ...headers };
  res.writeHead(status, finalHeaders);
  if (method === "HEAD" || body === undefined) {
    res.end();
    return;
  }
  res.end(body);
}

/** 取请求路径（不含查询串）；解码失败返回 undefined。 */
function pathnameOf(url) {
  try {
    return decodeURIComponent(new URL(url ?? "/", "http://diet.invalid").pathname);
  } catch {
    return undefined;
  }
}

/**
 * 造出三条路由的处理器与它们的共享状态。
 *
 * 与 Cordis 解耦，便于单测：只依赖 `registry.bundleResource(method, url)` 与
 * `registry.graph()` / `registry.clientPath(id)`（`clientModules` 服务的公开方法），
 * 以及可选的 dist 目录。
 * @param {object} deps - 依赖注入。
 * @param {object} deps.registry - clientModules 注册表。
 * @param {string} [deps.distRoot] - 前端 dist 目录；缺省时不提供 shell 处理器。
 * @param {number} [deps.minAssetBytes] - 外置阈值。
 * @param {number} [deps.assetPoolBytes] - 外置图片池上限。
 * @param {{ warn?: Function, info?: Function }} [deps.logger] - 诊断输出。
 * @returns {{ combo: Function, asset: Function, shell: Function | undefined, warm: Function, stats: () => object }} 处理器、预热入口与统计。
 */
export function createDietHandlers({
  registry,
  distRoot,
  minAssetBytes = DEFAULT_MIN_ASSET_BYTES,
  assetPoolBytes = DEFAULT_ASSET_POOL_BYTES,
  logger,
} = {}) {
  if (registry === null || typeof registry !== "object" || typeof registry.bundleResource !== "function") {
    throw new Error("payload-diet：缺少 clientModules.bundleResource");
  }
  const computed = new Map();
  const inFlight = new Map();
  const assets = new Map();
  const missingLogged = new Set();
  const assetsRoot = distRoot === undefined ? undefined : join(distRoot, "assets");
  let assetBytes = 0;
  const stats = {
    combos: 0,
    assetRefs: 0,
    externalized: 0,
    savedBytes: 0,
    skippedAssets: 0,
    assetRequests: 0,
    missingAssets: 0,
    cacheHits: 0,
    droppedAssets: 0,
    warmed: 0,
  };

  /** 收下一条外置资源；池满时返回 false，调用方据此保留内联（不整批放弃）。 */
  function keepAsset(asset) {
    if (assets.has(asset.file)) return true;
    if (assetBytes + asset.bytes.length > assetPoolBytes) {
      stats.droppedAssets += 1;
      return false;
    }
    assets.set(asset.file, { mime: asset.mime, bytes: asset.bytes });
    assetBytes += asset.bytes.length;
    stats.externalized += 1;
    return true;
  }

  /** 回源 + 改写 + 记账；任何异常都退回上游原字节。 */
  async function build(url) {
    const rest = url.startsWith(COMBO_ROUTE) ? url.slice(COMBO_ROUTE.length) : url;
    const upstream = await registry.bundleResource("GET", `${UPSTREAM_PREFIX}${rest}`);
    // 只有 200 才值得标 immutable：把 404 也标成一年有效，会把一次瞬时失败
    //（启动窗口、HMR 换 rev）变成该浏览器上的长期 404。
    if (upstream.status !== 200 || upstream.body === undefined) {
      return { status: upstream.status, headers: { ...(upstream.headers ?? {}) }, body: upstream.body };
    }
    const headers = { ...(upstream.headers ?? {}), "cache-control": IMMUTABLE };
    const source = Buffer.isBuffer(upstream.body) ? upstream.body.toString("utf8") : String(upstream.body);
    let body = upstream.body;
    let externalized = 0;
    let saved = 0;
    try {
      const result = externalizeDataUrls(source, {
        minBytes: minAssetBytes,
        shouldExternalize: (asset) => keepAsset(asset),
      });
      body = Buffer.from(result.code, "utf8");
      externalized = result.assets.length;
      saved = result.savedBytes;
      stats.combos += 1;
      stats.assetRefs += result.assets.length;
      stats.skippedAssets += result.skipped;
      stats.savedBytes += saved;
      if (result.assets.length > 0) {
        logger?.info?.(
          `payload-diet：外置 ${result.assets.length} 处内联资源，` +
            `${Math.round(Buffer.byteLength(source, "utf8") / 1024)} KB → ${Math.round(body.length / 1024)} KB（未压缩）`,
        );
      }
    } catch (error) {
      // 改写失败就退回原字节：网页优先于省流量。结果照常缓存，因为原样内容同样正确。
      logger?.warn?.(`payload-diet：combo 改写失败，退回原样 ${String(error)}`);
      body = upstream.body;
      externalized = 0;
      saved = 0;
    }
    return { status: 200, headers, body, externalized, saved };
  }

  /**
   * combo 路由：回源到上游拼装结果，按请求 URL（含 rev）缓存改写产物。
   * @param {object} req - node:http 请求。
   * @param {object} res - node:http 响应。
   */
  async function combo(req, res) {
    if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res);
    const url = req.url ?? "/";
    const cached = computed.get(url);
    if (cached !== undefined) {
      // 命中即挪到队尾，让淘汰按最近使用而不是插入顺序
      computed.delete(url);
      computed.set(url, cached);
      stats.cacheHits += 1;
      return send(res, req.method, cached.status, cached.headers, cached.body);
    }
    let pending = inFlight.get(url);
    if (pending === undefined) {
      pending = build(url)
        .catch((error) => {
          logger?.warn?.(`payload-diet：combo 回源失败 ${String(error)}`);
          return { status: 502, headers: {}, body: undefined };
        })
        .finally(() => inFlight.delete(url));
      inFlight.set(url, pending);
    }
    const result = await pending;
    if (result.status === 200 && result.body !== undefined) {
      if (computed.size >= COMBO_CACHE_LIMIT) computed.delete(computed.keys().next().value);
      computed.set(url, result);
    }
    return send(res, req.method, result.status, result.headers, result.body);
  }

  /**
   * 外置图片路由：内容寻址，命中即永久缓存。
   *
   * 池只会由 build() 与 warm() 填充；两者都是确定性的（哈希由字节决定），
   * 所以宿主重启后 warm() 重建出的文件名与浏览器缓存里那些 URL 完全一致。
   * @param {object} req - node:http 请求。
   * @param {object} res - node:http 响应。
   */
  function asset(req, res) {
    if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res);
    const pathname = pathnameOf(req.url);
    if (pathname === undefined || !pathname.startsWith(`${ASSET_ROUTE}/`)) return finish(res, 404);
    const file = pathname.slice(ASSET_ROUTE.length + 1);
    const record = assets.get(file);
    if (record === undefined) {
      stats.missingAssets += 1;
      if (missingLogged.size < MISSING_ASSET_LOG_LIMIT && !missingLogged.has(file)) {
        missingLogged.add(file);
        logger?.warn?.(`payload-diet：外置资源不在池中（${file}），可能是旧缓存指向了本进程没重建的产物`);
      }
      // no-store：一次瞬时未命中不能被浏览器启发式缓存住，否则重启窗口期的 404 会粘住。
      res.writeHead(404, { "content-length": "0", "cache-control": "no-store" });
      res.end();
      return;
    }
    stats.assetRequests += 1;
    return send(res, req.method, 200, {
      "content-type": record.mime,
      "cache-control": IMMUTABLE,
      "x-content-type-options": "nosniff",
      // SVG 也在白名单里：万一把这个 URL 直接当文档打开，也不让里面的脚本跑起来。
      "content-security-policy": "sandbox",
    }, record.bytes);
  }

  /**
   * shell 路由：只服务 `<dist>/assets/` 子树，替 frontend-static 补缓存头。
   *
   * 为什么限制子树：`/assets` 是前缀路由，会顶掉上游对这批路径的处理；而
   * `%2e%2e%2f` 这类编码不会被 URL 规范化掉，解码后能走到 dist 根下的
   * `index.html`——那是上游要过鉴权并注入 `__DSH_BOOT__` 的文件，这里既没有
   * 鉴权也不能注入，只能拒绝。
   * @param {object} req - node:http 请求。
   * @param {object} res - node:http 响应。
   */
  async function shell(req, res) {
    if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res);
    const pathname = pathnameOf(req.url);
    if (pathname === undefined) return finish(res, 400);
    if (!pathname.startsWith("/assets/")) return finish(res, 404);
    const target = resolve(join(assetsRoot, pathname.slice("/assets/".length)));
    if (!target.startsWith(assetsRoot + sep)) return finish(res, 403);
    let info;
    try {
      info = await stat(target);
    } catch {
      logger?.warn?.(`payload-diet：/assets 文件不存在（${pathname}），index.html 与本地 dist 可能不是同一份`);
      return finish(res, 404);
    }
    if (!info.isFile()) return finish(res, 404);
    const name = target.slice(assetsRoot.length + 1);
    const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    const headers = {
      "content-type": SHELL_MIME[extname(target).toLowerCase()] ?? "application/octet-stream",
      "cache-control": HASHED_NAME.test(name) ? IMMUTABLE : REVALIDATE,
      "x-content-type-options": "nosniff",
      etag,
      "last-modified": new Date(info.mtimeMs).toUTCString(),
    };
    if (req.headers?.["if-none-match"] === etag) return send(res, req.method, 304, headers);
    const body = req.method === "HEAD" ? undefined : await readFile(target);
    return send(res, req.method, 200, body === undefined ? { ...headers, "content-length": String(info.size) } : headers, body);
  }

  /**
   * 启动预热：按当前 composition 把每个客户端 bundle 过一遍，把外置资源重新装进池。
   *
   * 存在的理由：combo 带一年 immutable，浏览器不会因为宿主重启而重取它；如果池只在
   * 请求路径上填充，重启后浏览器手里的旧 combo 会指向一个空池，那些图就 404。
   * 这里重建的哈希与原来完全一致（同一份字节 → 同一个 sha256），所以能无缝接上。
   * @returns {Promise<{ entries: number, assets: number }>} 预热统计。
   */
  async function warm() {
    const graph = typeof registry.graph === "function" ? registry.graph() : undefined;
    const entries = Array.isArray(graph?.entries) ? graph.entries : [];
    if (typeof registry.clientPath !== "function") return { entries: 0, assets: 0 };
    let seen = 0;
    for (const entry of entries) {
      const id = entry?.id;
      if (typeof id !== "string") continue;
      const path = registry.clientPath(id);
      if (typeof path !== "string") continue;
      try {
        const text = await readFile(path, "utf8");
        const result = externalizeDataUrls(text, {
          minBytes: minAssetBytes,
          shouldExternalize: (asset) => keepAsset(asset),
        });
        stats.warmed += result.assets.length;
        seen += 1;
      } catch {
        /* 单个 bundle 读不出来不影响其它条目，也不影响请求路径 */
      }
    }
    logger?.info?.(`payload-diet：预热 ${seen} 个客户端 bundle，池内 ${assets.size} 个资源`);
    return { entries: seen, assets: assets.size };
  }

  return {
    combo,
    asset,
    shell: distRoot === undefined ? undefined : shell,
    warm,
    stats: () => ({
      ...stats,
      cachedCombos: computed.size,
      assetCount: assets.size,
      assetBytes,
    }),
  };
}

/**
 * Cordis 插件入口：注册三条路由并把 HTML 里的 combo 地址指过来。
 *
 * 路由与 tap 都放在 `ctx.effect` 里注册，卸载（含启用 dsh-hmr 时的 patch 重载）时
 * 随 effect 释放，否则第二次注册会因 "duplicate route" 直接抛错。
 * @param {object} ctx - Cordis 上下文。
 * @param {unknown} rawConfig - Loader 行配置。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  if (!config.enabled) return;
  const distRoot = config.shellCache ? resolveShellRoot(config) : undefined;
  if (config.shellCache && distRoot === undefined) {
    ctx.logger?.warn?.("payload-diet：找不到前端 dist 目录，跳过 /assets 缓存头（可用 shellRoot 指定）");
  }
  const server = ctx.webServer;
  const handlers = createDietHandlers({
    registry: ctx.clientModules,
    distRoot,
    minAssetBytes: config.minAssetBytes,
    assetPoolBytes: config.assetPoolBytes,
    logger: ctx.logger,
  });
  ctx.effect(
    () => server.register({ kind: "prefix", path: COMBO_ROUTE, handler: handlers.combo }),
    "payload-diet: combo route",
  );
  ctx.effect(
    () => server.register({ kind: "prefix", path: ASSET_ROUTE, handler: handlers.asset }),
    "payload-diet: asset route",
  );
  if (handlers.shell !== undefined) {
    ctx.effect(
      () => server.register({ kind: "prefix", path: "/assets", handler: handlers.shell }),
      "payload-diet: shell route",
    );
  }
  ctx.effect(() => server.tapIndex(rewriteIndexHtml), "payload-diet: index rewrite");
  ctx.effect(
    () => () => ctx.logger?.info?.(`payload-diet：卸载，${JSON.stringify(handlers.stats())}`),
    "payload-diet: stats",
  );
  // 预热不阻塞启动：出错只影响「重启后旧缓存能否命中」，不影响请求路径本身。
  void handlers.warm().catch((error) => ctx.logger?.warn?.(`payload-diet：预热失败 ${String(error)}`));
}
