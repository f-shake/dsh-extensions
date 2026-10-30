package com.fshake.dshremote.core

import java.net.IDN

/** 归一化后的主机地址：只保留 https 的 origin。 */
data class HostOrigin(val host: String, val port: Int = 443) {
    val isDefaultPort: Boolean get() = port == 443
    val authority: String get() = if (isDefaultPort) host else "$host:$port"
    val baseUrl: String get() = "https://$authority"
}

sealed interface HostUrlResult {
    data class Ok(val origin: HostOrigin, val normalized: String, val note: String?) : HostUrlResult
    data class Error(val message: String) : HostUrlResult
}

/**
 * 地址解析与归一化。
 *
 * 只接受 https：两台主机都是公网 HTTPS 部署，放开 http 只会给中间人留门。
 * 输入的路径与查询会被丢弃，归一化结果只保留 origin —— 应用只需要一个入口地址。
 */
object HostUrl {

    fun parse(raw: String): HostUrlResult {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return HostUrlResult.Error("请输入主机地址")
        val text = if (trimmed.contains("://")) trimmed else "https://$trimmed"

        val schemeEnd = text.indexOf("://")
        val scheme = text.substring(0, schemeEnd).lowercase()
        if (scheme != "https") return HostUrlResult.Error("只支持 https 地址")

        val rest = text.substring(schemeEnd + 3)
        if (rest.contains('@')) return HostUrlResult.Error("地址不能包含用户名或密码")

        val authority = rest.substringBefore('/').substringBefore('?').substringBefore('#')
        if (authority.isEmpty()) return HostUrlResult.Error("地址缺少主机名")

        val (rawHost, rawPort) = splitAuthority(authority)
            ?: return HostUrlResult.Error("地址格式不正确")

        val port = if (rawPort == null) 443 else rawPort.toIntOrNull()
            ?: return HostUrlResult.Error("端口号不正确")
        if (port !in 1..65535) return HostUrlResult.Error("端口号超出范围")

        val host = normalizeHost(rawHost) ?: return HostUrlResult.Error("主机名不合法")
        if (host.length > 253) return HostUrlResult.Error("主机名过长")

        val path = rest.substring(authority.length).substringBefore('?').substringBefore('#')
        val note = if (path.isNotEmpty() && path != "/") "已按主机地址保存，路径部分被忽略" else null

        val origin = HostOrigin(host, port)
        return HostUrlResult.Ok(origin, origin.baseUrl, note)
    }

    private fun splitAuthority(authority: String): Pair<String, String?>? {
        if (authority.startsWith("[")) {
            val close = authority.indexOf(']')
            if (close < 0) return null
            val host = authority.substring(0, close + 1)
            val tail = authority.substring(close + 1)
            return when {
                tail.isEmpty() -> host to null
                tail.startsWith(":") -> host to tail.substring(1)
                else -> null
            }
        }
        val colon = authority.lastIndexOf(':')
        if (colon < 0) return authority to null
        return authority.substring(0, colon) to authority.substring(colon + 1)
    }

    private fun normalizeHost(rawHost: String): String? {
        if (rawHost.isEmpty()) return null
        if (rawHost.startsWith("[")) {
            val inner = rawHost.removePrefix("[").removeSuffix("]")
            if (inner.isEmpty() || !inner.all { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' || it == ':' || it == '.' }) {
                return null
            }
            return rawHost.lowercase()
        }
        val ascii = try {
            IDN.toASCII(rawHost).lowercase()
        } catch (_: IllegalArgumentException) {
            return null
        }
        if (ascii.isEmpty()) return null
        for (label in ascii.split('.')) {
            if (label.isEmpty() || label.length > 63) return null
            if (label.startsWith('-') || label.endsWith('-')) return null
            if (!label.all { it in 'a'..'z' || it in '0'..'9' || it == '-' }) return null
        }
        return ascii
    }
}
