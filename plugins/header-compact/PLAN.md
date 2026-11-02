# 手机端会话标题行收紧（子智能体 / 后台任务 / 打开文件资源管理器）

> 阶段一计划稿。状态：追问已闭环，待闸门1 确认。
> 目标：**新建独立插件** `plugins/header-compact`（包名 `@local/header-compact`，版本 0.1.0）。
> 已定决策：文案数量后置（Q1B）· 空格分隔（Q1A）· 手机端去掉状态后缀（Q2C）· 英文保持自身语序（Q3A）· 阈值 767.98px（Q2A）· 只处理会话标题行（Q3A）· 单独一个插件。

## 1. 功能需求

| # | 需求 | 验收方式 |
|---|---|---|
| FR1 | 视口宽度 ≤ 767.98px 时，子智能体计数按钮由「N 个子智能体」显示为「智能体 N」 | 手机竖屏硬刷新后肉眼确认；单测覆盖文案函数 |
| FR2 | 同一阈值下，后台任务按钮由「N 个后台任务」/「N 个后台任务运行中」显示为「后台 N」（后缀不显示） | 同上 |
| FR3 | 同一阈值下，会话标题行的「在本地打开 / 显示文件位置」整组按钮（含右侧下拉箭头）隐藏；右侧文件面板里的同款按钮不动 | 手机端确认按钮消失、面板里仍有；桌面端都在 |
| FR4 | 视口回到 > 767.98px（旋转、窗口缩放）时，文案逐字还原为原值、按钮重新出现 | 手机横屏 / 桌面窗口缩放各看一次 |
| FR5 | 宽屏（桌面）行为完全不变 | 桌面 1400px 宽确认文案与按钮均原样 |
| FR6 | 中文、英文两种字典都处理；其他语言或上游文案结构变化时不改写（宁可不动，不可乱改） | 单测覆盖中英文与「不匹配就不动」 |
| FR7 | 可见文案去后缀后，`aria-label` 仍保留「运行中 / 正在运行」 | 单测覆盖 aria 文案 |

非目标（本轮不做）：不改上游 `ui-jobs` / `ui-subagent` 源码；不动「⋯」更多菜单、右栏抽屉、输入区、右侧文件面板的打开按钮；不处理会话标题本身被截断的问题；不改 `mobile-fit` 现有行为。

## 2. 技术方案

**采用：新建一个纯客户端插件，做「窄屏文案收紧（DOM 文本改写）+ 窄屏按钮隐藏（CSS）」。**

- 文案：`MutationObserver` 观察 DOM，在会话标题行里找带 `aria-label` 的按钮；对按钮内「唯一文本子节点、且文本匹配计数文案」的 `span`，**改写该文本节点的 `nodeValue`**（不替换节点，避免 React 失去节点引用）；`aria-label` 同步改写。离开窄屏时按**登记的原值**逐字还原。
- 按钮：纯 CSS，用 `:has()` 把作用域限定在「含 `[data-conversation-header-corner]` 的标题行」内，隐藏 `[data-open-target="directory"]` 及其包裹层。
- 阈值：`window.matchMedia('(max-width: 767.98px)')`。
- 形态：宿主半边空实现（`apply() {}`），全部逻辑在 `client.js`；不依赖 React、不注册任何 slot、不碰 locale。

**为什么不用更「正规」的路子**

| 备选 | 否决理由 |
|---|---|
| A. 改 `node_modules` 里 `ui-jobs` / `ui-subagent` 的文案 | 升级即丢；本仓库既有 NFR 已把「改 node_modules」列为禁区 |
| B. 用 `ctx.locale.register('job'/'subagent', …)` 覆盖字典 | locale 运行时对**同名 namespace + 同语言**的重复注册直接抛错，覆盖不了 |
| C. 复用 slot id（`job-list` / `subagent-*`）接管整格 | 接管等于重写整个弹层（实时输出、终止任务、树形目录），风险与体量远超本次需求 |
| D. 只靠 CSS 隐藏原文再 `::after` 补字 | CSS 读不到文本里的数量；数量后置还要求重排词序 |
| E. 让标题行横向滚动 / 换行 | 解决不了拥挤的根因，也违背「只留『智能体』『后台』」的要求 |
| F. 塞进现有 `mobile-fit` | 用户明确要求单独一个插件，便于单独装卸 |

**为什么 DOM 文本改写可接受**：只改文本节点的值与一个属性，不增删节点、不动结构；React 之后重渲染会写回长文案，观察器下一帧再收紧。最坏情况是文案短暂回长，不会崩、不会错位。

**部署**：新 bundle 需要写进 profile 的 `dsh.profile.bundles`，客户端清单在 dsh 启动时扫描——所以**装完要重启 dsh**，再在手机上硬刷新。之后改 `client.js` 只需硬刷新（包地址带 mtime 派生的 `?rev=`）。

