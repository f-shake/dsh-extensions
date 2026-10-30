package com.fshake.dshremote.ui.nav

import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableIntState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.graphics.graphicsLayer
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.fshake.dshremote.AppContainer
import com.fshake.dshremote.auth.LoginReason
import com.fshake.dshremote.auth.SessionGate
import com.fshake.dshremote.auth.StartDecision
import com.fshake.dshremote.data.HostEntry
import com.fshake.dshremote.ui.hostedit.HostEditScreen
import com.fshake.dshremote.ui.hosts.HostListScreen
import com.fshake.dshremote.ui.hosts.HostListViewModel
import com.fshake.dshremote.ui.login.LoginScreen
import com.fshake.dshremote.ui.web.WebScreen
import com.fshake.dshremote.web.WebViewController

/** 页面只有四个，用状态机切换即可，不引入导航库。 */
sealed interface Route {
    data object Hosts : Route
    data class Login(val hostId: String, val reason: LoginReason) : Route
    data object Web : Route
    data class Edit(val hostId: String?) : Route
}

/**
 * 常驻的网页会话。
 *
 * 返回主机列表、或切到另一台实例时都不销毁 WebView —— 页面不重载、不丢状态。
 * 只有退出登录、删除主机，或超出保活上限被淘汰时才丢弃。
 */
private class WebTarget(
    val hostId: String,
    /** 建立这个会话时使用的地址；地址被编辑过就不能再复用，否则会一直显示旧主机。 */
    val baseUrl: String,
    val startUrl: String,
    val controller: WebViewController,
)

private const val SLIDE_MS = 220

/** 同时保活的实例上限：平板内存够，两个够用；再多就淘汰最久没用的。 */
private const val MAX_LIVE_WEBS = 2

