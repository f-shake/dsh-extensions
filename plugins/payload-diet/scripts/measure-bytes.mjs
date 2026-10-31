// 量化探针：改造前后用同一条命令量同样四件事。
//
//   node plugins/payload-diet/scripts/measure-bytes.mjs --url "http://127.0.0.1:8791/?token=..." --label before
//   node plugins/payload-diet/scripts/measure-bytes.mjs --url "..." --label after --baseline ./.measure/before.json
//
// 指标：
//   M1 冷加载字节  —— 空 profile 导航到首页后 15 s 内所有 HTTP 响应体字节 + WebSocket 帧字节
//   M2 刷新字节    —— 同一页面 reload（不走强制无缓存）后 9 s 的同一统计
//   M3 重连字节    —— 关掉 carrier socket、等客户端自己重连后 12 s 的 HTTP 增量
//   M4 首屏可用    —— 导航到 #root 出现子节点的毫秒数（MutationObserver 在文档起点打点）
//
// 只用 Node 内置能力 + 工作区里 ws 包（CDP 传输），不装任何依赖。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const require = createRequire("C:/Running/dsh/");
const WebSocket = require("ws");

/** 解析 --key value 形式的参数。 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) out[key] = true;
    else {
      out[key] = value;
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (typeof args.url !== "string") {
  console.error('用法: node plugins/payload-diet/scripts/measure-bytes.mjs --url "<带 token 的首页地址>" [--label 名字] [--json 输出路径] [--baseline 基线 json]');
  process.exit(2);
}

const LABEL = typeof args.label === "string" ? args.label : "run";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9900 + Math.floor(Math.random() * 90);
const PROFILE = resolve(process.env.TEMP ?? ".", `payload-diet-measure-${PORT}`);
// 上一次被强杀的运行可能留下同端口的 profile 目录，直接复用会让「冷加载」变成命中缓存的假数据。
rmSync(PROFILE, { recursive: true, force: true });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const MB = (bytes) => bytes / 1048576;

/** 文档起点注入：记录 #root 首个子节点出现的时刻，并留下 WebSocket 句柄供 M3 主动断开。 */
const INSTRUMENT = `(() => {
  const state = { readyAt: null, sockets: [] };
  window.__diet = state;
  const mark = () => {
    if (state.readyAt !== null) return;
    const root = document.getElementById("root");
    if (root !== null && root.children.length > 0) state.readyAt = performance.now();
  };
  const watch = () => {
    mark();
    new MutationObserver(mark).observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch);
  else watch();
  const Original = window.WebSocket;
  function Patched(url, protocols) {
    const socket = protocols === undefined ? new Original(url) : new Original(url, protocols);
    state.sockets.push(socket);
    return socket;
  }
  Patched.prototype = Original.prototype;
  Patched.CONNECTING = Original.CONNECTING;
  Patched.OPEN = Original.OPEN;
  Patched.CLOSING = Original.CLOSING;
  Patched.CLOSED = Original.CLOSED;
  window.WebSocket = Patched;
})();`;

/** 连上 CDP。 */
function cdp(wsUrl) {
  return new Promise((done, fail) => {
    const socket = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    let id = 0;
    const pending = new Map();
    socket.on("open", () =>
      done({
        send(method, params = {}, sessionId) {
          const mid = (id += 1);
          return new Promise((res, rej) => {
            pending.set(mid, { res, rej });
            socket.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
          });
        },
        on(fn) {
          socket.on("message", fn);
        },
        close() {
          socket.close();
        },
      }),
    );
    socket.on("error", fail);
    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.id && pending.has(message.id)) {
        const { res, rej } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) rej(new Error(JSON.stringify(message.error)));
        else res(message.result);
      }
    });
  });
}

const browser = spawn(EDGE, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-gpu",
  "about:blank",
], { stdio: "ignore" });

/** 一次请求的记账。 */
function newRecord(url) {
  return { url, wire: 0, cache: null };
}