## 3. 系统结构

```
新插件 plugins/header-compact（Cordis bundle）
├─ index.js            宿主半边：空实现
├─ client.js           浏览器半边：
│   ├─ 注入 @media (max-width: 767.98px) 规则      ── 隐藏「在本地打开」整组
│   ├─ shortenCountLabel(text, withSuffix)          ── 纯函数，中英文规则
│   └─ installHeaderCompact()
│       ├─ matchMedia 监听阈值
│       ├─ MutationObserver（合并到每帧一次）→ syncHeader()
│       │    ├─ 取每个 `[data-conversation-header-corner]` 的父元素（会话标题行）
│       │    ├─ 扫该行内 `button[aria-label]` 与其中唯一的文本节点
│       │    └─ 改写 / 按登记原值还原文本与 aria-label
│       └─ disposer：断开观察器、移除监听、还原文案
├─ cordis.patch.yml    bundle 插入声明
├─ package.json        dsh.client = web / immediately
├─ README.md           做什么、阈值、边界、卸载
└─ test/client.test.js 单测
```

与宿主、与 `mobile-fit` 都无耦合：两者各自独立装卸。

## 4. 数据结构

无持久化数据。纯函数与就地状态：

```js
/**
 * 收紧一条计数文案。
 * @param {string} text - 原文案。
 * @param {boolean} withSuffix - 是否保留「运行中 / 正在运行」后缀（aria 用 true，可见文案用 false）。
 * @returns {string|null} 短文案；不匹配时返回 null（表示「不归我管」）。
 */
shortenCountLabel(text, withSuffix)
```

规则（数字后置、空格分隔；可见文案丢后缀，aria 保留）：

| 原（中文） | 可见 | aria |
|---|---|---|
| `N 个子智能体` | `智能体 N` | `智能体 N` |
| `N 个子智能体，正在运行` | `智能体 N` | `智能体 N，正在运行` |
| `N 个后台任务` | `后台 N` | `后台 N` |
| `N 个后台任务运行中` | `后台 N` | `后台 N 运行中` |

| 原（英文） | 可见 | aria |
|---|---|---|
| `N subagent(s)` | `N agent(s)` | 同左 |
| `N subagent(s) running` | `N agent(s)` | `N agent(s) running` |
| `N background job(s)` | `N job(s)` | 同左 |
| `N background job(s) running` | `N job(s)` | `N job(s) running` |

就地状态：

```js
/** 被改写的文本节点 → 改写前的原文（还原用它，保证逐字还原）。 */
Map<Text, string>
/** 被改写的按钮 → 改写前的 aria-label。 */
Map<Element, string>
```

## 5. 模块划分

**负责**：窄屏下会话标题行的两处计数文案（含 aria）、一处「在本地打开」按钮；阈值切换时的收紧/还原；单测。

**不负责**：会话标题的省略与布局（宿主 `titleCluster` 的事）；后台任务弹层与子智能体目录弹层的内容；右侧文件面板里的打开按钮；其它语言；宿主侧任何逻辑；`mobile-fit` 的任何行为。

## 6. 交互逻辑

1. 打开 / 切换会话 → React 渲染标题行 → 观察器合并到下一帧 → 收紧为「智能体 3」「后台 1」。
2. 计数变化（子代理增减、后台任务起止）→ React 写回长文案 → 观察器下一帧再收紧；改写不触碰按钮点击行为，两个弹层功能完全不受影响。
3. 视口跨过 767.98px（旋转、缩放窗口）→ matchMedia 回调 → 收紧或按登记原值还原；按钮显隐由 CSS 自动跟随。
4. 插件卸载 → 断开观察器、移除监听、还原文案。

## 7. 异常情况

| 情况 | 表现 |
|---|---|
| 上游改了文案 / 新增语言，匹配不上 | 返回 null，**原样不动**，界面等同现状，不报错 |
| 当前会话是 blank / 隐藏 chrome，没有标题行 | 直接跳过，不做任何事 |
| 极老 WebView 没有 `MutationObserver` / `requestAnimationFrame` | 插件静默不生效，不抛错，界面等同现状 |
| `MediaQueryList` 没有 `addEventListener`（老 Safari） | 退回 `addListener` |
| 插件被卸载或重新加载 | 全部按登记原值还原，不留短文案残留 |
| profile 里漏写 bundles | 重启后插件不加载，界面等同现状（安装步骤里逐条核对） |

## 8. 边界条件

