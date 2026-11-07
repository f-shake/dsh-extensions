# llm-retry-ladder

把模型请求重试从「指数退避」换成分段常量阶梯，默认 **1 秒 5 次 → 2 秒 5 次 → 10 秒 100 次**。

## 为什么不能直接改配置

内置 `dsh-llm-retry` 的延迟恒为：

```
delay = min(min(initialDelayMs · 2^(retry-1), maxDelayMs) × jitter, maxDelayMs)
```

可配的只有 `initialDelayMs`、`maxDelayMs`、`jitterRatio` 三个数。指数天然是
1×/2×/4×/8×，**没有「在同一档原地重复 N 次」的机制**，所以「1 秒 5 次、2 秒 5 次、
10 秒 100 次」这种分段阶梯写不出来：

| 配置 | 实际序列 |
|---|---|
| `initial=1000, max=10000` | 1, 2, 4, 8, 10, 10, 10… |
| `initial=1000, max=2000` | 1, 2, 2, 2, 2… |

本插件接管 `agent/request-error` 自己算阶梯，并在自己的 bundle 补丁里把 `llm-retry`
停用（两层策略同时挂着会先被内置的 500ms 指数退避吃掉预算）。

## 行为

| 第几次重试 | 等待 |
|---|---|
| 1–5 | 1 s |
| 6–10 | 2 s |
| 11–110 | 10 s |
| 第 111 次起 | 不再重试，错误照常抛给上层 |

- 默认对 `EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT` 重试；
  `AUTH`、`QUOTA`、`INVALID_REQUEST`、`CONTEXT_WINDOW_EXCEEDED` 等一律不重试。
  错误码的归属：**插件级 `retryableCodes` 显式写过就全局接管**（改一处管所有 provider）；
  没写过就**逐个 provider 用它自己的 `retryPolicy.retryableCodes`**（适配器总会用
  `resolveRetryPolicy` 把默认值填满，所以拿到的要么是你配的，要么就是同一套默认五码）。
- 次数由阶梯决定，**provider 的 `maxRetries` 只当开关用**：填 `0` 表示该 provider 不重试，
  填其他值不会改变阶梯（这是刻意的——次数正是本插件要接管的东西）。
- `retryPolicy.mode: "always"` 时不看错误码（任何失败都重试），但次数仍受阶梯上限约束，
  且每个 provider 只告警一次。
- 计数按 `(agent, provider, turn, step)` 隔离：同一轮同一步内连续重试，换一步重新从 1 数。
- 等待可中断：用户点停止、turn 被取消、插件卸载都会立刻放弃本次重试。
- 默认 `jitterRatio: 0`，延迟是准的（内置默认 ±10% 抖动）。开了抖动后，单次实际延迟
  会在基础值的 `1 ± jitterRatio` 倍之间浮动，所以**单次上限不是 `retryAfterMaxMs`**：
  通式是最坏上界 `max(该档阶梯延迟, retryAfterMaxMs) × (1 + jitterRatio)`。上限管的是
  「要不要重试」，不是最终停多久。
- `retryAfter: "floor"`（默认）时，若服务端 `Retry-After` 要求等得更久就听它的，不会抢跑；
  但**超过 `retryAfterMaxMs` 就放弃这次重试**、把错误交给人（默认上限等于阶梯最高档 10 s，
  跟着服务端睡一小时等于让 turn 静默挂住）。想要严格按阶梯设成 `"ignore"`。

### 事件语义

每次重试仍照内置插件的样子发 `llm/retry` / `llm/retry-started`。这不是装饰：

- 会话格式迁移（v3→v4）会校验「retry 连续递增、一条策略链一个 `retryId`、provider 与
  `request/header` 一致」，字段集合按 disposition 表固定；
- 前端聊天区据此画重试节点；
- `token-meter` 靠 `llm/retry-started` 清替换槽，不发的话重试消耗的 token 会被算成
  「替换上一次」而不是累加，用量偏少。

