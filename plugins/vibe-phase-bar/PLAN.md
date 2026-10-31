# Vibe Coding 阶段面包屑（vibe-phase-bar）· 开发计划

> 状态：阶段一终稿，等待闸门 1 确认。确认前不写任何实现代码。

## 0. 已定决策

| # | 决策 |
|---|---|
| D1 | 流程激活后，五阶段条出现在**输入框上方**；未激活时，左下角加号右侧显示「代码」图标，点击即进入阶段一 |
| D2 | **任意阶段都能点**，包括跨阶段前跳 |
| D3 | 闪烁在**点击确认后立即停止** |
| D4 | 点「提交」= 进入**预提交**：列出计划提交的文件，不提交 |
| D5 | 窄屏：五个带短名的 chip 横向可滚动 |
| D6 | 点图标 = **直接发送**一条启动消息（不是填草稿） |
| D7 | 流程激活后**图标隐藏**，结束统一走阶段条上的出口 |
| D8 | 跳过中间阶段要在**条上标注**，并写进给 AI 的消息 |
| D9 | 预提交之后**再点一次「提交」才算授权**，第二次点击才 git commit |
| D10 | 提交完成后**保留全部完成态**，直到用户手动关闭或开新流程 |

## 1. 功能需求

| # | 需求 | 验收方式 |
|---|---|---|
| R1 | 无流程状态时，composer 左下角工具行、加号右侧有「代码」图标 | 新会话可见 `[data-vibe-start]` |
| R2 | 点图标即发送启动消息，条出现、图标消失 | 点后 transcript 有一条启动消息；随后条出现 |
| R3 | 有流程状态时，composer 卡片上方出现五阶段条 | `[data-vibe-phase]` 位于输入框上方 |
| R4 | 当前阶段高亮；到达过的为完成态；跳过的为跳过态 | 各 chip 的 `data-state` 取值正确 |
| R5 | 工具 `request(N)` 后第 N 个 chip 闪烁，直到用户点击 | 点击后动画立即停止（不等 AI 回复） |
| R6 | 点任意阶段 = 确认进入该阶段，注入一条用户消息 | 点击后 transcript 出现对应消息，状态在 1 秒内更新 |
| R7 | 前跳时条上把中间阶段标为跳过，消息里写明跳过了哪几段 | 从 2 点 5：3、4 为跳过态，消息含「跳过阶段 3、4」 |
| R8 | 点「提交」= 预提交，AI 只列清单不提交 | 回复含文件清单，`git log` 无新提交 |
| R9 | 预提交后**再点一次「提交」**= 授权提交 | 第二次点击才产生 commit |
| R10 | 窄屏（≤420px）chip 横向滚动，输入框不变形 | 375px 可横滑 |
| R11 | 工具/路由不可用时退回纯文字闸门 | 卸载插件后仍能走完一轮闸门 |
| R12 | 条上有出口：关闭后回到只有图标的状态 | 点 × 后条消失、图标出现、状态清空 |

## 2. 技术方案

一个包同时含宿主与客户端。

### 关键接口（本机核实）

| 用途 | 接口 | 证据 |
|---|---|---|
| 输入框上方整宽条目 | `conversation.input.dock`（list / session，「Full-width entries above the composer card」） | `dsh-cordis-client-runner/lib/client.js:3339`；`dsh-client-ui-goal/lib/client.js:604` |
| 左下角工具行 | `conversation.input.left`（list / session，「Compact controls at the left of the composer tool row」） | 同上目录；`dsh-client-ui-conversation/lib/client.js:19072` |
| 插槽注册 | `ctx.slots.inject(name, () => ctx.slots.register({ name, id, order }, Component))` | `plugins/mobile-fit/client.js:478` |
| React / 自带 CSS | `require('react')`；`<style data-plugin-css>` | `plugins/mobile-fit/client.js:4,466` |
| 工具注册 | `ctx.tools.register({ name, parameters, output: { schema, render }, execute })` | `dsh-tools/lib/index.js:2974` |
| 宿主 HTTP 路由 | `ctx.webServer.register({ kind: 'prefix', path, handler })` | `plugins/payload-diet/index.js:683` |
| 注入用户消息 | `agent.followup({ content, source: { kind: 'user' } })` | `dsh-agent` README「驱动 agent 的对话」 |
| 客户端提交（含空白会话） | `inputActions.setDraft(text)` + `inputActions.submit()` | `dsh-client-ui-conversation/lib/types/client/contract/input.d.ts:229` |

### 三条关键设计决定

