---
name: notify-mail
description: 用一条命令把邮件发到用户邮箱，用于告警通知、定时检查结果、报告/交付物投递。当用户说「发邮件给我」「邮件通知我」「恢复了邮件告我」「把结果发我邮箱」「每天/每次跑完邮件汇报」时使用。判断依据是**交付物要进收件箱、离开当前会话也要能看到**；只是聊天里回一段文字就能满足时不要用本技能。
---

# 发邮件（notify-mail）

一句话契约：**一条命令发一封纯文本邮件；成功与否看退出码和 stdout，密钥永远不出现在任何输出里。**

脚本自带两条通道（Resend HTTPS API / SMTP），按 `mail.json` 的 `channel` 自动选。默认本机已配好 Resend。

## 快速用法

```powershell
pwsh -NoProfile -File "$env:USERPROFILE\.dsh\skills\notify-mail\scripts\notify-mail.ps1" `
  -Subject "【已恢复】192.0.2.10:8081 登录服务" `
  -Body "首次测通 17:39:30，复测三条全绿，详见会话。"
```

| 参数 | 说明 |
|---|---|
| `-Subject` | 邮件标题，默认「通知」；调用时建议写清「对象 + 状态」，别用只有本机看得懂的名字 |
| `-Body` | 纯文本正文；多行用 PowerShell here-string `@"..."@` |
| `-To` | 覆盖收件人；不传则用 `mail.json` 的 `to` |
| `-DryRun` | 只解析并打印「会用哪条通道、发给谁」，不真发 |

**stdout 是给人和 agent 看的唯一结论**：

- 成功：`SENT: <收件人> id=<resend 返回的邮件 id>`
- 失败：`FAILED: HTTP <code> <响应体>` 或 `FAILED: <异常消息>`
- 缺配置：`MISSING_CONFIG: <缺的键>`

**退出码**：`0` 成功 · `1` 发送失败 · `2` 缺配置。**以退出码为准，不要靠肉眼猜 stdout 是否为空。**

## 先查再发

动手前先跑一次 dry-run，确认通道和收件人没跑偏（尤其是刚改过配置、或要发到非默认地址时）：

```powershell
pwsh -NoProfile -File "...\notify-mail.ps1" -DryRun -Subject "x" -Body "x"
```

## 当前配置与硬限制（Resend 测试模式）

配置在 `%USERPROFILE%\.dsh\mail.json`（非机密）：`channel` / `from` / `to` / 可选 `smtp_host`、`smtp_port`。

当前账号：`from=onboarding@resend.dev`，`to=you@example.com`。

**没验证发信域名时，Resend 只允许**：

1. `from` 必须是 `onboarding@resend.dev`；
2. `to` **只能等于注册账号的邮箱**，且是**字面字符串比对**——同一个邮箱的别名、别名转发一律 `403`。

所以「发到别的地址」只有两条路：在 Resend 验证一个域名并把 `from` 换成该域名，或切 SMTP 通道（QQ/163 授权码可发任意地址）。**不要试图用改写 `from`/`to` 绕过限制，那是服务端强校验。**

## 密钥怎么存

- Resend key：`%USERPROFILE%\.dsh\secrets\resend.key.enc`，**Windows DPAPI 加密、绑定本机账户**，文件拷走解不开。脚本运行时解密，明文只存在于进程内存。
- SMTP 凭据：`%USERPROFILE%\.dsh\.env` 的 `SMTP_USER` / `SMTP_PASS`（或 `mail.json` 的 `smtp_host`/`smtp_port`）。
- **绝不**打印密钥、写进仓库、写进提交信息、或贴进聊天记录。key 泄漏就去 Resend 控制台 roll。

首次配置（或换 key）：

```powershell
pwsh -NoProfile -File "$env:USERPROFILE\.dsh\skills\notify-mail\scripts\setup-resend.ps1" `
  -Key "re_xxx" -To "you@example.com"
```

## 失败怎么处置

1. 看退出码和 stdout，再看日志 `%USERPROFILE%\.dsh\logs\mail.log`（每次尝试都有一行）。
2. 常见情形：

   | 现象 | 含义 | 处置 |
   |---|---|---|
   | `401 restricted_api_key` | key 只有发信权限，属正常；别用它调 `/domains` 之类接口 | 无需处理 |
   | `403 validation_error` + `only send testing emails to your own email address` | 收件人不是注册邮箱 | 换回注册邮箱，或验证域名/改走 SMTP |
   | `401` / `invalid api key` | key 被吊销或写错 | 让用户重新生成，用 `setup-resend.ps1` 重存 |
   | `429` | 触发限流 | 脚本已自动重试（2s、4s），仍失败就等一会儿 |
   | `5xx` / 超时 | 上游或网络问题 | 脚本已重试；最终失败就如实告诉用户「邮件没发出去 + 原因」 |
   | `MISSING_CONFIG` | 配置或密钥缺失 | 按上文补齐，别改用别的通道硬凑 |

3. **绝不假装发出去了。** 失败就明确说「邮件没发成，原因是 X」，并把已经确认的事实（是否重试过、日志里有什么）一起给。

## 写邮件正文的规矩

- 纯文本，别塞 Markdown 表格（部分客户端显示难看）；需要列点就用缩进或 `1) 2) 3)`。
- **时间戳一律用本机时钟**（本机已对外校时）。曾踩过坑：拿被监控服务返回的 `Date` 头当权威时间，而那台机器的钟快 18 分钟，导致通知里的时间整体错位。**服务器时钟 ≠ 真实时间，发通知前先跟本机对一下。**
- 通知类邮件写四段就够：**发生了什么 → 首次观测时间 → 复测证据（原样贴状态码/响应）→ 结论**。
- 定时类任务只在**状态翻转那一刻**发一封，别每轮都发。

## 自测

改过脚本、换过 key、或搬到新机器后，先跑一遍（离线，不联网、不发信）：

```powershell
pwsh -NoProfile -File "$env:USERPROFILE\.dsh\skills\notify-mail\scripts\tests\test_notify_mail.ps1"
# 想顺带真发一封验证收件箱：
pwsh -NoProfile -File "...\scripts\tests\test_notify_mail.ps1" -Online
```

13 项断言覆盖：两条通道的 dry-run 解析、`-To` 覆盖、空配置时干净失败（exit 2 且不宣称成功）、密钥不出现在输出里。设计取舍与安装说明见同目录 [`README.md`](README.md)。

## 依赖与位置

- 脚本自包含，只依赖 Windows PowerShell 7（`pwsh`）与 .NET 自带库，不需要装模块。
- 脚本有 `-Root <目录>` 参数，默认 `%USERPROFILE%\.dsh`；**只有自测会用它**，正常调用不要传。
- SMTP 通道同时支持 `587 STARTTLS` 和 `465 直连 SSL`（465 走手写会话，因为 `System.Net.Mail.SmtpClient` 不支持 465）。
- 脚本、技能说明都在 `%USERPROFILE%\.dsh\skills\notify-mail\`；配置与密钥在 `%USERPROFILE%\.dsh\` 根下，**不要**把密钥放进技能目录（技能目录会被复制/分享）。
