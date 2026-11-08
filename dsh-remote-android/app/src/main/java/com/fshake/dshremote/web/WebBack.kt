package com.fshake.dshremote.web

/**
 * 返回键与页面脚本之间的约定。
 *
 * 脚本回传关掉的浮层名（menu / listbox / dialog / drawer / float / right），
 * 没有浮层时为 none。evaluateJavascript 会把 JS 字符串序列化成带引号的 JSON
 * 文本，所以这里先去掉引号再判断；空值、异常文本、未知层名一律当作没有浮层。
 */
object WebBack {

    const val NONE = "none"

    /** 脚本能回报的层名；测试用它对齐脚本里的 return 字面量。 */
    internal val names: Set<String> = setOf("menu", "listbox", "dialog", "drawer", "float", "right")

    /** 这次返回是否被页面里的浮层消费掉。 */
    fun overlayDismissed(raw: String?): Boolean = overlayName(raw) != NONE

    /** 取脚本回报的层名；无法识别时回退到 [NONE]，只用于判断与诊断。 */
    fun overlayName(raw: String?): String {
        val value = raw?.trim()?.trim('"')?.trim().orEmpty()
        return if (value in names) value else NONE
    }
}
