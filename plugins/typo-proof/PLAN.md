# 日记错别字校对插件 · 开发计划

- 版本：v0.2（Q1–Q7 已闭环，待闸门1 确认）
- 日期：2026-11-06
- 状态：阶段一 · 计划
- 目标产物：dsh 宿主插件 `@local/typo-proof`

---

## 0. 一句话

把 docx 日记逐句送**本地小模型**采样 3 次：**3 次里至少 2 次改动了原文**，该句才算「可能有错」；把这些样本里的改动全部取出，交**云端大模型**盲复核，复核确认的改法以 **Word 修订（tracked changes）**写进**副本**。原文件永不改动。

粒度是**句**（不是段），短于 8 个汉字的句子不检。

---

## 1. 功能需求

每条都对应可执行断言，验收口径见 §11。

| # | 需求 | 验收方式 |
|---|---|---|
| REQ-1 | 给定 docx 绝对路径，解析出段落 / 句子 / run 三层结构 | 解析 `2011~2014.docx`：段数 = 234 |
| REQ-2 | 每个可检句子用本地模型采样 **3 次**（同一提示词，temperature 0.7） | mock provider 断言调用次数 = 3 × 句数 |
| REQ-3 | 句级闸门（Q3=A）：3 次样本中 **≥2 次「与原文不同」** 该句才进复核；候选 = 这些样本的编辑**并集**，每条带 `votes`（1–3），互不一致的编辑也各自进复核 | 构造样本单测（1 票情形 / 3 票情形 / 两句不同位置） |
| REQ-4 | 词法闸门：只接受「单个 CJK 字 → 单个 CJK 字」；忽略标点/空格/英文/数字/繁简；整句相似度 < 0.80 或单句改动 > 5 处 → 该样本作废 | 单测 12 组真假样本 |
| REQ-5 | 每条候选携带上下文：本句 + 前一句 + 后一句（拼接后长度超过 400 字则前后各截断到 200 字） | 单测 |
| REQ-6 | 云端**盲复核**：只给上下文，不给候选；大模型独立改正后做同样 diff | 单测（mock 三种返回） |
| REQ-7 | 复核结论四态：`confirmed` / `rejected` / `redirected`（大模型改了别处）/ `failed`（调用异常） | 单测 |
| REQ-8 | 生成副本 `<原名>_校对副本_<yyyyMMdd-HHmm>.docx`；只有 `confirmed` 的候选写入 | 集成测试 |
| REQ-9 | 修订写入形态：`w:del`（原文，内含 `w:delText`）+ `w:ins`（新字），author=`typo-proof`，带 `w:id` / `w:date` | 解 XML 断言 |
| REQ-10 | 原文件零改动：运行前后 sha256 与 mtime 完全一致 | 集成测试断言 |
| REQ-11 | 句级缓存：键 = `sha1(句文本) + 模型 + 提示词版本`；命中则不调用模型 | 单测 |
| REQ-12 | 断点续跑：进程中断后，重跑同参数跳过已完成句子 | 单测（模拟中断） |
| REQ-13 | 每次运行落盘 `report.json` + `candidates.csv`（段号/句序/原字/新字/上下文/投票数/复核结论/复核说明） | 集成测试 |
| REQ-14 | 进度可观测：已处理/总数、候选数、确认数、失败数、耗时 | 工具返回值 |
| REQ-15 | 副本生成后若 LibreOffice 可用，必须 headless 转换成功才报告成功 | 集成测试 |
| REQ-16 | 面板（v1 最小）：显示进度、结果概览、副本下载按钮 | 手工冒烟 |
| REQ-17 | 加密段（`##…##`、含跨段）、目录样式、表格、超链接内文本默认跳过；跳过项计入报告 | 单测 |
| REQ-18 | 句级最小长度（Q2 追加）：汉字数 < `minHanzi`（默认 **8**，可配）的句子不检、不计入 total | 单测 |

**量化验收基线**

