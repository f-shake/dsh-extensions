# DSH 远程 Android · 修复计划：状态栏图标 / 返回键关浮层 / 刷新按钮

状态：定稿（追问已闭环）；开发、单元测试与真机验证已完成
日期：2026-11-08
目标版本：1.0.38（versionCode 39）
关联：`docs/plan.md`（初版计划）

## 0. 背景与问题定位

用户反馈三个问题，先给出代码层面的定位依据，再据此写方案。

### 0.1 浅色模式下状态栏图标仍是白色

| 事实 | 位置 |
|---|---|
| `enableEdgeToEdge()` 只在 `onCreate` 调用一次，它按**调用那一刻**的 `uiMode` 决定状态栏图标明暗 | `MainActivity.kt:17` |
| `AndroidManifest.xml` 的 `configChanges` 含 `uiMode`，系统深色↔浅色切换时 Activity **不重建**，`onCreate` 不再执行 | `AndroidManifest.xml:25` |
| 界面明暗由 Compose 的 `isSystemInDarkTheme()` 驱动，系统切换后顶栏会变浅 | `ui/theme/Theme.kt:29`、`ui/common/CompactTopBar.kt:42` |

结论：系统从深色切到浅色后，顶栏背景变成浅色，但状态栏图标仍是上一次的「浅色模式」设置（白色），于是白字白底。反向切换（浅→深）同样会残留深色图标。根因是**窗口装饰的明暗只在创建时取了一次值**。

### 0.2 返回键不关网页里的浮层

- 返回键统一在 `ui/nav/AppNav.kt:150` 的 `BackHandler` 处理：网页路由里只做 `controller.goBack()`，失败则 `backToList()`。
- 侧栏、对话框、菜单、浮动面板都是**网页里的覆盖层**，开关不进入 WebView 历史，`goBack()` 感知不到它们，于是直接退回主机列表；再按一次就退出应用。
- DSH 0.2.2 的浮层形态（依据本机安装的 `dsh-web-frontend` / `dsh-client-ui-*` 源码）：

| 浮层 | 识别标记 | 关闭方式 |
|---|---|---|
| 下拉菜单 / 右键菜单 | `[role="menu"]`（菜单 portal 到 body） | 派发 `Escape`（组件在 document 上监听） |
| 输入框候选 / 命令面板 | `[role="listbox"]`（`aria-activedescendant`） | 派发 `Escape`（React 挂在输入框上） |
| 模态对话框（设置、账号、快捷键、确认框、图片预览） | `[role="dialog"][aria-modal="true"]` | 派发 `Escape`（dialog 在 document 上监听，按层栈只关心最上层） |
| 左侧抽屉 | 遮罩 `[data-sidebar-mask]` 常驻；收起时 frame 带 `data-sidebar-collapsed` | 点遮罩 |
| 右侧栏（手机全屏形态） | `[data-sidebar-right-panel="fullscreen"][data-sidebar-right-open]` | 点 `[data-sidebar-right-toggle]` |
| 浮动面板（dock 浮窗） | `[data-dockkit-float]` | 点其内部 `[data-dockkit-float-dock]` |

- 本仓库的 `plugins/swipe-sidebar/client.js` 已在用同一组侧栏选择器做手势，说明这些是稳定的官方标记，而不是靠类名猜。
- DSH 的浮层关闭几乎都走 `Escape`：对话框与菜单在 document 上监听、按各自层栈只处理最上层，图片预览在 window 上监听。因此「派发一次 Escape」可以统一关掉这些层，而不必逐个认类名。

### 0.3 刷新按钮位置

刷新目前只存在于右上角「更多」菜单的第一项（`ui/web/WebScreen.kt:143-150`），顶栏没有独立入口。

## 1. 功能需求

