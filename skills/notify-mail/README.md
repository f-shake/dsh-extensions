# notify-mail AI 能力

把「发一封邮件」变成一个 agent 能直接调用的动作。一个目录装三样东西：

```
SKILL.md                    给模型看的「何时用、怎么用、边界在哪」
README.md                   给人看的（这份）：设计取舍、配置、排错
scripts/notify-mail.ps1     真正干活发信
scripts/setup-resend.ps1    写入 / 更换 Resend key 与收件人
scripts/tests/              自测（离线为主）
```

## 为什么是 PowerShell 脚本，不是 MCP

- **零依赖**：Windows 自带 PowerShell 7（`pwsh`），脚本只用 .NET 自带库。不引 SDK、不装模块、不要 Python。
- **一个动作**：发一封纯文本邮件，没有工具编排需求。CLI 在任何有 shell 的 agent 里都能用（DSH、Claude Code、Codex、Cursor），MCP 要在每个客户端各配一遍。
- **凭证不进环境变量**：harness 会清洗命中 `KEY|PASSWORD|SECRET|TOKEN` 的环境变量，所以本能力**不读环境变量里的密钥**，只从 DPAPI 密文文件解密。

## 两条通道，为什么都要

| 通道 | 优点 | 代价 |
|---|---|---|
| **Resend HTTPS API** | 绕开 SMTP 的端口/TLS/风控；一条 HTTPS；key 可随时吊销；送达有 SPF/DKIM 兜底 | 未验证发信域名时**只能发注册账号那个邮箱**，且是字面比对；依赖境外服务（本机实测 API ~1s、控制台 ~6s） |
| **SMTP** | 能发任意地址（QQ/163 授权码即可） | 大厂风控、日限额；465 端口要手写会话（`System.Net.Mail.SmtpClient` 不支持「连接即 TLS」） |

脚本按 `mail.json` 的 `channel` 自动选；`secrets/resend.key.enc` 存在且 `channel` 不是 `smtp` 就走 Resend，否则走 SMTP。

## 用法

```powershell
pwsh -NoProfile -File scripts/notify-mail.ps1 -Subject "标题" -Body "正文"
pwsh -NoProfile -File scripts/notify-mail.ps1 -DryRun -Subject x -Body x
pwsh -NoProfile -File scripts/notify-mail.ps1 -To someone@x.com -Subject "..." -Body "..."
```

输出契约（stdout 一行结论）：

- `SENT: <收件人> id=<resend 邮件 id>` → 退出码 `0`
- `FAILED: HTTP <code> <响应体>` / `FAILED: <异常消息>` → 退出码 `1`
- `MISSING_CONFIG: <键名>` → 退出码 `2`

日志：`%USERPROFILE%\.dsh\logs\mail.log`，每次尝试一行（含重试次数与 HTTP 码）。

## 配置与密钥

`%USERPROFILE%\.dsh\mail.json`（非机密）：

```json
{ "channel": "resend", "from": "onboarding@resend.dev", "to": "you@example.com" }
```

`%USERPROFILE%\.dsh\secrets\resend.key.enc`：**Windows DPAPI 加密（CurrentUser 作用域）**，绑定本机账户，文件拷到别的机器/别的用户下解不开。脚本运行时解密，明文只存在于进程内存，绝不打印。

这不是「密钥管理系统」级别的保护：本机同一账户下能跑脚本的东西都能解密。它挡的是「文件被顺手看见、被备份拷走」。

**密钥不放技能目录**：技能目录会被复制、打包、分享；配置和密文放在 `~\.dsh\` 根下。

首次配置 / 换 key：

```powershell
pwsh -NoProfile -File scripts/setup-resend.ps1 -Key "re_xxx" -To "you@outlook.com" -Test
```

## 硬边界（别自行放宽）

- **Resend 测试模式按字面比对收件人**：同一个邮箱的别名、别名转发一律 `403`。要发别的地址只有两条路——验证发信域名并改 `from`，或切 SMTP。
- 免费额度 **100 封/天、3000 封/月**；告警量绰绰有余，但别拿它做批量通知。
- **时间戳一律用本机时钟**。曾踩过：拿被监控服务返回的 `Date` 头当权威时间，而那台机器快 18 分钟，整封通知时间错位。
- 通知类邮件**只在状态翻转那一刻**发一封，不每轮都发。
- 失败**绝不假装成功**：退出码非 0 就如实报「没发出去 + 原因」。

## 安装到另一台机器

1. 复制整个 `notify-mail/` 目录到目标机的 `%USERPROFILE%\.dsh\skills\notify-mail\`。
2. `pwsh -File scripts/setup-resend.ps1 -Key re_xxx -To <注册邮箱> -Test`（DPAPI 密文不能跨机复用，必须重存）。
3. `pwsh -File scripts/tests/test_notify_mail.ps1` 跑一遍自测。
4. 重开 DSH 会话，技能会被自动加载（`SKILL.md` 的 frontmatter 决定触发）。

## 测试

```powershell
pwsh -File scripts/tests/test_notify_mail.ps1           # 离线：13 项断言，不联网、不发信
pwsh -File scripts/tests/test_notify_mail.ps1 -Online   # 额外用真实配置真发一封
```

离线用例覆盖：resend/smtp 两条通道的 dry-run 解析、`-To` 覆盖、空配置时干净失败（exit 2 且不宣称成功）、密钥不出现在输出里。每个用例用独立临时配置根（`-Root`），不碰真实配置。

## 已知局限

- 只发**纯文本**，不支持 HTML 和附件。
- 没有幂等键：调用方重试可能重复投递（邮件本身没有唯一约束可依赖）。
- 路径假设是 Windows（`%USERPROFILE%\.dsh`、DPAPI）；Linux/macOS 需要另写密钥回退。
- 依赖 `pwsh` 7+（`ProtectedData` 需要 `Add-Type -AssemblyName System.Security`）。
