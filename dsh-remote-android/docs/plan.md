# DSH 远程 Android 客户端 · 开发计划

状态：定稿，等待闸门1 确认
日期：2026-10-29

## 0. 目标

一个 Android 应用，用于远程访问已发布到公网的 DSH 实例：先选主机（可配置），原生登录页完成密码与动态验证码认证，再用 WebView 承载该主机的 DSH 界面。

| 项 | 值 |
|---|---|
| 工程位置 | `<repo>\dsh-remote-android` |
| 包名 | `com.fshake.dshremote` |
| 应用名 | DSH 远程 |
| 仓库 | `f-shake/dsh-extensions` 的 `dsh-remote-android/` 子目录（提交与推送分步授权） |
| 签名 | `signing/dshremote.jks` 与 `signing/keystore.properties` 只放本机，都不入库（已被 .gitignore 忽略） |

## 1. 功能需求

| 编号 | 需求 | 验收方式 |
|---|---|---|
| R1 | 启动进入主机列表；每条显示名称、主机名、最近使用时间、登录状态；点击即连接 | 单测 + 手测 |
| R2 | 首次安装预置 dsn.example.com 与 dw.example.com 两条，可编辑、可删除 | 单测 + 手测 |
| R3 | 主机可新增、编辑（改名、改地址）、删除；删除需二次确认；改动持久化 | 单测 + 手测 |
| R4 | 地址校验：只接受 https，归一化为 origin，拒绝带路径、查询、重复地址，并给出明确提示 | 单测 |
| R5 | 连接主机时若已有有效会话，直接进入 DSH 界面；否则进入原生登录页 | 单测 + 手测 |
| R6 | 原生登录页提供密码与 6 位动态验证码两个输入；密码可切换明文；提交期间显示进度并禁用重复提交；填满不自动提交 | 单测 + 手测 |
| R7 | 登录成功后进入 DSH 界面，会话 cookie 由 WebView 持有并自动持久化 | 手测 |
| R8 | 登录失败按原因区分提示：凭据错误、提交频繁、网络不通、服务不可用 | 单测 + 手测 |
| R9 | 会话过期（被网关重定向到 /login.html）时自动回到原生登录页并提示已过期，不显示网关登录页 | 单测 + 手测 |
| R10 | WebView 顶部工具栏提供返回、刷新、主机标识、更多菜单（在浏览器打开、退出登录、清除密码、切换主机） | 手测 |
| R11 | 网页触发的文件选择调起系统选择器，支持多选与类型过滤，取消后页面不报错 | 手测 |
| R12 | 网页触发的下载交给系统下载管理器，并提示已开始下载 | 手测 |
| R13 | 指向其他站点的链接用系统浏览器打开，不在应用内加载 | 手测 |
| R14 | 上游不可用（502、504）或断网时显示原生提示与重试按钮，替代 WebView 默认错误页 | 手测 |
| R15 | 记住密码：开关打开时密码经系统密钥库加密保存，登录页自动填充；可单独清除 | 单测 + 手测 |
| R16 | 退出登录只清除当前主机的登录 cookie，不影响其他主机与已保存密码 | 手测 |
| R17 | 主机列表显示每台主机的登录状态（剩余有效期或需登录），有效期取自登录响应，不写死天数 | 单测 + 手测 |
| R18 | 大屏适配：宽度 ≥600dp 时主机列表双列且内容限宽 840dp，登录页与编辑页居中限宽 480dp | 单测 + 手测 |

说明：动态验证码由服务端强制，客户端无法跳过。会话有效期由服务端会话 cookie 决定，客户端只负责沿用与展示。

## 2. 技术方案

### 2.1 选型

