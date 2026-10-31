import test from "node:test";
import assert from "node:assert/strict";

import {
  apply,
  compressOptions,
  findWebSocketServer,
  install,
  normalizeConfig,
  patchWebSocketServer,
} from "../index.js";

/** 一个最小的 ws 服务端替身：只保留补丁用到的 options 与 handleUpgrade。 */
function fakeWebSocketServer() {
  return class FakeWebSocketServer {
    constructor(options) {
      this.options = options;
      this.upgrades = [];
    }

    handleUpgrade(request, socket, head, callback) {
      this.upgrades.push({ request, socket, head, callback, options: this.options });
      return "upgraded";
    }
  };
}

/** 缓存键按真实安装树的形状造，补丁靠它认出同一个 ws 实例。 */
const WS_CACHE_KEY = "C:\\Running\\dsh\\node_modules\\ws\\lib\\websocket-server.js";

/** 记录日志与 effect 的 Cordis 上下文替身。 */
function fakeCtx() {
  const effects = [];
  const warnings = [];
  const infos = [];
  return {
    effects,
    warnings,
    infos,
    logger: {
      warn: (message) => warnings.push(message),
      info: (message) => infos.push(message),
    },
    effect(factory) {
      effects.push(factory());
    },
  };
}

test("默认配置：开启、阈值 1024、级别 6", () => {
  const config = normalizeConfig(undefined);
  assert.equal(config.enabled, true);
  assert.equal(config.threshold, 1024);
  assert.equal(config.level, 6);
  assert.equal(config.verbose, false);
});

test("配置可覆盖阈值与级别", () => {
  const config = normalizeConfig({ threshold: 4096, level: 9, verbose: true });
  assert.equal(config.threshold, 4096);
  assert.equal(config.level, 9);
  assert.equal(config.verbose, true);
});

test("空串与 null 退回默认值，不当成 0", () => {
  // Number(null) 与 Number("") 都是 0，直接比较会把「没填」误判成「压所有帧」。
  assert.equal(normalizeConfig({ threshold: null }).threshold, 1024);
  assert.equal(normalizeConfig({ threshold: "" }).threshold, 1024);
  assert.equal(normalizeConfig({ threshold: "   " }).threshold, 1024);
  assert.equal(normalizeConfig({ threshold: "4096" }).threshold, 4096);
});

test("阈值 0 是合法值：等于压所有帧", () => {
  assert.equal(normalizeConfig({ threshold: 0 }).threshold, 0);
});

test("负数、非有限数的阈值退回默认值", () => {
  assert.equal(normalizeConfig({ threshold: -1 }).threshold, 1024);
  assert.equal(normalizeConfig({ threshold: Number.POSITIVE_INFINITY }).threshold, 1024);
  assert.equal(normalizeConfig({ threshold: Number.NaN }).threshold, 1024);
  assert.equal(normalizeConfig({ threshold: true }).threshold, 1024);
});

test("级别越界退回默认档，避免 zlib 抛错打断启动", () => {
  assert.equal(normalizeConfig({ level: 0 }).level, 6);
  assert.equal(normalizeConfig({ level: 10 }).level, 6);
  assert.equal(normalizeConfig({ level: -3 }).level, 6);
  assert.equal(normalizeConfig({ level: 1 }).level, 1);
});

test("enabled:false 时归一化结果如实反映", () => {
  assert.equal(normalizeConfig({ enabled: false }).enabled, false);
});

test("pathPrefix 默认只认 mux，空串退回默认，* 表示不限制", () => {
  assert.equal(normalizeConfig({}).pathPrefix, "/api/remote.mux");
  assert.equal(normalizeConfig({ pathPrefix: "   " }).pathPrefix, "/api/remote.mux");
  assert.equal(normalizeConfig({ pathPrefix: "*" }).pathPrefix, "*");
  assert.equal(normalizeConfig({ pathPrefix: "/ws/" }).pathPrefix, "/ws/");
});

test("compressOptions 只交出 ws 认得的字段", () => {
  assert.deepEqual(compressOptions({ threshold: 2048, level: 4 }), {
    threshold: 2048,
    zlibDeflateOptions: { level: 4 },
  });
});

test("findWebSocketServer 认出真实形状：websocket-server.js 直接导出类", () => {
  // ws/lib/websocket-server.js 是 `module.exports = WebSocketServer`，不是具名导出。
  const Server = fakeWebSocketServer();
  const loader = {
    cache: { [WS_CACHE_KEY]: { exports: Server } },
    load: () => {
      throw new Error("不该走到 require");
    },
  };
  assert.equal(findWebSocketServer(loader), Server);
});

test("findWebSocketServer 也认具名导出与 default 导出", () => {
  const Server = fakeWebSocketServer();
  const named = {
    cache: { [WS_CACHE_KEY]: { exports: { WebSocketServer: Server } } },
    load: () => ({}),
  };
  const dflt = { cache: { [WS_CACHE_KEY]: { exports: { default: Server } } }, load: () => ({}) };
  assert.equal(findWebSocketServer(named), Server);
  assert.equal(findWebSocketServer(dflt), Server);
});

