# @local/vibe-phase-bar

给 vibe coding 五阶段流程用的界面：输入框上方一条阶段面包屑，未开始流程时在输入框左下角、加号右侧出一个「`</>`」图标。配套一个模型侧工具 `vibe_phase`，让模型请求进入下一阶段时，那一格会闪烁等你点击。

## 它做什么

| 位置 | 元素 | 行为 |
|---|---|---|
| `conversation.input.left` | `</>` 图标 | 只在没有流程状态时出现。点击发一条启动消息，流程从阶段一开始 |
| `conversation.input.dock` | 五阶段条 | 计划 / 开发 / 复核 / 验证 / 提交。当前阶段高亮，跳过的阶段划掉，被请求的阶段闪烁 |
| 工具 `vibe_phase` | 宿主 | `enter` 进入阶段、`request` 请求确认；请求后阶段条上对应一格开始闪 |

点击阶段条就是确认：宿主把一句用户消息交给 agent（`确认进入阶段 2（开发）。`），同时把状态推进到目标阶段。点更靠后的阶段等于主动跳过中间闸门，消息里会写明跳过了哪几段；点更靠前的阶段等于回退。

阶段五是两步：第一次点只进入**预提交**——模型列出计划提交的文件和提交信息，但不提交；冷却 2 秒后再点一次才是**授权提交**。冷却用来挡掉手滑双击。

条右下角的 `×` 要连点两次才关闭流程（四秒内没有第二次点击就自动收回），避免误触把整条状态清掉。

## 安装

插件装在 profile 里，宿主与客户端两侧一起生效：

```powershell
node C:\Running\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js plugin --profile aa add "@local/vibe-phase-bar@link:<repo>/plugins/vibe-phase-bar"
```

`dsh plugin add` 会同时写入 profile 的依赖与 `dsh.profile.bundles`。装完需要重启 dsh 进程（客户端包在页面加载时取）。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `precommitCooldownMs` | `2000` | 预提交到授权提交之间的最小间隔，单位毫秒 |

## 接口

宿主只暴露三条同源路由（`ctx.webServer`，前缀 `/vibe-phase`）：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/vibe-phase/state?session=<id>` | 读当前阶段状态，没有状态时为 `null` |
| POST | `/vibe-phase/confirm` | `{ session, phase }`：推进阶段并给 agent 发一条用户消息 |
| POST | `/vibe-phase/reset` | `{ session }`：关闭流程、清掉状态 |

客户端每 1 秒轮询一次。不做会话事件订阅，是因为外部客户端插件没有公开的事件订阅口；不做自定义投影，是因为外部插件不能写自定义会话事件。

## 已知限制

- 状态只在宿主进程内存里。重启后阶段条消失、图标回来，流程从头开始。
- 宿主没有 `webServer` 时（无界面的部署），工具照常可用，界面不出现。
- 模型不调用 `vibe_phase` 时，阶段条不会出现——它没有别的办法知道流程开始了。

## 测试

```powershell
node --test test/
```
