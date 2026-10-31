import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  apply,
  assetFileName,
  createDietHandlers,
  externalizeDataUrls,
  narrowOpenWindow,
  normalizeConfig,
  resolveShellRoot,
  rewriteIndexHtml,
} from "../index.js";

/** 造一张“大图”：4096 字节，base64 后远超预筛下限。 */
function bigBytes(size = 4096) {
  return Buffer.alloc(size, 7);
}

/** 造一个 data URI，与 bundle 里的写法一致。 */
function dataUri(mime, bytes) {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** 最小请求替身。 */
function fakeReq(method, url, headers = {}) {
  return { method, url, headers };
}

/** 最小响应替身：记状态、头、body。 */
function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: undefined,
    ended: false,
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
      this.ended = true;
    },
  };
}

/** 上游注册表替身：记录回源参数，可注入 body / 状态 / 抛错 / 组合图。 */
function registryOf(body, options = {}) {
  const calls = [];
  const registry = {
    calls,
    async bundleResource(method, url) {
      calls.push({ method, url });
      if (options.throw !== undefined) throw new Error(options.throw);
      const status = options.status ?? 200;
      return {
        status,
        headers: status === 200
          ? { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" }
          : {},
        body: status === 200 ? body : undefined,
      };
    },
  };
  if (options.graph !== undefined) registry.graph = () => options.graph;
  if (options.clientPath !== undefined) registry.clientPath = options.clientPath;
  return registry;
}

/** 建一个临时 dist 目录；返回根路径并登记清理。 */
function tempDist(t, files) {
  const root = mkdtempSync(join(tmpdir(), "payload-diet-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

/** webServer 替身：记录注册的路由与 tap，返回的 disposer 真的会摘掉。 */
function fakeServer() {
  const routes = [];
  const taps = [];
  return {
    routes,
    taps,
    register(route) {
      routes.push(route);
      return () => {
        const at = routes.indexOf(route);
        if (at !== -1) routes.splice(at, 1);
      };
    },
    tapIndex(fn) {
      taps.push(fn);
      return () => {
        const at = taps.indexOf(fn);
        if (at !== -1) taps.splice(at, 1);
      };
    },
  };
}

/** Cordis 上下文替身：effect 收集 disposer，services 直接给。 */
function fakeContext(server, clientModules, logger = { warn() {}, info() {} }) {
  const effects = [];
  return {
    effects,
    ctx: {
      logger,
      webServer: server,
      clientModules,
      effect(factory) {
        const disposer = factory();
        effects.push(disposer);
        return disposer;
      },
    },
  };
}

// ---------------------------------------------------------------- 配置

test("normalizeConfig：空配置给默认值", () => {
  for (const raw of [undefined, null, {}, 42, "x"]) {
    const config = normalizeConfig(raw);
    assert.equal(config.enabled, true);
    assert.equal(config.minAssetBytes, 2048);
    assert.equal(config.assetPoolBytes, 64 * 1024 * 1024);
    assert.equal(config.shellCache, true);
    assert.equal(config.shellRoot, undefined);
  }
});

test("normalizeConfig：null 与空串退回默认值，而不是被当成 0", () => {
  for (const value of [null, "", "   ", true, false, Number.NaN, Infinity]) {
    assert.equal(normalizeConfig({ minAssetBytes: value }).minAssetBytes, 2048, `minAssetBytes=${String(value)}`);
    assert.equal(normalizeConfig({ assetPoolBytes: value }).assetPoolBytes, 64 * 1024 * 1024, `assetPoolBytes=${String(value)}`);
  }
});

test("normalizeConfig：负值与非数字退回默认，合法值取整", () => {
  assert.equal(normalizeConfig({ minAssetBytes: -1 }).minAssetBytes, 2048);
  assert.equal(normalizeConfig({ minAssetBytes: "abc" }).minAssetBytes, 2048);
  assert.equal(normalizeConfig({ minAssetBytes: 100.9 }).minAssetBytes, 100);
  assert.equal(normalizeConfig({ minAssetBytes: "512" }).minAssetBytes, 512);
  assert.equal(normalizeConfig({ minAssetBytes: 0 }).minAssetBytes, 0);
  assert.equal(normalizeConfig({ assetPoolBytes: 0 }).assetPoolBytes, 0);
});

test("normalizeConfig：开关与 shellRoot 被保留并归一化", () => {
  const config = normalizeConfig({ enabled: false, shellCache: false, shellRoot: "C:/x/dist" });
  assert.equal(config.enabled, false);
  assert.equal(config.shellCache, false);
  assert.match(config.shellRoot, /[\\/]x[\\/]dist$/);
  assert.equal(normalizeConfig({ shellRoot: "   " }).shellRoot, undefined);
});

// ---------------------------------------------------------------- HTML 改写

test("rewriteIndexHtml：多处 plugins/?? 全部换成自己的前缀", () => {
  const html = '<link href="plugins/??a/client.js&rev=1"><script src="plugins/??b/client.js&rev=2"></script>';
  const out = rewriteIndexHtml(html);
  assert.equal(out.includes("plugins/??"), false);
  assert.equal((out.match(/dsh-diet\/combo\/\?\?/g) ?? []).length, 2);
  assert.ok(out.includes("&rev=1"));
});

test("rewriteIndexHtml：没有匹配时原样返回，非字符串也原样返回", () => {
  const html = "<html><body>no combos here</body></html>";
  assert.equal(rewriteIndexHtml(html), html);
  assert.equal(rewriteIndexHtml(undefined), undefined);
});

test("rewriteIndexHtml：重复执行结果不变（幂等）", () => {
  const html = '<script src="plugins/??a/client.js&rev=1"></script>';
  const once = rewriteIndexHtml(html);
  assert.equal(rewriteIndexHtml(once), once);
});

// ---------------------------------------------------------------- 文件名与内联资源

test("assetFileName：同内容同名，不同内容不同名", () => {
  const a = assetFileName("image/webp", bigBytes());
  assert.equal(a, assetFileName("image/webp", bigBytes()));
  assert.notEqual(a, assetFileName("image/webp", bigBytes(4097)));
  assert.match(a, /^[0-9a-f]{16}\.webp$/);
});

test("assetFileName：按 MIME 给后缀，未知类型落 .bin", () => {
  assert.ok(assetFileName("image/webp", bigBytes()).endsWith(".webp"));
  assert.ok(assetFileName("image/png", bigBytes()).endsWith(".png"));
  assert.ok(assetFileName("image/svg+xml", bigBytes()).endsWith(".svg"));
  assert.ok(assetFileName("application/octet-stream", bigBytes()).endsWith(".bin"));
});

test("externalizeDataUrls：大图换成取用 URL，其余字节不动", () => {
  const uri = dataUri("image/webp", bigBytes());
  const source = `const a = "${uri}"; const b = 1;`;
  const { code, assets, savedBytes } = externalizeDataUrls(source);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].mime, "image/webp");
  assert.equal(assets[0].bytes.length, 4096);
  assert.ok(code.includes(`"/dsh-diet/asset/${assets[0].file}"`));
  assert.ok(code.endsWith("const b = 1;"));
  assert.equal(savedBytes, uri.length - `/dsh-diet/asset/${assets[0].file}`.length);
});

test("externalizeDataUrls：小图因预筛或阈值保持内联", () => {
  const tiny = dataUri("image/png", Buffer.alloc(512, 1)); // base64 长度不足预筛
  const mid = dataUri("image/png", Buffer.alloc(1500, 2)); // 过预筛但解码后 < 2048
  const source = `${tiny} ${mid}`;
  const { code, assets, skipped } = externalizeDataUrls(source);
  assert.equal(assets.length, 0);
  assert.equal(skipped, 0);
  assert.equal(code, source);
});

test("externalizeDataUrls：minBytes 可以关掉阈值过滤", () => {
  const uri = dataUri("image/png", Buffer.alloc(1500, 3));
  const { assets } = externalizeDataUrls(uri, { minBytes: 0 });
  assert.equal(assets.length, 1);
});

test("externalizeDataUrls：非 base64 的 data URI 不碰", () => {
  const source = 'const s = "data:image/svg+xml,%3Csvg xmlns=%27x%27%3E";';
  assert.equal(externalizeDataUrls(source).code, source);
});

test("externalizeDataUrls：白名单外的类型（text/html）保持内联", () => {
  const uri = dataUri("text/html", bigBytes());
  const { code, assets } = externalizeDataUrls(uri);
  assert.equal(assets.length, 0);
  assert.equal(code, uri);
});

test("externalizeDataUrls：载荷被换行截断时放弃替换并计入 skipped", () => {
  // 截断点之后仍有 ≥2048 字节可解，所以「不替换」只可能来自后继字符检查。
  const payload = Buffer.from(bigBytes(6000)).toString("base64");
  const source = `"data:image/png;base64,${payload.slice(0, 3000)}\n${payload.slice(3000)}"`;
  const { code, assets, skipped } = externalizeDataUrls(source);
  assert.equal(assets.length, 0);
  assert.equal(skipped, 1);
  assert.equal(code, source);
});

test("externalizeDataUrls：相同图片去重成同一个文件名", () => {
  const uri = dataUri("image/webp", bigBytes());
  // 真实 bundle 里每处内联都在自己的引号/换行之间，不会首尾相连成一条更长的 base64。
  const { assets } = externalizeDataUrls(`${uri}\n${uri}\n${uri}`);
  assert.equal(assets.length, 3);
  assert.equal(new Set(assets.map((asset) => asset.file)).size, 1);
});

test("externalizeDataUrls：shouldExternalize 返回 false 时不替换", () => {
  const uri = dataUri("image/webp", bigBytes());
  const { code, assets, skipped } = externalizeDataUrls(uri, { shouldExternalize: () => false });
  assert.equal(assets.length, 0);
  assert.equal(skipped, 1);
  assert.equal(code, uri);
});

// ---------------------------------------------------------------- combo 路由

test("combo：回源到 /plugins 前缀并把图片外置", async () => {
  const uri = dataUri("image/webp", bigBytes());
  const registry = registryOf(Buffer.from(`const a="${uri}";`));
  const handlers = createDietHandlers({ registry });
  const res = fakeRes();
  await handlers.combo(fakeReq("GET", "/dsh-diet/combo/??@deepseek-ai/dsh-api-gateway/client.js&rev=abc"), res);
  assert.equal(res.status, 200);
  assert.equal(registry.calls.length, 1);
  assert.equal(registry.calls[0].url, "/plugins/??@deepseek-ai/dsh-api-gateway/client.js&rev=abc");
  assert.equal(res.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(res.headers["content-length"], String(res.body.length));
  assert.ok(res.body.toString("utf8").includes("/dsh-diet/asset/"));
});

test("combo：非 200 透传状态且不带 immutable（404 不能被缓存一年）", async () => {
  const registry = registryOf(undefined, { status: 404 });
  const handlers = createDietHandlers({ registry });
  const res = fakeRes();
  await handlers.combo(fakeReq("GET", "/dsh-diet/combo/??x/client.js&rev=9"), res);
  assert.equal(res.status, 404);
  assert.equal(res.headers["cache-control"], undefined);
  assert.equal(res.body, undefined);
});

test("combo：上游抛错返回 502 且不缓存", async () => {
  const registry = registryOf(Buffer.from("x"), { throw: "boom" });
  const handlers = createDietHandlers({ registry });
  const res = fakeRes();
  await handlers.combo(fakeReq("GET", "/dsh-diet/combo/??x/client.js&rev=9"), res);
  assert.equal(res.status, 502);
  assert.equal(handlers.stats().combos, 0);
  assert.equal(handlers.stats().cachedCombos, 0);
});

test("combo：非 GET/HEAD 返回 405 且带 Allow", async () => {
  const handlers = createDietHandlers({ registry: registryOf(Buffer.from("x")) });
  const res = fakeRes();
  await handlers.combo(fakeReq("POST", "/dsh-diet/combo/??x"), res);
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, "GET, HEAD");
  assert.equal(res.headers["content-length"], "0");
});

test("combo：HEAD 只写头，仍带 content-length", async () => {
  const body = Buffer.from("const a = 1;");
  const handlers = createDietHandlers({ registry: registryOf(body) });
  const res = fakeRes();
  await handlers.combo(fakeReq("HEAD", "/dsh-diet/combo/??x/client.js&rev=3"), res);
  assert.equal(res.status, 200);
  assert.equal(res.ended, true);
  assert.equal(res.body, undefined);
  assert.equal(res.headers["content-length"], String(body.length));
});

test("combo：改写结果除 URL 外与上游逐字节一致", async () => {
  const uri = dataUri("image/webp", bigBytes(3000));
  const source = `const a="${uri}";const b=2;`;
  const handlers = createDietHandlers({ registry: registryOf(Buffer.from(source)) });
  const res = fakeRes();
  await handlers.combo(fakeReq("GET", "/dsh-diet/combo/??x/client.js&rev=4"), res);
  const out = res.body.toString("utf8");
  const restored = out.replace(/\/dsh-diet\/asset\/[0-9a-f]{16}\.webp/, uri);
  assert.equal(restored, source);
});

test("combo：第二次请求命中缓存，两次 body 完全一致", async () => {
  const registry = registryOf(Buffer.from(`const a = "${dataUri("image/webp", bigBytes())}";`));
  const handlers = createDietHandlers({ registry });
  const url = "/dsh-diet/combo/??@deepseek-ai/x/client.js&rev=1";
  const first = fakeRes();
  const second = fakeRes();
  await handlers.combo(fakeReq("GET", url), first);
  await handlers.combo(fakeReq("GET", url), second);
  assert.equal(registry.calls.length, 1);
  assert.equal(handlers.stats().cacheHits, 1);
  assert.deepEqual(second.body, first.body);
  assert.equal(second.headers["content-length"], first.headers["content-length"]);
});

test("combo：并发请求只回源一次，两个响应都拿到完整字节", async () => {
  const body = Buffer.from(`const a = "${dataUri("image/webp", bigBytes())}";`);
  const registry = registryOf(body);
  const handlers = createDietHandlers({ registry });
  const url = "/dsh-diet/combo/??@deepseek-ai/y/client.js&rev=2";
  const first = fakeRes();
  const second = fakeRes();
  await Promise.all([handlers.combo(fakeReq("GET", url), first), handlers.combo(fakeReq("GET", url), second)]);
  assert.equal(registry.calls.length, 1);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(first.body, second.body);
  assert.ok(first.body.length > 0);
  assert.ok(first.body.toString("utf8").includes("/dsh-diet/asset/"));
});

test("combo：缓存超过上限按最近最少使用淘汰", async () => {
  const handlers = createDietHandlers({ registry: registryOf(Buffer.from("const a = 1;")) });
  for (let index = 0; index < 9; index += 1) {
    await handlers.combo(fakeReq("GET", `/dsh-diet/combo/??x/client.js&rev=${index}`), fakeRes());
  }
  assert.equal(handlers.stats().cachedCombos, 8);
  const before = handlers.stats().cacheHits;
  await handlers.combo(fakeReq("GET", "/dsh-diet/combo/??x/client.js&rev=0"), fakeRes());
  assert.equal(handlers.stats().cacheHits, before, "最早的一条应已被淘汰");
  await handlers.combo(fakeReq("GET", "/dsh-diet/combo/??x/client.js&rev=8"), fakeRes());
  assert.equal(handlers.stats().cacheHits, before + 1, "最近的一条应仍在缓存里");
});

test("combo：池满时只跳过超限的那张图，其余照常外置且不留孤儿", async () => {
  const uriA = dataUri("image/webp", bigBytes(3000));
  const uriB = dataUri("image/webp", Buffer.alloc(3000, 9));
  const source = `const a="${uriA}";const b="${uriB}";`;
  const handlers = createDietHandlers({ registry: registryOf(Buffer.from(source)), assetPoolBytes: 3500 });
  const res = fakeRes();
  await handlers.combo(fakeReq("GET", "/dsh-diet/combo/??x/client.js&rev=5"), res);
  const out = res.body.toString("utf8");
  assert.ok(out.includes("/dsh-diet/asset/"), "第一张应被外置");
  assert.ok(out.includes(uriB), "第二张应保持内联");
  const stats = handlers.stats();
  assert.equal(stats.droppedAssets, 1);
  assert.equal(stats.assetCount, 1);
  assert.equal(stats.assetBytes, 3000);
});

test("combo：同一张图出现两次只入池一份", async () => {
  const uri = dataUri("image/webp", bigBytes());
  const handlers = createDietHandlers({ registry: registryOf(Buffer.from(`a="${uri}";b="${uri}";`)) });
  const res = fakeRes();
  await handlers.combo(fakeReq("GET", "/dsh-diet/combo/??x/client.js&rev=6"), res);
  const stats = handlers.stats();
  assert.equal(stats.assetRefs, 2);
  assert.equal(stats.externalized, 1);
  assert.equal(stats.assetCount, 1);
  assert.equal(stats.assetBytes, 4096);
  assert.ok(stats.combos > 0);
  const url = `/dsh-diet/asset/${assetFileName("image/webp", bigBytes())}`;
  assert.equal(stats.savedBytes, 2 * (uri.length - url.length));
});

// ---------------------------------------------------------------- 外置图片路由

test("asset：按内容寻址返回原始字节、MIME、immutable 与 nosniff", async () => {
  const bytes = bigBytes();
  const handlers = createDietHandlers({ registry: registryOf(Buffer.from(`"${dataUri("image/webp", bytes)}"`)) });
  const comboRes = fakeRes();
  await handlers.combo(fakeReq("GET", "/dsh-diet/combo/??x/client.js&rev=7"), comboRes);
  const file = /\/dsh-diet\/asset\/([0-9a-f]{16}\.webp)/.exec(comboRes.body.toString("utf8"))[1];
  const res = fakeRes();
  handlers.asset(fakeReq("GET", `/dsh-diet/asset/${file}`), res);
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "image/webp");
  assert.equal(res.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["content-security-policy"], "sandbox");
  assert.deepEqual(res.body, bytes);
  assert.equal(handlers.stats().assetRequests, 1);
});

test("asset：HEAD 只写头", async () => {
  const bytes = bigBytes();
  const handlers = createDietHandlers({ registry: registryOf(Buffer.from(`"${dataUri("image/webp", bytes)}"`)) });
  const comboRes = fakeRes();
  await handlers.combo(fakeReq("GET", "/dsh-diet/combo/??x/client.js&rev=8"), comboRes);
  const file = /\/dsh-diet\/asset\/([0-9a-f]{16}\.webp)/.exec(comboRes.body.toString("utf8"))[1];
  const res = fakeRes();
  handlers.asset(fakeReq("HEAD", `/dsh-diet/asset/${file}`), res);
  assert.equal(res.status, 200);
  assert.equal(res.body, undefined);
  assert.equal(res.headers["content-length"], String(bytes.length));
});

test("asset：未知文件 404 并计数，非该前缀 404，非 GET/HEAD 405", () => {
  const messages = [];
  const handlers = createDietHandlers({
    registry: registryOf(Buffer.from("x")),
    logger: { warn: (message) => messages.push(message), info() {} },
  });
  const missing = fakeRes();
  handlers.asset(fakeReq("GET", "/dsh-diet/asset/0000000000000000.webp"), missing);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers["cache-control"], "no-store");
  assert.equal(handlers.stats().missingAssets, 1);
  assert.equal(messages.length, 1);
  // 同一个文件再请求一次不再刷日志
  handlers.asset(fakeReq("GET", "/dsh-diet/asset/0000000000000000.webp"), fakeRes());
  assert.equal(messages.length, 1);

  const other = fakeRes();
  handlers.asset(fakeReq("GET", "/elsewhere/x.webp"), other);
  assert.equal(other.status, 404);

  const post = fakeRes();
  handlers.asset(fakeReq("POST", "/dsh-diet/asset/whatever.webp"), post);
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, "GET, HEAD");
});

