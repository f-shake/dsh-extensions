package com.fshake.dshremote

import com.fshake.dshremote.auth.AuthOutcome
import com.fshake.dshremote.auth.LoginClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class LoginClientTest {

    private lateinit var server: MockWebServer
    private val fixedNow = 1_800_000_000_000L
    private val expiresSeconds = fixedNow / 1000 + 604_800

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private val baseUrl: String get() = server.url("/").toString().trimEnd('/')

    private fun client(): LoginClient = LoginClient(now = { fixedNow })

    @Test
    fun `成功时返回下一跳地址与到期时间`() {
        server.enqueue(
            MockResponse()
                .setResponseCode(302)
                .addHeader("Location", "/?token=abc123")
                .addHeader("Set-Cookie", "dsh_auth=v1.$expiresSeconds.sig; Path=/; HttpOnly; Secure"),
        )

        val outcome = client().login(baseUrl, "pass", "123456")

        assertTrue("期望成功，实际 $outcome", outcome is AuthOutcome.Success)
        val success = outcome as AuthOutcome.Success
        assertEquals("$baseUrl/?token=abc123", success.nextUrl)
        assertEquals(1, success.cookies.size)
        assertEquals(expiresSeconds * 1000, success.sessionExpiresAt)
    }

    @Test
    fun `成功后请求体包含密码与验证码`() {
        server.enqueue(
            MockResponse()
                .setResponseCode(302)
                .addHeader("Location", "/?token=abc123")
                .addHeader("Set-Cookie", "dsh_auth=v1.$expiresSeconds.sig"),
        )

        client().login(baseUrl, "pass", "123456")
        val recorded = server.takeRequest()

        assertEquals("/_app_login", recorded.path)
        val body = recorded.body.readUtf8()
        assertTrue("请求体应包含密码：$body", body.contains("password=pass"))
        assertTrue("请求体应包含验证码：$body", body.contains("code=123456"))
    }

    @Test
    fun `成功但没有 token 时下一跳是首页`() {
        server.enqueue(
            MockResponse()
                .setResponseCode(302)
                .addHeader("Location", "/")
                .addHeader("Set-Cookie", "dsh-auth-deadbeef=v1.body.sig; Path=/")
                .addHeader("Set-Cookie", "dsh_auth=v1.$expiresSeconds.sig; Path=/"),
        )

        val outcome = client().login(baseUrl, "pass", "123456") as AuthOutcome.Success

        assertEquals("$baseUrl/", outcome.nextUrl)
        assertEquals(2, outcome.cookies.size)
    }

    @Test
    fun `重定向到登录页表示凭据错误`() {
        server.enqueue(
            MockResponse()
                .setResponseCode(302)
                .addHeader("Location", "/login.html?e=bad"),
        )

        assertEquals(AuthOutcome.InvalidCredentials, client().login(baseUrl, "pass", "123456"))
    }

    @Test
    fun `重定向到登录页的 replay 参数同样算凭据错误`() {
        server.enqueue(
            MockResponse()
                .setResponseCode(302)
                .addHeader("Location", "/login.html?e=replay"),
        )

        assertEquals(AuthOutcome.InvalidCredentials, client().login(baseUrl, "pass", "123456"))
    }

    @Test
    fun `429 表示提交过于频繁`() {
        server.enqueue(MockResponse().setResponseCode(429))

        assertEquals(AuthOutcome.RateLimited, client().login(baseUrl, "pass", "123456"))
    }

    @Test
    fun `5xx 归为服务端错误`() {
        server.enqueue(MockResponse().setResponseCode(502))

        assertEquals(AuthOutcome.ServerError(502), client().login(baseUrl, "pass", "123456"))
    }

    @Test
    fun `200 属于非预期状态`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("ok"))

        assertEquals(AuthOutcome.UnexpectedStatus(200), client().login(baseUrl, "pass", "123456"))
    }

    @Test
    fun `302 缺少 Location 属于非预期状态`() {
        server.enqueue(MockResponse().setResponseCode(302))

        assertEquals(AuthOutcome.UnexpectedStatus(302), client().login(baseUrl, "pass", "123456"))
    }

    @Test
    fun `连接失败归为网络错误`() {
        server.shutdown()

        val outcome = client().login("http://127.0.0.1:1", "pass", "123456")

        assertTrue("期望网络错误，实际 $outcome", outcome is AuthOutcome.NetworkError)
    }
}