1. **启动走客户端提交，确认走宿主路由。**
   启动必须经过 composer 的正常提交通道，因为新会话还是 blank、可能没有 agent；`inputActions` 正是给会话作用域插槽组件的公开入口。
   确认必须走宿主：要保证「清 pending」和「发消息」同时落地，且不碰用户正在写的草稿。
2. **状态权威在宿主内存，客户端只按 `version` 渲染。**
   轮询 1 秒；点击后本地先乐观置位，避免出现「已确认但还在闪」。
3. **「提交」chip 需要二次点击 + 2 秒冷却。**
   第一次点击进入预提交；进入预提交后 2 秒内的点击一律忽略，防止手滑双击直接把代码提交上去。

### 否决方案

| 方案 | 理由 |
|---|---|
| 自定义 session projection | 外部插件不能写自定义会话事件（`dsh-session` README 限定 `packages/experimental/`） |
| typert Remote | 需要生成协议产物，成本远超收益 |
| 解析 AI 文本横幅 | 模型漏写即失真 |
| 客户端订阅会话事件 | 61 个 `dsh-client-*` 产物里没找到公开订阅口 |
| 确认也走客户端提交 | 会覆盖用户草稿；且状态清理与发消息无法原子 |

## 3. 系统结构

```
┌──────────── 宿主 ────────────┐        ┌──────── 客户端 ─────────────┐
│ 模型 ─tool: vibe_phase─► 状态表│        │ input.left 「</>」图标       │
│                              │        │   │ 点击 → setDraft+submit   │
│        GET /state ◄──────────┼────────┼───┘                          │
│        POST /confirm ◄───────┼────────┼─── 点 chip                    │
│                              │        │ input.dock  五阶段条 + ×      │
│ 点击 ─► followup(「确认进入…」) │        │                              │
└──────────────────────────────┘        └──────────────────────────────┘
```

图标与条互斥：`state === null` 显示图标，否则显示条。

## 4. 数据结构

```ts
type Phase = 1 | 2 | 3 | 4 | 5
type PhaseState = {
  phase: Phase            // 当前阶段
  reached: Phase[]        // 到达过的阶段（完成态）
  skipped: Phase[]        // 被跳过的阶段
  pending: Phase | null   // 等待确认（闪烁）
  precommit: boolean      // 已进入预提交
  authorized: boolean     // 已授权提交
  version: number
  updatedAt: number
}
```

工具参数：`{ action: 'enter' | 'request', phase: 1..5 }`

- `enter`：`phase = N`，`reached += N`，`pending = null`，`precommit = false`（离开阶段五时）。
- `request`：`pending = N`，不动其他字段。

HTTP：

| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| GET | `/vibe-phase/state?session=` | — | `{ ok, state }`（无状态为 `null`） |
| POST | `/vibe-phase/confirm` | `{ session, phase }` | `{ ok, state }` |
| POST | `/vibe-phase/reset` | `{ session }` | `{ ok, state: null }` |

## 5. 模块划分

| 模块 | 负责 | **不负责** |
|---|---|---|
| 工具 `vibe_phase` | 校验参数、推进状态、返回短文案 | 不渲染、不发消息 |
| `/confirm` | 把点击翻译成一句给 AI 的话、推进状态、清 pending | 不判断阶段该不该进 |
| `/reset` | 关闭流程、清状态 | 不撤回已发消息 |
| 客户端图标 | 可见性、点击、启动提交 | 不持有权威状态 |
| 客户端条 | 轮询、渲染、点击、闪烁、横滑、关闭 | 不推断阶段、不解析聊天文本 |
| `SKILL.md` 增补 | 何时调工具、点击即授权、跳过留痕、工具缺失降级 | 不改流程语义 |

## 6. 交互逻辑（含实际文案）

| 动作 | 谁发起 | 落地动作 | 发给 AI 的消息 |
|---|---|---|---|
| 启动 | 点图标 | 客户端 `setDraft` + `submit` | `用 vibe coding 开一个新流程，进入阶段一，等我说构想。` |
| 请求 | 工具 `request(N)` | 置 `pending = N` | 不产生用户消息（工具结果自带提示） |
| 确认 | 点 chip | POST，宿主 `followup` | `确认进入阶段 N（短名）。` |
| 前跳 | 点更靠后的 chip | 同上 | `确认跳到阶段 N（短名），跳过阶段 A、B。` |
| 回退 | 点更靠前的 chip | 同上 | `回到阶段 N（短名）重新走。` |
| 预提交 | 点「提交」（第一次） | `precommit = true` | `确认进入预提交：列出计划提交的文件和提交信息，不要执行 git commit。` |
| 授权 | 再点「提交」（冷却后） | `authorized = true` | `授权提交：按上面的提交信息执行 git commit。` |
| 关闭 | 点条上的 × | POST `/reset` | 不产生用户消息 |