/** 一次 mux 升级请求的最小替身：只带 url，因为补丁按路径过滤。 */
function muxRequest() {
  return { url: "/api/remote.mux?interactions=none" };
}

test("findWebSocketServer 缓存里没有再回落到 require", () => {
  const Server = fakeWebSocketServer();
  let loaded = 0;
  const loader = {
    cache: { "C:\\Running\\dsh\\node_modules\\ws\\index.js": { exports: {} } },
    load(id) {
      loaded += 1;
      assert.equal(id, "ws");
      return { WebSocketServer: Server };
    },
  };
  assert.equal(findWebSocketServer(loader), Server);
  assert.equal(loaded, 1);
});

test("findWebSocketServer 发现多份 ws 时回调告警，并返回第一个", () => {
  const first = fakeWebSocketServer();
  const second = fakeWebSocketServer();
  const loader = {
    cache: {
      "C:\\dsh\\node_modules\\ws\\lib\\websocket-server.js": { exports: first },
      "C:\\dsh\\node_modules\\dep\\node_modules\\ws\\lib\\websocket-server.js": { exports: second },
    },
    load: () => ({}),
  };
  let reported = 0;
  assert.equal(
    findWebSocketServer(loader, (count) => {
      reported = count;
    }),
    first,
  );
  assert.equal(reported, 2, "多份时要告警，否则打错补丁也没人知道");
});

test("findWebSocketServer 只有一份时不告警", () => {
  const Server = fakeWebSocketServer();
  const loader = { cache: { [WS_CACHE_KEY]: { exports: Server } }, load: () => ({}) };
  let reported = 0;
  findWebSocketServer(loader, () => {
    reported += 1;
  });
  assert.equal(reported, 0);
});

test("findWebSocketServer 两处都没有时返回 undefined", () => {
  const loader = {
    cache: {},
    load() {
      throw new Error("MODULE_NOT_FOUND");
    },
  };
  assert.equal(findWebSocketServer(loader), undefined);
});

test("findWebSocketServer 跳过没有 handleUpgrade 的候选", () => {
  const loader = {
    cache: { [WS_CACHE_KEY]: { exports: { WebSocketServer: class {} } } },
    load: () => ({}),
  };
  assert.equal(findWebSocketServer(loader), undefined);
});

test("findWebSocketServer 没有加载器时返回 undefined", () => {
  assert.equal(findWebSocketServer(undefined), undefined);
});

test("patchWebSocketServer 在升级前注入 perMessageDeflate", () => {
  const Server = fakeWebSocketServer();
  const options = { threshold: 1024, zlibDeflateOptions: { level: 6 } };
  const result = patchWebSocketServer(Server, options);
  assert.equal(result.patched, true);

  const server = new Server({ noServer: true });
  const request = muxRequest();
  const socket = { id: "socket" };
  const callback = () => {};
  const returned = server.handleUpgrade(request, socket, "head", callback);

  assert.equal(returned, "upgraded");
  assert.equal(server.upgrades.length, 1);
  // 参数必须原样转发：这里换了参数，握手就断了。
  assert.equal(server.upgrades[0].request, request);
  assert.equal(server.upgrades[0].socket, socket);
  assert.equal(server.upgrades[0].head, "head");
  assert.equal(server.upgrades[0].callback, callback);
  assert.deepEqual(server.options.perMessageDeflate, options);
});

test("patchWebSocketServer 只对 mux 路径生效，别的升级不碰", () => {
  const Server = fakeWebSocketServer();
  patchWebSocketServer(Server, { threshold: 1024 });
  const server = new Server({ noServer: true });

  server.handleUpgrade({ url: "/other/socket" }, {}, "", () => {});
  assert.equal(server.options.perMessageDeflate, undefined, "别的路径不该被改");

  server.handleUpgrade(muxRequest(), {}, "", () => {});
  assert.deepEqual(server.options.perMessageDeflate, { threshold: 1024 });
});

test("patchWebSocketServer 的 pathPrefix 配成 * 时不限制路径", () => {
  const Server = fakeWebSocketServer();
  patchWebSocketServer(Server, { threshold: 1024 }, { pathPrefix: "*" });
  const server = new Server({ noServer: true });
  server.handleUpgrade({ url: "/elsewhere" }, {}, "", () => {});
  assert.deepEqual(server.options.perMessageDeflate, { threshold: 1024 });
});

test("patchWebSocketServer 不覆盖别处显式配好的压缩选项", () => {
  const Server = fakeWebSocketServer();
  patchWebSocketServer(Server, { threshold: 1024 });
  const explicit = { threshold: 32 };
  const server = new Server({ noServer: true, perMessageDeflate: explicit });
  server.handleUpgrade(muxRequest(), {}, "", () => {});
  assert.deepEqual(server.options.perMessageDeflate, explicit);
});

