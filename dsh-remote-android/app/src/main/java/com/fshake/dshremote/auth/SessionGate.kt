package com.fshake.dshremote.auth

import com.fshake.dshremote.data.HostEntry

enum class LoginReason { FIRST_TIME, EXPIRED }

sealed interface StartDecision {
    data object OpenWeb : StartDecision
    data class NeedLogin(val reason: LoginReason) : StartDecision
}

/**
 * 进入某台主机时的路由判定。
 *
 * 本地只知道会话的到期时间，不知道服务端是否提前吊销；所以即使判定可以直接进 Web，
 * 仍保留 WebView 撞到 /login.html 时回退登录页的通道。
 */
object SessionGate {

    const val EXPIRY_SKEW_MS = 60_000L

    fun decide(host: HostEntry, now: Long): StartDecision {
        if (host.sessionExpiresAt > now + EXPIRY_SKEW_MS) return StartDecision.OpenWeb
        // 只有曾经拿到过会话、后来失效了才叫“过期”；从没登录过的是“需要登录”
        val reason = if (host.sessionExpiresAt > 0L) LoginReason.EXPIRED else LoginReason.FIRST_TIME
        return StartDecision.NeedLogin(reason)
    }
}
