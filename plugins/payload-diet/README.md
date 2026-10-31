# payload-diet

把 DSH Web 首屏里内联的 base64 图片外置、并给静态资源补上缓存头，用来降低远程访问时要穿过隧道的字节数。

宿主侧插件（跑在 dsh 进程里），**不给客户端 bundle 增加任何一个字节**。

## 为什么

2026-10-30 用 headless Edge + CDP 逐请求统计（gzip 开启、本机回环）得到的现状：

| 场景 | 线上字节 | 主要构成 |
|---|---|---|
| 冷加载 | 5.36 MB | 插件 combo 4.12 + 0.40、`/api/session/list` 0.36、shell js/css 0.54 |
| 刷新 / 锁屏回来 | 0.94 MB | combo 命中缓存，但 shell 0.54 重下 + session/list 0.36 |

两处浪费，都在上游：

1. `dsh-client-ui-settings-account` 的 `lib/client.js` 有 3.26 MB，其中 **3.05 MB 是 `data:image/webp;base64,` 内联插画**（`dsh-client-ui-plugin-manager` 另有 0.39 MB）。实测这个文件 `gzip` 后 2.35 MB、去掉图片后 0.05 MB——图片基本不可压缩，而且只有账号浮层打开时才需要。
2. `dsh-host-frontend-static` 的 `serveStatic` 只写 `content-type`，没有 Cache-Control/ETag，于是内容哈希命名的 `index-*.js`(312 KB)、`vendor-*.js`(205 KB) 每次刷新都整份重下。

## 机制

```
浏览器 ─GET / ─────────────► webServer 兜底路由（frontend-static）
                                │ renderIndex() → 本插件的 index tap
                                ▼  HTML 里 plugins/?? → dsh-diet/combo/??
浏览器 ─GET /dsh-diet/combo/??… ─► 本插件：回源 clientModules.bundleResource()
                                │            把大图换成 /dsh-diet/asset/<sha256>
                                ▼            结果按 URL 缓存（含 rev）
浏览器 ─GET /dsh-diet/asset/<f> ──► 本插件：内容寻址的内存池，immutable
浏览器 ─GET /assets/* ────────────► 本插件：只服务 <dist>/assets/ 子树，补 immutable/ETag
```

三条必须守住的正确性约束：

- **为什么改 HTML 里的地址**：`webServer.match()` 的前缀规则是
  `pathname === prefix || pathname.startsWith(prefix + "/")`，而 combo 路径是
  `/plugins/??@deepseek-ai/...`——`??` 后面跟的是 `@` 不是 `/`，任何 `/plugins/??`
  形式的前缀都匹配不上；`/plugins` 本身也已被 client-modules 占用（重复注册会抛错）。
- **为什么启动时要预热**：combo 响应带一年 `immutable`，浏览器不会再回来取。如果外置图池
  只在请求路径上填充，宿主重启后池是空的，而浏览器还揣着旧 combo，那些图就 404 且能持续
  很久。插件启动时按当前 composition 把每个 bundle 过一遍重建池（内容寻址，哈希与原来
  逐字节一致），所以旧 URL 仍能命中。
- **为什么 `/assets` 只服务 `assets/` 子树**：它是前缀路由，会整体顶掉上游对这批路径的
  处理；而 `%2e%2e%2f` 不会被 URL 规范化掉，解码后能走到 `dist/index.html`——那是上游
  要过鉴权并注入 `__DSH_BOOT__` 的文件，这里既没有鉴权也不能注入，只能拒绝。

失败姿态：改写抛错、池满、上游异常都退回上游原样字节或透传状态，网页优先于省流量。

## 配置

```yaml
- insert:
    - id: payload-diet
      name: '@local/payload-diet'
      config:
        enabled: true              # false = 完全不注册路由与 tap，等价于未安装
        minAssetBytes: 2048        # 解码后小于它的图保持内联
        assetPoolBytes: 67108864   # 外置图片池上限（默认 64 MB）；池满时只跳过超限的那张图
        shellCache: true           # 是否接管 /assets/* 补缓存头
        shellRoot: ''              # 可选，前端 dist 目录；留空则按 dsh-web-app 的锚点自动解析
        openWindow:                # 会话首次打开的窗口（收窄首屏，回补不受影响）
          enabled: true
          maxMessages: 60          # 1–500，上限与上游默认页大小对齐（本插件只收窄，不放宽）
          minMessages: 12          # 1..maxMessages
          minTurns: 2              # 1–20
```

数字项写成 `null`、空串或非数字时一律退回默认值（不会被当成 0 而静默关掉功能）。

`openWindow` 只替换客户端包里 `events.open(...)` 那一处调用；`loadOlder()` 走的是
`events.prepend(...)`，所以“加载更早”拿到的仍是上游的 500/50 大页。锚点必须唯一命中才改写，
上游若重构出两处相同调用，插件会放弃改写并只 warn 一次，页面照常加载。

## 安装与生效