| 项 | 选择 |
|---|---|
| 语言与 UI | Kotlin 2.1.20、Jetpack Compose、Material 3、material3-window-size-class |
| 构建 | Gradle 8.10.2、AGP 8.7.3、JDK 17 |
| SDK | compileSdk 35、targetSdk 35、minSdk 26 |
| 网络 | OkHttp 4.12 |
| 网页容器 | 平台 WebView，配 androidx.webkit 做能力判断 |
| 持久化 | 主机配置用 DataStore（JSON）；会话 cookie 交给 WebView 自身存储；密码用 Android Keystore 加密后存 SharedPreferences |

构建源：Gradle 发行版走腾讯镜像（`services.gradle.org` 本机实测超时），Maven 依赖优先阿里云镜像，Google 仓库用 `dl.google.com`（本机实测 296 毫秒）。本机 SDK 现只装 platform-34，需补装 platform-35 与 build-tools 35（约 60 MB）。

### 2.2 选型理由

- 与本机已有项目同一套栈，Gradle、AGP 与依赖缓存可复用。
- 功能面只有两个表单页加一个 WebView，引入 Flutter 或 React Native 会增加一套运行时与构建链，没有收益。
- OkHttp 可以精确控制“不跟随 302”、读取 Set-Cookie、设定超时，并且能用 MockWebServer 做纯 JVM 单测。
- 用平台 WebView 而不自带 Chromium：包体小，随系统更新。

### 2.3 认证协议（依据 dsh-auth 源码与实测）

| 环节 | 事实 |
|---|---|
| 登录页 | `GET /login.html` 免认证，200 |
| 提交 | `POST /_app_login`，`application/x-www-form-urlencoded`，字段 `password`、`code` |
| 成功 | 302，`Location` 为 `/?token=…` 或 `/`，`Set-Cookie: dsh_auth=v1.<exp>.<hmac>`；`HttpOnly`、`Secure`、`SameSite=Lax` |
| 成功但不带 token | 网关改用离线签发，额外下发 `dsh-auth-<sha256(host)>=…` |
| 失败 | 302，`Location` 为 `/login.html?e=bad`，无 Set-Cookie |
| 限流 | nginx `limit_req` 5 次/分、突发 3，超限返回 429 |
| 会话校验 | nginx `auth_request` 校验 `dsh_auth`；未通过 302 到 `/login.html` |
| 会话有效期 | 服务端变量 `DSH_SESSION_TTL`，dsn 实测为 604800 秒（7 天）；cookie 值 `v1.<exp>.<hmac>` 里的 `exp` 是 Unix 秒，客户端可直接读出真实到期时间 |

关键实现：原生登录只负责拿到 cookie 与下一跳地址；把响应的 Set-Cookie 全部写入 WebView 的 CookieManager，再由 WebView 加载下一跳地址，让 DSH 在正确的 authority 下自行签发会话 cookie。这样不必手工构造 DSH 的 cookie，也符合服务端“cookie 绑定 host:port”的设计。

有效期不写死：从 `dsh_auth` 的 `v1.<exp>` 或 `Max-Age` 计算剩余时间，写入该主机的本地状态，用于列表展示与过期提示。

### 2.4 应用图标

取自 DSH 官方前端资源 `dsh-web-frontend/dist/favicon.svg` 的鲸鱼路径（单一 path，fill 为黑），转成 Android VectorDrawable：`viewportWidth=50`、`viewportHeight=50`，路径数据原样保留。自适应图标背景纯白 `#FFFFFF`，前景按安全区缩放到 108dp 画布的 44%，与浏览器标签页上的观感一致。

### 2.5 被否决的方案

| 方案 | 否决理由 |
|---|---|
| 直接加载网关登录页 | 不满足“登录页用原生”的明确要求 |
| 在 WebView 里注入脚本填表提交 | 拿不到 HttpOnly cookie，还要处理同源跳转，随页面改版失效 |
| OkHttp 跟随完整重定向再复制 cookie | 需要自行解析 DSH 的 Set-Cookie 并拼域名路径，多一处出错点，且 token 会在不可见的请求里被消耗 |
| Trusted Web Activity | 无法定制登录与主机列表，cookie 不受控 |
| 在既有客户端上加功能 | 产品定位与后端 API 完全不同，只能借鉴技术栈 |
| 固定桌面视图或 UA 切换开关 | 已定只用手机 UA |