- 阶段短名：计划 / 开发 / 复核 / 验证 / 提交。
- 点当前阶段：无操作。
- 点闪烁阶段与其他阶段等价——任意点击都发对应消息（D2）。
- 前跳的跳过集合 = 当前阶段与目标阶段之间、尚未到达的阶段。

## 7. 异常情况

| 场景 | 表现 | 文案 |
|---|---|---|
| 插件未装 | 工具调用失败 → skill 退回文字闸门 | skill 内写明 |
| 无 `webServer` | 工具可用；图标与条都不渲染 | 日志 warn 一次 |
| 轮询失败 | 保留上次状态，条尾显示灰点 | 「状态未同步」 |
| POST 失败 | 本地回滚，闪烁恢复 | 「确认失败，请再点一次」 |
| 会话 agent 已结束（409） | 条禁用 | 「该会话已不在运行」 |
| 空白会话点启动 | 走客户端提交，正常创建 agent | — |
| 启动时草稿非空 | 先备份草稿，提交后还原；还原失败则提示一次 | 「启动消息已发出，原草稿未能恢复」 |
| 非法 `phase` | 400，不改状态 | 「阶段值必须是 1~5」 |
| 连点 | 通用 500ms 去重；「提交」chip 额外 2 秒冷却 | — |
| AI 正在跑 | `followup` 进入下一轮队列 | 条尾显示「已排队」 |
| 宿主重启 | 状态清空，图标回来 | — |

## 8. 边界条件

- 新会话：只有图标。
- 会话切换：组件以 `sessionId` 为 key 重新拉取。
- 多标签页：各自轮询；点击后本地乐观置位，下一次轮询对齐。
- 375px：横向滚动，chip 不换行；条高固定，不挤压输入框。
- `prefers-reduced-motion`：静态描边 + 「待确认」角标。
- 深浅色：只用主题变量。
- 阶段五的两态：`precommit` 未授权时 chip 显示「待授权」，`authorized` 后显示「已授权」。

## 9. 修改范围（文件清单 · 基线）

新增：

1. `plugins/vibe-phase-bar/package.json`
2. `plugins/vibe-phase-bar/cordis.patch.yml`
3. `plugins/vibe-phase-bar/index.js`（工具 + 两个路由 + 状态）
4. `plugins/vibe-phase-bar/client.js`（图标 + 阶段条 + 轮询 + 样式）
5. `plugins/vibe-phase-bar/README.md`
6. `plugins/vibe-phase-bar/test/host.test.js`
7. `plugins/vibe-phase-bar/test/state.test.js`

修改：

8. `C:\Users\autod\OneDrive\开发\vibe-coding-skills\vibe-coding\SKILL.md`
9. `C:\Users\autod\.dsh\skills\vibe-coding\SKILL.md`
10. `README.md`（仓库顶层表格）
11. profile `aa` 的 `package.json` + `dsh.profile.bundles`（经 `dsh plugin add` 写入）

> 计划文件本身不计入修改范围。

## 10. 实现步骤

1. 包骨架，确认可加载。
2. 状态归约纯函数 + 单测。
3. 工具 `vibe_phase` + 单测。
4. 路由 + 单测（含文案、跳过集合、400/404/409）。
5. 客户端图标（`input.left`）+ 启动提交。
6. 客户端条（`input.dock`）：静态渲染 → 轮询 → 点击 → 闪烁 → 横滑 → 关闭。
7. 装到 profile `aa`，重启 dsh，打开 GUI 验收。
8. 手工走完整链：启动 → 1 → 请求 2 → 确认 → 跳到 5 → 预提交 → 再点授权。
9. 改两份 `SKILL.md`，验证降级路径。
10. 补 README 与表格，跑全量 `node --test`。

## 11. 测试方案

- 单测：状态归约（进入/请求/回退/跳阶段/预提交/授权/重置/幂等）、工具参数校验、路由消息文案、客户端纯函数（短名、chip 状态、跳过集合、冷却判定）。
- 人工验收：桌面 + 375px；双标签同步；空白会话启动；草稿非空启动；宿主重启；卸载降级；双击不误提交。
- 回归：现有 `plugins/*/test` 全绿。

## 附：实现期需核实的两个事实（不是待定决策）

1. `inputActions.setDraft()` 后立即 `submit()` 能否同步生效；不能则改为 `requestAnimationFrame` 后再提交。
2. `ctx.agents.get(sessionId)` 在会话空闲/刚创建时是否可用；确认路由据此决定直接 `followup` 还是提示「会话未就绪」。