| 编号 | 需求 | 验收方式 |
|---|---|---|
| R1 | 浅色状态下，应用前台时状态栏图标为深色、清晰可读；深色状态下为浅色 | 真机手测（已连 Android 15 设备） |
| R2 | 应用在前台期间，系统深色↔浅色**任一方向**切换后，状态栏与导航栏图标立即跟随，不需重启或重建 | 真机手测 + 截图 |
| R3 | 三类页面（主机列表、登录页、网页页）表现一致 | 真机手测 |
| R4 | 网页里有浮层打开时，按系统返回键只关闭**最上层**那一个，页面不跳转、不退回列表、不退出应用 | 真机手测 |
| R5 | 逐层关闭顺序：下拉/右键菜单 → 输入候选/命令面板 → 模态对话框 → 左侧抽屉 → 浮动面板 → 全屏右侧栏 | 真机手测 |
| R6 | 没有浮层打开时，返回键行为与现在完全一致：先网页历史回退，再退回主机列表，最后退出应用 | 单测 + 手测 |
| R7 | 宽屏（≥768dp，平板/折叠屏展开）下侧栏是停靠列，返回键**不**收起它；手动切到全屏的右侧栏仍算浮层 | 手测（平板可选） |
| R8 | 网页页顶栏「更多」按钮左侧新增刷新图标按钮；点击重新加载当前页面，行为与菜单里的「刷新」一致 | 手测 |
| R9 | 网页页顶栏返回箭头保持原语义：只做网页历史回退，不参与关浮层 | 手测 |
| R10 | 「更多」菜单里不再有「刷新」项 | 手测 |

说明：R6 是回归保护；R9 是用户在追问中明确选择的行为（顶栏箭头不动）；R7 避免把「平板上一直显示的侧栏」当成浮层。

## 2. 技术方案

### 2.1 状态栏图标跟随主题（R1~R3）

**做法**：把 `enableEdgeToEdge()` 从「只在 `onCreate` 调一次」改为「主题变化时重新应用」。

```kotlin
setContent {
    val darkTheme = isSystemInDarkTheme()
    // uiMode 在 configChanges 里，系统切换深浅色时 Activity 不会重建；
    // 窗口装饰的明暗必须跟着 Compose 主题重设，否则会留着上一次的图标颜色。
    LaunchedEffect(darkTheme) { enableEdgeToEdge() }
    DshRemoteTheme(darkTheme = darkTheme) {
        AppRoot(container, imeBottom)
    }
}
```

- `enableEdgeToEdge()` 内部重新读取 `resources.configuration.uiMode`，与 `isSystemInDarkTheme()` 同源；一次调用同时覆盖状态栏图标、导航栏图标与旧系统（API 26~28）的导航栏 scrim。
- `onCreate` 里保留原调用，保证首帧不闪。
- 不改 `Theme.kt` 的默认参数，预览与其它调用方不受影响。

**被否决的备选**：

| 方案 | 否决理由 |
|---|---|
| 从 `configChanges` 去掉 `uiMode`，让 Activity 重建 | 会重建 WebView，页面重载、会话内滚动位置与草稿全丢；与现有「网页常驻」设计冲突 |
| 在 `onConfigurationChanged` 里重设 `isAppearanceLightStatusBars` | 可行，但「窗口明暗」与「Compose 主题」变成两套判定，正是本次问题的成因；以 Compose 主题为唯一来源更不易再分叉 |
| 只手动设 `isAppearanceLightStatusBars` / `isAppearanceLightNavigationBars` | 丢掉导航栏 scrim 与其它窗口装饰的一致性；`enableEdgeToEdge()` 已封装这些细节 |

### 2.2 返回键逐层关闭浮层（R4~R7）

**做法**：返回时先向页面问一句「有浮层吗？有就关掉最上层」，页面返回关掉的层名；得到非 `none` 就消费这次返回，否则走原有逻辑。

页面脚本（新增到 `web/WebCompat.kt`，按 z-order 从高到低判断）：