## 3. 系统结构

```
UI 层      HostListScreen   LoginScreen   WebScreen   HostEditScreen
               │                │            │
           HostListViewModel  LoginViewModel  WebViewModel
               │                │            │
应用层      HostRepository    LoginUseCase   SessionGate
               │                │            │
数据层      HostStore        LoginClient   CookieBridge   PasswordVault
               │                │            │                │
平台        DataStore         HTTPS        WebView Cookie    Android Keystore
                                           Manager
```

调用链：主机列表选中主机 → SessionGate 决定直接进 Web 还是进登录 → 登录经 LoginClient 取结果、CookieBridge 注入 cookie → 进 Web；Web 拦截到 `/login.html` 时回到 SessionGate → 登录。

## 4. 数据结构

```kotlin
@Serializable
data class HostEntry(
    val id: String,             // UUID，稳定标识
    val name: String,           // 展示名，非空，最长 40 字符
    val baseUrl: String,        // 归一化 origin，形如 https://dsn.example.com
    val createdAt: Long,
    val lastUsedAt: Long,       // 0 表示从未使用
    val sessionExpiresAt: Long, // 0 表示未知或需要登录
)
```

```kotlin
@Serializable
data class AppState(
    val hosts: List<HostEntry> = emptyList(),
    val selectedHostId: String? = null,
    val rememberPassword: Boolean = true,
)
```

地址归一化规则：scheme 必须为 https；host 转小写并做 IDN 到 punycode；默认端口 443 省略、非默认端口保留；不允许 userinfo、path、query、fragment；结果只保留 origin。

```kotlin
sealed interface AuthOutcome {
    data class Success(val nextUrl: String, val cookies: List<String>, val sessionExpiresAt: Long) : AuthOutcome
    data object InvalidCredentials : AuthOutcome
    data object RateLimited : AuthOutcome
    data class ServerError(val status: Int) : AuthOutcome
    data class UnexpectedStatus(val status: Int) : AuthOutcome
    data class NetworkError(val reason: String) : AuthOutcome
}
```

`cookies` 为逐条 `Set-Cookie` 的 name=value 片段，属性另行保留，注入时统一补 `Path=/; Secure`。`sessionExpiresAt` 解析自 `dsh_auth` 的 `v1.<exp>`，解析失败时回落 `Max-Age`，两者都缺则记 0（未知）。

密码存储：`PasswordVault` 以主机 id 为键，值为 Keystore AES-GCM 加密后的 Base64（IV 与密文拼接）。密钥在 Android Keystore 内生成，不可导出。加解密抽象为接口，便于单测注入替身。

## 5. 模块划分

| 模块 | 负责 | 不负责 |
|---|---|---|
| `core/HostUrl` | 地址解析、归一化、合法性判定 | 持久化、网络 |
| `core/UrlMatchers` | 判定某个 URL 是否为本主机的网关登录页 | 发起跳转 |
| `core/CookieExpiry` | 从 Set-Cookie 解析会话到期时间 | 存 cookie |
| `core/LayoutPolicy` | 依宽度决定列数与内容限宽 | 具体布局实现 |
| `data/HostStore` | 读写主机配置、首次预置、结构变更 | 校验规则、排序语义 |
| `data/HostRepository` | 增删改、排序、记录最近使用与登录状态 | UI 状态、网络 |
| `auth/LoginClient` | 构造表单、执行 POST、把响应分类为 AuthOutcome | 注入 cookie、导航 |
| `auth/CookieBridge` | 写入与清除 WebView cookie | 决定跳哪一页 |
| `auth/PasswordVault` | 密码的加密保存、读取、清除 | 校验密码正确性 |
| `auth/SessionGate` | 路由决策：进 Web 还是进登录 | 页面渲染 |
| `web/DshWebView` | WebView 配置、文件选择、下载、外链、SSL 与 HTTP 错误处理、登录页拦截 | 鉴权判断 |
| `ui/*ViewModel` | 状态机与事件处理 | 网络与持久化细节 |
| `ui/*Screen` | 渲染与输入收集 | 业务判断 |

