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

## 2026-11-14 · typo-proof：候选卡片常开、四个复制按钮、同位置合并

**部件**：`plugins/typo-proof`（`client.js`、`lib/pipeline.js`、`index.js`、`README.md`）

**变了什么**

- 面板的候选卡片改成**常开**：段号、票数、结论、差异句一直看得见，不再一条条点；前/后句与
  三次采样收进卡片内部的折叠。每张卡片加四个小按钮（复制原文 / 修改后 / 错字 / 正字）。
- 同一处位置被采样出两种改法时**合并成一条**（确认 > 分歧 > 否决），落选的改法在说明里标成
  「另有改法：算（已否决）」。检查结果总数会因此变小（例：2015.docx 从 122 条变 112 条）。
- CSV 末尾加两列：`改动次数`（该处被改动的采样数）与 `备选改法`；`投票数` 仍是支持最终改法的次数。

**要动手**：重启 dsh（插件客户端与管线都改了）。已有的旧报告不会回溯合并，要看新口径就重跑一次检查。

---

## 2026-11-14 · 子模块跟进上游：live-compact 1.1.7、mnemon 0.5.45

**部件**：`plugins/external/dsh-live-compact`、`plugins/external/dsh-mnemon`

**变了什么**

- `dsh-live-compact` 1.1.5 → 1.1.7：billion-context 接管官方压缩时一律让位，不再同时改写会话；
  长 read 失败改走普通选点，重复 `toolCallId` 按原文哈希区分，raw 已写而 meta 缺时重启后可重建；
  大段 catch-up 期间按会话维护闸让出事件循环（#49）；导出 `dsh-live-compact/package.json`，
  宿主 bundle loader 才读得到包元数据（#53）。
- `dsh-mnemon` 0.5.42 → 0.5.45：DSH 0.2.2-rc2 上收起已下线的记忆卡片；技能来源目录组可折叠、
  链接技能可按需更新原件；空闲复核的输出预算与“上下文销毁后取消复核”两处修复；
  嵌入凭据不再写进 profile 设置。

**要动手**

- 无。子模块指针跟着 pull 走，`git submodule update --init --recursive` 之后即到位。
- 但要分清：这只是仓库里锁的版本。本机 profile 实际装的仍是 `dsh-live-compact` 1.1.5、
  `dsh-mnemon` 0.5.42；要跟进得改 profile `package.json` 的版本、在 profile 目录 `pnpm install`，
  再重启 dsh 才生效。

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
