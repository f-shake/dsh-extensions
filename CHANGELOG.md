# 更新日志

这个仓库在几台电脑之间同步 DSH 的插件、技能和启动器配置。这份文件只回答两件事：
**这次更新改了什么**、**我这边拉下来要不要动手**。

## 怎么用

1. 先跑 `.\scripts\check-updates.ps1`：fetch 一次，列出你落后的提交、涉及哪些部件、
   每个部件怎么才能生效。它不动工作区，纯只读。
2. 再看本文顶部几条记录，按「要动手」逐条处理。
3. 细节以 `git log` / `git show` 为准——这里不复述 diff。

## 写这条日志的约定

- **在同一次提交里更新**：改动和它的日志条目一起提交，`git log -- CHANGELOG.md` 才对得上号。
  一条对应一次推送，不按文件拆。落后几条不靠数条目——那是 `check-updates.ps1` 的事。
- 倒序，最新在上。
- 三个固定字段，缺一个都算没写：
  - `部件`：用仓库里的真实路径（`skills/asr-repair`、`plugins/deliver`），便于搜索
  - `变了什么`：一到三条，说人话，不复述 diff
  - `要动手`：拉取后必须做的操作；**没有就写「无」**，不能省略——省略会被读成「忘了写」
- 只记影响使用者的改动。重构、格式化、改注释、内部重命名不记。
- 破坏性变化、需要手动迁移的，标题前加 ⚠️。
- 起点：2026-11-14 之前的历史不补记，翻 `git log`（当时 52 个提交）。本文件最初那条是**补记**，
  覆盖同一天更早推送的两条提交——那时候还没有本文件，此后的条目严格一条对应一次推送。

---

## 2026-11-14 · 新增更新日志与跨机检查脚本

**部件**：`CHANGELOG.md`（新）、`scripts/check-updates.ps1`（新）、`README.md`

**变了什么**

- 新增 `CHANGELOG.md`，即本文件：拉取前先看「变了什么 / 要动手」。
- 新增 `scripts/check-updates.ps1`：`git fetch` 后列出落后的提交、涉及的部件，并给每个部件标出
  「怎么才算生效」——技能要不要重新同步、插件要不要重启 dsh、子模块要不要 update、APK 要不要重出包。
  顺带提示工作区的未提交改动和子模块状态。只读，pull 由人决定。
- README 补「跨机器同步」一节，以及本文件的写法约定。

**要动手**

- 无。拉下来直接跑 `.\scripts\check-updates.ps1` 就行，不用安装。

## 2026-11-14 · asr-repair 技能入库；dsh-host 收进启动器

**部件**：`skills/asr-repair`、`dsh-host`、`README.md`、`.gitignore`

**变了什么**

- 新增 `skills/asr-repair`：ASR 转写稿的误听修复技能。从线上部署环境的 `asr_repair` v4.0.0
  拆成两部分——`SKILL.md` / `references/` / `scripts/` 是通用本体（可分享），`personal/`
  是个人词表（真实人名、单位、地名、口头禅），在 `.gitignore` 里，**不进库**。
- `dsh-host`：启动器（`launcher.py` + 两个 vbs）、`network/setup-lan.ps1`、profile patch 留底。
- 根 README：补 asr-repair 的说明、修掉「真符号链接会被静默跳过」的错误说法（实测 junction 可被发现）、
  修正 sync 脚本的恢复命令。

**要动手**

- `skills/asr-repair`：新技能，目标机器上要么建 junction、要么跑一次 `.\scripts\sync-skills.ps1`。
  同步下来只有方法，没有词表——`personal/` 要在本机单独建（格式见
  `skills/asr-repair/references/glossary-template.md`）。
- `dsh-host`：仓库里只是留底，不同步到 `%LOCALAPPDATA%\DeepSeekHarness` 和 `~/.dsh/profiles/web`，
  不影响正在跑的实例。要套用就去对应目录手工比对。
- 其余：无。
