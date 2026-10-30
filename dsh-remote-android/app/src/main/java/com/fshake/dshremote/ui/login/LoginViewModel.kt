package com.fshake.dshremote.ui.login

import com.fshake.dshremote.auth.AuthOutcome
import com.fshake.dshremote.auth.CookieInjector
import com.fshake.dshremote.auth.LoginGateway
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 登录失败文案的唯一出处，界面与测试都读这里。 */
object LoginMessages {

    fun message(outcome: AuthOutcome): String? = when (outcome) {
        is AuthOutcome.Success -> null
        AuthOutcome.InvalidCredentials -> "密码或动态验证码不正确，请重新输入"
        AuthOutcome.RateLimited -> "提交过于频繁，请等待一分钟后重试"
        is AuthOutcome.ServerError -> "服务器暂时不可用，请稍后重试"
        is AuthOutcome.UnexpectedStatus -> when (outcome.status) {
            401 -> "服务端未开放登录接口（401），请检查网关的 /_app_login 配置"
            403 -> "服务端拒绝了这次登录请求（403）"
            else -> "登录接口返回异常，状态码 ${outcome.status}"
        }
        is AuthOutcome.NetworkError -> "无法连接到服务器，请检查网络"
    }
}

/**
 * 登录页状态机。
 *
 * 密码与验证码都只在内存里；成功时把 cookie 交给 CookieInjector，
 * 再由界面跳转 —— ViewModel 不碰导航。
 */
class LoginViewModel(
    private val baseUrl: String,
    initialPassword: String?,
    private val client: LoginGateway,
    private val cookies: CookieInjector,
    private val scope: CoroutineScope,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    cooldownSeconds: Int = DEFAULT_COOLDOWN_SECONDS,
) {

    data class UiState(
        val password: String = "",
        val code: String = "",
        val passwordVisible: Boolean = false,
        val loading: Boolean = false,
        val error: String? = null,
        val cooldown: Int = 0,
    )

    private val _state = MutableStateFlow(UiState(password = initialPassword.orEmpty()))
    val state: StateFlow<UiState> = _state.asStateFlow()

    private val _success = MutableStateFlow<AuthOutcome.Success?>(null)
    val success: StateFlow<AuthOutcome.Success?> = _success.asStateFlow()

    private val cooldownLength = cooldownSeconds

    fun onPasswordChange(value: String) {
        _state.value = _state.value.copy(password = value, error = null)
    }

    fun onCodeChange(value: String) {
        val digits = value.filter { it.isDigit() }.take(CODE_LENGTH)
        _state.value = _state.value.copy(code = digits, error = null)
    }

    fun togglePasswordVisible() {
        _state.value = _state.value.copy(passwordVisible = !_state.value.passwordVisible)
    }

    fun consumeSuccess() {
        _success.value = null
    }

    fun canSubmit(): Boolean {
        val current = _state.value
        return !current.loading &&
            current.cooldown == 0 &&
            current.password.isNotEmpty() &&
            current.code.length == CODE_LENGTH
    }

    fun submit() {
        if (!canSubmit()) return
        val snapshot = _state.value
        _state.value = snapshot.copy(loading = true, error = null)

        scope.launch {
            val outcome = withContext(io) { client.login(baseUrl, snapshot.password, snapshot.code) }
            when (outcome) {
                is AuthOutcome.Success -> {
                    _state.value = _state.value.copy(loading = false)
                    cookies.inject(baseUrl, outcome.cookies)
                    _success.value = outcome
                }

                else -> {
                    _state.value = _state.value.copy(
                        loading = false,
                        error = LoginMessages.message(outcome),
                        code = "",
                    )
                    if (outcome is AuthOutcome.RateLimited) startCooldown()
                }
            }
        }
    }

    private fun startCooldown() {
        scope.launch {
            var remaining = cooldownLength
            while (remaining > 0) {
                _state.value = _state.value.copy(cooldown = remaining)
                delay(1000L)
                remaining -= 1
            }
            _state.value = _state.value.copy(cooldown = 0)
        }
    }

    companion object {
        const val CODE_LENGTH = 6
        const val DEFAULT_COOLDOWN_SECONDS = 60
    }
}

