# payload-diet 开发计划

> 阶段一产物（vibe-coding）。确认后按此一次性开发；本文件不计入修改范围。

## 0. 背景与结论依据

2026-10-30 用 headless Edge + CDP 逐请求统计（gzip 开启、`127.0.0.1:8791`）得出的现状：

| 场景 | 线上字节 | 构成 |
|---|---|---|
| 冷加载 | 5.35 MB | combo1 4.12 + combo2 0.40 + `/api/session/list` 0.36 + shell（js/css）0.54 + 其他 0.03 |
| 刷新 / 锁屏回来 | 0.93 MB | combo 命中缓存；shell 0.54 重下 + session/list 0.36 |
| 断线重连 | 0.38 MB | 几乎全是 `/api/session/list` 重拉 |

两处根因（均已在源码中定位）：

1. `ui-settings-account` 的 `lib/client.js` 3.26 MB 里 3.05 MB 是 `data:image/webp;base64,` 内联插画；`ui-plugin-manager` 另有 0.39 MB。实测 `gzip(整文件)=2.35 MB`、`gzip(去掉图片)=0.05 MB`，即 combo1 的 4.12 MB 中有 **2.47 MB 是图片**，且只在账号/登录浮层打开时才需要。
2. `dsh-host-frontend-static/lib/index.js` 的 `serveStatic` 只写 `content-type`（第 73 行），没有 Cache-Control/ETag，内容哈希命名的 `index-*.js`(312 KB)、`vendor-*.js`(205 KB) 每次刷新全量重下。

## 1. 功能需求（每条可被一条用例验证）

| # | 需求 | 验证方式 |
|---|---|---|
| R1 | combo 响应中 ≥ `minAssetBytes`（默认 2048）的 `data:<mime>;base64,` 资源，替换为 `/dsh-diet/asset/<sha256前16><ext>`；小于阈值的保持内联 | 单测：给定合成 bundle，断言替换点与保留点 |
| R2 | `GET /dsh-diet/asset/<file>` 返回原始字节 + 原 MIME + `cache-control: public, max-age=31536000, immutable`；未知文件 404 | 单测：字节相等；未知名 404 |
| R3 | combo 路由的响应体，除被替换的 data URI 外与上游**逐字节一致** | 单测：把替换结果里的 URL 逆向换回原 data URI，sha256 与上游相同 |
| R4 | index.html 中所有 `plugins/??` 改写为 `dsh-diet/combo/??`，且幂等 | 单测：含 0/1/N 处、重复执行两次结果不变 |
| R5 | `/assets/*` 返回 `immutable` + `etag`；`if-none-match` 命中返回 304 且无 body | 单测：两种请求的头与状态码 |
| R6 | 任何改写异常都必须返回上游原始字节（不让页面白屏） | 单测：注入抛错的改写函数，断言响应体等于上游 |
| R7 | `enabled: false` 时不注册路由、不加 tap（与未安装等价） | 单测：假 ctx 断言 `register`/`tapIndex` 调用次数为 0 |
| R8 | 产出改造前后三场景字节对比表（见 §12） | 运行 `scripts/measure-bytes.mjs` 两次（已装/未装） |

## 2. 技术方案与选型

**选 A：host 侧 Cordis 插件，复用上游拼装 + `tapIndex` 改写 HTML + 自管 `/assets` 前缀。**

理由：
- 只有 host 侧能在字节层面动手（客户端插件本身就在那个 4 MB 包里，加进去只会更大）。
- `clientModules.bundleResource(method, url)` 是公开服务方法，返回拼好的 `Buffer`，复用它就不用重新实现 combo 拼装、rev、排序。
- `webServer.tapIndex(fn)` 是公开的 raw HTML 变换口，渲染后执行，正好改 URL。

**关键约束（决定了为什么必须改 HTML）**：`webServer.match()` 只认 `pathname === prefix || pathname.startsWith(prefix + "/")`。combo 路径是 `/plugins/??@deepseek-ai/...`，`??` 后跟 `@` 而非 `/`，所以 `/plugins/??` 这种前缀**永远匹配不上**；而 `/plugins` 已被 `client-modules` 注册（重复注册会抛错）。因此只能把自己的 URL 写进 HTML，再在自己的前缀下回源。

**否决的方案**：

| 方案 | 否决理由 |
|---|---|
| B：订阅 `webserver/index-inject`，为每个 combo URL 注册 exact 路由 | 插件增删/升级都会换 URL，要重新注册；一旦漏注册就是白屏 |
| C：重写 `POST /api/session/list` 响应体瘦身 | 要拆装 RPC 帧，且要维护"哪些字段侧栏还要用"，风险高于收益（0.36 MB），本期不做 |
| D：前端重打包开启 minify | 本机是 npm 安装产物，没有构建期 |
| E：nginx/CDN 缓存静态资源 | 属运维，需要 VPS 权限；不解决"隧道要传多少"（第一次仍要穿隧道） |

## 3. 系统结构

