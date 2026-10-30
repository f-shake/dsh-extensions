package com.fshake.dshremote.auth

import com.fshake.dshremote.core.CookieExpiry
import com.fshake.dshremote.core.UrlMatchers
import okhttp3.FormBody
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.util.concurrent.TimeUnit

/** 登录能力的抽象，便于单测替换实现。 */
interface LoginGateway {
    fun login(baseUrl: String, password: String, code: String): AuthOutcome
}

/**
 * 网关登录。
 *
 * 不跟随重定向：成功与失败都是 302，区别只在 Location —— 跟了就分不清了。
 * 成功时把 Location 换成绝对地址交给 WebView，让 DSH 在正确的 authority 下自行签发会话 cookie。
 */
class LoginClient(
    private val client: OkHttpClient = defaultClient(),
    private val now: () -> Long = System::currentTimeMillis,
) : LoginGateway {

    override fun login(baseUrl: String, password: String, code: String): AuthOutcome {
        val url = baseUrl.trimEnd('/') + LOGIN_PATH
        val body = FormBody.Builder()
            .add("password", password)
            .add("code", code)
            .build()
        val request = Request.Builder()
            .url(url)
            .header("User-Agent", USER_AGENT)
            .post(body)
            .build()

        return try {
            client.newCall(request).execute().use { response ->
                when (response.code) {
                    RATE_LIMITED -> AuthOutcome.RateLimited
                    in 300..399 -> onRedirect(baseUrl, response.header("Location"), response.headers.values("Set-Cookie"), response.code)
                    in 500..599 -> AuthOutcome.ServerError(response.code)
                    else -> AuthOutcome.UnexpectedStatus(response.code)
                }
            }
        } catch (error: IOException) {
            AuthOutcome.NetworkError(error.message ?: "网络异常")
        }
    }

    private fun onRedirect(baseUrl: String, location: String?, cookies: List<String>, status: Int): AuthOutcome {
        if (location.isNullOrBlank()) return AuthOutcome.UnexpectedStatus(status)
        if (UrlMatchers.isLoginPage(location)) return AuthOutcome.InvalidCredentials
        val expiresAt = cookies.map { CookieExpiry.fromSetCookie(it, now()) }.maxOrNull() ?: 0L
        return AuthOutcome.Success(
            nextUrl = UrlMatchers.absolute(location, baseUrl),
            cookies = cookies,
            sessionExpiresAt = expiresAt,
        )
    }

    companion object {
        const val LOGIN_PATH = "/_app_login"
        const val USER_AGENT = "DSHRemote/1.0 (Android)"
        private const val RATE_LIMITED = 429
        private const val TIMEOUT_SECONDS = 8L

        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .connectTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .readTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .writeTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .build()
    }
}
