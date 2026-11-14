# dsh-host

本机 DSH web 实例的**启动与接入配置**：怎么起、绑哪个地址、局域网怎么进来、profile 的 patch 长什么样。
这三类东西平时散在 `%LOCALAPPDATA%\DeepSeekHarness` 和 `~/.dsh/profiles/web`，改坏了才发现没留底，所以在这里收一份。

```
dsh-host/
├── launcher/     启动与停止（留底副本；本机实际由 %LOCALAPPDATA%\DeepSeekHarness 启动）
│   ├── DeepSeekHarness.vbs       启动入口：wscript 静默调 pythonw launcher.py
│   ├── launcher.py               真正的启动器：选地址、拉起 dsh、抓 token、记 pid
│   ├── StopDeepSeekHarness.vbs   停止入口
│   └── stop.ps1                  停止实现
├── network/
│   └── setup-lan.ps1             幂等的防火墙 + portproxy 配置（需管理员）
└── profile/
    └── cordis.patch.yml          web profile 的 patch 层（preset、本地模型、UI、权限）
```

## 启动链路

```
DeepSeekHarness.vbs
  └─ pythonw launcher.py
       ├─ 探测默认路由网卡的 IPv4（当前 192.168.0.10）
       ├─ node <npm>/@deepseek-ai/dsh/lib/bin.js web --host <lan ip> --port 8791 --no-open
       │     （DETACHED_PROCESS + 新进程组：会话里的 CTRL_C 打不到服务）
       ├─ 从 stdout 抓 "dsh web: http://…?token=…"
       ├─ 写 lan-url.txt / local-url.txt / dsh.pid
       │     （dsh.pid 只写不读，停止逻辑靠命令行匹配；见「已知缺陷」）
       └─ 若已在运行：直接用存下的 token 打开浏览器
```

`launch.ps1` 是上一代启动器，已退役（`DeepSeekHarness.vbs` 不再引用它）。它只存在于旧安装目录
`%LOCALAPPDATA%\DeepSeekHarness`，本仓库不留底；留着会和 `launcher.py` 抢同一端口，遇到可以删。

## 为什么绑具体 IP，而不是 0.0.0.0

dsh 明确拒绝通配地址，CLI 和 webserver 两层都检查：

```
error: --host 0.0.0.0 is an unspecified (wildcard) address, which is not supported:
binding every interface would expose remote code execution to the network; bind one
concrete IPv4 or IPv6 address instead
```

所以 `launcher.py` 选「默认路由那张网卡的 IPv4」。换网络（DHCP 换段）时地址会变，`launcher.py` 每次启动重新探测，不用改脚本；但 portproxy 的转发目标要跟着改，见下。

## 局域网接入 = 防火墙 + portproxy

```
LAN 设备 ──> <lan ip>:8791 ──> dsh (node)
本机浏览器 ──> 127.0.0.1:8791 ──[portproxy]──> <lan ip>:8791
```

`network/setup-lan.ps1`（管理员）幂等地建两样东西：

```powershell
New-NetFirewallRule -DisplayName 'DSH Web 8791 (LAN)' -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort 8791 -Profile Domain,Private -RemoteAddress LocalSubnet
netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=8791 `
  connectaddress=<lan ip> connectport=8791
```

`-Remove` 撤销这两项。

两个坑记一下：

- **不能把 portproxy 的监听改成 `0.0.0.0`**。`0.0.0.0:8791` 占住端口后，dsh 再绑 `<lan ip>:8791` 就 `EADDRINUSE`；而它转发到 `127.0.0.1:8791` 又会落回自己 -> 请求自环，客户端看到的是空回复。
- 走 portproxy 的请求 Host 是 `127.0.0.1`，`isTrustedApiRequest` 对 loopback 主机放行（但仍会拒绝
  `sec-fetch-site: cross-site` 并校验 Origin），所以不需要配 `--trusted-host`。（只有在 dsh 绑 loopback、
  由代理转发外部 Host 时才需要。）

## token 与 URL 文件

token 每次进程启动重新生成，只出现在启动打印的那一行；`launcher.py` 把它拆成两条：

- `lan-url.txt` → `http://<lan ip>:8791/?token=…`（手机/别的机器用）
- `local-url.txt` → `http://127.0.0.1:8791/?token=…`（本机用）

裸地址永远是 401，响应体是 `dsh web authentication required; reopen the URL printed by dsh web.`，
这是设计：token 换一个绑定在 `主机:端口` 上的 cookie，之后靠 cookie（所以两个 authority 各要换一次）。
**那条 URL 等于这台机器的完整控制权**，不要外发；怀疑泄漏就重启一次。

