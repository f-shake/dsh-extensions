# dsh-extensions

DSH（DeepSeek Harness）相关的自研部件，统一放在一个仓库里。

```
dsh-extensions/
├── dsh-remote-android/        Android 客户端：远程访问 DSH 实例（Kotlin + Compose + WebView）
├── dsh-auth/                  DSH 公网访问网关：密码 + TOTP 双因子（Python / FastAPI）
└── plugins/                   DSH 客户端插件（Cordis bundle）
    ├── mobile-fit/            窄屏适配：弹窗/设置面板不超屏
    ├── header-compact/        窄屏标题行收紧：子智能体/后台任务文案缩短、隐藏手机端无用的「在本地打开」
    ├── session-activity-order/ 侧栏排序：活跃工作区/会话自动置顶
    ├── composer-focus/        输入框交互：点按钮不拉键盘、滑聊天区收键盘、切会话不自动弹键盘
    ├── background-send/       插话即转后台：用户插话时把前台命令转到后台
    ├── payload-diet/          宿主侧减负：外置 combo 里的内联图、给静态资源补缓存头、收窄会话首屏窗口
    ├── mux-deflate/           宿主侧减负：给 /api/remote.mux 的 WebSocket 打开压缩
    ├── vibe-phase-bar/        vibe coding 流程：输入框上方的五阶段条、加号右侧的显隐按钮、阶段二/四的选择弹框、阶段请求工具
    └── session-list-cache/    客户端减负：会话列表先用上次的结果出来，不等网络
```

三部分是独立的交付物，各有自己的构建方式和部署位置，只是一起做版本管理。

## dsh-remote-android

Android 客户端，包名 `com.fshake.dshremote`。

```powershell
$env:JAVA_HOME='C:\Users\<you>\.jdks\jdk-17.0.20.1+1'
cd dsh-remote-android
.\gradlew.bat assembleRelease
```

产物在 `app/build/outputs/apk/release/`。

签名文件不进库：`signing/dshremote.jks`、`signing/keystore.properties`、`local.properties`
需要在本机单独准备，否则只能出 debug 包。

## dsh-auth

DSH 的公网访问网关（密码 + TOTP），部署在 nas-host 上，经本机隧道 + VPS nginx 暴露。
端口 `127.0.0.1:8099`，对外路径 `/_app_auth`、`/_app_login`、`/login.html`。

```powershell
powershell -NoProfile -File .\start-auth.ps1     # 前台启动（调试）
```

安装为计划任务 / 服务的脚本在目录内，详细链路见 `dsh-auth/README-部署说明.md`。

密钥不进库：`.env`（TOTP 密钥、密码哈希、cookie 密钥）本机单独维护，
字段清单见 `.env.example`。`totp-qr.png` 含 TOTP 密钥，同样不进库。

## plugins

插件是 DSH 的 Cordis bundle，安装到 profile 里生效
（profile 目录 `~/.dsh/profiles/<名>`，依赖写成 `link:` 指向本仓库的目录）。
多数是客户端插件；宿主侧（跑在 dsh 进程里）有四个：`payload-diet` 接管 HTTP 路由与
combo 改写、`mux-deflate` 接管 WebSocket 压缩、`background-send` 处理插话转后台、
`vibe-phase-bar` 注册 `vibe_phase` 工具与 `/vibe-phase` 状态路由。

```powershell
# 以 profile aa 为例
node C:\Running\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js plugin --profile aa add "@local/mobile-fit@link:<repo>/plugins/mobile-fit"
```

同时在 profile 的 `package.json` 的 `dsh.profile.bundles` 里加上包名，客户端才会加载。

打包成可分发 tgz（`files` 字段只带运行必需的文件）：

```powershell
cd plugins\mobile-fit
pnpm pack
```

## 版本管理约定

- 三个部件版本号各自独立，不强行对齐
- 提交信息按部件加前缀：`android:` / `auth:` / `plugin(mobile-fit):` 等
- 任何密钥、口令、私钥、TOTP 二维码都不入库
