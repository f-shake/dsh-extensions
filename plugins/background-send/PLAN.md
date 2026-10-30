# 转后台发送（background-send）· 开发计划

> 状态：**定稿**（grilling 已闭环，待闸门1 人工审查）
> 目标版本：0.1.0
> 决策记录：见 §2.6（Q1–Q6 均已拍板）
> 相关对话：用户提出「命令跑起来之后，能不能在输入框旁加一个按钮，点一下就把当前命令转后台，并把这句话立刻发出去」

---

## 1. 功能需求

每条需求对应一条可执行验收标准。

| # | 需求 | 验收标准 |
|---|---|---|
| FR1 | 会话运行中（agent 正在跑、输入框里有文本）且存在前台 shell 调用时，发送区出现一个独立按钮，语义为「转后台并立即发送」 | 运行中 + 草稿非空 + 存在 kind 为 `pwsh`/`bash` 且未带 `run_in_background` 的运行中工具调用 → 按钮可见可点；其余情况隐藏 |
| FR2 | 点击后，当前正在前台等待的 shell 命令（pwsh/bash）停止阻塞工具调用，进程继续运行，并成为可 `job_output` / `job_kill` 的后台任务 | 工具结果出现 `[still running after …; moved to background job …]`；会话头部后台任务列表出现该 job；命令进程未被杀 |
| FR3 | 点击后，输入框里的文本以「插话（steer）」方式立刻发出，而不是排队到整轮结束 | 对话里出现该用户消息，且下一模型步骤即可见；不出现「排队中」行 |
| FR4 | 不改变默认发送按钮的行为（默认仍是排队发送） | 普通发送仍产生排队语义 |
| FR5 | 转后台后，命令结束时模型仍能收到完成通知（与超时自动提升一致） | 命令结束后模型收到 job 完成通知，或 `job_output` 能读到终态 |
| FR6 | 没有可转的后台对象时，按钮不出现，也不会造成异常；插话能力仍由现有 Ctrl+Enter 提供 | 无前台 shell 调用时按钮隐藏；此时不存在可点击路径 |
| FR7 | 同一会话并行多个前台 shell 调用时，一次点击释放全部 | 所有等待中的 shell 调用都返回 promoted 结果 |
| FR8 | 插件缺失或 DSH 升级导致挂接失效时，按钮仍然可用（退化为插话发送），并给出一次可见提示 | 模拟 wait 包装失败 → 按钮可点，发送成功，显示降级提示 |

非功能需求：
- NFR1 不修改 DSH 安装目录（`C:\Running\dsh\node_modules`）中的任何文件。
- NFR2 不引入新的 npm 依赖（客户端与宿主均只用现有运行时）。
- NFR3 插件卸载/禁用后，行为完全恢复原状（不残留全局副作用）。

---

## 2. 技术方案（含选型理由与否决方案）

### 2.1 结论

采用**纯扩展（bundle）方案**：一个包含宿主半边与浏览器半边的 Cordis bundle，放在本仓库 `plugins/background-send/`。

- **宿主半边**：`inject: ["jobs"]`，包装 `ctx.jobs.wait`，登记「谁正在等待哪个 job」；订阅会话事件 `agent/inbox/spliced`，识别插话，然后释放对应等待（返回当前 running 视图），让工具走它已有的 promoted 分支。
- **浏览器半边**：在发送区渲染第二个按钮，点击时用 steer 模式发送草稿。

### 2.2 关键机制与依据（已核实）

