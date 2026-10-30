package com.fshake.dshremote.core

import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * 会话有效期解析。
 *
 * 网关下发的 dsh_auth 值是 v1.<过期秒>.<签名>，过期时间可直接读出；
 * 读不到时退回 Set-Cookie 的 Max-Age，再退回 Expires。三者都没有就记 0（未知），
 * 应用不假设固定天数 —— 两台主机的服务端配置未必相同。
 */
object CookieExpiry {

    fun fromSetCookie(setCookie: String, nowMillis: Long): Long {
        val segments = setCookie.split(';')
        val first = segments.firstOrNull()?.trim().orEmpty()
        val eq = first.indexOf('=')
        if (eq <= 0) return 0L
        val name = first.substring(0, eq).trim()
        val value = first.substring(eq + 1).trim()
        val attributes = segments.drop(1)

        fromCookieValue(name, value)?.let { return it }

        var maxAge: Long? = null
        var expires: Long? = null
        for (attribute in attributes) {
            val trimmed = attribute.trim()
            val index = trimmed.indexOf('=')
            if (index <= 0) continue
            val key = trimmed.substring(0, index).trim().lowercase()
            val raw = trimmed.substring(index + 1).trim()
            when (key) {
                "max-age" -> raw.toLongOrNull()?.let { maxAge = nowMillis + it * 1000L }
                "expires" -> parseExpires(raw)?.let { expires = it }
            }
        }
        return maxAge ?: expires ?: 0L
    }

    /** 仅当 cookie 名是网关会话且值形如 v1.<exp>.<sig> 时才解析。 */
    fun fromCookieValue(name: String, value: String): Long? {
        if (name != SESSION_COOKIE) return null
        if (!value.startsWith("v1.")) return null
        val parts = value.split('.')
        if (parts.size != 3) return null
        val exp = parts[1].toLongOrNull() ?: return null
        if (exp <= 0) return null
        return exp * 1000L
    }

    private fun parseExpires(raw: String): Long? = try {
        val format = SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US)
        format.timeZone = TimeZone.getTimeZone("GMT")
        format.parse(raw)?.time
    } catch (_: Exception) {
        null
    }

    const val SESSION_COOKIE = "dsh_auth"
}
