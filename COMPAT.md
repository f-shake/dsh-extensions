# 与 DSH 新版本的兼容性记录

每次升级 DSH 之前/之后照这份走。记录的是「核对结论」和「踩过的坑」，不是发布说明的复读。

## 基线

| 项 | 值 |
|---|---|
| 升级日期 | 2026-11-06 |
| 起点 | `@deepseek-ai/dsh@0.2.1-rc.2`（2026-10-17） |
| 终点 | `@deepseek-ai/dsh@0.2.2-rc.1`（2026-11-04） |
| Node | v26.12.1（0.2.2 起最低 24.9） |
| 核对方式 | 把 0.2.2-rc.1 装进临时目录（330 个包），逐项比对插件真正调用的 API，不照 release note 猜 |

## 升级时必须做的一件事：立刻重启

**装完 `npm install` 不等于升级完成。** 旧进程会继续用内存里的旧服务表，同时把磁盘上新构建的前端 bundle 发给浏览器，结果是：

```
Failed to load plugins / web boot: 25 entries did not activate
（一堆条目在等 contextMenus、sidebarRight、uiWorkspace 这些旧进程没有的服务）
```

而且端口一直在监听，看门狗不会自动重启，表现是「网站还开着但插件全灭」。

正确做法：装完立刻重启，从 dsh 进程树外面触发。

```powershell
Start-ScheduledTask -TaskName DshRestartOnce   # 20 秒后停旧起新
```

不要从 dsh 自己的会话里直接跑 `restart-dsh.ps1`：那是 dsh 的子进程，`Stop-Process` 会把自己一起带走。

重启后 token 会变（`aa.out.log` 里的新 URL），旧书签失效。

## 插件现状

| 插件 | 形态 | 与 0.2.2 的关系 |
|---|---|---|
| `session-activity-order` | 纯客户端 | 仍需要；调私有 `sessions.handleSessionActivity`，留意侧栏抖动 |
| `header-compact` | 纯客户端 | 需保留文案缩写；「隐藏在本地打开」与官方方向相反，见下 |
| `composer-focus` | 纯客户端 | 规则 1、2 官方未覆盖（实测），规则 3 官方已修 |
| `swipe-sidebar` | 纯客户端 | 官方无手势，独占 |
| `background-send` | 纯宿主 | 前台 shell 命令的插话释放，官方仍无替代 |
| `payload-diet` | 纯宿主 | 图外置仍独有；`/assets` 接管随包配置已关闭 |
| `deliver` | 双半边 | 与官方 present 卡并存，见下 |
| `vibe-phase-bar` | 双半边 | 独占；1 秒轮询待优化 |
| `git-panel` | 双半边 | 独占，无冲突 |
| `typo-proof` | 双半边 | 独占，`tools.register` 新签名兼容 |
| `dsh-live-compact` 1.1.4 | 第三方 | `engines.dsh` 覆盖新版；侵入压缩内部，异常时优先怀疑它。1.1.x 起有插件设置页（宿主设置表单，`schemastery` peer 已由 profile 内的 3.19.0 满足），Windows 备份目录 ACL 写失败会熔断本进程后续备份。1.1.3/1.1.4 修 #34：工具结果的 shadow/ACL 写不再在事件路径同步执行（排队 + `toolCallId` 去重），空闲维护的大段 catch-up 分批让出事件循环，Windows 阴影文件短暂忙时按 8 次上限退避重试；小切默认参数与配置项未变 |
| `dsh-mnemon` 0.5.42 | 第三方 | `engines.dsh` 明确覆盖 0.2.2-rc.1（其 release note 也写了验证）；双半边，装完需重启。`pnpm peers check` 会报 cordis / typert-protocol / react 缺失，但宿主加载器能解析，实测工具与 Memory System 正常 |

## 官方已替代 / 已归档

| 插件 | 归档原因 |
|---|---|
| `mobile-fit` | 官方 <768 原生抽屉（遮罩、inert、Esc、按钮齐全），<1024 自动收起；`visualViewport` 也有了。差异只在 768–1023 区间官方是轨道而非抽屉，手机用不到 |
| `mux-deflate` | 官方 `websocketCompression` 默认 `deflate`，网关自带 `perMessageDeflate`。官方 level 1、我们原 level 6，隧道实在吃紧再考虑回来 |
| `session-list-cache` | 从未启用（设计上就标「不要启用」）；0.2.2 又优化了列表加载，收益归零 |

归档方式：目录改名 `.deprecated.<name>`（`git mv`，历史保留），profile 依赖与 `bundles` 移除，README 记录恢复步骤。恢复四步：目录改回 → `dsh plugin add` → 加回 `bundles` → 重启。

## 与官方的具体重叠

**`payload-diet`：`/assets` 接管随包关闭**

0.2.2 的 frontend-static 自己写弱 ETag + `no-cache`/304。插件接管 `/assets` 会整体顶掉这套逻辑，从「补缺失」变成「遮蔽官方」，以后官方改缓存策略插件也不会跟。所以随包的 `cordis.patch.yml` 里把 `shellCache` 置 `false`——**只关开关，代码保留，代码默认值仍是 `true`**，需要 `immutable` 时改回去即可。