| 事实 | 依据 |
|---|---|
| 前台 shell 调用一开始就以 kind=`pwsh`/`bash` 注册成 job，并在 `registry.wait` 上等待 | `dsh-tool-pwsh/lib/index.js` 的 `startJob` + `waitOnJob`；`promoteOnTimeout` 默认 true |
| `registry.wait` 只有三个出口：settle / timeout / abort；abort 会被工具当作中断并 kill | `waitOnJob` 的 catch 分支调用 `stop("tool call aborted")` |
| 等待超时后工具返回 `kind:"promoted"`（job 继续跑、返回 jobId 与截至当前的输出），且不 kill | 同上，promoted 分支 |
| 插话会进入 inbox 并记录 `agent/inbox/spliced` 事件（带 target 与 inserted 消息），宿主可订阅 `session/event` 观察 | `dsh-agent` 的 SessionEventMap；`dsh-api-session-controller` 的 steer 路径 |
| 工具在 `registry.wait` 返回 running 视图时不需要额外信息就能走 promoted 分支（只缺「结束原因」的文案精度） | `waitOnJob` 的 `(view.status === "running" || "stopping") && process() !== undefined` |
| 浏览器插件的宿主沟通通道 `ctx.connection.call` 不向第三方插件开放（handle 无 call，远程调用绑定是生成代码） | `dsh-client-connection/client.browser.js` 的 handle 结构 |

### 2.3 为什么是「插话即释放」

客户端要触发宿主动作，只有现有 API 可用（send / steer / abort / kill）。其中唯一能在「命令还跑着」时把消息送进正在运行的一轮、且不破坏会话的，就是 steer。

因此本方案把「转后台」绑定到 **steer 事件**：任何用户插话到来时，若该会话有前台 shell 等待，就释放等待。
这样按钮本身只需要「以 steer 发送」，不需要任何新 RPC、不碰生成代码、不重建前端。

代价：Ctrl+Enter 的原生插话也会同样触发转后台（见 Q2）。这是本方案唯一的行为外溢。

### 2.4 wait 包装的实现要点（避免语义漂移）

不重写 wait 语义，而是**切片委托**：

```
wait(id, timeoutMs, caller, signal):
  登记 waiter{id, owner, release}
  循环:
    slice = min(剩余时间, 250ms)
    并发等待 original.wait(id, slice, caller, signal) 与 release 信号
    - original 先结束：
        - 终态 → 返回该视图（原语义）
        - 仍 running → 继续循环（直到总超时）
        - 抛错（abort）→ 原样抛出（工具仍会 kill）
    - release 先到：
        - 等当前 slice 结束（≤250ms，保证原 wait 的 resolver 已摘除，
          从而 job 结算时 `awaited=false`，完成通知不会被吞）
        - 返回 registry.get(id, caller)（running 视图）
```

要点：
- 释放后**不**再发起新 slice，避免长时间挂着 resolver。
- `awaited` 语义得以保留：settlement 不再认为有人收过结果，完成通知照常发出（FR5）。
- 每 250ms 一次唤醒，仅对「有人在等」的 job 生效；命令结果最多延迟 250ms 可见。
- 包装失败（服务缺失、方法被冻结等）→ 记录一次警告并完全跳过（FR8）。

### 2.5 否决的备选

| 方案 | 否决原因 |
|---|---|
| 修改 `C:\Running\dsh\node_modules` 里的 `dsh-jobs-local` / `dsh-tool-pwsh` / `dsh-api-job-controller` | 违反 NFR1；升级即丢；改动生成代码与前端产物，成本远高于收益 |
| 新增宿主 RPC（typert remote service）给按钮调用 | 第三方包缺少代码生成链路；客户端绑定是构建产物；需要重建前端 |
| 重写客户端 `ctx.jobs` 代理或替换 jobs 服务 | 需要与生成客户端、任务列表、终止按钮全部重新对齐，风险高 |
| 用「杀掉命令再以 run_in_background 重跑」近似 | 副作用重复执行，语义错误，明确否决 |
| 打标记（消息里加隐藏字符）区分「按钮插话」与「普通插话」 | 标记会出现在会话记录与模型上下文里，且不可靠 |
| 只依赖用户按 Ctrl+Enter 插话，不加按钮 | 不满足「按钮」这一交互诉求（但可作为降级路径） |

### 2.6 已定决策（2026-10-30）

| # | 决策 | 取值 | 影响 |
|---|---|---|---|
| Q1 | 架构落点 | **A 纯扩展** `plugins/background-send` | 不改安装目录；升级只影响 wait 包装点 |
| Q2 | 触发来源 | **B 仅 `source.kind === "user"` 的 steer** | goal / plan / 子代理等内部插话不触发 |
| Q3 | 覆盖范围 | **A 仅 `pwsh` / `bash`**（配置可改） | workflow 等其他 job 的等待语义不变 |
| Q4 | 按钮位置 | **A `conversation.input.right`** | 位置在模型选择器左侧；不赌布局 |
| Q5 | 无命令在跑时 | **A 隐藏** | 按钮只在「运行中 + 草稿非空 + 有前台 shell 调用」时出现 |
| Q6 | 命名/位置 | **A `plugins/background-send`**，计划文件留在该目录 | 与仓库现有插件结构一致 |

