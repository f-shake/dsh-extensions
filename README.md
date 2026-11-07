# dsh-extensions

DSH（DeepSeek Harness）相关的自研部件，统一放在一个仓库里。

```
dsh-extensions/
├── dsh-remote-android/        Android 客户端：远程访问 DSH 实例（Kotlin + Compose + WebView）
├── dsh-auth/                  DSH 公网访问网关：密码 + TOTP 双因子（Python / FastAPI）
├── skills/                    vibe coding 系列技能（skill 源文件，同步到 ~/.dsh/skills 生效）
└── plugins/                   DSH 客户端插件（Cordis bundle）
    ├── session-activity-order/ 侧栏排序：活跃工作区/会话自动置顶
    ├── header-compact/        窄屏标题行收紧：计数文案换短写法、隐藏手机端无用的「在本地打开」
    ├── composer-focus/        输入框交互：点按钮不拉键盘、滑聊天区收键盘、切会话不自动弹键盘
    ├── swipe-sidebar/         窄屏手势：左半屏右滑开左抽屉、右半屏左滑开右侧栏、反向滑动收起
    ├── background-send/       插话即转后台：把前台命令转到后台，结果里说明是插话而非超时
    ├── payload-diet/          宿主侧减负：外置 combo 里的内联图、收窄会话首屏窗口（/assets 缓存头接管随包关闭）
    ├── deliver/               文件投递：宿主文件变成可下载的卡片，右侧栏带一个投递箱
    ├── vibe-phase-bar/        vibe coding 流程：输入框上方的五阶段条、加号右侧的显隐按钮、阶段二/四的选择弹框、阶段请求工具
    ├── git-panel/             右侧边栏的 Git 面板：选择子仓库、未提交文件分组与逐文件差异（只读）
    ├── typo-proof/            日记错别字检查：本地模型采样、云端盲复核，确认的改动以修订模式写进 docx 副本
    ├── llm-retry-ladder/      模型请求重试：停用内置指数退避，改成分段阶梯（1s×5 → 2s×5 → 10s×100）
    ├── external/              第三方插件源码（git 子模块，仓库里只有 commit 指针）
    │   └── dsh-live-compact/  边做边压：不调模型的尾部小切压缩（MIT，上游 MerkyorLynn/dsh-live-compact）
    └── .deprecated.*/         已停用的插件，代码保留备查，不装进 profile（见下文「已停用的插件」）
        ├── .deprecated.mobile-fit/          窄屏适配：被 0.2.2 官方折叠侧栏取代
        ├── .deprecated.mux-deflate/         宿主侧 WebSocket 压缩：官方默认开启
        └── .deprecated.session-list-cache/  会话列表缓存：官方已优化列表加载，且它从启用起就标注「不要启用」
```

各部件是独立的交付物，各有自己的构建方式和部署位置，只是一起做版本管理。

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
多数是客户端插件；宿主侧（跑在 dsh 进程里）有七个：`payload-diet` 接管 combo 改写
（`/assets` 缓存头接管随包配置已关闭）、`background-send` 处理插话转后台、
`vibe-phase-bar` 注册 `vibe_phase` 工具与 `/vibe-phase` 状态路由、`deliver` 注册
`deliver` 工具与 `/deliver` 下载/投递箱路由、`git-panel` 提供 `/git-panel` 只读查询、
`typo-proof` 注册 `typo_check` 工具与 `/typo-proof` 任务路由、`llm-retry-ladder`
接管 `agent/request-error` 并把内置 `dsh-llm-retry` 停用。

```powershell
# 以 profile aa 为例
node C:\Running\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js plugin --profile aa add "@local/deliver@link:<repo>/plugins/deliver"
```

同时在 profile 的 `package.json` 的 `dsh.profile.bundles` 里加上包名，客户端才会加载。

打包成可分发 tgz（`files` 字段只带运行必需的文件）：

```powershell
cd plugins\deliver
pnpm pack
```

### 已停用的插件（`plugins\.deprecated.*`）

停用但不想删代码的插件，目录重命名为 `.deprecated.<原名>`，包名保持不变。
这样它们不会被误装、在编辑器里也和活跃插件分得开；恢复时把目录名改回去即可。

