# @local/git-panel

右侧边栏里的只读 Git 面板：不用离开会话，就能看到当前仓库有哪些未提交文件、每个文件属于已暂存 / 未暂存 / 未跟踪哪一组，以及逐文件的文本差异。

会话目录本身不是仓库（例如 `D:\Programming` 下面放了多个项目）时，面板先让你选一个子仓库：自动扫描会话目录下一级的项目，以及 `xmzhyp/backend` 这种二级子仓库；选择会按会话记住，下次打开还是同一个。

## 结构

```
git-panel/
├── index.js           宿主半边：/git-panel/status、/repos、/diff 三条只读路由
├── client.js          Web 半边：右侧边栏的 Git tab（仓库选择 + 文件列表 + 差异页）
├── cordis.patch.yml   把宿主插件插进 profile
└── test/              宿主解析/接口与客户端渲染测试
```

### 宿主半边

`apply()` 通过 `webServer.register({ kind: 'prefix', path: '/git-panel' })` 挂三条 GET 路由：

| 路由 | 作用 |
|---|---|
| `GET /git-panel/repos?session=<id>` | 扫描会话目录下两层的候选仓库（跳过 `node_modules`、隐藏目录，遇到仓库不再下探） |
| `GET /git-panel/status?session=<id>&repo=<rel>` | `git status --porcelain=v1 -z --branch --untracked-files=all` + 两侧 `--numstat`，一次拿到分支、上游、ahead/behind 与文件列表；`repo` 指定子仓库 |
| `GET /git-panel/diff?session=<id>&path=<rel>&repo=<rel>&orig=<rel>&staged=1&untracked=1` | 把 unified diff 解析成 hunk/行号模型；只接受当前状态列表里的路径；未跟踪文件走 `git diff --no-index`，重命名带上旧路径才按 rename 比较 |

工作目录取自 `workingDirectory` 服务的当前投影值（agent 在会话里改过目录后跟着变），不接受客户端传来的 `cwd`。会话不存在就直接 404，避免把接口变成任意目录读取。所有路径参数都会拒绝绝对路径、盘符路径与 `..`，并用 realpath 再确认没有借符号链接逃出仓库根。

`/diff` 还会先核对路径仍在最近的 `git status` 列表里，因此不能借它读 `.git/config` 或未列入改动的仓库文件。

### Web 半边

- `ctx.sidebarRightTabs.register({ id, kind: 'git', ... })` 注册一个页面类型，并在引导页（右侧栏 `+` 打开的页面）里放一个「Git 改动」入口。
- `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: '@local/git-panel' }, GitBody)` 提供正文。
- 会话目录不是仓库时自动进入「选择 Git 仓库」页：可过滤的候选列表，按目录层级显示相对路径。
- 选中子仓库后按「冲突 / 已暂存 / 未暂存 / 未跟踪」分组列出文件；点一行进入差异页（旧/新行号、± 底色、hunk 头、横向滚动、Esc 返回）。头部有「切换仓库」按钮。
- 面板可见时每 10 秒自动刷新一次，切回页面时补刷；侧栏的刷新命令（`tab.actions.bindCommands({ refresh })`）也接到同一个入口。
- 选择按会话存进 `localStorage`（`dsh.git-panel.repo.<sessionId>`），刷新页面后保持。
- 没有写操作：不 stage、不 commit，纯查看，避免误触改到工作区。

## 安装

```powershell
# 1. 装进 profile（link: 指向本目录，改代码后重载即可生效；通常会同时写入 dsh.profile.bundles）
node C:\Users\<you>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js plugin --profile aa add "@local/git-panel@link:D:/Programming/dsh-extensions/plugins/git-panel"

# 2. 确认 profile 的 dsh.profile.bundles 里有 "@local/git-panel"；没有就手动补一行

# 3. 打开右侧栏 → 点 tab 条的 + → 选「Git 改动」
```

宿主插件本身由包的 `dsh.bundle.patch` 自动插入，无需手改 `cordis.patch.yml`。

## 限制

- 仓库选择只自动扫描两层；更深的位置把会话建在仓库目录里打开即可。
- 会话目录本身是仓库时直接展示该仓库，不自动列出其下的嵌套仓库。
- 未跟踪文件的行数是宿主现读文件数出来的（最多 20 个、每个 ≤256 KiB），超过就不显示 `+N`。
- 单次状态最多列 1000 个文件，单次差异最多 4000 行 / 2 MB；超出会标注截断。
- 二进制文件、合并冲突文件不显示文本差异。
- 分支 ahead/behind 只在配置了 upstream 时显示。

## 测试

```powershell
cd plugins\git-panel
node --test test/client.test.js test/host.test.js
```