```js
(function () {
  try {
    function visible(el) {
      if (!el || !el.getClientRects().length) return false;
      var cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
    }
    function top(selector) {
      var list = document.querySelectorAll(selector);
      for (var i = list.length - 1; i >= 0; i--) if (visible(list[i])) return list[i];
      return null;
    }
    function pressEscape() {
      var target = document.activeElement || document.body || document.documentElement;
      var event = new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
        bubbles: true, cancelable: true, composed: true
      });
      target.dispatchEvent(event);
    }
    // 1) 下拉/右键菜单（portal 到 body，z 最高）
    if (top('[role="menu"]')) { pressEscape(); return 'menu'; }
    // 2) 输入候选/命令面板（React 挂在输入框上，需把事件派给焦点元素）
    if (top('[role="listbox"]')) { pressEscape(); return 'listbox'; }
    // 3) 模态对话框；左抽屉也带 aria-modal，留到后面单独处理
    if (top('[role="dialog"][aria-modal="true"]:not([data-shortcut-modal="sidebar"])')) {
      pressEscape(); return 'dialog';
    }
    // 4) 左侧抽屉
    var mask = document.querySelector('[data-sidebar-mask]');
    if (mask !== null) {
      var frame = mask.parentElement;
      if (frame === null || !frame.hasAttribute('data-sidebar-collapsed')) {
        mask.click(); return 'drawer';
      }
    }
    // 5) 浮动面板：收回停靠，不销毁标签页
    var float = top('[data-dockkit-float]');
    if (float !== null) {
      var dock = float.querySelector('[data-dockkit-float-dock]');
      if (dock !== null) { dock.click(); return 'float'; }
    }
    // 6) 手机上的全屏右侧栏（停靠/推挤形态不算浮层）
    var panel = document.querySelector('[data-sidebar-right-panel="fullscreen"][data-sidebar-right-open]');
    if (panel !== null) {
      var close = panel.querySelector('[data-sidebar-right-toggle]') || document.querySelector('[data-sidebar-right-toggle]');
      if (close !== null) { close.click(); return 'right'; }
    }
    return 'none';
  } catch (e) { return 'none'; }
})();
```

原生通道（`WebViewController`）：

```kotlin
fun dismissOverlayIfOpen(onResult: (Boolean) -> Unit) {
    if (dismissingOverlay) return           // 连按两次返回只处理一次
    dismissingOverlay = true
    val view = webView
    if (view == null) { dismissingOverlay = false; onResult(false); return }
    view.evaluateJavascript(WebCompat.backDismissScript) { raw ->
        dismissingOverlay = false
        val dismissed = WebBack.overlayDismissed(raw)
        if (dismissed) WebDiagnostics.add("[back] overlay=${WebBack.overlayName(raw)}")
        onResult(dismissed)
    }
}
```

返回路由（`AppNav.kt`）：

```kotlin
fun webBack(controller: WebViewController) {
    controller.dismissOverlayIfOpen { dismissed ->
        if (!dismissed && !controller.goBack()) backToList()
    }
}
```

**为什么用 `Escape` 而不是逐个点关闭按钮**：

- DSH 的对话框、菜单、提示气泡都实现了 `Escape` 关闭，并且按层栈只处理最上层；一次派发就能覆盖未知的新对话框（例如插件注册的），不必跟着枚举按钮。
- 关闭事件是同步派发的，React 的同步更新在同一任务内提交，返回后立即再查 DOM 也能看到变化；语义上也不会误触页面上其它可点击元素。

**被否决的备选**：

| 方案 | 否决理由 |
|---|---|
| `addJavascriptInterface` 常驻上报浮层状态 | 需要长期维护状态与页面重载后的重装，还多一个 JS 桥暴露面；本次只需按键那一瞬间的答案 |
| 用坐标点屏幕边缘/遮罩像素 | 依赖布局与动画时序，脆弱 |
| 给每类浮层写一个关闭按钮选择器 | 插件/新版本一加浮层就漏；且菜单、对话框的关闭按钮位置不统一 |
| 改 DSH 前端或在宿主装插件 | 客户端不能假设用户实例装了哪个插件；WebView 里能拿到的只有页面本身 |
| 用 `history.pushState` 让浮层占一条历史 | 需要改页面行为；且不清历史时会把「返回一次」变成回退到无效 token 页（现有代码已刻意避免） |

