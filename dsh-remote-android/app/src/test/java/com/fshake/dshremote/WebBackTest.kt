package com.fshake.dshremote

import com.fshake.dshremote.web.WebBack
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebBackTest {

    @Test
    fun `页面回报的浮层名都算消费了返回`() {
        WebBack.names.forEach { kind ->
            assertTrue(kind, WebBack.overlayDismissed("\"$kind\""))
            assertEquals(kind, WebBack.overlayName("\"$kind\""))
        }
    }

    @Test
    fun `层名表不包含无浮层的兜底值`() {
        assertFalse(WebBack.NONE in WebBack.names)
        assertTrue(WebBack.names.isNotEmpty())
    }

    @Test
    fun `没有浮层时不消费返回`() {
        assertFalse(WebBack.overlayDismissed("\"none\""))
        assertEquals(WebBack.NONE, WebBack.overlayName("\"none\""))
    }

    @Test
    fun `页面没建好或脚本异常时按没有浮层处理`() {
        assertFalse(WebBack.overlayDismissed(null))
        assertFalse(WebBack.overlayDismissed(""))
        assertFalse(WebBack.overlayDismissed("null"))
        assertFalse(WebBack.overlayDismissed("undefined"))
        assertFalse(WebBack.overlayDismissed("ReferenceError: document is not defined"))
        assertEquals(WebBack.NONE, WebBack.overlayName(null))
    }

    @Test
    fun `未知层名不会被误当成已关闭`() {
        assertFalse(WebBack.overlayDismissed("\"toast\""))
        assertFalse(WebBack.overlayDismissed("{}"))
        assertEquals(WebBack.NONE, WebBack.overlayName("\"toast\""))
    }

    @Test
    fun `带空白或未加引号的回报也能识别`() {
        assertTrue(WebBack.overlayDismissed("  \"menu\"  "))
        assertEquals("menu", WebBack.overlayName("menu"))
    }
}
