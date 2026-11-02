/**
 * header-compact 的宿主半边。
 *
 * 全部行为都在浏览器里：client.js 在手机宽度下把会话标题行的子智能体与后台任务
 * 计数文案换短，并隐藏桌面端才用得上的「在本地打开」。这里不碰模型请求，也不碰
 * 任何 Host Service，所以整行是空实现。
 */
export function apply() {}
