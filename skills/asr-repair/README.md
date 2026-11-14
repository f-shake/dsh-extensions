# asr-repair 技能

修语音转文字（ASR）转写稿里的误听错误：**只改听错的字，不改说话的方式**。
本体通用、词表私有，两部分物理分开。

| 部分 | 位置 | 入库 | 内容 |
|---|---|---|---|
| 本体 | `SKILL.md`、`references/`、`scripts/`、本文件 | ✅ | 判断方法、通用规则、扫描脚本 |
| 个人词表 | `personal/` | ❌（`.gitignore`） | 人名、单位、产品、地名、口头禅 |

## 来源

从内部部署环境的技能 `asr_repair` v4.0.0 拆出来的：

- 原来一份 `SKILL.md` 里既有流程方法，也有几十条真实人名 / 单位 / 本地地名 / 个人口头禅；
- 那份东西**没法分享**（全是隐私），也**没法维护**（改个流程要在一堆专名里找）；
- 现在：方法进本体，专名进词表。分享本体不会带出任何真实姓名；改流程不碰词条。

原始包留在 `personal/_upstream/asr_repair-v4.0.0.zip`（不入库），只作迁移存证。

## 安装 / 生效

本机 `~/.dsh/skills/asr-repair` 是指向本目录的**目录联接**（junction）：

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\skills\asr-repair" `
  -Target "C:\Users\<you>\Documents\dsh-extensions\skills\asr-repair"
```

- DSH 按目录发现技能，改完正文当场生效，不用重启；
- 别用 `scripts\sync-skills.ps1` 同步这一个——它先删后拷，会把 junction 换成副本。

## 分享本体

只拷这些：

```
SKILL.md
README.md
references/
scripts/
```

**不要**拷 `personal/`。收到的人没有词表也能用，只是要自己攒；`SKILL.md` §0 写了怎么按模板建一份。

## 自测

```powershell
pwsh -NoProfile -File .\scripts\glossary-scan.ps1 -SelfTest
pwsh -NoProfile -File .\scripts\glossary-scan.ps1 -TextFile <把这里换成实际稿子.txt>
```

第一条跑内置断言（表格解析 + 命中 + 上下文 + 词边界 + 转义竖线）；第二条是真实扫描，
`<...>` 换成你手上的文件，技能目录里没有现成稿子。
`MISSING_GLOSSARY` 退出码 2 = 词表没放到位；`NO_RULES` 退出码 3 = 词表解析不出规则——都不是脚本坏了。

## 设计取舍

- **为什么不做自动替换脚本**：同一个读音在别的语境里可能是对的（既可能是人名，也可能是普通动词）。
  脚本只把候选摊开，判断留给上下文。
- **为什么词表是 markdown 表格**：模型直接读得懂，人也能改，脚本还能解析——一份数据三种用法。
- **为什么「勿改白名单」单独一节**：只记「错→对」的模型会越改越野；把「核实过、别碰」的写下来，
  才挡得住第二年的自己。
