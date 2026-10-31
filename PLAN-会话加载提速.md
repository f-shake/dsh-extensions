# 计划：会话加载提速（A 传输压缩 / B 首屏窗口 / C 列表缓存）

> 状态：阶段一草稿。本文件是阶段一的产物，不代表已获批准。
> 基线数据来自 2026-10-31 在 `127.0.0.1:8791` 上的实测（见 §0）。

## 0. 基线（实测，用于验收对照）

| 通道 | 实测 | 压缩 | 缓存 |
|---|---|---|---|
| 壳 combo ×3 | 7.26 MB → 1958 KB（gzip） | gzip ✓ | `immutable` 1 年 ✓ |
| 壳 `/assets` ×4 | 1.79 MB → 556 KB（gzip） | gzip ✓ | `immutable` ✓ |
| `session/list`（HTTP RPC） | 1.08 MB JSON → 369 KB（gzip） | gzip ✓ | 无，每次冷启动都付 |
| `session/follow`（WebSocket 首包） | 0.92–2.20 MB | **无** | 无 |

会话首包明细（同一台实例，真实会话）：

| 会话 | 记录数 | 首包字节 | gzip 后 | 服务端耗时 |
|---|---|---|---|---|
| zlZG…（9 366 事件，冷） | 297 | 2 201 000 | 613 KB | 395 ms |
| weft 7dc4…（12 428 事件，冷） | 578 | 1 784 009 | 427 KB | 447 ms |
| 800cb7…（热） | 397 | 967 852 | 185 KB | 12 ms |

同一条 zlZG 会话换窗口参数的首包字节：`500/50` → 2.20 MB，`120/20` → 0.81 MB，`60/12` → 0.47 MB，`40/8` → 0.32 MB。

根因：`compression` 中间件只覆盖 HTTP；`/api/remote.mux` 由 `new WebSocketServer({ noServer: true })` 承载，未开 `perMessageDeflate`，实测握手 `extensions` 为空串。

## 1. 功能需求

每条可被一条用例或一次测量验证。

- **R1（A-压缩生效）** 会话打开首包在 socket 层的字节数，相对基线下降 ≥ 4 倍（2.20 MB → ≤ 0.55 MB，同一会话同一参数）。
- **R2（A-协议正确）** WS 握手响应带 `permessage-deflate`；压缩后的帧能被浏览器正确还原，页面会话内容渲染与压缩前一致（逐条比对记录数与末条 seq）。
- **R3（A-可关）** 配置 `enabled:false` 后行为与「未安装本插件」逐字节一致。
- **R4（A-不阻塞）** 找不到 `ws` 模块或补丁点变化时，宿主正常启动，仅打一条 warn，压缩不生效。
- **R5（B-首屏收窄）** 会话首次打开（`events.open`）使用 `maxMessages ≤ 60 / minMessages ≤ 12 / minTurns 2`，首包 ≤ 0.55 MB。
- **R6（B-回补不受影响）** 「加载更早」（`loadOlder`）仍使用 500 / 50 / 2 的大页，点一次补的量与今天相同。
- **R7（B-失效安全）** 锚点未命中时原样返回上游字节并只 warn 一次，页面照常加载。
- **R8（C-列表秒开）** 存在有效缓存时，`session/list` 的 fetch 在不等待网络的情况下 resolve；同时后台回源并在成功后更新缓存。本次不要求 UI 热更——新顺序在下次进应用时可见。
- **R9（C-降级安全）** 无缓存、缓存损坏、存储不可用、回源失败时，等价于未安装（直连网络 / 保留旧缓存）。
- **R10（组合）** 三个开关互相独立，任一项 `enabled:false` 都不影响其余两项。
- **R11（语义不变）** 除 B 的「首屏显示的消息条数变少」外，不改变任何用户可见行为；不改写任何会话数据、不新增宿主磁盘文件。

## 2. 技术方案

### A · 传输压缩

做法：在宿主启动时把 `perMessageDeflate` 注入到 gateway 已构造的 `WebSocketServer` 上——patch `ws` 的 `WebSocketServer.prototype.handleUpgrade`，在调用原实现前补 `this.options.perMessageDeflate`。