```
browser ─GET / ───────────────► webServer fallback = frontend-static
                                      │ renderIndex() → applyIndexTaps()
                                      ▼  [payload-diet] plugins/?? → dsh-diet/combo/??
browser ─GET /dsh-diet/combo/??… ─► [payload-diet] combo ─► clientModules.bundleResource()
                                      │                      （上游拼好的 Buffer）
                                      ▼  externalizeDataUrls() → 缓存 → 返回
browser ─GET /dsh-diet/asset/<f> ──► [payload-diet] asset（内容寻址内存池）
browser ─GET /assets/* ────────────► [payload-diet] shell（dist 文件 + immutable + etag）
```

新增层：webServer 的 3 条 prefix 路由 + 1 个 index tap。**不改**任何上游包、不改客户端 bundle。

## 4. 数据结构

```js
// 配置（cordis.patch.yml 的 config）
{ enabled: true, minAssetBytes: 2048, shellCache: true, shellRoot?: string }

// 外置资源池：key = "<sha256前16>.<ext>"
assets: Map<string, { mime: string, bytes: Buffer }>     // 上限 64 MB；超限时该图保持内联并计数（不整批回退）
// combo 结果缓存：key = 请求 URL（含 &rev=，天然内容寻址）
comboCache: Map<string, { headers: object, body: Buffer }>  // 上限 8 条，LRU（命中即挪队尾）
// 统计
stats: { combos, externalized, savedBytes, assetRequests, cacheHits, cachedCombos, assetCount }
```

MIME→后缀：webp/png/jpg/gif/svg/avif/ico/woff/woff2/ttf，未列出落 `.bin`。

## 5. 模块划分

| 模块 | 负责 | **不负责** |
|---|---|---|
| `index.js` | 配置归一化、HTML 改写、data URI 外置、三条路由、插件入口 | combo 拼装（上游）、gzip（webserver 中间件）、鉴权（connection / nginx） |
| `cordis.patch.yml` | 插入插件行与默认配置 | — |
| `test/host.test.js` | 纯函数 + 假 ctx 的路由单测 | 端到端字节 |
| `scripts/measure-bytes.mjs` | CDP 量化：冷加载/刷新/重连/首屏可用 | 不看界面内容，只统计字节与时间 |

## 6. 交互逻辑

- 用户侧**无感**：页面、路由、账号浮层行为完全不变；插画在浮层打开时才请求。
- 首屏：HTML 里 combo 地址被改写 → 请求进 `payload-diet` → 命中 combo 缓存直接回。
- 刷新：`/assets/*` 命中浏览器缓存（此前不可缓存），只有 API 请求。
- 开发者侧：每个 combo 首次转换打一行日志
  `payload-diet：<url 前 60 字>… 外置 N 张图，X KB → Y KB（未压缩）`。

## 7. 异常情况（含提示文案）

| 情况 | 表现 / 文案 |
|---|---|
| 上游 combo 非 200 | 透传上游状态码与响应头，不改写 |
| 上游 `bundleResource` 抛错 | 502，日志 `payload-diet：combo 回源失败 <err>` |
| 改写过程抛错 | 返回**上游原始字节**，日志 `payload-diet：combo 改写失败，退回原样 <err>` |
| 找不到 dist 目录 | 启动 warn `payload-diet：找不到前端 dist 目录，跳过 /assets 缓存头（可用 shellRoot 指定）`，插件其余部分照常 |
| 资源池超上限 | warn + 该图保持内联（宁可不省，不能丢图） |
| 请求不存在的资产 | 404 |
| 路径穿越（`../`） | 403 |
| 非 GET/HEAD | 405（`content-length: 0`） |
| 插件卸载 | 注销 3 条路由与 tap，info 打印统计 JSON |

## 8. 边界条件

- base64 载荷 < 1024 字符：跳过（廉价预筛），不解码。
- 解码后 < `minAssetBytes`：保持内联。
- 同一张图在多个 bundle/多处出现：内容寻址去重，只存一份、只一个 URL。
- index.html 里 `plugins/??` 出现 0 次：改写为 no-op（不改动原字符串）。
- 多个标签页同时首达同一 combo：缓存未命中时的并发转换，允许重复计算，结果一致。
- 插件热重载：路由在 `ctx.effect` 内注册，先注销再注册，避免 "duplicate route" 抛错。
- 空文件 / 0 字节资产：正常 200。
- `shellRoot` 指向不存在的目录：视为缺失，跳过 `/assets` 路由。

## 9. 修改范围（文件清单，基线）

新增（全部在 `plugins/payload-diet/`）：

- `index.js`
- `package.json`（`@local/payload-diet`，`dsh.bundle.patch`）
- `cordis.patch.yml`
- `README.md`
- `PLAN.md`（本文件）
- `test/host.test.js`
- `scripts/measure-bytes.mjs`

仓库外修改（需要你重启才生效，我只改配置）：

- `~/.dsh/profiles/aa/package.json`：加 `"@local/payload-diet": "link:<repo>/plugins/payload-diet"`
- `~/.dsh/profiles/aa/cordis.patch.yml`：加 insert 行