@Composable
fun AppRoot(container: AppContainer, imeBottom: MutableIntState) {
    val context = LocalContext.current
    val repository = container.repository
    val appState by repository.state.collectAsStateWithLifecycle()
    // 上次停留的实例：在第一次组合就定下初始路由。若先以列表进入组合、事后再切过去，
    // 列表会走一遍 220ms 的退出动画，冷启动时会看到它在网页上滑出一次。
    val startHost = remember { hostToRestore(repository.state.value) }
    var route by remember { mutableStateOf<Route>(if (startHost == null) Route.Hosts else Route.Web) }
    val webs = remember { mutableStateMapOf<String, WebTarget>() }
    var activeHostId by remember { mutableStateOf<String?>(null) }

    // 切换实例时的淡入：新实例从半透明过渡到不透明，期间能看到旧实例，形成交叉淡出
    val switchAlpha = remember { androidx.compose.animation.core.Animatable(1f) }
    LaunchedEffect(activeHostId) {
        if (activeHostId != null && webs.size > 1) {
            switchAlpha.snapTo(0.35f)
            switchAlpha.animateTo(1f, tween(200))
        }
    }

    fun toast(message: String) {
        Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
    }

    /** 已有会话就直接复用活着的页面；没有则按登录状态决定去哪。 */
    fun openHost(host: HostEntry, startUrl: String? = null) {
        repository.markUsed(host.id)
        val alive = webs[host.id]
        if (alive != null && alive.baseUrl != host.baseUrl) {
            // 地址被改过：旧页面连的是旧主机，继续复用只会让人以为已经切过去了
            webs.remove(host.id)
        } else if (alive != null && startUrl == null) {
            activeHostId = host.id
            route = Route.Web
            return
        }
        when (val decision = SessionGate.decide(host, System.currentTimeMillis())) {
            is StartDecision.OpenWeb -> {
                while (webs.size >= MAX_LIVE_WEBS) {
                    val victim = webs.keys.firstOrNull { it != activeHostId } ?: break
                    webs.remove(victim)
                }
                webs[host.id] = WebTarget(
                    hostId = host.id,
                    baseUrl = host.baseUrl,
                    startUrl = startUrl ?: host.baseUrl,
                    controller = WebViewController(),
                )
                activeHostId = host.id
                route = Route.Web
            }

            is StartDecision.NeedLogin -> route = Route.Login(host.id, decision.reason)
        }
    }

    fun dropWeb(hostId: String) {
        webs.remove(hostId)
        if (activeHostId == hostId) {
            activeHostId = webs.keys.lastOrNull()
        }
    }

    /** 回列表：同时把「上次停留的主机」清掉，下次启动才不会又跳回实例里。 */
    fun backToList() {
        repository.select(null)
        route = Route.Hosts
    }

    // 进程被系统回收后重建（返回桌面放久了、内存吃紧），或者字号、密度、语言这类
    // 没在 configChanges 里声明的变更导致 Activity 重建时，route 会掉回列表。
    // 这里按落盘的「上次停留的主机」把会话补起来：还有效就直接进网页，
    // 过期就落到登录页，与用户离开时看到的一致。（旋转不会重建，见 AndroidManifest。）
    LaunchedEffect(Unit) {
        val host = startHost ?: return@LaunchedEffect
        if (webs[host.id] == null) openHost(host)
    }

    // 返回：网页里优先网页自身回退，其次退回主机列表；其余页面直接回列表。
    // 放在这里而不是各页面内部，避免常驻的网页页在列表上抢走返回键。
    BackHandler(enabled = route !is Route.Hosts) {
        when (route) {
            is Route.Web -> {
                val controller = activeHostId?.let { webs[it]?.controller }
                if (controller == null || !controller.goBack()) backToList()
            }

            is Route.Login -> backToList()
            is Route.Edit -> backToList()
            else -> Unit
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        // 底层：所有保活中的网页，当前实例排在最后（画在最上面并接收触摸）
        val order = webs.keys.filter { it != activeHostId } + listOfNotNull(activeHostId)
        order.forEach { hostId ->
            val target = webs[hostId] ?: return@forEach
            val host = appState.hosts.firstOrNull { it.id == hostId }
            if (host == null) {
                LaunchedEffect(hostId) { dropWeb(hostId) }
                return@forEach
            }
            // key 带上会话自身的地址：地址被改过时会换成一个新的 WebTarget，
            // 只有 hostId 的话 Compose 会认为还是同一个节点，复用出旧页面的 WebView。
            key(hostId, target.baseUrl, target.startUrl) {
                val isActive = hostId == activeHostId
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .graphicsLayer { alpha = if (isActive) switchAlpha.value else 1f },
                ) {
                WebScreen(
                    host = host,
                    hosts = appState.hosts,
                    startUrl = target.startUrl,
                    controller = target.controller,
                    imeBottom = imeBottom,
                    onSelectHost = { other -> openHost(other) },
                    onExpired = {
                        // 只有「正在看的网页」才配改写路由：后台保活的实例、以及已经退回列表
                        // 或停在别的登录页时，过期只该清掉它自己的会话，不能把前台顶掉
                        val wasActive = hostId == activeHostId && route is Route.Web
                        repository.clearSession(host.id)
                        dropWeb(host.id)
                        if (wasActive) route = Route.Login(host.id, LoginReason.EXPIRED)
                    },
                    onBack = { backToList() },
                    onSignOut = {
                        container.cookieBridge.clear(host.baseUrl)
                        repository.clearSession(host.id)
                        dropWeb(host.id)
                        toast("已退出 ${host.name}")
                        route = Route.Login(host.id, LoginReason.EXPIRED)
                    },
                    onClearPassword = {
                        container.passwordVault.clear(host.id)
                        toast("已清除保存的密码")
                    },
                    onSwitchHost = { backToList() },
                )
                }
            }
        }

        // 上层：主机列表（滑入滑出）
        AnimatedVisibility(
            visible = route is Route.Hosts,
            enter = slideInHorizontally(tween(SLIDE_MS)) { -it / 4 } + fadeIn(tween(SLIDE_MS)),
            exit = slideOutHorizontally(tween(SLIDE_MS)) { -it / 4 } + fadeOut(tween(SLIDE_MS)),
        ) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(MaterialTheme.colorScheme.background),
            ) {
                HostListScreen(
                    state = appState,
                    viewModel = remember { HostListViewModel(repository) },
                    onOpen = { openHost(it) },
                    onEdit = { route = Route.Edit(it.id) },
                    onDelete = { host ->
                        container.cookieBridge.clear(host.baseUrl)
                        container.passwordVault.clear(host.id)
                        dropWeb(host.id)
                        repository.remove(host.id)
                        toast("已删除 ${host.name}")
                    },
                    onSignOut = { host ->
                        container.cookieBridge.clear(host.baseUrl)
                        repository.clearSession(host.id)
                        dropWeb(host.id)
                        toast("已退出 ${host.name}")
                    },
                    onAdd = { route = Route.Edit(null) },
                )
            }
        }

        // 上层：原生登录页
        val loginRoute = route as? Route.Login
        AnimatedVisibility(
            visible = loginRoute != null,
            enter = slideInVertically(tween(SLIDE_MS)) { it / 3 } + fadeIn(tween(SLIDE_MS)),
            exit = slideOutVertically(tween(SLIDE_MS)) { it / 3 } + fadeOut(tween(SLIDE_MS)),
        ) {
            val host = loginRoute?.let { current -> appState.hosts.firstOrNull { it.id == current.hostId } }
            if (loginRoute != null && host != null) {
                // 只在进入这台主机的登录页时解一次密：重组期间保持不变，既省掉反复的 Keystore
                // 运算，也不会因为中途切换「记住密码」而把已经填好的密码与验证码冲掉。
                val savedPassword = remember(host.id) {
                    if (appState.rememberPassword) container.passwordVault.read(host.id) else null
                }
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(MaterialTheme.colorScheme.background),
                ) {
                    LoginScreen(
                        host = host,
                        reason = loginRoute.reason,
                        rememberPassword = appState.rememberPassword,
                        initialPassword = savedPassword,
                        client = container.loginClient,
                        cookieInjector = container.cookieBridge,
                        onRememberPasswordChange = { enabled ->
                            repository.setRememberPassword(enabled)
                            if (!enabled) container.passwordVault.clear(host.id)
                        },
                        onSuccess = { outcome, password ->
                            if (appState.rememberPassword) {
                                val saved = container.passwordVault.save(host.id, password)
                                if (!saved) toast("这台设备的密钥库不可用，密码未能保存")
                            }
                            repository.setSessionExpiry(host.id, outcome.sessionExpiresAt)
                            while (webs.size >= MAX_LIVE_WEBS) {
                                val victim = webs.keys.firstOrNull { it != activeHostId } ?: break
                                webs.remove(victim)
                            }
                            webs[host.id] = WebTarget(
                                hostId = host.id,
                                baseUrl = host.baseUrl,
                                startUrl = outcome.nextUrl,
                                controller = WebViewController(),
                            )
                            activeHostId = host.id
                            route = Route.Web
                        },
                        onBack = { backToList() },
                    )
                }
            }
        }

        // 上层：主机编辑
        val editRoute = route as? Route.Edit
        AnimatedVisibility(
            visible = editRoute != null,
            enter = slideInVertically(tween(SLIDE_MS)) { it / 3 } + fadeIn(tween(SLIDE_MS)),
            exit = slideOutVertically(tween(SLIDE_MS)) { it / 3 } + fadeOut(tween(SLIDE_MS)),
        ) {
            if (editRoute != null) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(MaterialTheme.colorScheme.background),
                ) {
                    HostEditScreen(
                        existing = appState.hosts.firstOrNull { it.id == editRoute.hostId },
                        repository = repository,
                        onDone = { backToList() },
                    )
                }
            }
        }
    }
}