- 解析 `2011~2014.docx`：234 段、CJK 字符 16916
- 已知真错 5 条（`确认错别字_2011-2014.csv`）：管线召回 **≥4 条**（段 208/214/226/228 必中，229 两处「人→员」命中其一即可）
- 副本能被 LibreOffice 打开，Word 修订面板可见 ≥5 处

---

## 2. 技术方案（含被否决的备选）

| 决策 | 采用 | 为什么 | 否决的方案 |
|---|---|---|---|
| 模型入口 | `ctx.llm.stream({ provider, model, messages })` | 用户要求复用模型栏配置；端口/key/重试统一归 provider 适配器；`ctx.llm.listProviders()` 可做下拉 | 插件自建 HTTP 客户端打 LM Studio —— 等于第二套配置源，模型栏里改了这里不知道 |
| docx 解析 | 自写 XML 扫描器 + `node:zlib` 解压 | 修订写入必须**字节级保留属性串**（`w:rsid`、`w:pPr`、命名空间前缀），任何 DOM/序列化都会重排属性、丢命名空间 | `fast-xml-parser`（会规范化属性、丢失原样）；`python-docx`（宿主 Python 无此包，且**不支持 tracked changes**） |
| 字符定位 | 自写 LCS DP diff | 句长 ≤ 200，O(n²) 完全够；要拿到 `(pos, orig, sugg)` 三件套 | 引 `jsdiff`（新增依赖，且仍需自己折算位置） |
| 复核方式 | 大模型**独立改正 + diff 比较** | 《级联方案》§5.5 实测：问「A→B 对不对」模型会顺着说对 | 让大模型输出 `判断\|正确字\|理由`（§4 实测 9B 做判断题格式全崩） |
| 输出形态 | 只做 tracked changes（Q1=A），v1 不做批注 | Word 自带「接受全部」= 一键完成，审阅 UI 现成；批注要逐条手工改，且需另建 comments.xml + rels + contentTypes | 面板里逐条接受/拒绝 —— 和 Word 修订重复，白造两遍；批注模式 —— v1 无收益，留配置位 |
| UI | 右侧栏最小面板 + `/typo-proof` 路由 | 参照 `plugins/deliver` 的 `ctx.slots.register` / `ctx.sidebarRightTabs.register` / `scope.webServer.register` | 无 UI 纯工具（v1 也能用，但进度不可见） |
| 测试 | `node --test`，`test/` 目录 | 与 `plugins/deliver` 一致 | vitest（仓库内无先例） |

**依赖**：**零第三方运行时依赖**。zip 的 deflate 用 Node 内置 `node:zlib`（`inflateRawSync` / `deflateRawSync`，zip 条目就是 raw deflate，已实测 Node v26.12.1 可用）——比引 `fflate` 更稳，`fflate` 只装在宿主 `C:\Running\dsh\node_modules`，**`aa` profile 下没有**，靠 hop 解析不可靠。LibreOffice 走 `@deepseek-ai/libreoffice-kit` 与 `dsh-skill-office`（宿主侧已有），缺失时降级。

---

## 3. 系统结构

```
              ┌──────────────────────────────┐
  dsh 宿主 ──►│ index.js  (apply)            │
              │  ├ tools.register(typo_proof)│
              │  ├ sidebarRightTabs.register │
              │  └ webServer.register        │
              └───────┬──────────────┬───────┘
                      │              │
                 ┌────▼─────┐   ┌────▼──────┐
                 │ pipeline │   │ client.js │  (面板：进度/概览/下载)
                 └────┬─────┘   └───────────┘
        ┌─────────────┼──────────────┬─────────────┐
   ┌────▼────┐  ┌─────▼─────┐  ┌─────▼─────┐  ┌────▼────┐
   │docx-read│  │ segment   │  │candidates │  │  cache  │
   └────┬────┘  └───────────┘  └─────┬─────┘  └─────────┘
        │                            │
   ┌────▼────┐  ┌──────────┐   ┌─────▼─────┐  ┌────────────┐
   │  xml    │  │  diff    │   │  prompts  │  │ docx-write │
   │  zip    │  └──────────┘   └───────────┘  └────────────┘
   └─────────┘                                        │
                                              ctx.llm.stream (小/大模型)
```

