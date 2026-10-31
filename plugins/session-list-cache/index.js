/**
 * 会话列表缓存的宿主半边。
 *
 * 功能全在浏览器侧：`client.js` 包一层 `globalThis.fetch`，让 `session/list` 先用上次
 * 的结果返回、再后台回源更新缓存。这里不接触任何模型请求或宿主服务，所以是空实现。
 */
export function apply() {}
