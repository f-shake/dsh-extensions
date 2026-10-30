package com.fshake.dshremote.auth

import android.webkit.CookieManager
import com.fshake.dshremote.core.CookieExpiry

/** Set-Cookie 与 CookieManager 之间的纯转换，便于单测。 */
object CookiePlan {

    fun splitSetCookie(line: String): Pair<String, String>? {
        val first = line.substringBefore(';').trim()
        val eq = first.indexOf('=')
        if (eq <= 0) return null
        val name = first.substring(0, eq).trim()
        val value = first.substring(eq + 1).trim()
        if (name.isEmpty()) return null
        return name to value
    }

    /**
     * 注入用的 cookie 值。
     *
     * 只保留 name=value，属性统一补 Path=/; Secure：WebView 的 CookieManager 不认 SameSite，
     * 而服务端下发的 HttpOnly 属性在这里也无需复现，只要值正确即可通过网关校验。
     * 但有效期必须带上——服务端给的是 7 天，丢了它就变成会话 cookie，进程一退就没了，
     * 本地记的到期时间却还是 7 天，重进时直接撞到登录页。
     */
    fun injectionHeader(line: String): String? {
        val (name, value) = splitSetCookie(line) ?: return null
        return "$name=$value; Path=/; Secure" + lifetimeAttribute(line)
    }

    /** 取 Max-Age（优先）或 Expires，原样保留；两者都没有就不带。 */
    private fun lifetimeAttribute(line: String): String {
        var maxAge: String? = null
        var expires: String? = null
        for (attribute in line.split(';').drop(1)) {
            val trimmed = attribute.trim()
            val index = trimmed.indexOf('=')
            if (index <= 0) continue
            val key = trimmed.substring(0, index).trim().lowercase()
            val raw = trimmed.substring(index + 1).trim()
            if (raw.isEmpty()) continue
            when (key) {
                "max-age" -> if (maxAge == null && raw.toLongOrNull() != null) maxAge = raw
                "expires" -> if (expires == null) expires = raw
            }
        }
        return when {
            maxAge != null -> "; Max-Age=$maxAge"
            expires != null -> "; Expires=$expires"
            else -> ""
        }
    }

    fun clearHeader(name: String): String = "$name=; Path=/; Max-Age=0"

    fun cookieNames(cookieHeader: String): List<String> = cookieHeader
        .split(';')
        .map { it.substringBefore('=').trim() }
        .filter { it.isNotEmpty() }
}

interface CookieInjector {
    fun inject(baseUrl: String, setCookies: List<String>)
}

class CookieBridge(
    private val manager: CookieManager = CookieManager.getInstance(),
) : CookieInjector {

    override fun inject(baseUrl: String, setCookies: List<String>) {
        setCookies.forEach { line ->
            CookiePlan.injectionHeader(line)?.let { manager.setCookie(baseUrl, it) }
        }
        manager.flush()
    }

    /** 退出登录：清掉该主机域下的会话 cookie，其它主机不受影响。 */
    fun clear(baseUrl: String) {
        val names = CookiePlan.cookieNames(manager.getCookie(baseUrl).orEmpty()).toMutableSet()
        names += CookieExpiry.SESSION_COOKIE
        names.forEach { manager.setCookie(baseUrl, CookiePlan.clearHeader(it)) }
        manager.flush()
    }
}