token 每次进程启动重新生成，所以 URL 文件会过期：若 dsh 是被 `launcher.py` 之外的方式重启的
（手工跑 `dsh web`、旧启动器、崩溃后别的脚本拉起），文件里是上一进程的 token，打开只会得到 401。
这时看 `dsh.out.log` 最后一行 `dsh web: …`，或者先停止再启动（`StopDeepSeekHarness.vbs` 再点启动快捷方式）
让 `launcher.py` 重新拉起进程、重新写文件。注意：只点启动**不会**刷新——端口已通时 `launcher.py`
走的是"已在运行"分支，只会再打开一次那个过期的地址。

## 停止与重启

- 停止：`StopDeepSeekHarness.vbs` -> `stop.ps1`。
- `stop.ps1` 按**命令行**找 node 进程，不按端口找——portproxy 让 `127.0.0.1:8791` 看起来属于 svchost，按端口会杀错。
- **不要从 dsh 自己的会话里执行停止/重启**：那是 dsh 的子进程，`Stop-Process` 会把自己一起带走，看起来像"命令失败"。要么点快捷方式，要么起一个脱离进程（`Invoke-CimMethod Win32_Process Create`，父进程会变成 `WmiPrvSE`）来做这件事。

## 已知缺陷（留底副本按原样保留）

`launcher/` 下四个文件是**本机原件的逐字副本**，允许与原件哈希一致；因此这里只记录问题、不修代码——
要修就改本机原件，再重新留底，否则副本与运行中的代码会分叉。已核对并记录的缺陷：

- `stop.ps1` 第二段按 `$dir\launch.ps1` 匹配 powershell 包装进程，而 `launch.ps1` 已退役、仓库里也没有这个文件，
  这段在仓库布局下永远匹配不到（死代码）。
- `stop.ps1` 用 `$ErrorActionPreference='SilentlyContinue'` 且由 vbs 隐藏调用：停止失败没有任何反馈，
  表现为"点了没反应、服务还在"。真遇上了在终端里手工按命令行杀。
- `launcher.py` 启动后 90 秒抓不到 token 就只报失败，不终止已经 detach 的 node 进程；用户看到"启动失败"，
  服务却可能在监听，下次运行会走"已在运行"分支打开旧 URL。
- `dsh.pid` 只写不读：停止靠命令行匹配，launcher 自己不读它，停止后也不删除。

## profile patch

`profile/cordis.patch.yml` 是 `~/.dsh/profiles/web/cordis.patch.yml` 的副本，7 条顶层项、按用途分五类：

| 段 | 作用 |
|---|---|
| `ui-settings-general` / `ui-chat` / `ui-conversation` | 界面偏好：欢迎提示版本、transcript 视图、忙碌时回车=插话 |
| `permission` | 三档权限预设，默认 `danger-full-access` |
| `llm-pi-ai` | 本机 llama-server（`127.0.0.1:8081/v1`），模型名必须是 `--alias`，apiKey 走 `~/.dsh/.credentials.yaml` 的 `LOCAL_API_KEY` ref |
| `agent-default-model` | 新会话默认模型：`provider: local` / `model: local-model`，覆盖 base 的 `deepseek-official` / `deepseek-flash`。llama-server 没起时新会话首次请求会失败 |
| `insert: preset-chat` | 第五个 agent preset「问答（无命令行）」 |

关于 `preset-chat` 的能力边界要说清：它裁掉了 shell/fs/jobs/skill/goal/subagent 这些**preset 作用域**的行，但 `@local/deliver`、`typo-proof`、`vibe-phase-bar`、`dsh-mnemon` 和 base 的 `tool-working-directory` 注册在全局工具服务上，**preset 裁不掉**。也就是说那个会话仍能通过 `deliver` 投递文件、通过 `typo_check` 读写 docx。要真正隔离，需要另开一个只装 base+web-app 的 profile（第二个实例）。

patch 里没有密钥：只有 `apiKeyEnv` 的名字，真正的 key 在 `~/.dsh/.credentials.yaml`。

## 迁移到新机器

1. 装 `@deepseek-ai/dsh`，建 profile（`dsh web` 首次运行会初始化）；
2. 把 `profile/cordis.patch.yml` 拷到 `~/.dsh/profiles/web/`；
3. 把 `launcher/` 整个拷到 `%LOCALAPPDATA%\DeepSeekHarness`，改 `DeepSeekHarness.vbs` 里的 python 路径；
4. 管理员跑一次 `network/setup-lan.ps1`（只在本机需要局域网接入时才做）；
5. 首次启动会在同目录生成 `dsh.out.log` / `*.url.txt`；`dsh.out.log` 必须是 UTF-8（`launcher.py` 就是这么写的，别用 `Tee-Object` 覆盖，它会写成 UTF-16，token 行就读不出来了）。
