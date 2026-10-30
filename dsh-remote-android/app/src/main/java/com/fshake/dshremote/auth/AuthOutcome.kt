package com.fshake.dshremote.auth

/** 登录请求的归类结果。成功时带上下一跳地址、原始 Set-Cookie 与会话到期时间。 */
sealed interface AuthOutcome {
    data class Success(
        val nextUrl: String,
        val cookies: List<String>,
        val sessionExpiresAt: Long,
    ) : AuthOutcome

    data object InvalidCredentials : AuthOutcome

    data object RateLimited : AuthOutcome

    data class ServerError(val status: Int) : AuthOutcome

    data class UnexpectedStatus(val status: Int) : AuthOutcome

    data class NetworkError(val reason: String) : AuthOutcome
}