## 6. 交互逻辑

1. 冷启动 → 主机列表（无主机时显示空状态与“添加主机”）。
2. 点某主机 → 记录最近使用 → 进入 Web 路由。
3. Web 路由加载 `https://host/`：
   - 落到 `/login.html`（被拦截）→ 进入登录页，reason 为“需要登录”。
   - 正常加载 → 显示 DSH 界面。
4. 登录页：密码按开关决定是否已填充；输入 6 位验证码 → 提交：
   - 成功 → 注入 cookie、记下到期时间 → Web 加载 `nextUrl`（通常带 token）→ DSH 签发会话 → 落到 `/`。
   - 失败 → 停在登录页显示原因，清空验证码，保留密码。
5. Web 内任意导航命中 `/login.html` → 拦截，回到登录页，reason 为“登录已过期”。
6. 工具栏“切换主机” → 回到主机列表；各主机 cookie 互不影响。
7. 工具栏“退出登录” → 清除该主机 cookie 与登录状态 → 回到登录页。
8. 工具栏“清除密码” → 删除该主机保存的密码，需二次确认。
9. 返回键：WebView 可后退则后退，否则回到主机列表。

状态机：

```
HostList → Connecting(host) → WebReady
                           → NeedLogin(reason) → LoggingIn → WebReady
                                                        → LoginFailed(message)
```

## 7. 异常情况

| 场景 | 判定依据 | 用户看到 | 恢复 |
|---|---|---|---|
| 密码或验证码错误 | 302 到 `/login.html?e=bad` | 登录页提示：密码或动态验证码不正确，请重新输入 | 清空验证码，保留密码 |
| 提交过于频繁 | HTTP 429 | 提示：提交过于频繁，请等待一分钟后重试 | 禁用提交 60 秒后恢复 |
| 上游不可用 | HTTP 502、503、504 | 提示：服务器暂时不可用，请稍后重试 | 重试按钮 |
| 网络不通或超时 | IOException，超时 8 秒 | 提示：无法连接到服务器，请检查网络 | 重试按钮 |
| 响应非预期 | 200 或其他状态 | 提示：登录接口返回异常，状态码 n | 返回重试 |
| 会话过期 | Web 导航命中 `/login.html` | 登录页提示：登录已过期，请重新登录 | 重新登录 |
| 证书校验失败 | onReceivedSslError | 停止加载并提示：服务器证书校验失败，已停止连接 | 仅可返回 |
| 下载失败 | DownloadManager 失败广播 | 提示：下载失败 | 可重试点击 |
| 文件选择取消 | 回调为空 | 无提示 | 无 |
| 密码解密失败（密钥失效或被清除） | Keystore 抛异常 | 静默清空已保存密码，登录页留空 | 重新输入 |

## 8. 边界条件

- 主机列表为空：显示空状态与引导按钮。
- 密码为空或验证码不足 6 位：提交按钮禁用。
- 验证码含非数字或超过 6 位：输入层过滤，最多 6 位。
- 地址重复：拒绝并提示该主机已存在。
- 地址带路径或查询：归一化为 origin 后保存。
- 地址非 https、无主机名、含非法字符、主机名超过 253 字符：拒绝并说明原因。
- 名称留空：回落为 host 名。
- 首次运行：预置两台主机。
- 进程被杀后重建：WebView 页面不保证恢复，回到主机列表。
- 旋转与分屏改变窗口尺寸：manifest 声明 configChanges，避免 WebView 重建，Compose 按新宽度重排。
- 连续点击提交：进入 loading 即禁用，避免浪费限流配额。
- 两台主机同名：允许，以地址区分。
- 同一主机重复进入：复用同一 WebView 实例，不重复加载。
- 会话到期时间为 0 或已过期：列表显示“需登录”。
- 保存密码失败（Keystore 不可用）：降级为不保存，并在登录页提示一次。