范围要注意：这个开关只覆盖本仓库这份 patch config。新建 profile、或把包打出去给别人的 profile 用时，如果没有带上这份 config，会按代码默认值重新接管 `/assets`。

关闭后验证：`/assets/index-*.js` 响应头是 `Cache-Control: no-cache` + `ETag: W/"..."`，不再是 `immutable`；首页 combo 仍是 `dsh-diet/combo/??...`、没有 `plugins/??`，图仍是按需取。

注意：这是宿主侧插件，改配置**必须重启**才生效。

**`background-send`：独占，不是重叠**

原生的插话释放只在 `dsh-tool-jobs`（`job_output(wait:true)`，监听 `agent/inbox/inserted`，`releasedBy = "user steered"`）。`dsh-tool-pwsh` / `dsh-tool-bash` 里没有任何 inbox/steer 逻辑，前台命令被插话时原生不放手。两者服务对象不同，不会重复标记。

实测（2026-11-06）：15 圈 × 6 秒的命令，插话发生在 +0s，工具调用立刻返回并转后台，命令跑到 +84s 完整结束，15 行输出齐全，结尾 `DONE total 90s`。

**`deliver`：与官方 present 卡并存**

两套数据源不相交：官方只认 `deliverables/presented`（`dsh-tool-present` 发），我们只认工具结果的 `meta.deliveryId`。同一轮同时调 present 和 deliver 会并排出现两张——一张负责预览/打开，一张负责下载，是设计而非重复。

回合末尾那张已从整卡改成单行下载条（`文件名 + 大小 + 剩余有效期 + 下载`），工具行里的卡片保持原版式（含预览、撤销）。

**`header-compact`：有一条逆方向**

0.2.2 改成「溢出渐隐、保住按钮可点」，手机也能打开宿主文件（在宿主执行、手机收提示）。我们隐藏 `[data-open-target="directory"]` 这一条与新行为相悖。文案缩写（`3 个子智能体` → `智能体 3`）无害，保留。

**`composer-focus`：1、2 条仍是净增益**

官方做了「更少自动弹键盘」「发送后收起」，但「点按钮不弹键盘」（键盘收起后点 composer 控件，宿主会抢回焦点）和「滑聊天区收键盘」仍在。规则 3（切会话不自动聚焦）已被官方修好，插件的对应逻辑现在只是冗余，不冲突。

**`session-activity-order`：私有 API**

靠 `sessions.handleSessionActivity` 推进 `updatedAt`，该方法不在 `ISessions` 公开契约里（0.2.2 里仍在）。官方新增「运行中和等待回应的会话更容易找到」的展开规则，两者叠加可能让侧栏跑完时抖一下，功能不受影响。

## 每次升级后的验证清单

1. **重启**（见上），确认 `aa.err.log` 干净、新 token 可用；
2. 首页 HTML：combo 是 `dsh-diet/combo/??...`、`plugins/??` 出现 0 次、**有客户端半边的 8 个** `@local` bundle 都 200（`@local` 共 10 个，另两个是纯宿主的 `payload-diet`、`background-send`，没有 `/client.js`）；
3. `/assets/index-*.js` 响应头是官方 `no-cache` + 弱 ETag（说明 `shellCache` 仍关）；
4. 工具列表里有 `deliver`、`typo_check`、`vibe_phase`；
5. 长命令 + 插话：命令转后台、进程不死、输出完整；
6. 跑完一轮看侧栏是否抖动或错位（session-activity-order）；
7. 手机：抽屉默认收起、左右滑动开合、标题行文案、键盘两条规则；
8. 长对话确认自动压缩正常（dsh-live-compact）；
9. 记忆：`mnemon_status` 返回 `healthy: true`，工具列表里有 `mnemon_runtime_memory`（dsh-mnemon）。

## 已知坑

- **升级不重启**：旧进程 + 新 bundle = 插件全灭，且看门狗看不见（端口还在听）。
- **token 轮换**：每次重启都换，书签要更新，URL 在 `aa.out.log`。
- **插件目录改名要同步 profile 依赖**：`link:` 指向改名后的目录会变成悬空链接。
- **pnpm remove 留悬空 junction**：`node_modules/@local/<name>` 会残留，要手动删。
- **客户端插件改动不用重启**：bundle 带内容哈希 `&rev=`，刷新就换；有宿主半边的（`payload-diet`、`background-send`、`deliver`、`git-panel`、`typo-proof`、`vibe-phase-bar`、`dsh-mnemon`）必须重启。
- **`dsh-mnemon` 的记忆空间需要外部后端**：默认 provider 要全局装 `@mnemon-dev/mnemon` CLI；不装时只有 runtime 记忆与项目文档可用，`MEMORY.md` 满了会归档到本地文件而不是记忆空间。
- **0.2.2 默认关掉了两项防护**：`applyPatch`（这套 Web 组合里仍是 false）和 `fs-observation-policy` 的「先读后写」。改文件前要不要打开，按场景决定。
