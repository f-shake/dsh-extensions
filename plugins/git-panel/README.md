# @local/git-panel

右侧边栏里的只读 Git 面板：不用离开会话，就能看到当前仓库有哪些未提交文件、每个文件属于已暂存 / 未暂存 / 未跟踪哪一组，以及逐文件的文本差异；切到「历史」还能看当前分支、切换任意本地/远程分支、翻看每个分支的提交记录。

会话目录本身不是仓库（例如 `D:\Programming` 下面放了多个项目）时，面板先让你选一个子仓库：自动扫描会话目录下一级的项目，以及 `xmzhyp/backend` 这种二级子仓库；选择会按会话记住，下次打开还是同一个。

## 结构

```
git-panel/
├── index.js           宿主半边：/git-panel/status、/repos、/diff、/branches、/commits 五条只读路由
├── client.js          Web 半边：右侧边栏的 Git tab（改动 / 历史两个视图）
├── cordis.patch.yml   把宿主插件插进 profile
└── test/              宿主解析/接口与客户端渲染测试
```

### 宿主半边

`apply()` 通过 `webServer.register({ kind: 'prefix', path: '/git-panel' })` 挂五条 GET 路由：

| 路由 | 作用 |
|---|---|
| `GET /git-panel/repos?session=<id>` | 扫描会话目录下两层的候选仓库（跳过 `node_modules`、隐藏目录，遇到仓库不再下探） |
| `GET /git-panel/status?session=<id>&repo=<rel>` | `git status --porcelain=v1 -z --branch --untracked-files=all` + 两侧 `--numstat`，一次拿到分支、上游、ahead/behind 与文件列表；`repo` 指定子仓库 |
| `GET /git-panel/diff?session=<id>&path=<rel>&repo=<rel>&orig=<rel>&staged=1&untracked=1` | 把 unified diff 解析成 hunk/行号模型；只接受当前状态列表里的路径；未跟踪文件走 `git diff --no-index`，重命名带上旧路径才按 rename 比较 |
| `GET /git-panel/branches?session=<id>&repo=<rel>` | 一次 `git for-each-ref` 拿全部分支（本地 + 远程）的名称、短 sha、最后提交与上游；当前分支置顶，只有它算 ahead/behind |
| `GET /git-panel/commits?session=<id>&repo=<rel>&branch=<name>&skip=0&limit=50` | `git log` 分页取提交；`limit` 钳在 1–100、`skip` 钳在 0–5000；`branch` 必须在分支白名单里，否则 409 |

工作目录取自 `workingDirectory` 服务的当前投影值（agent 在会话里改过目录后跟着变），不接受客户端传来的 `cwd`。会话不存在就直接 404，避免把接口变成任意目录读取。所有路径参数都会拒绝绝对路径、盘符路径与 `..`，并用 realpath 再确认没有借符号链接逃出仓库根。

`/diff` 还会先核对路径仍在最近的 `git status` 列表里，因此不能借它读 `.git/config` 或未列入改动的仓库文件。`/commits` 同理：分支名必须命中 `for-each-ref` 的结果（分离头时只认字面量 `HEAD`），不接受任意 revision 表达式。

### Web 半边

- `ctx.sidebarRightTabs.register({ id, kind: 'git', ... })` 注册一个页面类型，并在引导页（右侧栏 `+` 打开的页面）里放一个「Git 改动」入口。
- `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: '@local/git-panel' }, GitBody)` 提供正文。
- 会话目录不是仓库时自动进入「选择 Git 仓库」页：可过滤的候选列表，按目录层级显示相对路径。
- 头部下方是「改动 / 历史」分段切换，两个视图共享同一个子仓库选择；两边都保持挂载，切回来滚动位置不丢。
- 改动视图：选中子仓库后按「冲突 / 已暂存 / 未暂存 / 未跟踪」分组列出文件；点一行进入差异页（旧/新行号、± 底色、hunk 头、横向滚动、Esc 返回）。头部有「切换仓库」按钮。
- 历史视图：顶部是分支入口，点开是分支选择浮层（本地/远程分组、可过滤、当前分支带「当前」角标、↑/↓ 移动高亮、Enter 选中、Esc 关闭并还原焦点）；下面是该分支的提交列表（短 sha、标题、作者、相对时间），点一行展开详情（完整 hash、父提交、refs、正文），底部「加载更多」每页 50 条、最多 500 条。
- 刷新或重新进入历史视图一律从第一页重拉（已加载的后续页不会重复追加）；「加载更多」失败时页脚给重试，重试会重发同一个请求。已有数据时刷新失败只在列表顶部显示一条可重试的错误条，旧内容继续可见。
- 面板可见时每 10 秒刷新一次（历史视图只重拉分支列表，不动已展开的提交列表），切回页面时补刷；侧栏的刷新命令（`tab.actions.bindCommands({ refresh })`）会连提交列表一起重拉。
- 子仓库选择按会话存进 `localStorage`（`dsh.git-panel.repo.<sessionId>`），刷新页面后保持；选中的分支只存在内存里，刷新页面回到当前分支。
- 没有写操作：不 stage、不 commit、不 checkout，纯查看，避免误触改到工作区。

## 安装

```powershell
# 1. 装进 profile（link: 指向本目录，改代码后重载即可生效；通常会同时写入 dsh.profile.bundles）
node C:\Users\<you>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js plugin --profile aa add "@local/git-panel@link:D:/Programming/dsh-extensions/plugins/git-panel"

# 2. 确认 profile 的 dsh.profile.bundles 里有 "@local/git-panel"；没有就手动补一行

# 3. 打开右侧栏 → 点 tab 条的 + → 选「Git 改动」
```

宿主插件本身由包的 `dsh.bundle.patch` 自动插入，无需手改 `cordis.patch.yml`。

改了 `client.js` 只要刷新页面就能看到；改了 `index.js`（宿主路由）必须重启 DSH——宿主插件在启动时加载，没有热重载。

## 限制

- 仓库选择只自动扫描两层；更深的位置把会话建在仓库目录里打开即可。
- 会话目录本身是仓库时直接展示该仓库，不自动列出其下的嵌套仓库。
- 未跟踪文件的行数是宿主现读文件数出来的（最多 20 个、每个 ≤256 KiB），超过就不显示 `+N`。
- 单次状态最多列 1000 个文件，单次差异最多 4000 行 / 2 MB；超出会标注截断。
- 二进制文件、合并冲突文件不显示文本差异。
- 分支 ahead/behind 只在配置了 upstream 时显示，且只算当前分支；其它分支不逐个跑 `rev-list`。
- 历史视图最多列 200 个分支、每个分支最多 500 条提交；不显示单个提交的 diff 与文件列表（只展开提交元信息）。
- 分离头（detached HEAD）时分支入口显示 `detached@<短sha>`，提交列表按 `HEAD` 取。

## 测试

```powershell
cd plugins\git-panel
node --test test/client.test.js test/host.test.js
```
