# session-activity-order

DSH Web 侧栏：哪个工作区最近有活动，它连同整组自动排到工作区列表的最上方；组内刚活跃的会话行也升到组内第一。

## 行为

一次活动做两件事：

1. 把该会话行在组内升到第一（走 `sessions.handleSessionActivity`，“最后更新”排序模式下可见）；
2. 把它所属的工作区分组升到整列第一（走 `workspaces.insertBefore`，与手动拖拽同一接口，顺序由 Host 持久化）。

活动来源（固定，没有开关）：

| 信号 | 含义 |
|---|---|
| 运行开始 | 会话的 Agent 由空闲转为运行 |
| 运行结束 | 运行结束，含失败与中断 |
| 等待处理 | 出现审批、计划审阅或提问 |
| 未读完成 | 非当前会话跑完，产生未读 |
| 用户消息 | 你自己发出一条持久消息 |

已在第一位时不搬移（幂等）。同一帧里多个工作区同时活动时，搬移串行执行、每次重算目标位置；
它们之间的先后按会话列表顺序决定，不保证严格等于信号的先后时间。

## 接口依赖

- `workspaces.insertBefore` 是 Workspace Controller 客户端服务的公开方法。
- `sessions.handleSessionActivity` 在运行时存在，但**不在 `ISessions` 的公开契约里**（只出现在具体类上，官方只从 `api-session/activity` 事件调用它）。如果将来版本删掉它，会话行上升会失效（会打一条 `[session-activity-order] advance-session-activity` 警告），工作区分组上升不受影响。

## 加载自检

插件加载成功时，控制台会打一行：

```
[session-activity-order] 已加载；insertBefore=function，handleSessionActivity=function
```

两个 `typeof` 都是 `function` 才说明宿主接口可用；没有这一行说明插件没进页面（需要重启 DSH 主进程，仅刷新页面不够）。

## 已知限制

1. 工作区顺序是 **Host 持久化**的：本插件会改写你拖出来的顺序，刷新、重启、换浏览器都保持，没有自动还原，只能手动拖回。
2. 组内行上升依赖 `updatedAt`，该行时间显示因此变成“刚刚”。
3. 断线重连后 `sessions.refresh()` 用 Host 日志重建摘要，组内行顺序回退；工作区分组顺序不受影响。
4. 不属于任何工作区的会话（Ungrouped）没有分组可升，只升行。
5. “工作区树”嵌套视图下，提升的是 Host 全局顺序里的第一位；渲染时它仍归在父级之下，父级分组本身不会跟着搬到最上面。
6. “手动”排序模式只管组内会话行：行不重排，分组仍会升。
7. 搬移是一次 Host 往返；失败只记一条 `console.warn`，不重试、不弹窗。
8. “等你处理 / 未读”两类信号依赖 `uiSession` 服务：它若在插件启动 1 秒后才注册，这两类信号本次会话内不会生效（分组与行上升不受影响）。

## 安装

用 `link:` 直连本仓库的源码目录（改代码即生效）：

```
dsh plugin --profile aa add "@local/session-activity-order@link:<repo>/plugins/session-activity-order"
```

也可以先在这个目录里 `pnpm pack`，再把打出来的 tgz 装进 profile（Web 端“设置 → 插件”也能装 tgz）。

命令只写依赖；还要把包名加进该 profile `package.json` 的 `dsh.profile.bundles`，插件才会被装载：

```json
"dsh": { "profile": { "bundles": ["...", "@local/session-activity-order"] } }
```

改完重启 DSH，浏览器端刷新页面。

## 卸载

从 `dsh.profile.bundles` 与 `dependencies` 中移除该包，重装依赖后重启。卸载不会还原已经被改写的工作区顺序。

## 开发

```
node --test
```

单测在 vm 沙箱里加载真实的 `client.js`，直接测纯函数与 `apply`，不复制实现。