| 插件 | 停用时间 | 停用原因 |
|---|---|---|
| `.deprecated.mobile-fit` | 2026-11-06 | DSH 0.2.2 官方内置窄屏抽屉（<768 抽屉 + 遮罩，<1024 自动收起），行为与插件一致 |
| `.deprecated.mux-deflate` | 2026-11-06 | 官方 `websocketCompression` 默认 `deflate`，插件从补丁变成多余，且会把用户关掉的压缩强行打开 |
| `.deprecated.session-list-cache` | 2026-11-06 | 该插件从设计起就标注「不要启用」（rpcId/缓存一致性风险）；0.2.2 官方进一步优化了大量会话的列表加载，缓存收益归零 |

> `header-compact` 与 `composer-focus` 曾在同一天被停用，实测后当天恢复：
> 官方的「溢出渐隐」在手机标题行上不如原插件的文案缩写干净；键盘方面官方只做了
> 发送后收起，**点按钮不弹键盘**和**切会话不自动聚焦**两条仍然缺。
> 结论：官方覆盖 ≠ 等价覆盖，停用前必须实机验证，不能只看 release note。

恢复步骤（以 mobile-fit 为例）：

1. `git mv plugins/.deprecated.mobile-fit plugins/mobile-fit`
2. `dsh plugin --profile aa add "@local/mobile-fit@link:<repo>/plugins/mobile-fit"`
3. 在 profile 的 `dsh.profile.bundles` 里加回 `@local/mobile-fit`
4. 重启 dsh

停用前请先读对应目录的 README——里面记录了它当年解决的问题，确认官方是否真的覆盖了。

### 第三方插件（plugins/external/）

别人开源的插件放在 `plugins/external/<名>/`，用 **git 子模块**引入：本仓库只记一条 commit
指针，源码留在上游，不复制、不 fork，对方的 LICENSE 和版权声明原样保留。

```powershell
# 拉仓库必须带子模块，否则 external/ 下是空目录
git clone --recurse-submodules <repo>

# 更新到上游新提交，再提交更新后的指针
git submodule update --remote plugins/external/dsh-live-compact
```

安装仍然是 profile 的事，与本仓库其他插件一样走 `link:`：

```powershell
dsh plugin --profile aa add "<上游真实包名>@link:<repo>/plugins/external/<名>"
```

方式别用反：**只读引用才用子模块**——在子模块里改代码，下次 `update --remote` 就被冲掉。
真要改，就 fork，或者复制进 `plugins/` 当自己的插件维护。
零构建的包（根目录直接是 `.js`）检出即可用；TS 写的那种必须先 `pnpm build` 出 `dist/`。

## skills

`vibe-coding`、`grilling`、`review-and-fix-cycle` 三个技能的源文件，原来在 OneDrive 的
独立仓库里，现并入本仓库统一版本管理。

**本仓库是「源」，`~/.dsh/skills/` 是「副本」——改这里的文件不会自动生效，必须同步：**

```powershell
.\scripts\sync-skills.ps1          # 覆盖前备份 + 先删后拷 + 哈希校验
.\scripts\sync-skills.ps1 -Prune   # 顺带删掉副本里仓库已无的技能
.\scripts\sync-skills.ps1 -NoBackup # 不做备份（确认副本不比仓库新时才用）
```

脚本不碰 `anydrop`、`docsearch-*`、`notify-mail` 这些不由本仓库管理的技能。

**覆盖前会先备份**：要把旧目录拷到 `~/.dsh/skills.bak/<时间戳>/<技能名>`，只留最近 5 份
（`-MaxBackups` 可调）。备份目录在 `skills/` 外面，不会被当成技能扫到。
这条是为「副本被改得比仓库新」准备的——先删后拷会把那种改动直接抹掉，没有备份就只能去翻会话日志。

几个约束（来自 DSH 的 skill 发现规则）：

- **目录结构必须是 `skills/<name>/SKILL.md`**，发现深度只有一层，不支持嵌套 `**/SKILL.md`；bundle 内部的 `references/` 随意嵌套
- 用**复制**而不是符号链接：Node 的 `dirent.isDirectory()` 对符号链接目录返回 `false`，会被静默跳过，skill 直接消失
- 必须**先删后拷**：直接覆盖会留下上一版已删除的文件
- DSH 监视 `~/.dsh/skills/`，改完即生效；正文每次加载重读，不必重启

## 版本管理约定

- 三个部件版本号各自独立，不强行对齐
- 提交信息按部件加前缀：`android:` / `auth:` / `plugin(mobile-fit):` 等
- 任何密钥、口令、私钥、TOTP 二维码都不入库
- 升级 DSH 前后的核对结论、已归档插件与验证清单见 [COMPAT.md](COMPAT.md)
