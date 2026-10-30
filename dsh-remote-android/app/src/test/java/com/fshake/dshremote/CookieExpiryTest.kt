package com.fshake.dshremote

import com.fshake.dshremote.core.CookieExpiry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CookieExpiryTest {

    private val now = 1_800_000_000_000L
    private val expiresSeconds = now / 1000 + 604_800

    @Test
    fun `dsh_auth 的 v1 值直接给出到期时间`() {
        val line = "dsh_auth=v1.$expiresSeconds.signature; Path=/; HttpOnly; Secure; SameSite=Lax"
        assertEquals(expiresSeconds * 1000, CookieExpiry.fromSetCookie(line, now))
    }

    @Test
    fun `没有 v1 值时用 Max-Age`() {
        val line = "dsh_auth=other; Path=/; Max-Age=3600"
        assertEquals(now + 3_600_000, CookieExpiry.fromSetCookie(line, now))
    }

    @Test
    fun `没有 Max-Age 时用 Expires`() {
        val line = "dsh_auth=other; Path=/; Expires=Wed, 01 Jan 2025 00:00:00 GMT"
        val expected = CookieExpiry.fromSetCookie(line, now)
        assertEquals(1_735_689_600_000L, expected)
    }

    @Test
    fun `既没有 v1 也没有属性时返回 0`() {
        assertEquals(0L, CookieExpiry.fromSetCookie("dsh_auth=plain", now))
    }

    @Test
    fun `格式错误的 v1 值回落 Max-Age`() {
        val line = "dsh_auth=v1.abc.signature; Max-Age=60"
        assertEquals(now + 60_000, CookieExpiry.fromSetCookie(line, now))
    }

    @Test
    fun `非网关会话的 cookie 不按 v1 解析`() {
        assertNull(CookieExpiry.fromCookieValue("dsh-auth-deadbeef", "v1.$expiresSeconds.sig"))
    }

    @Test
    fun `空串不抛异常`() {
        assertEquals(0L, CookieExpiry.fromSetCookie("", now))
    }
}
