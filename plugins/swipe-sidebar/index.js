/**
 * swipe-sidebar 的宿主半边。
 *
 * 全部行为都在浏览器里：client.js 在窄屏抽屉模式下监听触摸手势，左滑/右滑
 * 调官方的 `ctx.layout.toggleSidebar()` 与右侧栏自己的开关按钮。这里不碰模型
 * 请求，也不碰任何 Host Service，所以整行是空实现。
 *
 * 为什么不直接启用旧的 mobile-fit：它的 CSS 会在 1024 以下自己画一套抽屉，
 * 而 0.2.2 的官方布局在 768 以下已经原生画抽屉了，两套叠在一起会打架。
 * 这个插件只拿走"手势"这一件官方没有的东西。
 */
export function apply() {}