## 9. 修改范围

全部为新增文件，不改动本机已有任何仓库。清单如下：

```
dsh-remote-android/
  settings.gradle.kts, build.gradle.kts, gradle.properties
  gradle/wrapper/gradle-wrapper.properties, gradle/wrapper/gradle-wrapper.jar
  gradle/libs.versions.toml
  gradlew, gradlew.bat
  .gitignore
  signing/dshremote.jks, signing/keystore.properties
  app/build.gradle.kts, app/proguard-rules.pro
  app/src/main/AndroidManifest.xml
  app/src/main/res/values/strings.xml, colors.xml, themes.xml
  app/src/main/res/xml/backup_rules.xml, data_extraction_rules.xml
  app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml, ic_launcher_round.xml
  app/src/main/res/drawable/ic_launcher_foreground.xml
  app/src/main/res/values/ic_launcher_background.xml
  app/src/main/java/com/fshake/dshremote/MainActivity.kt
  app/src/main/java/com/fshake/dshremote/DshRemoteApp.kt
  app/src/main/java/com/fshake/dshremote/core/HostUrl.kt
  app/src/main/java/com/fshake/dshremote/core/UrlMatchers.kt
  app/src/main/java/com/fshake/dshremote/core/CookieExpiry.kt
  app/src/main/java/com/fshake/dshremote/core/LayoutPolicy.kt
  app/src/main/java/com/fshake/dshremote/data/HostEntry.kt
  app/src/main/java/com/fshake/dshremote/data/HostStore.kt
  app/src/main/java/com/fshake/dshremote/data/HostRepository.kt
  app/src/main/java/com/fshake/dshremote/auth/AuthOutcome.kt
  app/src/main/java/com/fshake/dshremote/auth/LoginClient.kt
  app/src/main/java/com/fshake/dshremote/auth/CookieBridge.kt
  app/src/main/java/com/fshake/dshremote/auth/PasswordVault.kt
  app/src/main/java/com/fshake/dshremote/auth/SessionGate.kt
  app/src/main/java/com/fshake/dshremote/web/DshWebView.kt
  app/src/main/java/com/fshake/dshremote/ui/nav/AppNav.kt
  app/src/main/java/com/fshake/dshremote/ui/theme/Theme.kt
  app/src/main/java/com/fshake/dshremote/ui/hosts/HostListScreen.kt
  app/src/main/java/com/fshake/dshremote/ui/hosts/HostListViewModel.kt
  app/src/main/java/com/fshake/dshremote/ui/hostedit/HostEditScreen.kt
  app/src/main/java/com/fshake/dshremote/ui/login/LoginScreen.kt
  app/src/main/java/com/fshake/dshremote/ui/login/LoginViewModel.kt
  app/src/main/java/com/fshake/dshremote/ui/web/WebScreen.kt
  app/src/main/java/com/fshake/dshremote/ui/web/WebViewModel.kt
  app/src/test/java/com/fshake/dshremote/HostUrlTest.kt
  app/src/test/java/com/fshake/dshremote/UrlMatchersTest.kt
  app/src/test/java/com/fshake/dshremote/CookieExpiryTest.kt
  app/src/test/java/com/fshake/dshremote/LayoutPolicyTest.kt
  app/src/test/java/com/fshake/dshremote/LoginClientTest.kt
  app/src/test/java/com/fshake/dshremote/CookiePlanTest.kt
  app/src/test/java/com/fshake/dshremote/HostRepositoryTest.kt
  app/src/test/java/com/fshake/dshremote/PasswordVaultTest.kt
  app/src/test/java/com/fshake/dshremote/LoginViewModelTest.kt
  app/src/test/java/com/fshake/dshremote/HostListViewModelTest.kt
  README.md
```