**调用链**：`tool → pipeline → (docx-read → segment → 采样×3 → candidates → 复核 → docx-write) → report`

---

## 4. 数据结构

```js
// —— 解析层 ——
Paragraph {
  index: number          // 0-based，与 CSV「段号」口径对齐（需单测确认）
  style: string|null     // w:pStyle 的 w:val
  inTable: boolean
  skipped: null | 'toc' | 'encrypted' | 'table' | 'short' | 'nonChinese'
  text: string           // 拼接所有 w:t，忽略 w:tab / w:br / w:delText
  runs: Run[]
}
Run {
  index: number
  text: string
  start: number          // 该 run 在 paragraph.text 中的起始偏移
  rPr: string|null       // 原样保留的 <w:rPr> 片段
  inHyperlink: boolean
}
Sentence {
  paraIndex: number
  index: number          // 段内序号
  start: number; end: number   // 在 paragraph.text 中的偏移
  text: string
}

// —— 采样与候选 ——
Sample {
  sentenceKey: string    // sha1(model + promptVersion + sentence.text)
  ok: boolean            // false = 输出非法（空/超长/含解释）
  edits: Edit[]          // 已在 §REQ-4 闸门过滤后的编辑
  reason?: string        // ok=false 的原因
}
Edit { pos: number; orig: string; sugg: string }   // pos 相对句子起点

Candidate {
  id: string             // `${paraIndex}:${sentenceIndex}:${pos}:${sugg}`
  paraIndex, sentenceIndex, pos: number
  orig, sugg: string     // 均为单个 CJK 字
  votes: number          // 2 或 3
  context: { before: string; text: string; after: string }
  review: { status: ReviewStatus; suggestion?: string; note?: string }
  skippedWrite?: string  // 'hyperlink' | 'offsetshift' | null
}
ReviewStatus = 'confirmed'|'rejected'|'redirected'|'failed'

// —— 运行态 ——
RunState {
  file: string; fileHash: string
  phase: 'idle'|'parsing'|'sampling'|'reviewing'|'writing'|'done'|'failed'
  total, processed, candidates, confirmed, failed: number
  startedAt: number
  error?: { code: string; message: string }
}
```

---

## 5. 模块划分（职责 / 不负责什么）

| 模块 | 负责 | **不负责** |
|---|---|---|
| `lib/zip.js` | 读写 zip 中央目录、deflate | 不解析 XML；不管 docx 语义 |
| `lib/xml.js` | 词法扫描：元素边界、属性原样切片、`w:t` 文本提取与转义 | 不建 DOM、不做 XPath、不校验 schema |
| `lib/docx-read.js` | 读 `document.xml` → `Paragraph[]`；识别样式/表格/超链接 | 不判断哪段该检（那是 segment 的事） |
| `lib/segment.js` | 句子切分、加密段识别与屏蔽、跳过规则、上下文构造 | 不切 run、不碰 XML 写 |
| `lib/diff.js` | LCS → `Edit[]`；相似度计算 | 不判断编辑是否合法（candidates 的事） |
| `lib/candidates.js` | 编辑过滤、三次投票、候选装配 | 不调模型、不写盘 |
| `lib/prompts.js` | 提示词与版本号 | 不管调用与重试 |
| `lib/pipeline.js` | 编排、并发控制、缓存读写、进度回调、错误收敛 | 不直接操作 XML 字符串 |
| `lib/docx-write.js` | 按候选位置切 run、生成 `w:ins`/`w:del`、写副本、LibreOffice 校验 | 不决定改哪些字 |
| `lib/cache.js` | 句级哈希键、命中/写入、版本失效 | 不管业务 |
| `index.js` | 工具注册、任务状态、路由、面板槽位、配置解析 | 不含校对算法 |
| `client.js` | 面板渲染（进度条、概览表、下载按钮） | 不做判定 |

---

## 6. 交互逻辑

**工具调用**

