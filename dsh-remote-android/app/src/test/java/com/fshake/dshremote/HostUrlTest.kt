package com.fshake.dshremote

import com.fshake.dshremote.core.HostUrl
import com.fshake.dshremote.core.HostUrlResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HostUrlTest {

    private fun ok(raw: String): HostUrlResult.Ok {
        val result = HostUrl.parse(raw)
        assertTrue("期望解析成功：$raw，实际为 $result", result is HostUrlResult.Ok)
        return result as HostUrlResult.Ok
    }

    private fun err(raw: String): String {
        val result = HostUrl.parse(raw)
        assertTrue("期望解析失败：$raw，实际为 $result", result is HostUrlResult.Error)
        return (result as HostUrlResult.Error).message
    }

    @Test
    fun `缺少协议时补成 https`() {
        assertEquals("https://dsn.example.com", ok("dsn.example.com").normalized)
    }

    @Test
    fun `末尾斜杠被忽略且不产生提示`() {
        val parsed = ok("https://dsn.example.com/")
        assertEquals("https://dsn.example.com", parsed.normalized)
        assertNull(parsed.note)
    }

    @Test
    fun `主机名统一小写`() {
        assertEquals("https://dw.example.com", ok("HTTPS://DW.Example.COM").normalized)
    }

    @Test
    fun `非默认端口保留`() {
        assertEquals("https://dsn.example.com:8443", ok("https://dsn.example.com:8443").normalized)
    }

    @Test
    fun `显式 443 端口被省略`() {
        assertEquals("https://dsn.example.com", ok("https://dsn.example.com:443").normalized)
    }

    @Test
    fun `中文域名转 punycode`() {
        assertTrue(ok("https://例子.测试").normalized.startsWith("https://xn--"))
    }

    @Test
    fun `带路径时归一化并提示`() {
        val parsed = ok("https://dsn.example.com/some/page")
        assertEquals("https://dsn.example.com", parsed.normalized)
        assertEquals("已按主机地址保存，路径部分被忽略", parsed.note)
    }

    @Test
    fun `拒绝 http`() {
        assertEquals("只支持 https 地址", err("http://dsn.example.com"))
    }

    @Test
    fun `拒绝空输入`() {
        assertEquals("请输入主机地址", err("   "))
    }

    @Test
    fun `拒绝带用户名密码的地址`() {
        assertEquals("地址不能包含用户名或密码", err("https://user:pass@dsn.example.com"))
    }

    @Test
    fun `拒绝越界端口`() {
        assertEquals("端口号超出范围", err("https://dsn.example.com:70000"))
    }

    @Test
    fun `拒绝非数字端口`() {
        assertEquals("端口号不正确", err("https://dsn.example.com:abc"))
    }

    @Test
    fun `拒绝超长标签`() {
        val longLabel = "a".repeat(64)
        assertEquals("主机名不合法", err("https://$longLabel.com"))
    }

    @Test
    fun `拒绝非法字符`() {
        assertEquals("主机名不合法", err("https://bad_host.example.com"))
    }

    @Test
    fun `拒绝空主机名`() {
        assertEquals("地址缺少主机名", err("https://"))
    }
}