为什么可行（已核对源码）：
- `ws/lib/websocket-server.js:299` 在**每次升级时**读 `this.options.perMessageDeflate`，读不到就用默认值 `false`（第 76 行）。
- `handleUpgrade` 用 `{...this.options.perMessageDeflate}` 构造 `PerMessageDeflate`，`threshold` 默认 1024（`permessage-deflate.js:57`），发送侧按 `byteLength >= threshold` 决定是否压缩（`sender.js:382`）。
- 浏览器（含 Android WebView）握手时总会带 `permessage-deflate` offer，无需改客户端。
- 补丁只改协商开关，不改帧格式、不改协议版本。

拿到实例：插件里 `createRequire(process.argv[1])`（实测 `argv[1] = C:\Running\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js`），先扫 `require.cache` 里 `node_modules/ws/lib/websocket-server.js` 的导出（gateway 先于 profile 插件加载，正常能命中），未命中再 `require('ws')`；两者都失败就 warn 放弃。

被否决的备选：
- 直接改 `C:\Running\dsh\node_modules\@deepseek-ai\dsh-api-gateway\lib\index.js`：升级即丢、无版本记录、无法单测、破坏「插件可单独关闭」。
- 自建 WS 代理 + 改写页面里的 `WebSocket` 构造：多一跳、要转发全部帧/心跳/close 码、内存翻倍，风险高于收益。
- 交给 nginx 或 weft 压缩：nginx 不压缩 101 之后的 payload；weft 不在本仓，改动面更大。

### B · 首屏窗口收窄

做法：复用 payload-diet 已有的 combo 改写管线，对 `@deepseek-ai/dsh-api-session-controller` 的客户端包做一处定点文本替换：
`events.open(HISTORY_PAGE_OPTIONS)` → `events.open({ maxMessages: 60, turnWindow: { minMessages: 12, minTurns: 2 } })`。
锚点在整个 bundle 里唯一（`lib/client.js:2679`），`loadOlder`（第 2501 行 `...HISTORY_PAGE_OPTIONS`）不受影响，因此 R6 自然满足。

被否决的备选：
- 改 `HISTORY_PAGE_OPTIONS` 常量本身：会把「加载更早」也压成 60 条/次，点一次只补一点点。
- 客户端插件 monkey-patch `Session.prototype.doOpen`：要和 core 的类实例对齐，脆弱且难单测。
- 宿主侧截断 `request.maxMessages`：gateway 内部无公开钩子，只能改 core。

### C · 列表本地缓存

做法：新客户端插件替换 `window.fetch`，只拦 `POST /api/session/list`：命中缓存立刻返回合成 `Response`，同时另起真实请求，成功后写回缓存。

为什么可行（已核对）：`dsh-client-connection` 的 RPC 每次调用都动态读 `globalThis.fetch`（`client.browser.js:1210` 的闭包），所以补丁的安装时机不敏感；本插件的 bundle 在 combo 中排在 connection 之前，天然更早。

存储：IndexedDB 优先（单条 1.08 MB，避开 localStorage 5 MB 配额争用），不可用时退回 localStorage，再退回内存 Map。

被否决的备选：
- Service Worker：要额外的注册脚本与作用域，收益相同、复杂度更高，DSH 也没有 SW 注册点。
- 用 HTTP 缓存：`session/list` 是 POST RPC，HTTP 缓存管不到。

## 3. 系统结构

```
宿主进程
  @deepseek-ai/dsh-api-gateway  ── WebSocketServer(noServer) ── /api/remote.mux
        ▲ 启动时被 patch（A）
  @local/mux-deflate  ── 只做 prototype patch + 还原器

  @local/payload-diet ── /dsh-diet/combo ── bundleResource 回源
        └─ externalizeDataUrls(...)  →  narrowOpenWindow(...)  → 响应（B）

浏览器（页面）
  @local/session-list-cache/client.js ── 包装 window.fetch ── IndexedDB
        └─ 命中即返回缓存 Response；后台回源写回
```

改动层次：A 在传输层（宿主），B 在 HTTP 响应改写层（宿主，复用已有出口），C 在浏览器网络层。三者互不调用。

## 4. 数据结构

`mux-deflate` 配置（Schemastery）：

| 字段 | 类型 | 默认 | 约束 |
|---|---|---|---|
| `enabled` | boolean | `true` | 关闭后不 patch |
| `threshold` | number | `1024` | ≥ 0 整数，低于该字节数的消息不压缩 |
| `level` | number | `6` | 1–9，透传给 `zlibDeflateOptions.level` |
| `verbose` | boolean | `false` | 每次 patch 成功打一行 info |

`payload-diet` 新增配置块 `openWindow`：

