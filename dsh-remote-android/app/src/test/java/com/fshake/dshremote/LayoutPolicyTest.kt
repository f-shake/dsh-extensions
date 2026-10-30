package com.fshake.dshremote

import com.fshake.dshremote.core.LayoutPolicy
import org.junit.Assert.assertEquals
import org.junit.Test

class LayoutPolicyTest {

    @Test
    fun `手机宽度单列`() {
        assertEquals(1, LayoutPolicy.hostListColumns(411))
        assertEquals(1, LayoutPolicy.hostListColumns(599))
    }

    @Test
    fun `达到断点后双列`() {
        assertEquals(2, LayoutPolicy.hostListColumns(600))
        assertEquals(2, LayoutPolicy.hostListColumns(1024))
    }

    @Test
    fun `列表内容宽度限到 840`() {
        assertEquals(411, LayoutPolicy.listContentWidth(411))
        assertEquals(840, LayoutPolicy.listContentWidth(1024))
    }

    @Test
    fun `表单内容宽度限到 480`() {
        assertEquals(360, LayoutPolicy.formContentWidth(360))
        assertEquals(480, LayoutPolicy.formContentWidth(800))
    }
}