---

## 3. 系统结构

```
浏览器（client.js）
  └─ 发送区按钮（slot: conversation.input.right）
        │ click
        ▼
  session.send({ mode: "steer", text: 草稿, attachments })
        │  （现有会话 API）
        ▼
宿主（index.js）
  ├─ JobWaitTap       包装 ctx.jobs.wait，维护 waiter 表
  └─ SteerWatcher     订阅 session/event → agent/inbox/spliced
        │ target === steer 且来源为用户
        ▼
  releaseWaiters(sessionId)  → 逐个 resolve 等待，返回 running 视图
        │
        ▼
  工具 waitOnJob 收到 running 视图 → 返回 promoted 结果
        │
        ▼
  agent 下一步：模型看到 promoted 结果 + 用户插话消息
```

数据流方向：客户端 → 会话 API → 宿主事件 → job 等待表。**没有新增 RPC、没有新增工具。**

---

## 4. 数据结构

### 4.1 Waiter 记录（宿主内存）

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `jobId` | `string` | 否 | 即 JobId（`pwsh-…` / `bash-…`） |
| `owner` | `string \| undefined` | 是 | 会话 id；未声明 owner 的 job 不参与释放 |
| `kind` | `string` | 否 | 来自 wait 时的 `registry.get(id)`，用于过滤 `pwsh`/`bash` |
| `release` | `() => void` | 否 | 置位释放信号的闭包，幂等 |
| `startedAt` | `number` | 否 | 便于诊断与超时兜底 |

表：`Map<jobId, Waiter>`，同一 job 多次 wait 时以最后一次为准（当前工具只 wait 一次）。

### 4.2 插话识别条件

```
event.type === "agent/inbox/spliced"
event.data.target === <steer 目标名>
event.data.inserted 至少一条 source.kind === "user"
```

`target` 的具体字面量在实现期从 `InboxTarget` 类型读取，不硬编码猜测。

### 4.3 配置（插件的 Config schema）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | true | 总开关 |
| `kinds` | string[] | `["pwsh","bash"]` | 允许被释放的 job 类型 |
| `sliceMs` | number | 250 | 委托切片长度，范围 50–1000 |

无持久化数据、无迁移。

---

## 5. 模块划分

### 5.1 `index.js`（宿主半边）

**负责**：包装 `ctx.jobs.wait`、维护 waiter 表、订阅插话事件、按条件释放等待、卸载时恢复原方法。

**不负责**：不发送消息、不识别 UI、不改变 job 的生命周期与终止语义、不碰非 shell 类型（除非配置放开）、不持久化任何东西。

### 5.2 `client.js`（浏览器半边）

**负责**：渲染按钮、判断可见/禁用条件、读取当前草稿并调用 steer 发送、失败时回退排队发送并提示。

**不负责**：不直接操作 job、不感知 job 状态、不修改会话内容、不实现快捷键（首版不做）。

### 5.3 边界

- 两者只通过「用户消息以 steer 到达」这一既有事实耦合，没有私有协议。
- 任一半边单独存在时：客户端按钮仍能发送（只是不转后台）；宿主半边仍能释放（只是没有按钮）。

---

## 6. 交互逻辑

### 6.1 状态与流转

| 状态 | 触发 | 结果 |
|---|---|---|
| 空闲（无运行轮次） | — | 按钮隐藏 |
| 运行中、草稿为空 | 用户输入 | 按钮隐藏；主按钮为「停止」 |
| 运行中、有草稿、无前台 shell 调用 | — | 按钮隐藏（Q5=A） |
| 运行中、有草稿、有前台 shell 调用 | — | 按钮出现，可点击 |
| 点击按钮 | 用户操作 | 按钮进入 pending（防重复点击）→ 发送 steer → 恢复 |
| steer 已发送 | 宿主事件 | 若有等待中的 shell job：等待 ≤250ms 后工具返回 promoted，消息下一步送达 |
| 发送失败（轮次已结束/连接错误） | — | 回退为普通发送（排队）；Toast「已改为排队发送」 |