test("patchWebSocketServer 对 options 缺失的实例也不炸", () => {
  const Server = fakeWebSocketServer();
  patchWebSocketServer(Server, { threshold: 1024 });
  const server = new Server(undefined);
  assert.equal(server.handleUpgrade(muxRequest(), {}, "", () => {}), "upgraded");
});

test("重复 patch 返回未打补丁并说明原因", () => {
  const Server = fakeWebSocketServer();
  const options = { threshold: 1024 };
  assert.equal(patchWebSocketServer(Server, options).patched, true);
  const second = patchWebSocketServer(Server, options);
  assert.equal(second.patched, false);
  assert.match(second.reason, /已经打过补丁/);
  // 没有套娃：一次升级只记录一次。
  const server = new Server({ noServer: true });
  server.handleUpgrade(muxRequest(), {}, "", () => {});
  assert.equal(server.upgrades.length, 1);
});

test("类上没有 handleUpgrade 时安全跳过", () => {
  const result = patchWebSocketServer(class {}, { threshold: 1024 });
  assert.equal(result.patched, false);
  assert.match(result.reason, /handleUpgrade/);
  assert.doesNotThrow(() => result.restore());
});

test("restore 把原型还原成原函数，并撤掉已注入实例上的选项", () => {
  const Server = fakeWebSocketServer();
  const original = Server.prototype.handleUpgrade;
  const result = patchWebSocketServer(Server, { threshold: 1024 });

  // 先让一个实例真的被升级过一次：补丁写进了它的 options。
  const live = new Server({ noServer: true });
  live.handleUpgrade(muxRequest(), {}, "", () => {});
  assert.deepEqual(live.options.perMessageDeflate, { threshold: 1024 });

  result.restore();
  assert.equal(Server.prototype.handleUpgrade, original);
  // 只还原原型是不够的：已经升级过的实例会继续压缩。
  assert.equal(live.options.perMessageDeflate, undefined, "已注入的实例必须被撤回");

  // 还原之后新建的实例也不再被注入。
  const fresh = new Server({ noServer: true });
  fresh.handleUpgrade(muxRequest(), {}, "", () => {});
  assert.equal(fresh.options.perMessageDeflate, undefined);
});

test("restore 幂等：调用两次不抛错", () => {
  const Server = fakeWebSocketServer();
  const result = patchWebSocketServer(Server, { threshold: 1024 });
  result.restore();
  assert.doesNotThrow(() => result.restore());
});

test("install 找不到 ws 时告警且不抛，也不注册 effect", () => {
  const ctx = fakeCtx();
  const loader = {
    cache: {},
    load() {
      throw new Error("MODULE_NOT_FOUND");
    },
  };
  assert.equal(install(ctx, normalizeConfig({}), loader), false);
  assert.equal(ctx.effects.length, 0);
  assert.match(ctx.warnings[0], /未找到 ws 模块/);
});

test("install 成功后注册还原器，卸载即恢复原型", () => {
  const Server = fakeWebSocketServer();
  const original = Server.prototype.handleUpgrade;
  const ctx = fakeCtx();
  const loader = { cache: { [WS_CACHE_KEY]: { exports: { WebSocketServer: Server } } }, load: () => ({}) };

  assert.equal(install(ctx, normalizeConfig({ verbose: true }), loader), true);
  assert.notEqual(Server.prototype.handleUpgrade, original);
  assert.equal(ctx.effects.length, 1);
  assert.match(ctx.infos[0], /permessage-deflate/);

  ctx.effects[0]();
  assert.equal(Server.prototype.handleUpgrade, original);
});

test("install 对已打过补丁的类只告警，不重复挂还原器", () => {
  const Server = fakeWebSocketServer();
  const loader = { cache: { [WS_CACHE_KEY]: { exports: { WebSocketServer: Server } } }, load: () => ({}) };
  const first = fakeCtx();
  assert.equal(install(first, normalizeConfig({}), loader), true);

  const second = fakeCtx();
  assert.equal(install(second, normalizeConfig({}), loader), false);
  assert.match(second.warnings[0], /已经打过补丁/);
  assert.equal(second.effects.length, 0);
});

test("install 在 enabled:false 时完全不动手", () => {
  const Server = fakeWebSocketServer();
  const original = Server.prototype.handleUpgrade;
  const ctx = fakeCtx();
  const loader = { cache: { [WS_CACHE_KEY]: { exports: { WebSocketServer: Server } } }, load: () => ({}) };
  assert.equal(install(ctx, normalizeConfig({ enabled: false }), loader), false);
  assert.equal(Server.prototype.handleUpgrade, original);
  assert.equal(ctx.effects.length, 0);
});

test("apply 在找不到 ws 或已被打过补丁时不抛错", () => {
  const ctx = fakeCtx();
  assert.doesNotThrow(() => apply(ctx, { enabled: true, verbose: true }));
});
