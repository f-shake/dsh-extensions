# mux-deflate

> **⚠️ 已停用（2026-11-06）**：DSH 0.2.2 起默认开启 `websocketCompression`（`permessage-deflate`，
> level 1），插件不再是补丁、反而会把用户关掉的压缩强行打开。目录已重命名为
> `.deprecated.mux-deflate`，不再装进 profile。以下内容仅作历史记录。

给 `/api/remote.mux` 的 WebSocket 打开 `permessage-deflate`，让会话内容不再以**未压缩的** JSON 穿过隧道。

只压缩，不加密：握手双方仍能还原正文，这跟 TLS 或鉴权是两件事。

宿主侧插件（跑在 dsh 进程里），不改任何客户端 bundle，也不改 dsh 安装目录下的文件。

## 为什么

`compression` 中间件只覆盖 HTTP；会话内容（`session/follow` 的首包）走的是 WebSocket，绕过了它。
2026-10-31 在本机 8791 实测：

| 会话 | 记录数 | 首包 | 首次 gzip 后 |
|---|---|---|---|
| zlZG…（9 366 事件，冷） | 297 | 2 201 000 B | 613 KB |
| weft 7dc4…（12 428 事件，冷） | 578 | 1 784 009 B | 427 KB |
| 800cb7…（热） | 397 | 967 852 B | 185 KB |

同一条数据在 HTTP 通道上是压缩过的（`session/list`：1.08 MB → 369 KB），只有 WS 通道原样发送。
根因是 `dsh-api-gateway` 用 `new WebSocketServer({ noServer: true })` 建服务端，而 `ws` 对
`perMessageDeflate` 的默认值是 `false`，实测握手协商结果为空串。

## 机制

```
dsh 启动
  └─ @local/mux-deflate  apply()
       ├─ 从 dsh 入口文件 createRequire，扫 require.cache 找 node_modules/ws
       └─ 包一层 WebSocketServer.prototype.handleUpgrade
              └─ 调用原实现前，把 perMessageDeflate 补进实例的 options
```

为什么这样能生效：`ws` 在**每次升级时才读** `this.options.perMessageDeflate`（`websocket-server.js`
第 299 行），所以补丁放在原型上、在任何一次连接之前完成即可。`threshold` 由发送侧按
`byteLength >= threshold` 判定（`sender.js` 第 382 行），小帧不会被压。

为什么不去改 `C:\Running\dsh\node_modules` 里的 gateway 源码：那样升级 dsh 就丢、没有版本记录、
也没法写单测。为什么不做自建 WS 代理：要多一跳、要转发全部帧与心跳、内存翻倍，收益却一样。

## 安全取舍

对同一条 WebSocket 流开启压缩，理论上具备 BREACH 类条件：若攻击者既能往流里注入明文、
又能观测压缩后的长度，就有机会逐字节推断同一流里的其他内容。本插件用在个人隧道上
（单一用户、入口要过 dsh-auth 的密码与动态验证码、外部无法注入明文），因此按「可接受」处理。
将来这条链路若要多用户共享，或开始承载别人能控制的文本，就应当 `enabled: false` 关掉。

## 配置

```yaml
- id: mux-deflate
  name: '@local/mux-deflate'
  config:
    enabled: true      # 关掉就完全不 patch
    threshold: 1024    # 小于该字节数的消息不压缩
    level: 6           # zlib 级别 1–9
    verbose: false     # 开启后启动时打一行 info
    pathPrefix: '/api/remote.mux'  # 只对命中该前缀的升级路径生效；'*' 表示不限制
```

补丁打在 `ws` 的原型上，进程内每个 `WebSocketServer` 的升级都会经过它，所以默认按路径
过滤到 mux 这一条，不去改变别的服务端的协商行为。

## 失效与回退

- 找不到 `ws`，或 `handleUpgrade` 不在预期位置：只打一条 warn，宿主照常启动，压缩不生效。
- **已经配成对象**的 `perMessageDeflate` 不会被覆盖。注意 `ws` 的默认值就是 `false`，
  「显式传 false」与「没传」无法区分，两者都会被补上。
- 卸载（含 dsh-hmr 重载）时还原原型，并把**已经补过的实例**上的选项一起撤掉——
  只还原原型的话，升级过的实例还会继续压缩，改了 threshold 也不会重新读。
- 万一压缩导致页面异常：`enabled: false` 重启即恢复原状；插件不会自行判断并关闭。

## 测量

```powershell
node plugins/.deprecated.mux-deflate/scripts/measure-wire.mjs `
  --url "http://127.0.0.1:8791/?token=..." `
  --session <sessionId> --label A-开
```

读的是 `ws._socket.bytesRead` 的差值，也就是 TCP 层真实传输的字节，含 WS 帧头；
同时打印协商到的 extension 与解压后长度，用来看压缩比。

## 实测（2026-10-31，本机 8791 旧宿主 vs 8793 新宿主）

两条真实会话，`session/follow` 首包，wire 字节：

| 会话 | 基线（A 关） | 只开 A（500/50） | A + B（60/12） |
|---|---|---|---|
| weft 7dc4…（12 428 事件） | 1742 KB | 427 KB（4.08x） | **233 KB（7.5x）** |
| zlZG…（9 366 事件） | 2257 KB | 613 KB（3.68x） | **129 KB（17.5x）** |

“只开 A”就是压缩本身能拿到的倍数：两条会话分别 4.08x 与 3.68x——压缩比随内容浮动，
不是固定的 4x。“A + B”是收窄首屏窗口之后的合计。

服务端压缩的代价：一条 2.2 MB 的帧，进程内**第一次**压缩约 500 ms（zlib 预热），
之后稳定在约 95 ms。默认阈值 1024 让大量小的 assistant 增量帧不被压缩。

原始数据在 `plugins/.deprecated.mux-deflate/.measure/`（已 gitignore）。
