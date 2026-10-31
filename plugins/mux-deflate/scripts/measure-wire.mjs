// 在 socket 层量「打开一个会话」到底传了多少字节：会话首包走 WebSocket，
// HTTP 层的字节统计看不到它，压缩（permessage-deflate）也只体现在这里。
//
//   node plugins/mux-deflate/scripts/measure-wire.mjs \
//     --url "http://127.0.0.1:8791/?token=..." \
//     --session session-800cb75e-... \
//     [--label 名字] [--max-messages 500] [--min-messages 50] [--json 输出路径]
//
// 输出的 wireBytes 是 TCP 层 counted 的字节（ws._socket.bytesRead 的差值），
// 含 WS 帧头与握手之后的全部开销；decodedBytes 是解压后的消息长度，用来看压缩比。

import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** 解析 `--key value` / `--flag` 形式的参数。 */
function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    index += 1;
  }
  return out;
}

/**
 * 取一个支持 permessage-deflate 的 WebSocket 实现。
 * Node 内置的 WebSocket 不发压缩 offer，量不出压缩效果，所以必须用 ws。
 * @param {string | undefined} dshRoot - dsh 安装目录，ws 就装在那棵树的 node_modules 里。
 * @returns {{ WebSocket: Function }} ws 的客户端类。
 */
function loadWs(dshRoot) {
  const roots = [dshRoot, process.env.DSH_ROOT, "C:/Running/dsh"].filter(Boolean);
  const anchors = [process.argv[1] ?? "", ...roots.map((root) => join(root, "package.json"))];
  for (const anchor of anchors) {
    if (anchor === "") continue;
    try {
      const requireFn = createRequire(anchor);
      const module = requireFn("ws");
      return { WebSocket: module.WebSocket };
    } catch {
      // 换下一个锚点：ws 只装在 dsh 的安装树里，插件目录下没有。
    }
  }
  throw new Error("找不到 ws 模块：用 --dsh-root 或环境变量 DSH_ROOT 指向 dsh 安装目录");
}

/** 用启动 token 换出浏览器的会话 cookie。 */
async function bootstrapCookie(url) {
  const response = await fetch(url, { redirect: "manual" });
  const cookies = response.headers.getSetCookie();
  if (cookies.length === 0) {
    throw new Error(`换 cookie 失败：状态 ${response.status}，没有 Set-Cookie`);
  }
  return cookies.map((item) => item.split(";")[0]).join("; ");
}

/** 从带 token 的页面地址推出 mux 的 ws 地址。 */
function muxUrlOf(base) {
  const parsed = new URL(base);
  const scheme = parsed.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${parsed.host}/api/remote.mux`;
}

/**
 * 打开一次会话流，记录首包到达时的 socket 字节数与耗时。
 * @param {object} options - 连接与请求参数。
 * @returns {Promise<object>} 测量结果。
 */
async function measure(options) {
  const { WebSocket } = loadWs(options.dshRoot);
  const cookie = await bootstrapCookie(options.url);
  const socket = new WebSocket(muxUrlOf(options.url), { headers: { Cookie: cookie } });

  const started = Date.now();
  let decodedBytes = 0;
  let frames = 0;
  let snapshot = null;
  let startBytes = 0;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("12 秒内没等到首包")), 12000);
    const fail = (error) => {
      clearTimeout(timer);
      reject(error);
    };

    socket.on("error", fail);
    socket.on("open", () => {
      // 握手也算流量，但从这里开始算差值是「这一次打开」的净开销。
      startBytes = socket._socket?.bytesRead ?? 0;
      socket.send(
        JSON.stringify({
          type: "open",
          streamId: "measure",
          endpoint: "session/follow",
          payload: {
            args: {
              request: {
                address: { kind: "session", sessionId: options.session },
                assistantStream: true,
                maxMessages: options.maxMessages,
                turnWindow: { minMessages: options.minMessages, minTurns: options.minTurns },
              },
            },
          },
        }),
      );
    });

    socket.on("message", (data) => {
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      frames += 1;
      decodedBytes += Buffer.byteLength(text, "utf8");
      if (snapshot !== null) return;
      if (text.includes('"type":"error"')) {
        fail(new Error(`宿主返回错误：${text.slice(0, 400)}`));
        return;
      }
      if (!text.startsWith('{"type":"item"')) return;
      const read = socket._socket?.bytesRead ?? 0;
      let records = 0;
      try {
        records = JSON.parse(text).value?.records?.length ?? 0;
      } catch {
        records = 0;
      }
      snapshot = {
        ms: Date.now() - started,
        wireBytes: read - startBytes,
        decodedBytes,
        frames,
        records,
      };
      clearTimeout(timer);
      // 首包到手就够判定了；多连一会儿只为把「之后有没有推送」也记下来。
      setTimeout(resolve, options.settleMs);
    });
  });

  // 关闭之后 socket 会被销毁，字节数要先取下来。
  const finalBytes = socket._socket?.bytesRead ?? startBytes;
  socket.close();
  return {
    label: options.label,
    session: options.session,
    maxMessages: options.maxMessages,
    minMessages: options.minMessages,
    extensions: socket.extensions,
    snapshot,
    total: {
      wireBytes: finalBytes - startBytes,
      decodedBytes,
      frames,
    },
  };
}

const args = parseArgs(process.argv.slice(2));
if (typeof args.url !== "string" || typeof args.session !== "string") {
  console.error(
    '用法: node plugins/mux-deflate/scripts/measure-wire.mjs --url "<带 token 的首页地址>" --session <sessionId> ' +
      "[--label 名字] [--max-messages 500] [--min-messages 50] [--min-turns 2] [--settle-ms 800] [--json 输出路径]",
  );
  process.exit(2);
}

const result = await measure({
  url: args.url,
  session: args.session,
  label: typeof args.label === "string" ? args.label : "未命名",
  dshRoot: typeof args["dsh-root"] === "string" ? args["dsh-root"] : undefined,
  maxMessages: Number(args["max-messages"] ?? 500),
  minMessages: Number(args["min-messages"] ?? 50),
  minTurns: Number(args["min-turns"] ?? 2),
  settleMs: Number(args["settle-ms"] ?? 800),
});

const ratio = result.snapshot.wireBytes === 0 ? 0 : result.snapshot.decodedBytes / result.snapshot.wireBytes;
console.log(`[${result.label}] 会话 ${result.session}`);
console.log(`  压缩协商: ${result.extensions === "" ? "(无)" : result.extensions}`);
console.log(
  `  首包: ${result.snapshot.ms} ms，wire ${(result.snapshot.wireBytes / 1024).toFixed(0)} KB，` +
    `解压后 ${(result.snapshot.decodedBytes / 1024).toFixed(0)} KB，记录 ${result.snapshot.records} 条，` +
    `压缩比 ${ratio.toFixed(2)}x`,
);

if (typeof args.json === "string") {
  writeFileSync(
    args.json,
    `${JSON.stringify(
      {
        ...result,
        // token 不该落进产物：留个可核对但不泄露的摘要。
        url: args.url.replace(/token=[^&]+/, "token=***"),
        at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`  已写入 ${args.json}`);
}