- 数量 0/1/10/999：原样搬运数字，只重排词序。
- 后缀「，正在运行」「运行中」：可见文案丢掉，aria 保留（标点沿用原文）。
- 同一段文案连续处理：对已收紧的文案返回 null（幂等）。
- 阈值连续来回切换：还原只写回登记的原值，不会出现「智能体智能体」。
- 页面同时存在多个会话标题行（侧栏会话面板）：逐个处理。
- 英文单复数：`agent/agents`、`job/jobs` 保持原复数形态。
- 文本节点被 React 重建：新节点会重新被收紧；旧节点登记项失效无副作用（还原前判 `isConnected`）。

## 9. 修改范围

| 文件 | 改动 |
|---|---|
| `plugins/header-compact/package.json` | **新增**：包名、0.1.0、exports、files、`dsh.bundle.patch`、`dsh.client`(web/immediately)、`scripts.test` |
| `plugins/header-compact/index.js` | **新增**：空实现宿主半边 |
| `plugins/header-compact/client.js` | **新增**：纯函数 + `@media` 规则 + `installHeaderCompact()` |
| `plugins/header-compact/cordis.patch.yml` | **新增**：`insert: header-compact` |
| `plugins/header-compact/README.md` | **新增**：用途、阈值、边界、安装/卸载、验证方法 |
| `plugins/header-compact/test/client.test.js` | **新增**：文案函数 + 微型假 DOM 的改写/还原 |
| `plugins/header-compact/PLAN.md` | 本计划文件（阶段一产物） |
| `README.md` | 插件清单新增本插件一行 |
| `C:\Users\autod\.dsh\profiles\aa\package.json` | 安装（`dsh plugin add` 写入依赖与 `bundles`）；**不在本仓库内** |

不动：`mobile-fit` 全部文件、`index.js` 以外的其它插件、`node_modules` 内任何文件。

## 10. 实现步骤

1. 建 `plugins/header-compact/` 骨架：`package.json`、`index.js`、`cordis.patch.yml`。
2. `client.js`：加 `shortenCountLabel(text, withSuffix)`（中英文规则），并从模块返回里暴露 `internals`（仅供单测，宿主不读）。
3. `client.js`：样式表里写窄屏隐藏「在本地打开」整组的规则。
4. `client.js`：实现 `installHeaderCompact()`（matchMedia + 观察器 + 每帧合并 + 登记原值 + 还原 + disposer）。
5. 写 `test/client.test.js`：文案函数 + 微型假 DOM 的改写/还原；`node --test plugins/header-compact/test/` 全绿。
6. 写 `README.md`；根 `README.md` 插件清单加一行。
7. 装到 profile `aa`：`dsh plugin --profile aa add "@local/header-compact@link:C:/Users/autod/Documents/GitHub/dsh-extensions/plugins/header-compact"`，核对 `dependencies` 与 `dsh.profile.bundles` 两处都写了。
8. 重启 dsh（`restart-dsh.ps1 -DelaySeconds 20`），下一轮再验证。
9. 手机端硬刷新验收：竖屏收紧、横屏还原、桌面不变；再跑一遍 `mobile-fit` 的回归（抽屉、键盘贴合、设置弹层）。

## 11. 测试方案

**单测**（`node --test plugins/header-compact/test/`，覆盖 7 类维度）：

1. 正常：中文子智能体 / 后台任务的空闲与运行中四种形态（可见与 aria 各一套）。
2. 边界：0、1、多位数；数量与「个」之间有无空格；英文单复数。
3. 幂等：对已收紧的文案再收紧返回 null；连续 `syncHeader` 不重复改写。
4. 还原：改写后按登记原值还原，逐字回到原样（含「运行中」后缀）。
5. 不匹配：会话标题、「3 个文件」、空串、undefined → null 且 DOM 不动。
6. 语言：英文只换名词，不改英文自身词序。
7. 装配：`client.js` 能被 `__ModuleLoader__` 读入、`id` 为 `@local/header-compact`、`apply` 存在；假 DOM 上 `syncHeader(compact=true)` 后两个按钮文案变短、`compact=false` 后复原。

**手动 E2E**（阶段四按用户选定的方式跑）：

- 手机竖屏：两个按钮变成「智能体 3」「后台 1」、「在本地打开」消失、会话标题能露出来。
- 手机横屏 / 桌面 1400px：文案与按钮恢复原样。
- 回归：侧栏抽屉、输入法贴合、设置弹层重排、后台任务弹层与子智能体弹层照常。

## 附：追问结论

| 问题 | 结论 |
|---|---|
| 文案形态 | 数量后置：`智能体 N` / `后台 N` |
| 分隔 | 中文名词与数字之间留空格 |
| 状态后缀 | 手机端可见文案去掉；`aria-label` 保留 |
| 英文 | 保持英文自身语序（数量在前），只换名词 |
| 阈值 | `max-width: 767.98px` |
| 隐藏范围 | 只隐藏会话标题行的「在本地打开」整组 |
| 载体 | 单独一个插件（`@local/header-compact`），不并进 `mobile-fit` |