构建期还会产生 `local.properties`、`.gradle/`、`build/` 等生成物，均加入 `.gitignore`。若构建时发现清单遗漏必要文件（依赖、资源、测试夹具），按计划补漏规则登记后继续。

## 10. 实现步骤

| 步骤 | 内容 | 独立验证 |
|---|---|---|
| S1 | 补装 platform-35 与 build-tools 35，配置镜像与 wrapper，生成签名与工程骨架 | `gradlew.bat -v` 与空壳 `assembleDebug` 通过 |
| S2 | `core` 层：地址解析、登录页匹配、cookie 到期解析、大屏列数策略 | 四个单测类通过 |
| S3 | `data` 层：存储、预置、增删改、登录状态 | `HostRepositoryTest` 通过 |
| S4 | `auth` 层：登录客户端、cookie 注入计划、密码加密存取 | `LoginClientTest`、`CookiePlanTest`、`PasswordVaultTest` 通过 |
| S5 | UI 骨架：主题、导航、主机列表（含大屏双列） | 编译通过，手测可增删改 |
| S6 | 登录页与 ViewModel | `LoginViewModelTest` 通过 |
| S7 | WebView 容器与工具栏（文件选择、下载、外链、错误页、过期拦截） | 编译通过，手测 |
| S8 | 串接 SessionGate，跑通“选主机 → 登录 → Web → 过期回流” | 手测四段流程 |
| S9 | 全量单测与 `assembleRelease`，产出签名 APK | `testDebugUnitTest` 全绿，APK 生成 |
| S10 | 编写 README（构建、安装、手测清单） | 文档可照做 |

## 11. 测试方案

- 纯 JVM 单测，位于 `app/src/test`，用 `gradlew.bat testDebugUnitTest` 运行。
- 覆盖维度：
  - 地址解析：合法、非 https、带路径、带端口、IDN、超长、重复。
  - 登录结果分类：成功带 token、成功不带 token、错误凭据、429、5xx、非重定向状态、超时、连接失败。
  - cookie 提取与注入计划：单条、多条、缺失属性、特殊字符。
  - cookie 到期解析：v1 格式、仅 Max-Age、两者都缺、非法值。
  - 登录页匹配：带查询、带 fragment、大小写、其他路径不误判。
  - 大屏策略：599dp 与 600dp 的列数切换、限宽取值。
  - 仓库：增删改、预置、最近使用排序、重复地址、登录状态写入。
  - 密码保险箱：用替身加解密器验证保存、读取、清除、解密失败降级。
  - ViewModel：提交中禁用、错误文案映射、验证码清空、限流倒计时、密码自动填充。
- 预计用例数约 60 条。
- 不做：仪器化测试与 Robolectric UI 测试（本机无设备与模拟器），UI 行为以下面的手工清单在真机上验证。
- 手工清单（写入 README）：首次安装、登录成功、错误密码、会话过期、切换主机、文件上传、下载、外链、断网重试、旋转与分屏、清除密码。

## 附：已确认决策

| 问题 | 结论 |
|---|---|
| 工程位置 | `Documents\GitHub\dsh-remote-android` |
| 应用标识 | `com.fshake.dshremote`，应用名 DSH 远程 |
| 会话与密码 | 保留会话 cookie，动态码由服务端决定输一次；密码加密保存，可单独清除 |
| 地址策略 | 只允许 https |
| 交付方式 | 本机构建并产出签名 APK |
| 预置主机 | dsn 与 dw 两台，可编辑可删除 |
| 页面呈现 | 只用手机 UA，不提供桌面视图切换 |
| 登录页 | 密码可显隐、验证码只收 6 位数字、手动提交 |
| 签名与仓库 | 新建 `dshremote.jks`，仓库随 dsh-extensions 一起建，提交与推送分步授权 |
| 系统与屏幕 | minSdk 26、targetSdk 35，支持大屏布局 |
| 图标 | 取 DSH 官方 favicon 的鲸鱼路径 |
