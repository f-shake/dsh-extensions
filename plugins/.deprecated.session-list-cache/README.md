# session-list-cache

> ## ⛔ 不要启用
>
> **这个插件不启用，也不要再把它加回 profile 的 `dsh.profile.bundles`。** 代码留着是为了留住
> 当时的实现与测试，不是因为它可用。
>
> - **时间线**：2026-10-31 随「会话加载提速」上线（仓库提交 `cc8ce88`）；2026-11-02 从 profile
>   的 bundles 里摘掉。profile 目录里留着摘除前的备份 `package.json.bak-20261104-list-cache-off`。
>   2026-11-06 正式归档：目录改名 `.deprecated.session-list-cache`，profile 依赖移除；
>   同日升级到 DSH 0.2.2-rc.1，官方已优化大量会话的列表加载，缓存收益归零。
> - **原因**：实际启用后发现有问题，因此停用。具体现象：**待补**（本节由 2026-11-05 整理，
>   当时的现象没记录在仓库里）。
> - **重新启用前**：先把下面「已知代价」里的三条解决掉，并补上这里的原因与复现步骤；否则别开。

让会话列表先用上一次的结果出来，不等网络。

浏览器侧插件（`client.js` 跑在页面里），宿主半边是空实现。

## 为什么

`session/list` 是一个 POST 的 RPC，HTTP 缓存完全够不着它；它的响应在 2026-10-31 的实测里是
1.08 MB JSON（gzip 后 369 KB，278 个会话），而它决定侧栏什么时候有内容。每次冷启动都要等它
回来，在慢速隧道上就是接近两秒的白屏。

## 机制

```
页面启动
  └─ @local/session-list-cache  apply()
       └─ 包一层 globalThis.fetch，只认 POST api/session/list

命中缓存 ──► 立刻返回上次的正文（不走网络）
              └─ 同时另发一次真实请求，成功后把缓存更新掉
未命中   ──► 走网络，成功后把正文写进缓存
```

存储按可用性三档降级：IndexedDB → localStorage → 内存。任何一档出问题（隐私模式、
配额满、记录损坏、回源失败）都按「没装这个插件」处理：直连网络、保留旧缓存。

## 已知代价

界面看到的是**上一次启动时**的列表，本次不热更。新会话的顺序要下次进应用才生效；
如果会话在别处被删了，本次侧栏还会留着它，点进去得到「会话不存在」，下次进应用即消失。
这是有意的取舍：热更需要摸清 sessions list 的 store，而收益只是「本次就能看到」。

## 配置

**没有可用的配置面。** 客户端插件的装载链只把 id/url/rev/inject/external/immediately 交给
浏览器（`dsh-client-modules` 的 boot 清单与页面 Loader），profile 里写的 `config` 只会落到
宿主侧那个空实现 `index.js`，到不了 `client.js`。所以：

- 想关掉它：把 `@local/session-list-cache` 从 profile 的 `dsh.profile.bundles` 里移除；
- 上限、读超时这类常量写在 `client.js` 顶部，改它们要重新出包（并且注意 combo 的 `immutable`
  缓存，见 `payload-diet/README.md` 末尾那条）。

代码里的 `normalizeConfig` 仍然认识 `enabled` / `maxBytes`，是为了将来客户端配置通道打通时
不必再改结构；当前收不到值，行为等价于全部默认。

缓存记录的键形如 `dsh-list-cache:v1:session/list:<排序后的 args>`，`v` 一旦换版本旧记录自动作废。
用不同 `args` 调的两次 `session/list` 互不覆盖。

## 验证

页面里执行 `window.__dshSessionListCache()`，应看到**当前**用的存储后端（`indexeddb` /
`localstorage` / `memory`）——它是函数而不是快照，因为降级发生在运行时。
DevTools 的 Console（verbose 级别）里有 `[session-list-cache]` 的安装与命中日志；
Network 里 `session/list` 在命中缓存时仍然会发出一次（后台回源），但侧栏不等它。