| 字段 | 类型 | 默认 | 约束 |
|---|---|---|---|
| `enabled` | boolean | `true` | 关闭则不改写 |
| `maxMessages` | number | `60` | 1–500 整数 |
| `minMessages` | number | `12` | 1..maxMessages |
| `minTurns` | number | `2` | 1–20 |

`session-list-cache` 配置与存储记录：

| 字段 | 类型 | 说明 |
|---|---|---|
| `enabled` | boolean | 默认 true |
| `maxBytes` | number | 默认 4 MB，超过则不缓存 |

存储记录 `{ v: 1, savedAt: number, method: string, argsKey: string, body: string }`；
键 `dsh-list-cache:v1:<method>:<argsKey>`，`argsKey` 是请求体里 `payload.args` 的稳定序列化（用不同 args 的调用互不覆盖）。

## 5. 模块划分

- **`mux-deflate`（新，宿主）**：职责是「给 mux 的 WebSocket 打开压缩」。**不负责**：不改协议、不做缓存、不动任何业务数据、不处理 HTTP 压缩、不改 gateway 源码。
- **`payload-diet`（改，宿主）**：新增「首屏窗口参数替换」一项。**不负责**：不做自动加载更早、不改 `loadOlder` 的参数、不改会话数据。
- **`session-list-cache`（新，含客户端）**：职责是「`session/list` 的本地缓存与回源」。**不负责**：不缓存会话内容、不碰 WebSocket、不改宿主行为、不做离线可用。
- **测量脚本（新，工具）**：职责是「在 socket 层量字节」。**不负责**：不做断言、不进 CI。

## 6. 交互逻辑

**打开会话**：点击 → `open()` 用窄窗口取尾页 → 渲染最近 2 个 Turn → 若更早有内容，聊天底部/顶部出现「加载更早」按钮 → 点一次取 500/50 的大页（与今天一致）。

**冷启动**：进页面 → 列表 RPC 命中缓存立即 resolve → 侧栏立刻有内容 → 后台真实请求回来写缓存。本次界面不热更，新生成的会话顺序在**下次**进应用时可见。

**C 的已知代价**：如果在别处删掉了会话，本次进来侧栏可能还留着它，点进去会得到「会话不存在」；下次进应用即消失。这是本期接受的代价（见 §12 决策 3）。

**关闭任一插件**：profile 里 `enabled:false` → 重启 → 该渠道回到今天的字节数；三者之间无联动。

## 7. 异常情况

| 情况 | 表现 | 提示/日志 |
|---|---|---|
| 找不到 `ws` 模块 | 压缩不生效，其余正常 | `mux-deflate：未找到 ws 模块，压缩未启用（不影响启动）` |
| `handleUpgrade` 结构变化 | 同上 | `mux-deflate：ws 的 handleUpgrade 不在预期位置，跳过压缩` |
| 压缩导致页面异常（协议级） | 会话无法渲染 | 人工回退：`enabled:false`；插件不自行关闭 |
| B 锚点未命中 | 首屏仍是大窗口，页面正常 | `payload-diet：首屏窗口改写未命中（上游版本变化？），已按原样返回`（只打一次） |
| C 无存储/超配额 | 退到 localStorage，再退到内存 | 仅在 debug 下打一次 |
| C 回源失败 | 保留旧缓存，不覆盖 | 静默；下次启动仍旧用旧缓存 |
| C 缓存记录损坏 | 丢弃该条，走网络 | 静默删除 |

## 8. 边界条件

- **B**：会话消息数少于 `minMessages` → 上游 `paginate` 自然返回全部，`hasMore:false`，不显示「加载更早」。
- **B**：`refresh`（F5）/切换会话都走同一个 `open()`，行为一致。
- **A**：小于 `threshold` 的帧不压缩（大量小的 assistant delta 保持原样）；控制帧（ping/pong/close）从不压缩。
- **A**：多客户端并发时各自独立协商，互不影响。
- **C**：0 个会话的列表照常缓存；body > `maxBytes` 不缓存；同时两个 list 请求时第二个直接走网络（不做请求合并）；缓存跨版本升级由 `v` 字段作废旧记录。
- **C**：首次安装/清数据后无缓存 → 首次必然走网络。

## 9. 修改范围（文件清单，基线）

新增：