**明确不改**：`C:\Running\dsh\` 下任何文件、任何 `@deepseek-ai/*` 包、nginx、dsh-auth。

阶段三订正（实际产出与上表的差异）：仓库根 `.gitignore` 增加了 `plugins/payload-diet/.measure/` 忽略规则；仓库根 `README.md` 的插件树补上 payload-diet，并把安装命令里的 `C:\dsh` 订正为 `C:\Running\dsh`。两处都属计划补漏，没有改变「做什么」。

## 10. 实现步骤（每步可独立验证）

1. 落本文件（阶段一产物）。
2. `index.js` 纯函数段（`normalizeConfig` / `rewriteIndexHtml` / `assetFileName` / `externalizeDataUrls` / `resolveShellRoot`）+ 对应单测跑通。
3. 路由段（`createDietHandlers`）+ 假 ctx/假 registry 单测跑通。
4. `package.json` / `cordis.patch.yml` / `README.md` 收口。
5. `scripts/measure-bytes.mjs` 写好；**先在未安装状态跑一次**，应复现基线 5.35 / 0.93 / 0.38（±5%），证明脚本可信。
6. 在 `8792` 起测试实例（`--profile aa --port 8792 --patch <临时 overlay>`），只跑读请求，跑 measure 得"改造后"数字。
7. 数字达标（§12 阈值）后，把 link 与 insert 行写进 aa profile；**由你重启 8791**。
8. 重启后我在 8791 再跑一次 measure，作为线上实测，并入 §12 表。

> 步骤 6 与 8791 共用 session store，只做页面加载不发消息，不产生会话写入；若你要求绝对隔离，我再改用复制 profile 的方案（会慢一些）。

## 11. 测试方案

单测：`node --test plugins/payload-diet/test/`（node:test + node:assert/strict，与 `background-send/test/host.test.js` 同风格）。覆盖 7 类：

| 维度 | 用例 |
|---|---|
| 正常 | 外置替换正确、文件名稳定、字节可还原、combo 缓存命中不二次转换 |
| 边界 | 阈值上下、载荷预筛、重复图去重、HTML 0 处匹配 |
| 异常 | 上游 404、上游抛错→502、改写抛错→原字节、缺 dist→不注册 shell 路由 |
| 安全/权限 | `../` 穿越 403、未知资产 404、非 GET/HEAD 405 |
| 并发 | 同一 combo 两个并发请求都拿到完整字节 |
| 幂等 | `rewriteIndexHtml` 执行两次结果相同；卸载后路由已释放 |
| 统计 | `stats()` 各计数与实际情况一致 |

量化：`node plugins/payload-diet/scripts/measure-bytes.mjs <origin> [label]`
输出 JSON + Markdown 表，含 M1~M4 与基线差值。

## 12. 量化指标（改造前后对比）

### 12.1 指标定义

| 代号 | 定义 | 采集方法 |
|---|---|---|
| **M1 冷加载字节** | 空浏览器 profile，导航到 `/` 后 15 s 内所有 HTTP 响应的 `encodedDataLength` 之和（含 WS 帧字节） | CDP `Network.loadingFinished` + `webSocketFrame*` |
| **M2 刷新字节** | 同一页面 `Page.reload(ignoreCache:false)` 后 9 s 的同上统计 | 同上 |
| **M3 重连字节** | 关闭 carrier socket → 重连后 12 s 的 HTTP 增量 | 同上 |
| **M4 首屏可用时间** | 导航开始到 `document.querySelector('#root').children.length > 0` 的毫秒数 | CDP `Runtime.evaluate` 轮询 + `performance.now()` |

口径固定：本机 headless Edge、gzip 开启、同一版本浏览器、每个场景用**全新 profile**（冷加载）或同一 profile（刷新/重连）。

### 12.2 基线与目标

| 指标 | 基线（2026-10-30 实测） | 目标 | 判定 |
|---|---|---|---|
| M1 冷加载 | 5.35 MB | **≤ 3.10 MB**（−42%） | 硬阈值 |
| M2 刷新 | 0.93 MB | **≤ 0.45 MB**（−52%） | 硬阈值 |
| M3 重连 | 0.38 MB | **0.38 MB ±5%**（本期不改 session/list） | 不得变差 |
| M4 首屏 | 待基线补测 | **≤ 基线 ×1.10** | 不得变慢 |

理论预测（按实测分项）：M1 = 5.35 − 2.47 = **2.88 MB**；M2 = 0.93 − 0.54 = **0.39 MB**。

### 12.3 交付形态

`measure-bytes.mjs` 产出三列表：指标 / 基线 / 改造后 / 差值百分比，并附「按 195 KB/s 隧道折算的秒数」。此表与运行命令一并写进 `README.md` 的「实测」节，作为改造验收证据。

## 附：未决问题

无。五个范围问题已按「都按你推荐」闭环：① 只做图片外置 + `/assets` 缓存头；② 静默回退 + `enabled:false` 开关；③ 接受 HTML 中 `plugins/??` 的改写；④ 我只改配置，重启由你执行；⑤ 用 CDP 探针三段字节 + 首屏时间作验收。

