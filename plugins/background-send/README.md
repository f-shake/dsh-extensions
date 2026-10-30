# 后台化插话（background-send）

会话运行中，当用户在输入框里插话时，把正在等待的前台 shell 命令转到后台：命令继续跑，消息立刻送达。

## 它解决什么

`pwsh` / `bash` 在前台执行时，整个工具调用会一直等到命令结束；此时插话也要等到命令跑完才送进模型。想「先让命令继续跑、我现在就说一句」，此前没有入口。

装上本插件后，用户插话（发送行为为「插话发送」，或 Ctrl+Enter）就会：

- 让正在等待的命令不再阻塞工具调用，进程继续运行，并出现在后台任务列表里（可用 `job_output` 读输出、`job_kill` 停止）；
- 把这条消息送进当前一轮，下一个模型步骤就能看到；
- 命令真正结束时，模型仍会收到完成通知。

没有新增按钮：入口就是现有的发送键，插件只改变「插话到达时前台命令的去向」。

## 边界

- 只认**用户来源**的插话（`source.kind === "user"`）；goal、plan、子代理等内部插话不触发。
- 只认插话目标（`next-step`）；**排队发送**（`next-turn`）不触发——排队的语义就是不打断当前命令。
- 只处理 `pwsh` / `bash` 的等待；`workflow` 等其他任务不受影响。

## 安装

```powershell
# 以 profile aa 为例
node C:\Running\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js plugin --profile aa add "@local/background-send@link:<repo>\plugins\background-send"
```

CLI 会同时写入 profile 的 `dependencies` 与 `dsh.profile.bundles`。宿主插件在 dsh 启动时装载，装完需要重启 dsh。

## 配置

插件的 Loader 行支持三个字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `kinds` | `["pwsh", "bash"]` | 允许被转后台的任务类型 |
| `sliceMs` | `250` | wait 切片长度（50–1000）；正常情况下决定插话到工具返回的最大延迟，等待年龄不足 750ms 时最坏约 1 秒 |

## 已知限制

- 工具结果里的文字仍按超时路径渲染，会写「still running after {timeoutMs}ms」；那个数字是工具配置的超时上限，不是真实等待时长。job id 与「进程仍在跑」的含义是正确的，这段文案属于工具侧，本插件改不到。
- 命令刚注册、进程还没 spawn 出来的那一小段窗口里插话，工具会走它自己的「准备期超时」分支把命令杀掉。插件会等满 750ms 的最小等待年龄再释放，能覆盖大多数启动耗时，但 spawn 更慢时仍会命中。
- 释放按「会话 + 任务类型」匹配，无法区分是谁在等：模型若正在用 `job_output(wait: true)` 等同一个任务，插话也会让它提前返回当前输出，而不是等它结束。
- 宿主半边包装的是 `ctx.jobs.wait`，不属于公开契约。DSH 升级后若该方法被冻结或移除，插件只记录一条警告并完全不生效（插话照常发送，命令不再转后台）。

## 卸载

从 profile 的 `dsh.profile.bundles` 移除包名并删除插件依赖，重启 dsh 即可。卸载时包装会把 `ctx.jobs.wait` 还原。

## 测试

```powershell
node --test plugins\background-send\test
```

## 设计说明

为什么包装 wait 而不是新增接口：DSH 没有「让在途工具调用提前收手、但保留进程」的公开入口；前台调用只在结算、超时或中断时结束，中断会连带杀进程。要保留进程，只能把一次长等待切成短切片，插话到来时停止等待并返回当前的 running 视图——工具自己的 promoted 分支会接手，返回 job id 与已产生的输出。

为什么释放后要等当前切片结束：切片是一次真实的 wait，会在原有实现里登记等待者；等待者还在时发生的结算会被判成「已取走」，完成通知就不再发给模型。等切片到点自己摘掉等待者，结算时的 `awaited` 才为 false。
