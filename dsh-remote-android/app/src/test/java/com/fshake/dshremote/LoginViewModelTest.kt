package com.fshake.dshremote

import com.fshake.dshremote.auth.AuthOutcome
import com.fshake.dshremote.auth.CookieInjector
import com.fshake.dshremote.auth.LoginGateway
import com.fshake.dshremote.ui.login.LoginMessages
import com.fshake.dshremote.ui.login.LoginViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class LoginViewModelTest {

    private class FakeGateway(private val outcome: () -> AuthOutcome) : LoginGateway {
        val calls = mutableListOf<Triple<String, String, String>>()
        override fun login(baseUrl: String, password: String, code: String): AuthOutcome {
            calls += Triple(baseUrl, password, code)
            return outcome()
        }
    }

    private class FakeInjector : CookieInjector {
        val injected = mutableListOf<Pair<String, List<String>>>()
        override fun inject(baseUrl: String, setCookies: List<String>) {
            injected += baseUrl to setCookies
        }
    }

    private fun TestScope.viewModel(
        gateway: LoginGateway = FakeGateway { AuthOutcome.InvalidCredentials },
        injector: CookieInjector = FakeInjector(),
        initialPassword: String? = null,
        cooldown: Int = 60,
    ): LoginViewModel = LoginViewModel(
        baseUrl = "https://dsn.example.com",
        initialPassword = initialPassword,
        client = gateway,
        cookies = injector,
        scope = this,
        io = StandardTestDispatcher(testScheduler),
        cooldownSeconds = cooldown,
    )

    @Test
    fun `保存过的密码会被预填`() = runTest {
        val viewModel = viewModel(initialPassword = "saved-password")
        assertEquals("saved-password", viewModel.state.value.password)
    }

    @Test
    fun `验证码只保留数字且最多六位`() = runTest {
        val viewModel = viewModel()

        viewModel.onCodeChange("12ab34")
        assertEquals("1234", viewModel.state.value.code)

        viewModel.onCodeChange("1234567890")
        assertEquals("123456", viewModel.state.value.code)
    }

    @Test
    fun `密码或验证码不完整时不能提交`() = runTest {
        val viewModel = viewModel()

        assertFalse(viewModel.canSubmit())

        viewModel.onPasswordChange("pass")
        viewModel.onCodeChange("12345")
        assertFalse(viewModel.canSubmit())

        viewModel.onCodeChange("123456")
        assertTrue(viewModel.canSubmit())
    }

    @Test
    fun `成功后注入 cookie 并发出成功事件`() = runTest {
        val injector = FakeInjector()
        val outcome = AuthOutcome.Success(
            nextUrl = "https://dsn.example.com/?token=abc",
            cookies = listOf("dsh_auth=v1.1.sig"),
            sessionExpiresAt = 1234L,
        )
        val viewModel = viewModel(gateway = FakeGateway { outcome }, injector = injector)

        viewModel.onPasswordChange("pass")
        viewModel.onCodeChange("123456")
        viewModel.submit()
        runCurrent()

        assertEquals(listOf("https://dsn.example.com" to listOf("dsh_auth=v1.1.sig")), injector.injected)
        assertEquals(outcome, viewModel.success.value)
        assertFalse(viewModel.state.value.loading)
    }

    @Test
    fun `成功后消费事件可以清空`() = runTest {
        val viewModel = viewModel(
            gateway = FakeGateway { AuthOutcome.Success("/", emptyList(), 0L) },
        )
        viewModel.onPasswordChange("pass")
        viewModel.onCodeChange("123456")
        viewModel.submit()
        runCurrent()

        viewModel.consumeSuccess()
        assertNull(viewModel.success.value)
    }

    @Test
    fun `凭据错误时给出文案并清空验证码`() = runTest {
        val viewModel = viewModel(gateway = FakeGateway { AuthOutcome.InvalidCredentials })

        viewModel.onPasswordChange("pass")
        viewModel.onCodeChange("123456")
        viewModel.submit()
        runCurrent()

        assertEquals(LoginMessages.message(AuthOutcome.InvalidCredentials), viewModel.state.value.error)
        assertEquals("", viewModel.state.value.code)
        assertEquals("pass", viewModel.state.value.password)
    }

    @Test
    fun `网络错误时给出对应文案`() = runTest {
        val viewModel = viewModel(gateway = FakeGateway { AuthOutcome.NetworkError("timeout") })

        viewModel.onPasswordChange("pass")
        viewModel.onCodeChange("123456")
        viewModel.submit()
        runCurrent()

        assertEquals("无法连接到服务器，请检查网络", viewModel.state.value.error)
    }

    @Test
    fun `限流后进入冷却且不能提交`() = runTest {
        val viewModel = viewModel(gateway = FakeGateway { AuthOutcome.RateLimited }, cooldown = 3)

        viewModel.onPasswordChange("pass")
        viewModel.onCodeChange("123456")
        viewModel.submit()
        runCurrent()

        assertEquals(3, viewModel.state.value.cooldown)
        assertFalse(viewModel.canSubmit())
    }

    @Test
    fun `冷却结束后恢复提交能力`() = runTest {
        val viewModel = viewModel(gateway = FakeGateway { AuthOutcome.RateLimited }, cooldown = 3)

        viewModel.onPasswordChange("pass")
        viewModel.onCodeChange("123456")
        viewModel.submit()
        runCurrent()

        viewModel.onCodeChange("123456")
        advanceTimeBy(3_100)
        runCurrent()

        assertEquals(0, viewModel.state.value.cooldown)
        assertTrue(viewModel.canSubmit())
    }

    @Test
    fun `提交中重复点击只发一次请求`() = runTest {
        val gateway = FakeGateway { AuthOutcome.InvalidCredentials }
        val viewModel = viewModel(gateway = gateway)

        viewModel.onPasswordChange("pass")
        viewModel.onCodeChange("123456")
        viewModel.submit()
        viewModel.submit()
        runCurrent()

        assertEquals(1, gateway.calls.size)
    }

    @Test
    fun `提交时按主机地址访问登录接口`() = runTest {
        val gateway = FakeGateway { AuthOutcome.InvalidCredentials }
        val viewModel = viewModel(gateway = gateway)

        viewModel.onPasswordChange("pass")
        viewModel.onCodeChange("123456")
        viewModel.submit()
        runCurrent()

        assertEquals("https://dsn.example.com", gateway.calls.single().first)
        assertEquals("pass", gateway.calls.single().second)
        assertEquals("123456", gateway.calls.single().third)
    }

    @Test
    fun `密码可见性可以切换`() = runTest {
        val viewModel = viewModel()
        assertFalse(viewModel.state.value.passwordVisible)

        viewModel.togglePasswordVisible()
        assertTrue(viewModel.state.value.passwordVisible)

        viewModel.togglePasswordVisible()
        assertFalse(viewModel.state.value.passwordVisible)
    }

    @Test
    fun `修改输入会清掉上一条错误`() = runTest {
        val viewModel = viewModel(gateway = FakeGateway { AuthOutcome.InvalidCredentials })
        viewModel.onPasswordChange("pass")
        viewModel.onCodeChange("123456")
        viewModel.submit()
        runCurrent()
        assertNotNull(viewModel.state.value.error)

        viewModel.onCodeChange("12")
        assertNull(viewModel.state.value.error)
    }
}
