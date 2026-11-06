/**
 * 给 `/api/remote.mux` 的 WebSocket 打开压缩。
 *
 * 会话内容（`session/follow` 的首包）走的是这条 WebSocket，不经过 HTTP 的
 * compression 中间件：实测同一条会话 2.2 MB 的 JSON 原样过隧道，而它 gzip 之后
 * 只有 613 KB。DSH 的 gateway 用 `new WebSocketServer({ noServer: true })` 建
 * 服务端，`ws` 对 `perMessageDeflate` 的默认值是 false，所以握手协商结果为空。
 *
 * 不直接改 `C:\Running\dsh\node_modules` 里的 gateway 源码，而是在运行期包一层
 * `WebSocketServer.prototype.handleUpgrade`：`ws` 在**每次升级时**才读
 * `this.options.perMessageDeflate`（websocket-server.js 第 299 行），所以提前把
 * 这个选项补进实例上即可生效，且升级 dsh 后无需重新打补丁。补丁点一旦变化，
 * 这里会安全跳过并告警，不影响宿主启动。
 */

import { createRequire } from "node:module";
import { join } from "node:path";

export const name = "mux-deflate";

/** 压缩阈值：低于该字节数的消息不压缩，避免给大量碎小帧白付 CPU。 */
const DEFAULT_THRESHOLD = 1024;

/** zlib 压缩级别；6 是 zlib 的默认档，JSON 文本上再高收益很小。 */
const DEFAULT_LEVEL = 6;

/** `ws` 服务端实现所在的模块路径，用来在已被加载的模块里认出同一个实例。 */
const WS_SERVER_MODULE = /[\\/]ws[\\/]lib[\\/]websocket-server\.js$/;

/** 标记已打过补丁的原函数，避免重复 apply（热重载）时套娃。 */
const PATCHED = Symbol.for("mux-deflate.patched");

/**
 * 默认只认这一条升级路径。
 *
 * 补丁打在原型上，进程内每个 `ws` 服务端的升级都会经过它；不按路径过滤的话，
 * 插件会悄悄改变别的服务端（含第三方插件新建的）的协商行为，而本插件的承诺
 * 只有 `/api/remote.mux` 一条。配成 `*` 表示不限制。
 */
const DEFAULT_PATH_PREFIX = "/api/remote.mux";

/**
 * 数字型配置项的归一化：null、空串、布尔、非有限数一律退回默认值。
 * `Number(null) === 0`、`Number("") === 0`，直接比较会把「没填」当成「填了 0」，
 * 而 0 在这里等于压所有帧，症状还伪装成正常回退。
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
 * @returns {{ enabled: boolean, threshold: number, level: number, verbose: boolean }} 归一化后的配置。
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const level = numberOption(source.level, DEFAULT_LEVEL);
  const prefix = typeof source.pathPrefix === "string" ? source.pathPrefix.trim() : DEFAULT_PATH_PREFIX;
  return {
    enabled: source.enabled !== false,
    threshold: numberOption(source.threshold, DEFAULT_THRESHOLD),
    // zlib 只接受 1..9；越界直接退回默认档，而不是让它抛到启动路径上。
    level: level >= 1 && level <= 9 ? level : DEFAULT_LEVEL,
    verbose: source.verbose === true,
    // 空串按「没填」处理，回到默认路径，而不是意外地放开到全进程。
    pathPrefix: prefix === "" ? DEFAULT_PATH_PREFIX : prefix,
  };
}

/**
 * 把配置翻译成 `ws` 的 perMessageDeflate 选项。
 * @param {{ threshold: number, level: number }} config - 归一化后的配置。
 * @returns {{ threshold: number, zlibDeflateOptions: { level: number } }} `ws` 认得的选项对象。
 */
export function compressOptions(config) {
  return {
    threshold: config.threshold,
    zlibDeflateOptions: { level: config.level },
  };
}

/**
 * 判断一个候选是不是可打的 `ws` 服务端类。
 * @param {unknown} candidate - 候选值。
 * @returns {boolean} 是否带 handleUpgrade 的构造函数。
 */
function isWebSocketServer(candidate) {
  return typeof candidate === "function" && typeof candidate.prototype?.handleUpgrade === "function";
}

/**
 * 找出宿主进程里**正在使用**的那个 `ws` 服务端类。
 *
 * 必须是同一个模块实例才有效：`ws` 若被装了两份，补丁打在一份上另一份照旧。
 * 所以先扫已加载模块的缓存（gateway 比 profile 插件先加载，正常都能命中），
 * 命不中才真的去 require 一次。
 * @param {{ cache?: Record<string, { exports?: unknown }>, load: (id: string) => unknown } | undefined} loader - 模块加载器。
 * @returns {Function | undefined} 可打补丁的 WebSocketServer 类。
 */
export function findWebSocketServer(loader, onAmbiguous) {
  if (loader === undefined) return undefined;
  const cache = loader.cache;
  const found = [];
  if (cache !== undefined && cache !== null) {
    for (const key of Object.keys(cache)) {
      if (!WS_SERVER_MODULE.test(key)) continue;
      // ws/lib/websocket-server.js 是 `module.exports = WebSocketServer`，
      // 不是具名导出；只认 `.WebSocketServer` 的话这条分支永远命中不了。
      const exported = cache[key]?.exports;
      for (const candidate of [exported, exported?.WebSocketServer, exported?.default]) {
        if (!isWebSocketServer(candidate)) continue;
        if (!found.includes(candidate)) found.push(candidate);
        break;
      }
    }
  }
  if (found.length > 1) {
    // 进程里有多份 ws：只有 gateway 实际用的那一份能让压缩生效，而这里认不出来。
    // 打完补丁也不吭声的话，症状是「配置了却没压缩」，比不压缩更难查。
    onAmbiguous?.(found.length);
  }
  if (found.length > 0) return found[0];
  try {
    const loaded = loader.load("ws");
    for (const candidate of [loaded?.WebSocketServer, loaded]) {
      if (isWebSocketServer(candidate)) return candidate;
    }
  } catch {
    // 宿主里没有 ws（例如换成别的 WS 实现）：按「找不到」处理，调用方会告警。
  }
  return undefined;
}