## 配置

```yaml
- id: llm-retry-ladder
  name: '@local/llm-retry-ladder'
  config:
    steps:
      - { delayMs: 1000, attempts: 5 }
      - { delayMs: 2000, attempts: 5 }
      - { delayMs: 10000, attempts: 100 }
    retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]  # 显式写=全局接管；删掉这行则听各 provider 自己的
    jitterRatio: 0            # 0–1，0 为准时
    retryAfter: floor         # floor | ignore
    retryAfterMaxMs: 10000    # 服务端要求超过这个值就放弃重试，默认取阶梯最高档
    enabled: true
```

配置是**严格校验**的：拼错的键（`stepz`）、`enabled: "false"` 这种字符串、`attempts: true`
都会直接抛错让 Loader 报出来，而不是悄悄跑默认阶梯。

单个 provider 想临时关掉重试，给它配 `retryPolicy: { mode: normal, maxRetries: 0 }`。
provider 自己的 `retryableCodes` 只在**插件级没显式写**时才生效（插件级写了就全局接管，
见上面示例那行的注释）；`mode: always` 不看错误码（次数仍受阶梯约束，告警一次）。

## 安装

```powershell
node C:\Running\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js plugin --profile aa add "@local/llm-retry-ladder@link:C:/Users/autod/Documents/GitHub/dsh-extensions/plugins/llm-retry-ladder"
```

再把 `@local/llm-retry-ladder` 加进 profile `package.json` 的 `dsh.profile.bundles`（CLI 会加）。
**必须重启 dsh** 才生效——停用 `llm-retry` 属于装载期改动，热重载不覆盖。

## 验证

```powershell
cd plugins/llm-retry-ladder
pnpm test          # 等价于 node --test test/
```

装好后对着一个会失败的路由（比如把 `baseURL` 指到不通的端口）跑一轮，看会话里
`llm/retry` 的 `delayMs` 序列是否 1000×5 → 2000×5 → 10000…，`retry` 是否从 1 连续。

## 已知取舍

- **计数在内存里**，不落 session projection。进程重启后计数归零：那条请求本身也已经没了，
  不值得为此引一个 zod 依赖（本插件零依赖、零构建）。极端情况下重启恰好落在重试等待中，
  新链的 `retry` 会从 1 重新开始，理论上与格式迁移的连续性校验冲突——实际触发需要
  「进程在等待期间被杀 + 该会话之后做 v3→v4 迁移」，概率极低。
- **110 次合计约 17 分钟**（`jitterRatio: 0` 时约 1015 秒；开 0.1 抖动约 15–19 分钟）。真挂了会空白等很久，界面上看起来就是卡住（停止按钮仍有效）。
  每次重试都会往 session 追加一条 `llm/retry`，长尾场景日志会明显变长。
- **最坏壁钟时间有上界**：阶梯本身 110 次，服务端 `Retry-After` 超过 `retryAfterMaxMs`
  （默认 10 s，等于阶梯最高档）就直接放弃重试，不会跟着服务端无界拉长。注意这个上限
  约束的是「要不要重试」，不是单次停多久——单次延迟的最坏上界是
  `max(该档阶梯延迟, retryAfterMaxMs) × (1 + jitterRatio)`。默认配置下 `retryAfterMaxMs`
  正好等于最高档，于是退化成 `retryAfterMaxMs × (1 + jitterRatio)`。两个边界情形：
  阶梯档位高于 `retryAfterMaxMs` 时，单次仍会停在档位上；`retryAfterMaxMs` 高于阶梯最高档时，
  上式偏大——服务端的值只要不超过上限就被直接采用，不再乘抖动，所以它只能当上界读。
- 停用 `llm-retry` 后，它的 `llmRetry` session projection 也不再注册；该 projection 只有
  它自己用，前端读的是原始事件，不受影响。