### 6.2 用户可见反馈

- 按钮 `title`：`转后台并立即发送`；`aria-label` 同。
- pending 期间按钮禁用（300ms 内）。
- 成功转后台：不额外弹窗（工具卡片本身会显示 `[still running … moved to background job …]`），任务列表出现该任务。
- 降级（wait 包装不可用）：首次点击后一次性 Toast「当前版本无法转后台，已作为插话发送」。

---

## 7. 异常情况

| 场景 | 表现 | 文案/处理 |
|---|---|---|
| steer 被拒（轮次刚结束） | 回退排队发送 | Toast：`已改为排队发送` |
| 网络/连接断开 | 保持草稿，提示失败 | 复用现有发送失败提示，不吞文本 |
| `ctx.jobs` 不存在 | 插件不挂接，纯插话 | 一次性 Toast：`当前版本无法转后台，已作为插话发送` |
| `wait` 不是可写方法（被冻结） | 包装跳过，记 warning | 同上降级 |
| 释放时 job 已结算 | 返回终态视图 | 工具返回真实结果，不显示 promoted |
| 释放时命令仍在准备（进程未 spawn） | 由工具自身的准备期分支处理 | 保持原行为：超时/中断；不额外 kill |
| 插话来源不是用户（goal / plan 等） | 不释放 | 静默忽略 |
| 无前台 shell 调用 | 按钮不出现 | 无可用路径，不产生任何副作用 |
| 会话被销毁时存在 waiter | 表项随会话清理 | 无泄漏；卸载时清空 |
| 插件热更新/卸载 | 恢复原 `wait` | 无残留 |

---

## 8. 边界条件

| 维度 | 情况 | 处理 |
|---|---|---|
| 空值 | 草稿为空 / 只有附件 | 按钮禁用（附件-only 视为空，首版不支持） |
| 零 | 没有等待中的 job | 不释放，消息照发 |
| 最大值 | 同时 10 个并行 shell 调用 | 全部释放（FR7） |
| 超长 | 单条消息超长 | 交给现有发送校验，插件不截断 |
| 重复 | 连点两次 | pending 锁；第二次点击忽略 |
| 首次 | 插件首次加载 | 不产生任何副作用，直到第一次插话 |
| 无权限 | 会话只读 / 非 continuable 子代理 | 按钮隐藏；宿主不释放（无插话事件即无动作） |
| 版本漂移 | DSH 升级后 `wait` 签名变化 | 启动自检（`typeof wait === "function"` 且可写），失败则降级并提示 |

---

## 9. 修改范围（文件清单）

新增：

| 文件 | 说明 |
|---|---|
| `plugins/background-send/package.json` | bundle 元数据（`dsh.bundle.patch` + `dsh.client`） |
| `plugins/background-send/cordis.patch.yml` | 插入宿主半边 |
| `plugins/background-send/index.js` | 宿主半边：wait 包装 + 插话监听 |
| `plugins/background-send/client.js` | 浏览器半边：按钮 + steer 发送 |
| `plugins/background-send/locale/zh.json`、`en.json` | 文案 |
| `plugins/background-send/test/host.test.js` | 宿主半边单元测试（node:test） |
| `plugins/background-send/test/client.test.js` | 客户端纯逻辑单元测试 |
| `plugins/background-send/README.md` | 用途、安装、卸载、已知限制、升级注意 |

修改：

| 文件 | 说明 |
|---|---|
| `README.md`（仓库根） | 在 plugins 列表补一行 |

不改：DSH 安装目录、其他插件、profile 配置（安装命令由用户执行）。

---

## 10. 实现步骤

