package com.fshake.dshremote.core

/** 大屏布局的取值规则。抽成纯函数，便于按宽度直接断言。 */
object LayoutPolicy {

    const val WIDE_BREAKPOINT_DP = 600
    const val MAX_LIST_WIDTH_DP = 840
    const val MAX_FORM_WIDTH_DP = 480

    fun hostListColumns(widthDp: Int): Int = if (widthDp >= WIDE_BREAKPOINT_DP) 2 else 1

    fun listContentWidth(widthDp: Int): Int = widthDp.coerceAtMost(MAX_LIST_WIDTH_DP)

    fun formContentWidth(widthDp: Int): Int = widthDp.coerceAtMost(MAX_FORM_WIDTH_DP)
}