```
typo_proof({ file, resume?: boolean, localModel?, reviewModel?, minHanzi? })
  → 立即返回 { jobId, phase: 'parsing', total? }
  → 后台推进，每 5 秒可被 typo_proof_status({jobId}) 查询
  → 完成返回 { jobId, candidates, confirmed, reportPath, copyPath, elapsedMs }
```

**面板状态机**

```
idle ──点「开始」──► parsing ──► sampling ──► reviewing ──► writing ──► done
                      │            │             │            │
                      └────────────┴─────────────┴────────────┘
                                   失败 → failed（红字 + 原因 + 「重试」）
```

- 面板只读展示；唯一动作按钮是「开始 / 中断 / 生成副本 / 下载副本」。
- **不做**逐条接受/拒绝 —— 审阅在 Word 修订模式里做。

---

## 7. 异常情况（含提示文案）

| 场景 | 表现 | 文案（中文） |
|---|---|---|
| provider 未注册 | 启动前校验失败 | `本地模型 provider「{{p}}」未在模型栏中配置。请先在设置里添加，可用：{{list}}` |
| 本地模型连不上 | 连续 3 句失败即停 | `连不上本地模型 {{provider}}/{{model}}：{{err}}。已在第 {{n}} 句停下，进度已保存，修好后可续跑。` |
| 大模型复核失败（单条） | 该条标 `failed`，不阻断 | 面板该行标「复核未完成」，报告注明 |
| 大模型全部失败 | 停在 reviewing | `云端复核连续失败 {{n}} 次，已停止。已确认 {{c}} 条，其余 {{m}} 条标记为未复核。` |
| docx 不是 zip / 损坏 | 解析阶段报错 | `无法读取 {{file}}：{{err}}。请确认它是 .docx（不是 .doc）。` |
| 文件不存在 / 无权限 | 立即报错 | `找不到文件：{{file}}` / `没有权限读取 {{file}}` |
| 输出文件已存在 | 追加时间戳，不覆盖 | 无需提示 |
| LibreOffice 校验失败 | 副本保留但标红 | `副本已生成，但转换校验失败（{{err}}）。建议在 Word 里打开确认后再使用。` |
| 写到一半进程被杀 | 副本不落盘（先写临时文件） | 重启后可 resume |
| 目标字符落在超链接内 | 跳过该条 | 报告计入 `skippedWrite: hyperlink` |

---

## 8. 边界条件

| 边界 | 处理 |
|---|---|
| 空文件 / 0 段 | 返回「没有可检段落」，不生成副本 |
| 全英文 / 全数字段 | 跳过（`nonChinese`），不计入 total |
| 段落短于 4 个汉字 | 跳过（《级联方案》§3 阶段0） |
| 句子汉字数 < `minHanzi`（默认 8） | 跳过、不计入 total（REQ-18）；阈值可配 |
| 加密段 `##…##` | 整段跳过；跨段时从起始标记到结束标记区间全跳 |
| 单句 > 200 字 | 按 200 字硬切后独立采样 |
| 同一句出现 3 个以上候选 | 全部进候选（不设上限），写入时按位置**倒序**应用 |
| 同一位置两个候选（不同字） | 只保留票数高者；平票则都进候选、写入时取第一个并标 `conflict` |
| 模型返回含解释/引号/代码块 | 剥离后仍超原文 1.2 倍长 → 作废该样本 |
| 模型返回空 | 作废该样本；3 次全废 → 该句标 `noSignal` |
| 文档已有 tracked changes | v1：段落内含 `w:ins`/`w:del` → 整段跳过并计数 |
| 只读文件 | 只写副本，不判错 |
| 首次运行（无缓存） | 正常；缓存目录不存在则创建 |
| 路径含中文/空格/长路径 | 全程不拼 shell 字符串，用 fs API |

---

## 9. 修改范围（文件清单 · 基线）

**全部为新增，不改动仓库现有插件。**

