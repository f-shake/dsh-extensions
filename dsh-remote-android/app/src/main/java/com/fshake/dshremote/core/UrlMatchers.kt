package com.fshake.dshremote.core

import java.net.URI

/** 与 URL 判定相关的纯函数，便于单测覆盖跳转分支。 */
object UrlMatchers {

    fun pathOf(url: String): String? = try {
        URI(url).path
    } catch (_: Exception) {
        null
    }

    /** 网关登录页：nginx 在未认证时 302 到这里，命中即视为需要重新登录。 */
    fun isLoginPage(url: String): Boolean {
        val path = pathOf(url) ?: return false
        // 服务端给的是绝对路径，但也兼容不带前导斜杠的相对形式，免得失败被当成成功
        val trimmed = path.trimEnd('/')
        return trimmed.equals("/login.html", ignoreCase = true) ||
            trimmed.equals("login.html", ignoreCase = true)
    }

    /** 取出 URL 的主机名（不含端口与协议），取不到返回 null。 */
    fun hostOf(url: String): String? = try {
        URI(url).host
    } catch (_: Exception) {
        null
    }

    fun isSameHost(url: String, host: String): Boolean {
        val parsed = try {
            URI(url)
        } catch (_: Exception) {
            return false
        }
        return parsed.host?.equals(host, ignoreCase = true) == true
    }

    fun isHttpScheme(url: String): Boolean = try {
        URI(url).scheme?.lowercase() in setOf("http", "https")
    } catch (_: Exception) {
        false
    }

    /** 把响应里的 Location 解析成绝对地址；相对地址按 baseUrl 归属。 */
    fun absolute(candidate: String, baseUrl: String): String {
        val parsed = try {
            URI(candidate)
        } catch (_: Exception) {
            return candidate
        }
        if (parsed.isAbsolute) return candidate
        return try {
            URI(baseUrl).resolve(candidate).toString()
        } catch (_: Exception) {
            candidate
        }
    }
}