```powershell
# 装进 profile（依赖写成 link: 指向本仓库）
node C:\Running\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js plugin --profile aa add "@local/payload-diet@link:<repo>/plugins/payload-diet"
```

再把包名加进 profile `package.json` 的 `dsh.profile.bundles`。
**未启用 `dsh-hmr` 时要重启 dsh 才生效**；启用后 patch 层重载会重新 apply（路由都在
`ctx.effect` 里注册，重载时先释放再注册）。

## 验证

单测：

```powershell
node --test plugins/payload-diet/test/
```

字节对比（四指标，同一条命令跑改造前后）：

```powershell
node plugins/payload-diet/scripts/measure-bytes.mjs --url "<带 token 的首页地址>" --label before --json .measure/before.json
node plugins/payload-diet/scripts/measure-bytes.mjs --url "<带 token 的首页地址>" --label after  --json .measure/after.json --baseline .measure/before.json
```

指标定义：M1 冷加载字节、M2 刷新字节、M3 重连字节（HTTP / WS 分开报）、M4 首屏可用时间
（导航到 `#root` 出现子节点的毫秒数）。

测量口径：每次运行用**全新的浏览器 profile**；M1 是这次导航的完整字节，M2/M3 在同一
profile 上继续（缓存已热）。脚本结束时会删掉临时 profile。

### 实测（2026-10-31，同一 composition 上开关插件，各跑三次取中位数）

改造前后是**两个实例、同一份 composition**（同 profile、同插件集，只把 `enabled` 从
false 切成 true），避免把「插件集变化」混进差值里：

| 指标 | 改造前 | 改造后 | 差值 |
|---|---|---|---|
| M1 冷加载 | 5.36 MB（5484 KB） | 2.85 MB（2914 KB） | **−46.9%** |
| M2 刷新 | 0.94 MB（968 KB） | 0.41 MB（423 KB） | **−56.3%** |
| M3 重连（HTTP） | 383 KB | 383 KB | 0%（本插件不碰 API，符合预期） |
| M3 重连（WS） | 18 KB | 18 KB | 帧数噪声，不构成收益 |
| M4 首屏可用 | 1141 ms | 1148 ms | +0.6%（判据 ±10% 内，中性） |

按 195 KB/s 的隧道折算：冷加载 28.1 s → 14.9 s，刷新 5.0 s → 2.2 s。

两类收益的来源可以分开看：

- **图片外置**：冷加载最大的一笔从 4120 KB 降到 1548 KB（14 张图外置，未压缩 9.16 MB → 5.52 MB）。
- **缓存头**：M2 里 shell 的四笔（312 / 205 / 19 / 8 KB）已从网络请求中消失。

局限与说明：

- **M4 首屏时间**只是 `#root` 首次出现子节点的时刻（可能先渲染占位），三次采样 1097~1308 ms，
  前后中位差 +0.6%，落在判据内；更早一次采样出现过 141 ms 的低值，是复用了上次被强杀的运行留下的
  浏览器 profile 造成的假冷加载，脚本现已改成每次运行前先清空 profile。
- 外置资源用的是**绝对路径** `/dsh-diet/asset/...`，适用于挂在域名根的情形；若将来要支持
  子路径挂载，需要改成与 `client-modules` 一致的 document-relative 形式。
- 池在进程内，不落盘；重启后靠启动预热重建（哈希确定，因此能接上浏览器里的旧 URL）。
  若插件自身改了 `minAssetBytes` 等规则，旧 combo 指向的某些图可能不再入库，此时会 404
  并在日志里留一条告警——硬刷新即可自愈。
- 首次转换会打一行 info 级日志（`payload-diet：外置 N 处内联资源…`），是否可见取决于
  profile 的日志级别。HTTP 层证据更可靠：
  `curl -s -H "Accept-Encoding: gzip" <origin>/dsh-diet/combo/??… | gunzip | grep -c 'dsh-diet/asset/'`。

## 回退

- 配置里 `enabled: false` 并重启：三条路由与 index tap 都不再注册，行为等同未安装；
- 或从 profile 的 `dsh.profile.bundles` 里移除包名。

## 不做什么

- 不 minify、不重新打包前端（本机是 npm 安装产物，没有构建期）；
- 不动 `__DSH_BOOT__` 的批次结构（改批次会破坏启动顺序）；
- 不改 combo 的 `rev`（`openWindow` 只替换正文，URL 原样保留）；
- 不接管 `/api/*`（`/api/session/list` 仍有 0.36 MB，瘦身属于另一件事）。

> **改了 `openWindow` 却没生效时看这条**：combo 响应带一年 `immutable`，而 `rev` 不变
> （`rev` 由模块的文件元数据决定，不由改写后的正文决定）。所以改了本插件的配置、或把
> `openWindow.enabled` 关掉，已经缓存过该 URL 的浏览器不会回来取新内容——需要硬刷新，
> 或让模块自身的 rev 变化（重装/升级插件包）。