### 2.3 刷新按钮（R8、R10）

在顶栏 actions 里、「更多」的 `Box` 之前插入：

```kotlin
IconButton(
    onClick = { failure = null; controller.reload() },
    modifier = Modifier.size(CompactIconSize),
) { Icon(Icons.Filled.Refresh, contentDescription = "刷新") }
```

同时从「更多」菜单里删掉「刷新」项。

### 2.4 验证方式

- 状态栏、返回键、浮层关闭：在已连接的 Android 15 真机上验证（`adb` 无线调试已连接，Android 15 真机）。用 `adb shell cmd uimode night yes|no` 切系统主题，截图比对状态栏图标；用 `adb shell input keyevent KEYCODE_BACK` 配合截图验证逐层关闭。
- 页面脚本契约：真机上打开真实 DSH 页面后逐类打开浮层验证（设置对话框、会话菜单、左抽屉、右栏、输入候选），不依赖桌面浏览器。
- 构建：`assembleDebug` + `assembleRelease`，确认可安装包产出。

## 3. 系统结构

```
MainActivity
  └─ setContent: darkTheme = isSystemInDarkTheme()
       ├─ LaunchedEffect(darkTheme) ──> enableEdgeToEdge() ──> WindowInsetsController(状态栏/导航栏图标)
       └─ DshRemoteTheme(darkTheme) ──> AppRoot
                                          ├─ BackHandler（仅系统返回）──> WebViewController.dismissOverlayIfOpen
                                          │                              └─ evaluateJavascript(WebCompat.backDismissScript)
                                          │                                    └─ 页面 DOM: 菜单/候选/对话框/抽屉/浮窗/右栏
                                          └─ WebScreen 顶栏
                                               ├─ 返回箭头 ──> controller.goBack()（不关浮层，R9）
                                               ├─ 刷新图标 ──> controller.reload()
                                               └─ 更多菜单（去掉「刷新」）
```

## 4. 数据结构

不新增持久化数据、不改主机模型。只新增一个**脚本返回值契约**：

| 项 | 定义 |
|---|---|
| JS 返回值 | 字符串：`menu` / `listbox` / `dialog` / `drawer` / `float` / `right` / `none` |
| 原生解析 | `WebBack.overlayDismissed(raw: String?)`：去掉 JSON 引号与空白后，非空且不是 `none` 即为真 |
| 空值/异常 | `null`、`"none"`、异常文本一律按 `false` 处理，退回原有返回逻辑 |
| 诊断 | 关掉浮层时写一条 `WebDiagnostics`：`[back] overlay=<kind>` |

## 5. 模块划分

| 模块 | 负责 | 不负责 |
|---|---|---|
| `MainActivity` | 窗口级外观：系统栏图标跟随主题 | 不感知网页、不感知路由 |
| `web/WebCompat` | 注入脚本常量（兼容垫片 + 本次的浮层关闭脚本） | 不做业务判断，不调原生 |
| `web/WebViewController` | 页面命令通道：reload / load / goBack / evaluate / dismissOverlayIfOpen | 不决定路由，不弹提示 |
| `web/WebBack`（新增，纯函数） | 解析脚本返回值、取层名做诊断 | 不接触 WebView |
| `ui/nav/AppNav` | 返回键路由、页面切换、会话保活 | 不直接拼 JS |
| `ui/web/WebScreen` | 顶栏布局与按钮 | 不直接拼 JS（通过 controller） |

## 6. 交互逻辑

### 6.1 系统返回键（网页路由）

