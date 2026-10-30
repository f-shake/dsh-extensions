# dsn 公网发布 —— 部署说明

> 生成于 2026-10-28。参照 `<部署记录>`（work-host / dw 那次）复用，
> 差异见文末「与参考文档的差别」。

## 一、链路

```
浏览器  https://dsn.example.com/
   │  DNS: *.example.com → VPS
   ▼
VPS (Windows) nginx :443
   ├─ /_app_auth  → 127.0.0.1:12318  ─┐
   ├─ /_app_login → 127.0.0.1:12318  ─┤  隧道
   └─ /           → 127.0.0.1:12315  ─┤
                                       ▼
                            nas-host（本机）
                              ├─ 127.0.0.1:8791  dsh web（profile aa）
                              └─ 127.0.0.1:8099  dsh-auth（密码 + TOTP）
```

公网上只暴露 443；隧道端口 12315/12318 在 VPS 上只监听回环，外网直连一律不通（已实测）。

## 二、本机已就位的东西

> 下表里的 `C:\dsh`、`C:\tunnel` 是按本机摆放写的示例路径，按你自己的安装位置替换。

| 路径 | 作用 |
|---|---|
| `<repo>\dsh-auth\app.py` | 认证服务（FastAPI）：`/auth` `/check-cookie` `/login-page` `/logout` `/healthz` |
| `<repo>\dsh-auth\login.html` | 登录页（与 dw 那套同一份样式） |
| `<repo>\dsh-auth\.env` | 密码哈希、TOTP 密钥、cookie 密钥、token 文件路径 |
| `<repo>\dsh-auth\totp-qr.png` | Authenticator 扫码用 |
| `<repo>\dsh-auth\totp-auth.log` | 失败审计：`PWD_FAIL` / `TOTP_FAIL` / `COOKIE_FAIL` / `AUTH_OK`，含 IP |
| `<repo>\dsh-auth\start-auth.ps1` | 前台启动（调试用） |
| `<repo>\dsh-auth\install-service.ps1` | 注册为 NSSM 服务 `dsh-auth`（需管理员） |
| `<repo>\dsh-auth\set-password.py` | 改密码 |
| `<repo>\dsh-auth\vps\nginx-dsn.conf` | **要贴到 VPS 的 nginx 配置** |
| `<repo>\dsh-auth\vps\verify-public.ps1` | 公网自检脚本 |
| `C:\dsh\restart-dsh.ps1` | 只重启 dsh（带公网参数，不动同进程树的其它服务） |
| `C:\tunnel\client.toml` | 新增两条隧道 `dsn12315` / `auth12318` |

## 三、凭据在哪

| 东西 | 位置 | 泄露后果 |
|---|---|---|
| 登录密码明文 | 只在人脑 / 密码管理器 | 还需 TOTP 才能进 |
| 密码 PBKDF2 哈希 | 本机 `.env` | 等同于密码 |
| TOTP 密钥 | 本机 `.env` | 可生成有效验证码 |
| 会话 cookie 密钥 | 本机 `.env` | 可伪造会话（改密码即失效） |
| DSH 启动 token | 本机日志 | 可换 DSH cookie |
| 证书私钥 | VPS | 可伪造站点（无法避免） |

公网配置里没有任何字面量凭据——VPS 那份 nginx 配置泄露不等于门被打开。

## 四、VPS 上还要做的三步

1. **贴配置**：把 `vps\nginx-dsn.conf` 的内容按注释位置并入 VPS 的 nginx.conf
   （`limit_req_zone` 那行放 http 段，其余是两个 server 块），把 `<CERT_PATH>` / `<KEY_PATH>`
   换成你自己已有的 443 server 块里那两行证书路径。
2. **验证语法并 reload**：
   ```powershell
   nginx.exe -t -p "C:\nginx/" -c "C:\nginx\conf\nginx.conf"
   nginx.exe -s reload -p "C:\nginx/"
   ```
3. **跑自检**（任一台能上公网的机器）：
   ```powershell
   pwsh -File <repo>\dsh-auth\vps\verify-public.ps1
   ```
   六项全绿才算发布完成。

## 五、日常运维

```powershell
# 认证服务
Get-Service dsh-auth
Restart-Service dsh-auth        # 管理员
Invoke-WebRequest http://127.0.0.1:8099/healthz -UseBasicParsing

# 改密码（改完所有会话失效，TOTP 不变）
<repo>\dsh-auth\.venv\Scripts\python.exe <repo>\dsh-auth\set-password.py

# 重启 dsh（会应用 --trusted-host / --public-url）
pwsh -File C:\dsh\restart-dsh.ps1

# 失败审计
Get-Content <repo>\dsh-auth\totp-auth.log -Tail 30

# 隧道状态
& C:\tunnel\tunnel.exe -c C:\tunnel\client.toml status
```

## 六、诊断顺序（按本机实际情况）

| 症状 | 先看哪里 |
|---|---|
| 502 | VPS 上 `curl 127.0.0.1:12315`；不通就是隧道 |
| 500 | `auth_request` 子请求失败：VPS 上 `curl 127.0.0.1:12318/healthz` |
| 504 | 上游超时：隧道空闲退避或 dsh 卡住 |
| 登录页能开、登录后仍回登录页 | cookie 没带上：看响应头 `Set-Cookie` 有没有 `Secure`，以及 `X-Forwarded-Proto` 是否透传 |
| `/api` 403 | dsh 的 `--trusted-host` 没生效（本次已加，重启后应消失） |

## 七、回滚

- dsh 参数：`pwsh -File <启动脚本> -WithDsh`（改回前的备份在
  `local-up.ps1.bak-*`），或直接
  `node C:\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js --profile aa --no-open --port 8791`
- 隧道：`Copy-Item C:\tunnel\client.toml.bak-<时间戳> client.toml` 后 `Restart-Service <隧道服务>`
- VPS：删掉两个 server 块 + 那行 limit_req_zone，reload

## 八、与参考文档的差别（为什么不一样）

1. **登录用 POST，不是 GET**。参考文档用的是表单 GET，密码哈希会进 URL（浏览器历史、
   Referer、日志）。这里字段放在请求体，同一个哈希不出现在任何 URL 里。
2. **token 取用前先实证**。参考文档直接读日志里的最后一个 token；日志被覆写或进程重启后
   会拿到死 token，表现为「登录成功但回到登录页」。这里先把候选 token 拿去 DSH 换一次 cookie，
   换到才算数，日志里另有一个更早的死 token 也会被自动跳过。
3. **会话 cookie 是无状态的**：`v1.<exp>.<HMAC(secret, 密码哈希|exp)>`。服务重启不掉线，
   改密码即全部失效（参考文档里「会话无法吊销」那条已解决）。
4. **`/_app_login` 必须带 `X-Forwarded-Proto`**，否则 cookie 不会带 `Secure`
   （参考文档的配置段漏了这个头）。
5. 参考文档 §9 里那个坑「重启 DSH 会杀掉同进程树的 nginx/auth/隧道」：本次 dsh 用
   `restart-dsh.ps1` 单独重启，不碰其它进程，从根上避开。