/**
 * 给出宿主进程可用的模块加载器。
 *
 * 用 dsh 自己的入口文件作锚点解析，插件装在 profile 目录下也能找到 dsh 安装树里
 * 的 `ws`。拿不到入口时返回 undefined，调用方按「找不到」降级。
 * @returns {{ cache: Record<string, { exports?: unknown }>, load: (id: string) => unknown } | undefined} 加载器。
 */
export function createLoader() {
  const anchor =
    typeof process.argv[1] === "string" && process.argv[1] !== ""
      ? process.argv[1]
      : join(process.cwd(), "index.js");
  try {
    const requireFn = createRequire(anchor);
    return { cache: requireFn.cache, load: (id) => requireFn(id) };
  } catch {
    return undefined;
  }
}

/**
 * 给 WebSocketServer 打上压缩选项补丁。
 *
 * 补丁做两件事：在原 `handleUpgrade` 动手之前，把 `perMessageDeflate` 补进该实例的
 * options；并记下被补过的实例，卸载时连实例上的选项一起撤掉——只还原原型的话，
 * 已经升级过的实例身上还留着选项，压缩会继续生效，改了配置也不会重新读。
 *
 * 已经真配过 compression（对象）的实例不覆盖。注意 `ws` 的默认值就是 `false`，
 * 所以「显式传 false」与「没传」无法区分，两者都会被补上。
 * @param {Function} WebSocketServer - `ws` 的服务端类。
 * @param {object} options - 要注入的 perMessageDeflate 选项。
 * @param {{ pathPrefix?: string }} [scope] - 只对命中该前缀的升级路径生效；`*` 表示不限制。
 * @returns {{ patched: boolean, reason?: string, restore: () => void }} 打补丁的结果与还原器。
 */
export function patchWebSocketServer(WebSocketServer, options, scope = {}) {
  const proto = WebSocketServer?.prototype;
  const original = proto?.handleUpgrade;
  if (typeof original !== "function") {
    return { patched: false, reason: "ws 的 handleUpgrade 不在预期位置", restore: () => {} };
  }
  if (original[PATCHED] === true) {
    return { patched: false, reason: "已经打过补丁", restore: () => {} };
  }

  const pathPrefix = scope.pathPrefix ?? DEFAULT_PATH_PREFIX;
  const injected = new Set();

  function matches(request) {
    if (pathPrefix === "*") return true;
    const url = request?.url;
    return typeof url === "string" && url.startsWith(pathPrefix);
  }

  function handleUpgrade(request) {
    if (matches(request) && this?.options !== undefined && this.options !== null && !this.options.perMessageDeflate) {
      this.options = { ...this.options, perMessageDeflate: options };
      injected.add(this);
    }
    return original.apply(this, arguments);
  }
  handleUpgrade[PATCHED] = true;
  proto.handleUpgrade = handleUpgrade;

  return {
    patched: true,
    restore: () => {
      if (proto.handleUpgrade === handleUpgrade) proto.handleUpgrade = original;
      // 已经被补过的实例要一起撤回：只换原型，压缩会继续在它们身上生效。
      for (const server of injected) {
        if (server.options === undefined || server.options === null) continue;
        const { perMessageDeflate, ...rest } = server.options;
        server.options = rest;
      }
      injected.clear();
    },
  };
}

/**
 * 用一份已经归一化的配置完成安装：找类、打补丁、挂还原器。
 *
 * 与 `apply` 分开是为了可测：模块加载器由参数传入，测试不必去碰真实的宿主模块树。
 * @param {object} ctx - Cordis 上下文。
 * @param {ReturnType<typeof normalizeConfig>} config - 归一化后的配置。
 * @param {Parameters<typeof findWebSocketServer>[0]} loader - 模块加载器。
 * @returns {boolean} 是否成功启用压缩。
 */
export function install(ctx, config, loader) {
  if (!config.enabled) return false;

  const Server = findWebSocketServer(loader, (count) => {
    ctx.logger?.warn?.(`mux-deflate：进程里有 ${count} 份 ws，只给找到的那一份打了补丁，压缩可能不生效`);
  });
  if (Server === undefined) {
    ctx.logger?.warn?.("mux-deflate：未找到 ws 模块，压缩未启用（不影响启动）");
    return false;
  }

  const result = patchWebSocketServer(Server, compressOptions(config), { pathPrefix: config.pathPrefix });
  if (!result.patched) {
    ctx.logger?.warn?.(`mux-deflate：${result.reason}，压缩未启用`);
    return false;
  }

  if (config.verbose) {
    ctx.logger?.info?.(
      `mux-deflate：已启用 permessage-deflate（threshold ${config.threshold}，level ${config.level}）`,
    );
  }
  ctx.effect(() => result.restore, "mux-deflate: ws compression");
  return true;
}

/**
 * Cordis 插件入口：启动时给 mux 的 WebSocket 打开压缩。
 *
 * 补丁挂在 `ctx.effect` 上，插件卸载（含 dsh-hmr 重载）时还原原型，避免重复 apply
 * 把 handleUpgrade 套成两层。
 * @param {object} ctx - Cordis 上下文。
 * @param {unknown} rawConfig - Loader 行配置。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  if (!config.enabled) return;
  install(ctx, config, createLoader());
}