1. 取当前前台实例的 `WebViewController`；没有（页面还没建好）→ 直接 `backToList()`。
2. 执行浮层关闭脚本：
   - 返回非 `none`：本次返回消费完毕，停留原页。
   - 返回 `none`：继续。
3. `controller.goBack()` 为真 → 网页历史回退。
4. 否则 `backToList()`（回主机列表，清掉「上次停留主机」）。
5. 主机列表上再按返回 → 系统默认行为（退出应用）。

多层叠加时每次只关最上层：先菜单、再候选、再对话框、再抽屉、再浮窗、再右栏，最后才是历史/列表。

### 6.2 顶栏返回箭头

保持现状：`controller.goBack()`，失败回列表；不参与关浮层（R9）。

### 6.3 系统深浅色切换

1. 系统切换 → Activity 收到 `onConfigurationChanged`（不重建）。
2. Compose 的 `LocalConfiguration` 更新，`isSystemInDarkTheme()` 取新值，`MainActivity` 重组。
3. `LaunchedEffect(darkTheme)` 重新执行 → `enableEdgeToEdge()` 按新 `uiMode` 设图标明暗。
4. 顶栏与状态栏同时变，无中间态。

### 6.4 点刷新

1. 清空 `failure`（若之前是错误覆盖层）。
2. `controller.reload()`；进度条按现有 `onProgress` 逻辑出现/消失。
3. 失败仍由现有 `FailurePanel` 呈现（网络/502/证书）。

## 7. 异常情况

| 场景 | 表现 | 提示文案 |
|---|---|---|
| 页面还没建好就按返回 | 跳过脚本，按原逻辑回退/回列表 | 无新增 |
| 脚本执行异常 / 选择器不存在（宿主 DSH 版本较老） | 返回 `none`，按原逻辑回退 | 无新增 |
| 对话框不允许关闭（必须确认） | 仍消费这次返回，不导航；用户需在对话框里明确选择 | 无新增 |
| 面板显示已展开但找不到关闭按钮 | 返回 `none`，按原逻辑回退 | 无新增 |
| WebView 已销毁（退出登录、删除主机） | `dismissOverlayIfOpen` 立即回调 `false`，不触达已销毁视图 | 无新增 |
| 连按两次返回 | 第二次在第一次未回调前被忽略；不会连续回退两层或连关两个浮层 | 无新增 |
| 刷新时断网/上游 502 | 现有 `FailurePanel`：`无法连接到服务器，请检查网络` / `服务器暂时不可用，请稍后重试（502）` | 沿用现有 |
| 主题切换发生在后台 | 回到前台时 Compose 已重组，图标在首帧即为正确颜色 | 无新增 |

## 8. 边界条件

- 手机横屏且宽度仍 <768px：仍是抽屉模式，返回键先关浮层。
- 平板/折叠屏 ≥768px：无遮罩，返回键不收起停靠侧栏（R7）。
- 平板手动把右侧栏切成全屏：仍算浮层，返回键关闭。
- 冷启动时抽屉因上次状态（`narrowExpanded` 持久化）自动展开：首帧后按返回也能关掉。
- 多个浮层叠加（例如设置对话框里再打开一个下拉菜单）：一次返回只关最上层。
- 输入框里正在用中文输入法组词：派发的 `Escape` 仍会按页面逻辑关闭浮层；不会清空已上屏文本。
- 会自动消失的提示气泡（tooltip）与操作提示条（toast）不纳入返回键处理（Q7）：它们不拦返回，自己到时间消失。
- 顶栏宽度最窄 320dp：返回 40 + 标题（weight）+ 主机切换（≤~120）+ 刷新 40 + 更多 40，标题仍可压缩显示省略号。
- 主题切换时若 Activity 正处于分屏/画中画：与前台一致，重设窗口装饰即可。
- 页面没有浮层但 WebView 自身有历史：行为与修改前逐字节一致。

## 9. 修改范围（文件清单）