1. 脚手架：package.json / cordis.patch.yml / 空的两半，装进测试 profile 验证能被加载（日志可见）。
2. 宿主半边 A：实现 `JobWaitTap`（包装 + waiter 表 + 卸载恢复），仅记录不释放；单测覆盖 wait 的四个出口。
3. 宿主半边 B：订阅 `session/event`，识别用户插话，调用释放；单测覆盖来源过滤与 target 过滤。
4. 客户端半边 A：渲染按钮（先常显），点击调用 steer 发送；手动验证发送路径。
5. 客户端半边 B：可见/禁用条件（运行中 + 草稿非空）、pending 锁、失败回退。
6. 集成验证：真实会话跑一条 30 秒命令 → 输入文字 → 点击 → 断言 promoted 结果、消息送达、任务列表、完成通知。
7. 降级路径：人为让包装失败，验证提示与插话发送。
8. 文档：README（安装/卸载/限制）+ 仓库 README 的一行。

每步完成后自测并播报，不需要等人。

---

## 11. 测试方案

### 11.1 宿主半边（`test/host.test.js`，node:test）

1. 正常路径：wait 被释放 → 返回 running 视图；原 wait 的 resolver 不残留。
2. 终态优先：wait 期间 job 结算 → 返回终态视图（不返回 running）。
3. 超时：到点返回视图，语义与原来一致。
4. 中断：signal abort → 原样 reject。
5. 释放竞态：释放与结算同时发生 → 只返回一个确定结果，不重复 resolve。
6. 过滤：非 shell kind 不释放；非用户来源插话不释放；其他会话的 job 不释放。
7. 卸载：restore 后 `wait` 恢复原函数，waiter 表清空。

### 11.2 客户端（`test/client.test.js`）

1. 可见性判定：运行中 + 非空 → 可见；其余组合 → 不可见/禁用。
2. 发送参数：默认走 steer；失败回退为队列。
3. 连点：pending 期间第二次点击不产生第二个请求。

### 11.3 运行方式

```
node --test plugins/background-send/test
```

（不跑全量测试；全量测试属于阶段四，需单独授权。）

### 11.4 手动端到端（必须做，写进交付小结）

在 Web GUI：`pwsh` 起一条 30 秒命令 → 输入框打字 → 点按钮 → 检查 4 点：promoted 文案、消息立即送达、任务列表出现、命令结束后收到完成通知。

---

## 附：决策记录

原「未决问题」六项已由用户于 2026-10-30 全部拍板，取值见 §2.6。实现期若发现某条决策在技术上不可达（例如客户端拿不到「是否有前台 shell 调用」这一状态），按计划补漏处理：登记差异、给出降级方案，在闸门2 一并报告，不擅自改变语义。

实现期仍需在代码里核实（不改变产品语义，失败则走降级）：

1. 客户端在 `conversation.input.right` 插槽中能否读到会话运行状态、草稿、运行中的工具调用（参考同包插件用 `useSession` / `useProjection` 的写法）。
2. 会话事件 `agent/inbox/spliced` 的 `target` 字面量与 scope 可见性。
3. 包装 `ctx.jobs.wait` 后，工具 promoted 分支与完成通知的实际表现（以真实会话验证）。

---

## 附：2026-10-30 范围变更（用户拍板）

**变更**：删除客户端半边（按钮、词条、客户端测试），插件只保留宿主行为「用户插话 ⇒ 前台 shell 命令转后台」。

**依据**：桌面实测确认按钮本来可用（模型选择器左侧的向下箭头），但用户的发送行为已是「插话发送」，按现有蓝色发送键就会触发转后台——专用按钮与之重复；手机端输入行已很拥挤（模型名被裁切），再加按钮只会更挤。用户明确选择删除。

**受影响项**：

- FR1 / FR6 的「按钮可见性」不再适用；入口改为现有发送键（插话）；
- §2.6 的 Q4（按钮位置）、Q5（无命令时按钮显隐）随按钮一起失效；
- §11.1 的客户端测试点（可见性、发送参数、连点）删除，宿主测试保留；
- 交付物减少三个文件：`client.js`、`locale/zh.json`、`locale/en.json`，以及 `test/client.test.js`；
- 版本号由 0.1.0 提到 0.1.1。

**仍然有效**：宿主行为、配置项、异常与边界、完成通知语义、以及「排队发送不触发」。


