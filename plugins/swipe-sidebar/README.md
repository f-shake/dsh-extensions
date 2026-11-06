# swipe-sidebar

窄屏抽屉的**滑动手势**。0.2.2 的官方布局在 768px 以下自带抽屉（遮罩、左上角开关、
`inert`、焦点与 Esc 都做了），但没有触摸手势：左滑右滑既打不开也关不掉侧边栏。
这个插件只补这一件，不碰任何布局 CSS。

## 手势

| 起手位置 | 滑动方向 | 结果 |
|---|---|---|
| 左半屏 | 向右 | 展开左侧栏（抽屉） |
| 右半屏 | 向左 | 展开右侧栏 |
| 任一侧开着 | 反向 | 收起 |

判定条件：位移 ≥ 56px、耗时 ≤ 900ms、横向位移占优（`|dy| ≤ 0.7·|dx|`）。
不抢手势：**有别的模态框开着时**（见下）、起手在输入区（`input`/`textarea`/`contenteditable`）、
起手在横向滚动容器（代码块、表格、横向列表）里。监听全部 `passive`，不阻断页面滚动。

模态框的判断要特别说明：官方窄屏抽屉**自己**就是 `aria-modal="true"`，所以不能简单地
「文档里有 aria-modal 就退出」，否则抽屉一开手势就永远收不起来。官方给抽屉打了
`data-shortcut-modal="sidebar"`，插件把它摘出去；其余任何 `aria-modal`（设置、快捷键、账号
面板等）都会让手势整体让位——**即使抽屉和弹窗同时开着**也不会穿透去收背后的抽屉。

## 为什么单独存在，而不是直接启用 mobile-fit

mobile-fit 的 CSS 在 1024px 以下自己画一套抽屉，而官方 0.2.2 在 768px 以下已经原生画了；
两套叠在一起会出现双重遮罩和列宽打架。手势本身没有官方替代，所以抽出来单独维护。

## 依赖的官方 DOM 契约

| 用途 | 选择器 |
|---|---|
| 判断是否抽屉模式 | `[data-sidebar-mask]`（抽屉模式下始终渲染） |
| 左抽屉是否打开 | 遮罩的父元素**没有** `data-sidebar-collapsed` |
| 左抽屉自己的模态标记 | `[aria-modal="true"]` + `data-shortcut-modal="sidebar"`（收起左抽屉时用它排除自身） |
| 右栏是否打开 | `[data-sidebar-right-panel][data-sidebar-right-open]` |
| 右栏开 / 关按钮 | `[data-sidebar-right-expand]` / `[data-sidebar-right-toggle]` |

左抽屉的开关走 `ctx.layout.toggleSidebar()`（官方自己也在用它）。

退化行为分两种，不是全都「安全失效」：

- **打开**左抽屉只依赖 `[data-sidebar-mask]` 与 `toggleSidebar()`，改名后手势不生效，页面不受影响；
- **收起**左抽屉还依赖上面那条 `aria-modal` + `data-shortcut-modal` 组合。若官方把这两个属性
  改名或拆分到不同元素，收起会**静默失效**（打开还在、滑不回去），届时查这张表即可。