| 文件 | 改动 |
|---|---|
| `dsh-remote-android/app/src/main/java/com/fshake/dshremote/MainActivity.kt` | 主题变化时重新 `enableEdgeToEdge()`；显式把 `darkTheme` 传给主题 |
| `dsh-remote-android/app/src/main/java/com/fshake/dshremote/web/WebCompat.kt` | 新增 `backDismissScript` |
| `dsh-remote-android/app/src/main/java/com/fshake/dshremote/web/DshWebView.kt` | `WebViewController` 新增 `dismissOverlayIfOpen` 与重入保护 |
| `dsh-remote-android/app/src/main/java/com/fshake/dshremote/web/WebBack.kt`（新增） | 纯函数解析脚本返回值、取层名 |
| `dsh-remote-android/app/src/main/java/com/fshake/dshremote/ui/nav/AppNav.kt` | 返回键先关浮层 |
| `dsh-remote-android/app/src/main/java/com/fshake/dshremote/ui/web/WebScreen.kt` | 新增刷新按钮；菜单去掉「刷新」 |
| `dsh-remote-android/app/build.gradle.kts` | versionCode 38→39，versionName 1.0.37→1.0.38 |
| `dsh-remote-android/app/src/test/java/com/fshake/dshremote/WebBackTest.kt`（新增） | 返回值解析用例 |
| `dsh-remote-android/app/src/test/java/com/fshake/dshremote/WebCompatScriptTest.kt`（新增，可选） | 脚本包含关键选择器、缺标记时返回 `none` 的契约 |
| `dsh-remote-android/README.md` | 功能清单与手工验证清单补条目 |
| `dsh-remote-android/docs/plan-statusbar-back-refresh.md`（本文件） | 计划，阶段一产物 |

基线说明：清单尽量列全；若实现中出现「不列就跑不通」的文件（例如测试辅助类）或生成物，按计划补漏处理并在闸门2 说明。

## 10. 实现步骤

1. **状态栏**：改 `MainActivity`，在 `setContent` 里以 `darkTheme` 为 key 重设 edge-to-edge；`assembleDebug` 通过。
2. **脚本常量**：在 `WebCompat` 加 `backDismissScript`。
3. **解析纯函数**：新增 `WebBack`，写 `WebBackTest`（各层名、`none`、`null`、异常文本）。
4. **命令通道**：`WebViewController.dismissOverlayIfOpen`（含重入保护、诊断日志）。
5. **返回路由**：`AppNav` 的 `BackHandler` 改为「先关浮层，再历史，再列表」。
6. **刷新按钮**：顶栏加图标，删菜单项。
7. **版本与文档**：bump 1.0.38/39；README 功能与手测清单补条目。
8. **自测**：跑改动的单测文件 + 全量编译；产出 debug/release APK；装机按 11.4 逐条验证。

## 11. 测试方案

### 11.1 单元测试（JVM）

| 文件 | 覆盖 |
|---|---|
| `WebBackTest.kt` | `"menu"`/`"dialog"`/`"drawer"` 等 → true；`"none"`、`null`、`""`、`"{}"` → false；带 JSON 引号与前后空白容错；`overlayName` 对未知值回退到 `none` |
| `WebCompatScriptTest.kt`（可选） | 脚本包含 `role="menu"`、`data-sidebar-mask`、`data-sidebar-right-panel`、`data-dockkit-float`；脚本以 `'none'` 兜底 |

### 11.2 真机验证（Android 15，已连接）

用 `adb` 驱动，截图逐条确认：

1. `adb shell cmd uimode night no` 后在前台观察：状态栏图标为深色。
2. `adb shell cmd uimode night yes`：状态栏图标为浅色；再切回 `no`：恢复深色。
3. 打开左侧抽屉 → `input keyevent KEYCODE_BACK`：抽屉关闭，仍在网页页。
4. 打开「设置」对话框 → 返回：对话框关闭，仍在网页页。
5. 打开任一菜单（会话「…」或右键菜单）→ 返回：菜单关闭。
6. 打开右侧栏（手机全屏）→ 返回：右栏关闭。
7. 输入框输入 `@` 或 `/` 出现候选面板 → 返回：候选关闭。
8. 无任何浮层时按返回：先网页历史，再回主机列表，再退出应用。
9. 平板/折叠屏测试（若设备可用）：停靠侧栏不被返回收起。
10. 点顶栏刷新图标：页面重新加载；「更多」菜单里没有「刷新」。
11. 顶栏返回箭头行为保持原样。