```
plugins/typo-proof/
  package.json
  cordis.patch.yml
  README.md
  PLAN.md
  index.js
  client.js
  lib/zip.js
  lib/xml.js
  lib/docx-read.js
  lib/docx-write.js
  lib/segment.js
  lib/diff.js
  lib/candidates.js
  lib/prompts.js
  lib/pipeline.js
  lib/cache.js
  test/xml.test.js
  test/docx-read.test.js
  test/segment.test.js
  test/diff.test.js
  test/candidates.test.js
  test/pipeline.test.js
  test/docx-write.test.js
  test/fixtures/known-typos.json      // 由 确认错别字_2011-2014.csv 固化
```

**仓库外：装到 profile（已查实，见下）**

当前 dsh 由 `dsh --profile aa` 启动（进程命令行实测），profile 目录 `~/.dsh/profiles/aa/`。该 profile **已装 12 个本地插件**（全部 `link:` 到 `<仓库>/plugins/*` 与本机其他目录），装法是两处同时改：

1. `package.json` 的 `dependencies` 加 `"@local/typo-proof": "link:<仓库>/plugins/typo-proof"`
2. 同文件 `dsh.profile.bundles` 数组追加 `"@local/typo-proof"`
3. `pnpm install`（profile 用 pnpm workspace，`nodeLinker: hoisted`），再重启 dsh 生效

**注意**：`~/.dsh/profiles/web/` 是另一个空 profile，**改它没用**——上一版计划里「尚未安装任何本地插件」的结论就是查错了 profile，已作废。改 `aa/package.json` 属于仓库外改动，**动手前先问用户**。

---

## 10. 实现步骤（每步可独立验证）

| # | 步骤 | 验证 |
|---|---|---|
| 1 | 骨架：package.json / cordis.patch.yml（照 deliver） | `node -e "import('./index.js')"` 不报错 |
| 2 | `zip` + `xml` 扫描器 | 解 `2011~2014.docx` 得 `document.xml`；`w:t` 提取与正则基准一致 |
| 3 | `docx-read` | 单测：段数 234、CJK 16916、run 偏移自洽（`some(r => pos in [start,start+len))`） |
| 4 | XML 往返：解析→原样回写 → 与输入字节相同 | 单测 |
| 5 | `segment`：分句、加密段、跳过规则 | 单测 + 打印前 20 句人工看 |
| 6 | `diff` + `candidates` 过滤/投票 | 单测 12 组 |
| 7 | `prompts` + `pipeline`（mock provider） | 单测：调用次数、缓存命中、中断续跑 |
| 8 | `docx-write` 修订模式 | 单测解 XML 断言；LibreOffice 转换通过 |
| 9 | `index.js` 工具注册 + 任务状态 + 路由 | 冒烟：`typo_proof` 出现在工具列表 |
| 10 | 安装到 profile 并冒烟 | 重启后面板出现、工具可调 |
| 11 | 真机跑 `2011~2014.docx` | 对照 §1 量化验收（需用户先启动 LM Studio） |

**顺序理由**：3→4 先把「读不坏、写不坏」钉死，再谈算法；8 独立于算法，可先用固定候选验证。

---

## 11. 测试方案

- **框架**：`node --test test/`（与 deliver 一致）
- **单测覆盖 7 维**：
  1. 正常路径（解析 / diff / 投票 / 候选装配）
  2. 边界（空、超长、非中文、加密段、超链接、表格）
  3. 非法输入（非 zip、损坏 XML、缺 `document.xml`）
  4. 模型异常（空返回、超长返回、含解释、超时、连续失败）
  5. 并发与顺序（4 并发不串位；同段多候选倒序应用）
  6. 幂等与缓存（二次运行零模型调用；提示词版本变更后失效）
  7. 写入正确性（`w:ins`/`w:delText` 结构、rPr 保留、作者/时间）
- **回归夹具**：`test/fixtures/known-typos.json` —— 由 `确认错别字_2011-2014.csv` 的 5 条固化，断言管线召回 ≥4
- **集成**：真实 docx → 生成副本 → LibreOffice 转 PDF；原文件 sha256 不变
- **端到端**（需真模型）：LM Studio 起 4B，跑一个文件，人工看前 20 条候选质量

---

