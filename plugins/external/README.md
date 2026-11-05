# plugins/external

别人开源的 DSH 插件，**只在这里做引用，不复制代码**。

这里放的是一个 git 子模块（submodule）：本仓库的对象库里只记一条 commit 指针，
代码本体在上游仓库。所以：

- 这个目录里的东西**不会**让插件生效。插件是否加载只由 profile 决定
  （`~/.dsh/profiles/<名>/package.json` 的依赖 + `dsh.profile.bundles`），
  与本目录无关。安装是另一个独立步骤。
- 拉本仓库时要带子模块：`git clone --recurse-submodules <本仓库>`，
  已克隆的用 `git submodule update --init`。

## 添加一个

```powershell
git submodule add https://github.com/<owner>/<repo>.git plugins/external/<名字>
git add .gitmodules plugins/external/<名字>
git commit -m "external: 引入 <owner>/<repo> @ <短 sha>"
```

规矩：

- 钉 **commit**，不钉分支。`git status` 里子模块显示 `(new commits)` 就说明上游动了，
  要么升指针，要么忽略。
- 一个子模块只对应一个上游仓库。上游是 monorepo（多个插件在一个仓库）时，
  一个子模块就够，安装时指向里面的子目录，不要为每个包加一个子模块。
- 不修改子模块里的文件。真要改，先 fork，改 fork，再引 fork —— 否则下次
  `submodule update` 会把改动冲掉，而且上游也收不到。

## 安装（独立步骤，不在本目录完成）

安装的目标是 profile，不是这个目录。步骤固定为三步：

1. **构建**（TS 仓库必须）：进子模块目录跑它 README 里的 build（多为 `pnpm install && pnpm build`），
   产物要落在包声明的入口（`dist/` 等）上。`link:` 不会替你构建。
2. **装进 profile**：依赖键用**上游的真实包名**，不要改写成 `@local/*` ——
   包内部按自己的名字自引用时会解析不到。

   ```powershell
   dsh plugin --profile aa add "<真实包名>@link:D:/Programming/dsh-extensions/plugins/external/<名字>/<子目录>"
   ```

   包如果声明了 `dsh.bundle.patch`，这条命令成功后会自动把名字追加进
   `dsh.profile.bundles`；没声明只当普通依赖，CLI 会打 warning，等于白装。
3. **验证**：宿主侧插件需重启 dsh；客户端插件刷新页面即可。确认
   `dsh.profile.bundles` 里有它、启动日志里没出现 `skippedBundles`。

## 兼容性

插件 `package.json` 的 `engines.dsh` 或 `@deepseek-ai/dsh*` 的 peer 范围必须匹配当前
DSH 运行时。声明了的按声明判，两个都没声明的放行（但运行时可能报错）。
实测不匹配时：

```powershell
dsh plugin --profile aa allow-version <包名>@<版本> --dsh-version <当前运行时版本> --accept-risk
```

## 许可

子模块保留上游 LICENSE 与版权声明，本仓库不重新授权这些代码。
GPL 类**不要**改成拷贝进本仓库。
