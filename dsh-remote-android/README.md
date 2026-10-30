# DSH 远程

Android 客户端，用于远程访问已发布到公网的 DeepSeek Harness 实例：先选主机，原生登录页完成“访问密码 + 动态验证码”认证，再用 WebView 承载该主机的 DSH 界面。

- 包名：`com.fshake.dshremote`
- 最低系统：Android 8.0（API 26）
- 目标系统：Android 15（API 35）

## 功能

- 主机列表：预置 `dsn` 与 `dw` 两台，可新增、编辑、删除；每条显示登录状态（剩余天数或需登录）。
- 原生登录页：密码可显隐，验证码只收 6 位数字，手动提交；按失败原因区分提示（凭据错误、提交频繁、网络不通、服务不可用）。
- 会话保持：登录成功后把网关下发的 cookie（连同有效期）交给 WebView 持有，在会话有效期内再次进入无需重新输入；有效期的长短由网关配置决定，应用不写死天数。
- 记住密码：开关默认开启，密码经 Android Keystore 加密保存，登录页自动填充；可在登录页或网页菜单里单独清除。
- 网页能力：文件选择、下载、外部链接交给系统处理；上游 502/504 与断网显示原生提示并可重试。
- 会话过期自动回到原生登录页，不显示网关的网页登录表单。
- 大屏适配：宽度 600dp 以上主机列表双列，内容限宽。

> 预置的两台主机指向 `dsn.example.com` / `dw.example.com`（示例域名）。要指向自己的实例，改
> `data/HostStore.kt` 里的 `PRESET_NAS_URL` / `PRESET_WORK_URL`，或直接在应用里新增主机。

## 构建

需要 JDK 17 与 Android SDK（platform 35、build-tools 35）。

```powershell
$env:JAVA_HOME = 'C:\Users\<you>\.jdks\jdk-17.0.20.1+1'
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
Set-Location <repo>\dsh-remote-android

.\gradlew.bat testDebugUnitTest      # 单元测试
.\gradlew.bat assembleDebug          # 调试包
.\gradlew.bat assembleRelease        # 签名包
```

产物：

- 调试包 `app/build/outputs/apk/debug/app-debug.apk`
- 正式包 `app/build/outputs/apk/release/app-release.apk`

`local.properties` 里的 `sdk.dir` 指向本机 SDK；该文件不入库。签名配置读取 `signing/keystore.properties`，缺文件时正式包不签名（只影响本地打包）。

依赖下载走镜像：Gradle 发行版用腾讯云，Maven 依赖优先阿里云。国内网络直连 `services.gradle.org` 会超时。

## 安装

```powershell
adb install -r app\build\outputs\apk\release\app-release.apk
```

也可以在手机上直接打开 APK 安装。换签名会覆盖安装失败，届时先卸载旧版本。

## 代码结构

```
app/src/main/java/com/fshake/dshremote/
  core/      地址解析、登录页匹配、cookie 到期解析、大屏策略（纯函数）
  data/      主机数据模型、序列化存储、仓库
  auth/      登录客户端、cookie 注入、密码保险箱、路由判定
  web/       WebView 容器与工具栏命令通道
  ui/        主机列表、编辑、登录、网页四个页面与 ViewModel
```

## 关键实现约定

- 登录请求 `POST /_app_login`（表单字段 `password`、`code`），**不跟随重定向**：成功与失败都返回 302，只能靠 `Location` 区分。
- 成功后不伪造 DSH 的会话 cookie，而是把响应的 Set-Cookie 写进 WebView 的 CookieManager，再由 WebView 打开带 token 的下一跳，让 DSH 在正确的 authority 下自行签发。
- 会话有效期不写死：从 `dsh_auth` 的 `v1.<exp>` 读取，读不到再退回 `Max-Age`、`Expires`；两台主机的服务端配置可以不同。
- 只用手机 UA，不提供桌面视图切换。

## 手工验证清单

装机后按顺序走一遍（这些都是单元测试覆盖不到的）：

1. 首次安装：列表里有两台预置主机，登录状态为“需登录”。
2. 点 dsn：进入原生登录页，输入密码与验证码，登录后进入 DSH 界面。
3. 杀掉进程重开：再点同一台主机，直接进入 DSH 界面，不再要求输入。
4. 输错密码：提示“密码或动态验证码不正确”，验证码被清空、密码保留。
5. 一分钟内连续输错 6 次：提示“提交过于频繁”，倒计时结束前按钮不可用。
6. 网页菜单“退出登录”：回到登录页，另一台主机的登录状态不受影响。
7. 网页内上传附件：能调起系统文件选择器并成功上传。
8. 网页内触发下载：通知栏出现下载任务。
9. 点开站外链接：跳转系统浏览器，应用内不加载。
10. 断网后刷新：显示“无法连接到服务器”，点重试可恢复。
11. 旋转屏幕或进入分屏：页面不重新加载，布局按新宽度重排。
12. 平板或折叠屏展开：主机列表变双列。
13. 网页菜单“清除保存的密码”：退出登录后重新进入，密码框为空。

## 安全说明

- 只接受 https 地址，应用不配置明文流量。
- 密码只以密文形式存在本机，密钥在 Android Keystore 内生成且不可导出；关闭了应用备份与设备迁移。
- 会话 cookie 由 WebView 自身保存，未落盘到应用自己的存储。