### 11.3 构建与静态检查

- `.\gradlew.bat testDebugUnitTest --tests "com.fshake.dshremote.WebBackTest"`（单文件，非全量）
- `.\gradlew.bat assembleDebug`
- `.\gradlew.bat assembleRelease`

### 11.4 真机手工清单（写进 README）

见 11.2 的 1~11 条。

## 12. 风险

- **宿主版本差异**：选择器来自 DSH 0.2.2；更老的宿主没有这些标记，脚本返回 `none`，行为退回现状，无回归但也不修好。
- **Escape 的副作用**：如果页面在浮层之外还监听了 `Escape`（例如取消内联编辑），派发事件可能顺带触发；但目前只在检测到浮层时才派发，影响面限制在浮层存在时。
- **`enableEdgeToEdge()` 重复调用**：Activity 1.9.3 的实现是幂等地设置窗口装饰；风险低，仍需真机确认导航栏不闪。
- **对话框拒绝关闭**：仍消费返回，表现为「按了没反应」；这是有意为之，避免在模态上继续导航。
- **浮动面板收回停靠**：这是已确认的语义（Q8）；收回后标签仍在右栏里，不会被销毁。

## 附：已确定的追问结论

| 编号 | 问题 | 结论 |
|---|---|---|
| Q1 | 返回键关哪些浮层 | 所有非停靠的侧栏、悬浮窗、对话框、Popup 等 |
| Q2 | 顶栏返回箭头是否统一 | B：不统一，箭头仍只做网页回退 |
| Q3 | 菜单里的「刷新」项 | A：删掉，只留顶栏图标 |
| Q4 | 导航栏图标 | A：与状态栏一起修 |
| Q5 | 页面内模态框 | 并入 Q1 的「对话框」，要关 |
| Q6 | 真机验证方式 | 无线调试已开，Android 15 设备已连接，由我跑 adb 验证 |
| Q7 | tooltip / toast 是否纳入 | A：不纳入，只处理需要主动关闭的浮层 |
| Q8 | 浮动面板返回语义 | A：收回停靠，保留标签页内容 |

## 附：未决问题

无。所有决策已闭环。

## 13. 实施与验证记录（2026-11-08）

- 计划项 8/8 完成；改动 10 个文件（7 改、3 新增），计划文件不计入。
- 单元测试：`WebBackTest`（6 条）+ `WebCompatScriptTest`（4 条），`testDebugUnitTest` 通过。
- 构建：`assembleDebug` 与 `assembleRelease` 均成功；release APK 11,890,646 字节；手机安装为 1.0.38（versionCode 39）。
- 真机：Android 15 真机（无线 adb）。
  - 主题：浅→深→浅 切换时状态栏图标依次为 深→白→深（截图确认）；导航栏为手势条。
  - 返回键：左抽屉、菜单、菜单叠抽屉、对话框、全屏右栏均只关最上层；诊断日志逐条对应
    `[back] overlay=drawer|menu|menu|drawer|dialog|drawer|right`。
  - 无浮层：返回退回主机列表（未退出应用）。
  - 刷新：点击后页面重载；「更多」菜单中已无「刷新」。
- 未在真机复现：dock 浮窗（float）、输入候选面板（listbox）、平板停靠侧栏的「返回不收起」
  （当前平板 ≥768dp 无抽屉，条件未构造）。脚本已按官方标记实现并由契约测试守卫。
- 设备设置已恢复：`cmd uimode night auto`，自动旋转开启。