- `plugins/mux-deflate/package.json`
- `plugins/mux-deflate/index.js`
- `plugins/mux-deflate/cordis.patch.yml`
- `plugins/mux-deflate/README.md`
- `plugins/mux-deflate/test/host.test.js`
- `plugins/mux-deflate/scripts/measure-wire.mjs`
- `plugins/session-list-cache/package.json`
- `plugins/session-list-cache/index.js`
- `plugins/session-list-cache/client.js`
- `plugins/session-list-cache/cordis.patch.yml`
- `plugins/session-list-cache/README.md`
- `plugins/session-list-cache/test/client.test.js`

修改：

- `plugins/payload-diet/index.js`（新增 `narrowOpenWindow` 与调用点、计数器、配置项）
- `plugins/payload-diet/test/host.test.js`（新增用例）
- `plugins/payload-diet/README.md`（记录新配置）
- `README.md`（插件树）

运行环境（不入库，需重启生效）：

- `C:\Users\autod\.dsh\profiles\aa\package.json`（两个新依赖 + bundles 顺序）

## 10. 实现步骤

1. `mux-deflate` 纯函数与测试：`normalizeConfig`、`resolveWebSocketClass`（假 cache/require）、`patchWebSocketServer`（幂等、可还原）。
2. `mux-deflate` 的 `apply()` + `ctx.effect` 还原器；`index.js` 打通。
3. `measure-wire.mjs`：拿 cookie → 连 mux → 打开指定会话 → 读 `ws._socket.bytesRead/bytesWritten` → 输出 JSON。先在关闭状态下跑出基线。
4. 启用 A，重跑测量，确认 ≥4 倍下降与握手 extension。
5. `payload-diet` 的 `narrowOpenWindow(code, options) → {code, applied}` + 单测（命中、未命中、参数非法、幂等）。
6. 接进 `build()`，计数并打一次日志；用 `measure-wire.mjs` 验证首包 ≤ 0.55 MB，且 `loadOlder` 请求仍带 500/50（在 Node 里读请求参数即可）。
7. `session-list-cache` 的纯逻辑（拦截判定、键、合成 Response、三层存储）+ 用假 `window.__ModuleLoader__` 的单测。
8. 写 `client.js` 的 `apply()`，装上后本机验证：刷新页面侧栏秒开、DevTools 里 `session/list` 请求仍在后台发生。
9. 接进 profile，重启，跑三项组合测量，出 A/B/C 的前后对照表。

## 11. 测试方案

- **单元测试**（`node --test plugins/`，逐文件跑）：
  - `mux-deflate`：配置归一化、类解析的三条路径、patch 幂等、options 注入正确、还原后恢复原状、`handleUpgrade` 缺失时安全跳过。
  - `payload-diet`：`narrowOpenWindow` 命中/未命中/重复调用/非法参数；`build()` 里两者叠加后 `loadOlder` 锚点未被改。
  - `session-list-cache`：拦截范围（只 POST + 只该路径）、缓存命中即返回、回源失败不覆盖、损坏记录被丢弃、三层存储降级、超 `maxBytes` 不缓存。
- **量化测量**：`plugins/mux-deflate/scripts/measure-wire.mjs`，同一会话、同一参数，3 次取中位数，对比「A 关 / A 开」「B 关 / B 开」。
- **端到端**：本机 8791 走一遍页面（会话能开、滚动能补历史、侧栏正确）；平板经 adb 另行安排（阶段四再定具体做法）。

## 12. 决策记录（追问环节已闭环）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 插件归属 | 三个独立插件：新建 `mux-deflate`、新建 `session-list-cache`，B 并入现有 `payload-diet` |
| 2 | B 的窗口参数 | `60 / 12 / 2`（首包约 0.47 MB） |
| 3 | C 的新鲜度 | 命中即返回 + **永远**后台回源更新缓存；不做回源跳过、不加 TTL；本次 UI 不热更，下次进应用看到新顺序 |
| 4 | 自动加载更早 | 本期不做，保持「加载更早」按钮 |
| 5 | A 的默认状态 | 默认开，`threshold:1024`、`level:6` |
| 6 | 计划落盘位置 | 仓库根 `PLAN-会话加载提速.md` |

由此产生的明确排除项（本期不做，避免实现时误扩）：

- 不做滚到顶自动加载、不改 `loadOlder` 的任何参数。
- 不给 C 做 TTL/回源跳过，不改侧栏的 store。
- 不缓存会话内容（不做会话正文的本地缓存）。
- 不新增宿主侧磁盘文件（C 的缓存只落在浏览器存储里）。
- 不改 `C:\Running\dsh\node_modules` 下的任何文件。
