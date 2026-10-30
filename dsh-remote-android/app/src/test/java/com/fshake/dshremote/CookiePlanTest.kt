package com.fshake.dshremote

import com.fshake.dshremote.auth.CookiePlan
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CookiePlanTest {

    @Test
    fun `解析 name 与 value`() {
        val pair = CookiePlan.splitSetCookie("dsh_auth=v1.123.sig; Path=/; HttpOnly")
        assertEquals("dsh_auth", pair?.first)
        assertEquals("v1.123.sig", pair?.second)
    }

    @Test
    fun `空串或没有等号时返回 null`() {
        assertNull(CookiePlan.splitSetCookie(""))
        assertNull(CookiePlan.splitSetCookie("no-equals-sign"))
        assertNull(CookiePlan.splitSetCookie("=value"))
    }

    @Test
    fun `注入头只保留 name value 并补齐路径与安全标记`() {
        val header = CookiePlan.injectionHeader("dsh_auth=v1.1.sig; Path=/; HttpOnly; Secure; SameSite=Lax")
        assertEquals("dsh_auth=v1.1.sig; Path=/; Secure", header)
    }

    @Test
    fun `注入头保留服务端的 Max-Age`() {
        val header = CookiePlan.injectionHeader(
            "dsh_auth=v1.1.sig; Path=/; HttpOnly; Secure; Max-Age=604800; SameSite=Lax",
        )
        assertEquals("dsh_auth=v1.1.sig; Path=/; Secure; Max-Age=604800", header)
    }

    @Test
    fun `没有 Max-Age 时保留 Expires`() {
        val header = CookiePlan.injectionHeader(
            "dsh_auth=v1.1.sig; Expires=Wed, 05 Nov 2026 10:00:00 GMT; Path=/; Secure",
        )
        assertEquals("dsh_auth=v1.1.sig; Path=/; Secure; Expires=Wed, 05 Nov 2026 10:00:00 GMT", header)
    }

    @Test
    fun `两者都有时优先 Max-Age`() {
        val header = CookiePlan.injectionHeader(
            "dsh_auth=v1.1.sig; Expires=Wed, 05 Nov 2026 10:00:00 GMT; Max-Age=60",
        )
        assertEquals("dsh_auth=v1.1.sig; Path=/; Secure; Max-Age=60", header)
    }

    @Test
    fun `清除头把值置空并立即过期`() {
        assertEquals("dsh_auth=; Path=/; Max-Age=0", CookiePlan.clearHeader("dsh_auth"))
    }

    @Test
    fun `从 Cookie 头里取出所有名字`() {
        val names = CookiePlan.cookieNames("dsh_auth=v1; other=2;  spaced = 3")
        assertEquals(listOf("dsh_auth", "other", "spaced"), names)
    }

    @Test
    fun `空 Cookie 头不产生名字`() {
        assertEquals(emptyList<String>(), CookiePlan.cookieNames(""))
    }
}