## 12. 对《级联方案》的取舍（用户要求：好的要参考）

**采纳**

| 来源 | 采纳内容 | 落在哪 |
|---|---|---|
| §2 | **模型只负责改写，定位和校验交给确定性代码**（不让模型自报 context/original/corrected） | §2 技术方案、REQ-4 |
| §3 阶段0 | 跳过目录样式、`##…##` 加密段（含跨段）、技术/英文段、<4 汉字段 | REQ-17 |
| §3 阶段2 | 只留中文单字替换；相似度 <0.80 判改写；单段改动超限判改写（句级阈值改为 5） | REQ-4 |
| §3 阶段2 | 上下文由 diff 位置机械生成，**不让模型给** | REQ-5 |
| §5.4 | 送复核的是**整句 + 前后各一句**，不是固定 ±10 字（的/地/得、人名依赖上下文） | REQ-5 |
| §5.5 | **盲复核**：让大模型独立改正再 diff，不问「A→B 对不对」 | REQ-6 |
| §5.6 | 段落/句子哈希增量缓存，只跑新增或改动 | REQ-11 |
| §5.7 | 人工判定沉淀为标注集，用于评测阈值与模型组合 | REQ-13 的 CSV 复用为标注 |
| §6 | 只写副本、不动原文件；不让模型直接列错误清单 | REQ-9、REQ-10 |
| §5.1 | 召回上限由本地模型决定 —— 靠三采样提升，并**保留低票候选进复核** | REQ-3（2 票即可，不设"仅 3 票"） |

**不采纳 / 改造**

| 来源 | 原做法 | 改成 | 理由 |
|---|---|---|---|
| §1、§3 阶段3 | 4B + 9B 双模型一致性 | **单模型 3 次采样**（用户指定） | 少维护一个模型；多样性靠采样 |
| §3 阶段3 | 高/中/低置信分层 | `votes`(2/3) + `review.status` 两维 | 分层阈值无标注集无法标定；且 §4 实测「低置信里 80% 真错」，分层反而诱导丢弃 |
| §3 阶段3 | 常见易混字表加权 | 删除 | §4 结论：只留易混字会漏掉大部分真错 |
| §3 阶段0 | **按段落**切分 | 按**句**切分（Q2=A，已定） | 4B 在 500 字段落里漏检率高；短句更聚焦、便于并发。段落仍作为上下文单位，并不丢 |
| §5.8 | 温度 0 也会抖 | 显式用 temperature 0.7 制造多样性 | 要的就是三次不同，靠投票收敛 |

---

## 13. 已定决策（2026-11-06 追问闭环）

| # | 问题 | 决定 | 落地 |
|---|---|---|---|
| Q1 | 修改怎么落到副本 | **只用修订模式**（`w:ins`/`w:del`），不做批注 | REQ-9、§2 |
| Q2 | 采样粒度 | **按句**（>200 字硬切），**并加句级最小字数 8 汉字** | REQ-2、REQ-18 |
| Q3 | 三次采样判据 | **3 次里 ≥2 次改动原文**即整句进复核；编辑取并集，互不一致也各自进复核 | REQ-3 |
| Q4 | 首版范围 | **只做单文件**；目录批量留到 v2 | §1、§6 |
| Q5 | 面板 | **最小面板**：进度 + 概览 + 下载副本 | REQ-16 |
| Q6 | 云端复核隐私 | **不脱敏**，上下文直发；面板显示「本次外发 N 句」 | REQ-6 |
| Q7 | 计划文件位置 | `plugins/typo-proof/PLAN.md` | 本文件 |

**Q3=A 的代价（已知并接受）**：同一句的三次采样可能各改一处、互不一致，这些「单票」编辑也会进云端复核 → 候选数、云端调用次数上升（估计比「同一修正 ≥2」多 2–3 倍），换来的是不漏掉「只在某一次里改对」的真错。云端复核是最后一道闸，1 票候选靠盲复核过滤。

**仍待确认**：`minHanzi` 默认值取 8 是否合适（技术上 5–8 都安全，越短误报越多）。