try {
  let version;
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      version = await response.json();
      break;
    } catch {
      await sleep(250);
    }
  }
  if (version === undefined) throw new Error("无法连接到 headless 浏览器");

  const client = await cdp(version.webSocketDebuggerUrl);
  const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
  const call = (method, params) => client.send(method, params, sessionId);

  const requests = new Map();
  const phases = [];
  let websocketBytes = 0;
  let socketCreations = 0;

  client.on((raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.sessionId !== sessionId) return;
    const { method, params } = message;
    if (method === "Network.requestWillBeSent") {
      requests.set(params.requestId, newRecord(params.request.url));
    } else if (method === "Network.responseReceived") {
      const record = requests.get(params.requestId);
      if (record !== undefined) {
        record.cache = params.response.fromDiskCache ? "disk" : params.response.fromMemoryCache ? "memory" : "network";
      }
    } else if (method === "Network.loadingFinished") {
      const record = requests.get(params.requestId);
      if (record !== undefined) record.wire = params.encodedDataLength;
    } else if (method === "Network.webSocketFrameReceived" || method === "Network.webSocketFrameSent") {
      // payloadData 是字符串，按 UTF-16 码元算会把中文帧低算；一律折成字节数。
      websocketBytes += Buffer.byteLength(params.response.payloadData ?? "", "utf8");
    } else if (method === "Network.webSocketCreated") {
      socketCreations += 1;
    }
  });

  await call("Runtime.enable");
  await call("Page.enable");
  await call("Network.enable");
  await call("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT });

  /** 记下当前水位，之后结算这一段的增量。 */
  const markPhase = () => {
    phases.push({ all: requests.size, ws: websocketBytes, sockets: socketCreations, at: Date.now() });
  };
  markPhase();

  await call("Page.navigate", { url: args.url });
  await sleep(15000);
  const ready = await call("Runtime.evaluate", {
    expression: "String(window.__diet && window.__diet.readyAt)",
    returnByValue: true,
  });
  markPhase();

  await call("Page.reload", { ignoreCache: false });
  await sleep(9000);
  markPhase();

  const closed = await call("Runtime.evaluate", {
    expression: "String((window.__diet && window.__diet.sockets || []).map((s) => s.close() ?? 1).length)",
    returnByValue: true,
  });
  await sleep(12000);
  markPhase();

  /** 结算某一段。 */
  const settle = (index) => {
    const from = phases[index];
    const to = phases[index + 1];
    const slice = [...requests.values()].slice(from.all, to.all);
    const wire = slice.reduce((sum, record) => sum + record.wire, 0);
    const top = slice
      .filter((record) => record.wire > 0)
      .sort((a, b) => b.wire - a.wire)
      .slice(0, 8)
      .map((record) => ({ url: record.url.replace(/^https?:\/\/[^/]+/, ""), kb: Math.round(record.wire / 1024), cache: record.cache }));
    const wsBytes = to.ws - from.ws;
    return {
      httpBytes: wire,
      wsBytes,
      bytes: wire + wsBytes,
      requests: slice.length,
      socketsOpened: to.sockets - from.sockets,
      top,
    };
  };

  const cold = settle(0);
  const reload = settle(1);
  const reconnect = settle(2);
  const reconnected = reconnect.socketsOpened > 0;
  const readyMs = Number(ready.result?.value ?? "NaN");

  const result = {
    label: LABEL,
    url: args.url.replace(/token=[^&]+/, "token=***"),
    measuredAt: new Date().toISOString(),
    m1ColdBytes: cold.bytes,
    m2ReloadBytes: reload.bytes,
    m3ReconnectBytes: reconnect.bytes,
    m3HttpBytes: reconnect.httpBytes,
    m3WsBytes: reconnect.wsBytes,
    m3Reconnected: reconnected,
    m4ReadyMs: Number.isFinite(readyMs) ? Math.round(readyMs) : null,
    detail: { cold, reload, reconnect, closedSockets: closed.result?.value },
  };

  if (typeof args.json === "string") {
    const target = resolve(args.json);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(`已写入 ${target}`);
  }

  const baseline = typeof args.baseline === "string" ? JSON.parse(readFileSync(resolve(args.baseline), "utf8")) : undefined;
  const rows = [
    ["M1 冷加载", baseline?.m1ColdBytes, cold.bytes],
    ["M2 刷新", baseline?.m2ReloadBytes, reload.bytes],
    ["M3 重连", baseline?.m3ReconnectBytes, reconnect.bytes],
  ];
  console.log(`\n=== ${LABEL} ===`);
  for (const [name, base, now] of rows) {
    const delta = base === undefined ? "" : `${(((now - base) / base) * 100).toFixed(1)}%`;
    console.log(`${name.padEnd(10)} ${MB(now).toFixed(2)} MB（${Math.round(now / 1024)} KB）  基线 ${base === undefined ? "-" : `${MB(base).toFixed(2)} MB`}  差值 ${delta || "-"}`);
  }
  console.log(`   └ M3 拆分：HTTP ${Math.round(reconnect.httpBytes / 1024)} KB（本插件应几乎不变）+ WS ${Math.round(reconnect.wsBytes / 1024)} KB，重连${reconnected ? "已发生" : "未发生（数据不可用）"}`);
  console.log(`M4 首屏可用  ${result.m4ReadyMs === null ? "未测到" : `${result.m4ReadyMs} ms`}${baseline?.m4ReadyMs ? `  基线 ${baseline.m4ReadyMs} ms` : ""}`);
  if (baseline !== undefined && baseline.m4ReadyMs && result.m4ReadyMs !== null) {
    console.log(`M4 差值      ${(((result.m4ReadyMs - baseline.m4ReadyMs) / baseline.m4ReadyMs) * 100).toFixed(1)}%`);
  }
  console.log("\n最大的几笔（冷加载）：");
  for (const item of cold.top) console.log(`  ${String(item.kb).padStart(6)} KB [${item.cache}] ${item.url.slice(0, 96)}`);
  console.log("\n最大的几笔（刷新）：");
  for (const item of reload.top) console.log(`  ${String(item.kb).padStart(6)} KB [${item.cache}] ${item.url.slice(0, 96)}`);

  client.close();
} catch (error) {
  console.error("测量失败：", error);
  process.exitCode = 1;
} finally {
  try {
    browser.kill();
  } catch {
    /* 浏览器可能已退出 */
  }
  try {
    rmSync(PROFILE, { recursive: true, force: true });
  } catch {
    /* 临时用户目录删不掉不影响测量结果 */
  }
}