test("asset：非法编码的 URL 返回 404 而不是抛错", () => {
  const handlers = createDietHandlers({ registry: registryOf(Buffer.from("x")) });
  const res = fakeRes();
  handlers.asset(fakeReq("GET", "/dsh-diet/asset/%E0%A4%A"), res);
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------- shell 路由

test("shell：内容哈希命名的文件给 immutable", async (t) => {
  const root = tempDist(t, { "index.html": "<html></html>", "assets/index-CN7NIWNw.js": "console.log(1);" });
  const handlers = createDietHandlers({ registry: registryOf(Buffer.from("x")), distRoot: root });
  const res = fakeRes();
  await handlers.shell(fakeReq("GET", "/assets/index-CN7NIWNw.js"), res);
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(res.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.ok(res.headers.etag);
  assert.equal(res.headers["content-length"], "15");
  assert.equal(res.body.toString("utf8"), "console.log(1);");
});

test("shell：非哈希命名只给 no-cache（升级后不会陈旧一年）", async (t) => {
  const root = tempDist(t, { "index.html": "<html></html>", "assets/plain.js": "x" });
  const handlers = createDietHandlers({ registry: registryOf(Buffer.from("x")), distRoot: root });
  const res = fakeRes();
  await handlers.shell(fakeReq("GET", "/assets/plain.js"), res);
  assert.equal(res.status, 200);
  assert.equal(res.headers["cache-control"], "no-cache");
});

test("shell：if-none-match 命中返回 304 且无 body", async (t) => {
  const root = tempDist(t, { "index.html": "<html></html>", "assets/index-CN7NIWNw.js": "x" });
  const handlers = createDietHandlers({ registry: registryOf(Buffer.from("x")), distRoot: root });
  const first = fakeRes();
  await handlers.shell(fakeReq("GET", "/assets/index-CN7NIWNw.js"), first);
  const cached = fakeRes();
  await handlers.shell(fakeReq("GET", "/assets/index-CN7NIWNw.js", { "if-none-match": first.headers.etag }), cached);
  assert.equal(cached.status, 304);
  assert.equal(cached.body, undefined);
});

test("shell：HEAD 只写头并带 content-length", async (t) => {
  const root = tempDist(t, { "index.html": "<html></html>", "assets/index-CN7NIWNw.js": "12345" });
  const handlers = createDietHandlers({ registry: registryOf(Buffer.from("x")), distRoot: root });
  const res = fakeRes();
  await handlers.shell(fakeReq("HEAD", "/assets/index-CN7NIWNw.js"), res);
  assert.equal(res.status, 200);
  assert.equal(res.body, undefined);
  assert.equal(res.headers["content-length"], "5");
});

test("shell：文件不存在 404 并留下告警，目录 404，未知后缀按 octet-stream", async (t) => {
  const messages = [];
  const root = tempDist(t, {
    "index.html": "<html></html>",
    "assets/sub/keep.txt": "k",
    "assets/data.bin": "b",
  });
  const handlers = createDietHandlers({
    registry: registryOf(Buffer.from("x")),
    distRoot: root,
    logger: { warn: (message) => messages.push(message), info() {} },
  });
  const missing = fakeRes();
  await handlers.shell(fakeReq("GET", "/assets/nope.js"), missing);
  assert.equal(missing.status, 404);
  assert.ok(messages.some((message) => message.includes("文件不存在")));

  const directory = fakeRes();
  await handlers.shell(fakeReq("GET", "/assets/sub"), directory);
  assert.equal(directory.status, 404);

  const unknown = fakeRes();
  await handlers.shell(fakeReq("GET", "/assets/data.bin"), unknown);
  assert.equal(unknown.status, 200);
  assert.equal(unknown.headers["content-type"], "application/octet-stream");
});

test("shell：编码后的上级目录跳转被 403 挡住（不能绕过 index 鉴权）", async (t) => {
  const root = tempDist(t, { "index.html": "<html></html>", "assets/index-CN7NIWNw.js": "x" });
  const handlers = createDietHandlers({ registry: registryOf(Buffer.from("x")), distRoot: root });
  for (const url of ["/assets/%2e%2e%2findex.html", "/assets/..%2f..%2fsecret.txt", "/assets/sub/..%2f..%2findex.html"]) {
    const res = fakeRes();
    await handlers.shell(fakeReq("GET", url), res);
    assert.equal(res.status, 403, url);
    assert.equal(res.body, undefined, url);
  }
});

test("shell：不在 /assets/ 下的路径 404，非法编码 400，非 GET/HEAD 405", async (t) => {
  const root = tempDist(t, { "index.html": "<html></html>", "assets/index-CN7NIWNw.js": "x" });
  const handlers = createDietHandlers({ registry: registryOf(Buffer.from("x")), distRoot: root });
  const outside = fakeRes();
  await handlers.shell(fakeReq("GET", "/manifest.webmanifest"), outside);
  assert.equal(outside.status, 404);
  const bad = fakeRes();
  await handlers.shell(fakeReq("GET", "/assets/%E0%A4%A"), bad);
  assert.equal(bad.status, 400);
  const post = fakeRes();
  await handlers.shell(fakeReq("POST", "/assets/index-CN7NIWNw.js"), post);
  assert.equal(post.status, 405);
});

test("shell：没有 distRoot 时不提供 shell 处理器", () => {
  const handlers = createDietHandlers({ registry: registryOf(Buffer.from("x")) });
  assert.equal(handlers.shell, undefined);
});

// ---------------------------------------------------------------- 预热

test("warm：按 composition 重建外置池，命名与请求路径一致", async (t) => {
  const uri = dataUri("image/webp", bigBytes());
  const root = tempDist(t, { "a.js": `"${uri}";`, "b.js": "const x = 1;" });
  const registry = registryOf(Buffer.from("x"), {
    graph: { entries: [{ id: "pkg-a" }, { id: "pkg-b" }, { id: "pkg-missing" }] },
    clientPath: (id) => (id === "pkg-a" ? join(root, "a.js") : id === "pkg-b" ? join(root, "b.js") : undefined),
  });
  const handlers = createDietHandlers({ registry });
  const result = await handlers.warm();
  assert.equal(result.entries, 2);
  assert.equal(handlers.stats().assetCount, 1);
  assert.equal(handlers.stats().warmed, 1);
  const file = assetFileName("image/webp", bigBytes());
  const res = fakeRes();
  handlers.asset(fakeReq("GET", `/dsh-diet/asset/${file}`), res);
  assert.equal(res.status, 200, "重启后浏览器手里的旧 combo 仍应命中");
});

test("warm：没有 graph 或 clientPath 时安全返回", async () => {
  const handlers = createDietHandlers({ registry: registryOf(Buffer.from("x")) });
  assert.deepEqual(await handlers.warm(), { entries: 0, assets: 0 });
});

// ---------------------------------------------------------------- resolveShellRoot

test("resolveShellRoot：显式配置优先", (t) => {
  const root = tempDist(t, { "index.html": "<html></html>" });
  assert.equal(resolveShellRoot({ shellRoot: root }), root);
});

test("resolveShellRoot：显式配置缺 index.html 时返回 undefined（避免 /assets 全 404）", (t) => {
  const root = tempDist(t, { "assets/app.js": "x" });
  assert.equal(resolveShellRoot({ shellRoot: root }), undefined);
});

test("resolveShellRoot：按 dsh-web-app 锚点解析前端 dist", (t) => {
  const root = tempDist(t, {
    "node_modules/@deepseek-ai/dsh-web-app/package.json": '{"name":"@deepseek-ai/dsh-web-app"}',
    "node_modules/@deepseek-ai/dsh-web-frontend/package.json": '{"name":"@deepseek-ai/dsh-web-frontend"}',
    "node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html": "<html></html>",
    "anchor.js": "",
  });
  const resolved = resolveShellRoot({}, join(root, "anchor.js"));
  assert.equal(resolved, join(root, "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist"));
});

test("resolveShellRoot：解析不到时返回 undefined 而不是抛错", () => {
  assert.equal(resolveShellRoot({}, "C:/definitely/not/a/module/entry.js"), undefined);
});

// ---------------------------------------------------------------- apply 接线

test("createDietHandlers：缺少 clientModules.bundleResource 时抛错", () => {
  assert.throws(() => createDietHandlers({}), /缺少 clientModules\.bundleResource/);
  assert.throws(() => createDietHandlers({ registry: {} }), /缺少 clientModules\.bundleResource/);
});

test("apply：enabled=false 时不注册任何路由与 tap", () => {
  const server = fakeServer();
  const { ctx, effects } = fakeContext(server, registryOf(Buffer.from("x")));
  apply(ctx, { enabled: false });
  assert.equal(server.routes.length, 0);
  assert.equal(server.taps.length, 0);
  assert.equal(effects.length, 0);
});

test("apply：启用后注册三条路由与一个 tap，卸载后全部释放", (t) => {
  const root = tempDist(t, { "index.html": "<html></html>", "assets/app.js": "x" });
  const server = fakeServer();
  const { ctx, effects } = fakeContext(server, registryOf(Buffer.from("x")));
  apply(ctx, { shellRoot: root });
  assert.deepEqual(server.routes.map((route) => route.path).sort(), ["/assets", "/dsh-diet/asset", "/dsh-diet/combo"]);
  assert.equal(server.taps.length, 1);
  for (const disposer of effects) if (typeof disposer === "function") disposer();
  assert.equal(server.routes.length, 0);
  assert.equal(server.taps.length, 0);
});

test("apply：shellCache=false 时只注册两条路由", () => {
  const server = fakeServer();
  const { ctx } = fakeContext(server, registryOf(Buffer.from("x")));
  apply(ctx, { shellCache: false });
  assert.deepEqual(server.routes.map((route) => route.path).sort(), ["/dsh-diet/asset", "/dsh-diet/combo"]);
});

test("apply：配置项真的透传下去了（minAssetBytes=0 时 1500 字节的图应外置）", async () => {
  const uri = dataUri("image/png", Buffer.alloc(1500, 4));
  const server = fakeServer();
  const { ctx } = fakeContext(server, registryOf(Buffer.from(`"${uri}";`)));
  apply(ctx, { shellCache: false, minAssetBytes: 0 });
  const combo = server.routes.find((route) => route.path === "/dsh-diet/combo");
  const res = fakeRes();
  await combo.handler(fakeReq("GET", "/dsh-diet/combo/??x/client.js&rev=1"), res);
  assert.ok(res.body.toString("utf8").includes("/dsh-diet/asset/"));
});

test("apply：dist 目录不可用时记一条 warn 并跳过 /assets 路由", () => {
  const server = fakeServer();
  const warnings = [];
  const { ctx } = fakeContext(server, registryOf(Buffer.from("x")), {
    warn: (message) => warnings.push(message),
    info() {},
  });
  apply(ctx, { shellRoot: "C:/definitely/not/here" });
  assert.equal(warnings.length, 1);
  assert.deepEqual(server.routes.map((route) => route.path).sort(), ["/dsh-diet/asset", "/dsh-diet/combo"]);
});

test("apply：插件的 tap 真的会把 HTML 里的 combo 地址指过来", (t) => {
  const root = tempDist(t, { "index.html": "<html></html>", "assets/app.js": "x" });
  const server = fakeServer();
  const { ctx } = fakeContext(server, registryOf(Buffer.from("x")));
  apply(ctx, { shellRoot: root });
  const html = '<script src="plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=1"></script>';
  assert.ok(server.taps[0](html).includes("dsh-diet/combo/??"));
});

// ---------------------------------------------------------------- 首屏窗口

/** 会话控制器客户端包里那两处调用点的真实形状（缩进无关）。 */
const OPEN_CALL = "await events.open(HISTORY_PAGE_OPTIONS);";
const OLDER_CALL = "await events.prepend({ beforeSeq: this.baseSeq, ...HISTORY_PAGE_OPTIONS });";

test("narrowOpenWindow：命中时换成给定参数，回补那一处不动", () => {
  const source = `${OPEN_CALL}\n${OLDER_CALL}`;
  const { code, applied } = narrowOpenWindow(source, { maxMessages: 60, minMessages: 12, minTurns: 2 });
  assert.equal(applied, true);
  assert.ok(code.includes("maxMessages: 60"));
  assert.ok(code.includes("minMessages: 12"));
  assert.ok(code.includes("minTurns: 2"));
  assert.ok(!code.includes("events.open(HISTORY_PAGE_OPTIONS)"));
  // 「加载更早」必须保持原样，否则点一次只补一点点。
  assert.ok(code.includes(OLDER_CALL));
});

test("narrowOpenWindow：未命中时原样返回并给出原因", () => {
  const source = "const a = 1;";
  const result = narrowOpenWindow(source);
  assert.equal(result.applied, false);
  assert.equal(result.code, source);
  assert.match(result.reason, /未命中/);
});

test("narrowOpenWindow：锚点出现两次时放弃改写", () => {
  // 上游若重构出两处相同调用，盲目替换会把回补也改掉，那时宁可不动。
  const source = `${OPEN_CALL}\n${OPEN_CALL}`;
  const result = narrowOpenWindow(source);
  assert.equal(result.applied, false);
  assert.equal(result.code, source);
  assert.match(result.reason, /2 次/);
});

test("narrowOpenWindow：开关关闭与非字符串输入都原样返回", () => {
  assert.equal(narrowOpenWindow(OPEN_CALL, { enabled: false }).applied, false);
  assert.equal(narrowOpenWindow(undefined).applied, false);
  assert.equal(narrowOpenWindow(undefined).code, undefined);
});

test("narrowOpenWindow：越界参数被夹紧而不是退回默认", () => {
  const loose = narrowOpenWindow(OPEN_CALL, { maxMessages: 900 }).code;
  assert.ok(loose.includes("maxMessages: 500"));
  const zero = narrowOpenWindow(OPEN_CALL, { maxMessages: 0, minMessages: 0, minTurns: 0 }).code;
  assert.ok(zero.includes("maxMessages: 1"));
  assert.ok(zero.includes("minMessages: 1"));
  assert.ok(zero.includes("minTurns: 1"));
});

test("narrowOpenWindow：minMessages 不会超过 maxMessages", () => {
  const code = narrowOpenWindow(OPEN_CALL, { maxMessages: 20, minMessages: 200 }).code;
  assert.ok(code.includes("minMessages: 20"));
});

test("normalizeConfig：openWindow 默认 60 / 12 / 2 且开启", () => {
  assert.deepEqual(normalizeConfig({}).openWindow, {
    enabled: true,
    maxMessages: 60,
    minMessages: 12,
    minTurns: 2,
  });
});

test("normalizeConfig：openWindow 可关、可改，并被夹紧", () => {
  assert.equal(normalizeConfig({ openWindow: { enabled: false } }).openWindow.enabled, false);
  const config = normalizeConfig({ openWindow: { maxMessages: 999, minMessages: -5, minTurns: 99 } });
  assert.equal(config.openWindow.maxMessages, 500);
  // 负数按「没填」处理，退回默认而不是夹到 1：与其余数字项同一套语义。
  assert.equal(config.openWindow.minMessages, 12);
  assert.equal(config.openWindow.minTurns, 20);
});

test("combo：会话控制器的包里首屏窗口被改写", async () => {
  const registry = registryOf(Buffer.from(`${OPEN_CALL}\n${OLDER_CALL}`));
  const handlers = createDietHandlers({ registry });
  const res = fakeRes();
  const url = "/dsh-diet/combo/??@deepseek-ai/dsh-api-session-controller/client.js&rev=abc";
  await handlers.combo(fakeReq("GET", url), res);
  const body = res.body.toString("utf8");
  assert.ok(body.includes("maxMessages: 60"));
  assert.ok(body.includes(OLDER_CALL));
  assert.equal(handlers.stats().windowsNarrowed, 1);
  assert.equal(handlers.stats().windowsMissed, 0);
});

test("combo：别的 bundle 不改写，也不计入未命中", async () => {
  const registry = registryOf(Buffer.from("const a = 1;"));
  const handlers = createDietHandlers({ registry });
  const res = fakeRes();
  await handlers.combo(fakeReq("GET", "/dsh-diet/combo/??@deepseek-ai/dsh-api-gateway/client.js&rev=1"), res);
  assert.equal(res.body.toString("utf8"), "const a = 1;");
  assert.equal(handlers.stats().windowsNarrowed, 0);
  assert.equal(handlers.stats().windowsMissed, 0);
});

test("combo：会话控制器包未命中时告警一次并原样返回", async () => {
  const warnings = [];
  const registry = registryOf(Buffer.from("const a = 1;"));
  const handlers = createDietHandlers({ registry, logger: { warn: (m) => warnings.push(m) } });
  const first = fakeRes();
  const second = fakeRes();
  // 两次必须用不同的 rev：同一个 URL 第二次会命中 combo 的 computed 缓存，
  // 根本不会再走一遍 build，这条用例就测不到「只 warn 一次」。
  await handlers.combo(fakeReq("GET", "/dsh-diet/combo/??@deepseek-ai/dsh-api-session-controller/client.js&rev=1"), first);
  await handlers.combo(fakeReq("GET", "/dsh-diet/combo/??@deepseek-ai/dsh-api-session-controller/client.js&rev=2"), second);
  assert.equal(first.body.toString("utf8"), "const a = 1;");
  assert.equal(second.body.toString("utf8"), "const a = 1;");
  assert.equal(handlers.stats().windowsMissed, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /首屏窗口改写未命中/);
});

test("combo：openWindow.enabled=false 时窗口保持上游原样", async () => {
  const registry = registryOf(Buffer.from(OPEN_CALL));
  const handlers = createDietHandlers({ registry, openWindow: { enabled: false, maxMessages: 60, minMessages: 12, minTurns: 2 } });
  const res = fakeRes();
  await handlers.combo(fakeReq("GET", "/dsh-diet/combo/??@deepseek-ai/dsh-api-session-controller/client.js&rev=1"), res);
  assert.ok(res.body.toString("utf8").includes("events.open(HISTORY_PAGE_OPTIONS)"));
});

test("apply：首屏窗口配置真的透传下去了", async () => {
  const server = fakeServer();
  const { ctx } = fakeContext(server, registryOf(Buffer.from(OPEN_CALL)));
  apply(ctx, { shellCache: false, openWindow: { maxMessages: 40, minMessages: 8 } });
  const combo = server.routes.find((route) => route.path === "/dsh-diet/combo");
  const res = fakeRes();
  await combo.handler(fakeReq("GET", "/dsh-diet/combo/??@deepseek-ai/dsh-api-session-controller/client.js&rev=1"), res);
  assert.ok(res.body.toString("utf8").includes("maxMessages: 40"));
});
