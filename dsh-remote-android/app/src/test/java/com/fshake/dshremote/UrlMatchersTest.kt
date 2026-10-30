package com.fshake.dshremote

import com.fshake.dshremote.core.UrlMatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UrlMatchersTest {

    @Test
    fun `登录页绝对地址被识别`() {
        assertTrue(UrlMatchers.isLoginPage("https://dsn.example.com/login.html"))
    }

    @Test
    fun `登录页带查询参数被识别`() {
        assertTrue(UrlMatchers.isLoginPage("https://dsn.example.com/login.html?e=bad"))
    }

    @Test
    fun `登录页带锚点被识别`() {
        assertTrue(UrlMatchers.isLoginPage("https://dsn.example.com/login.html#top"))
    }

    @Test
    fun `相对地址的登录页被识别`() {
        assertTrue(UrlMatchers.isLoginPage("/login.html?e=replay"))
    }

    @Test
    fun `不带前导斜杠的登录页也被识别`() {
        assertTrue(UrlMatchers.isLoginPage("login.html?e=bad"))
    }

    @Test
    fun `首页不被误判为登录页`() {
        assertFalse(UrlMatchers.isLoginPage("https://dsn.example.com/"))
        assertFalse(UrlMatchers.isLoginPage("https://dsn.example.com/index.html"))
        assertFalse(UrlMatchers.isLoginPage("https://dsn.example.com/session/login.html"))
    }

    @Test
    fun `带端口的主机只取主机名`() {
        assertEquals("dsn.example.com", UrlMatchers.hostOf("https://dsn.example.com:8443/session"))
        assertEquals("dsn.example.com", UrlMatchers.hostOf("https://dsn.example.com"))
        assertEquals(null, UrlMatchers.hostOf("not a url"))
    }

    @Test
    fun `同主机判定不受端口影响`() {
        assertTrue(UrlMatchers.isSameHost("https://dsn.example.com:8443/session", "dsn.example.com"))
    }

    @Test
    fun `同主机判定忽略大小写`() {
        assertTrue(UrlMatchers.isSameHost("https://DSN.example.com/session", "dsn.example.com"))
        assertFalse(UrlMatchers.isSameHost("https://dw.example.com/", "dsn.example.com"))
    }

    @Test
    fun `协议判定只认 http 与 https`() {
        assertTrue(UrlMatchers.isHttpScheme("https://a.com"))
        assertTrue(UrlMatchers.isHttpScheme("http://a.com"))
        assertFalse(UrlMatchers.isHttpScheme("mailto:someone@example.com"))
        assertFalse(UrlMatchers.isHttpScheme("javascript:void(0)"))
    }

    @Test
    fun `相对重定向解析成绝对地址`() {
        assertEquals(
            "https://dsn.example.com/?token=abc",
            UrlMatchers.absolute("/?token=abc", "https://dsn.example.com"),
        )
    }

    @Test
    fun `绝对重定向原样保留`() {
        assertEquals(
            "https://dsn.example.com/?token=abc",
            UrlMatchers.absolute("https://dsn.example.com/?token=abc", "https://dsn.example.com"),
        )
    }
}
