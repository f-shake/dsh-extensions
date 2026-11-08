package com.fshake.dshremote.ui.web

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableIntState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.fshake.dshremote.ui.common.CompactIconSize
import com.fshake.dshremote.ui.common.CompactTopBar
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.fshake.dshremote.data.HostEntry
import com.fshake.dshremote.web.DshWebView
import com.fshake.dshremote.web.WebCompat
import com.fshake.dshremote.web.WebDiagnostics
import com.fshake.dshremote.web.WebViewController

sealed interface WebFailure {
    data object Network : WebFailure
    data class Server(val status: Int) : WebFailure
    data object Certificate : WebFailure
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WebScreen(
    host: HostEntry,
    hosts: List<HostEntry>,
    startUrl: String,
    controller: WebViewController,
    imeBottom: MutableIntState,
    onSelectHost: (HostEntry) -> Unit,
    onExpired: () -> Unit,
    onBack: () -> Unit,
    onSignOut: () -> Unit,
    onClearPassword: () -> Unit,
    onSwitchHost: () -> Unit,
) {
    val context = LocalContext.current
    var progress by remember { mutableIntStateOf(100) }
    var failure by remember { mutableStateOf<WebFailure?>(null) }
    // 键盘高度只在动画开始时更新一次（见 installImeTargetListener），
    // 布局跟着一次性让位，页面只重排一次。
    val imeBottomDp = with(LocalDensity.current) { imeBottom.intValue.toDp() }
    var menuExpanded by remember { mutableStateOf(false) }
    var showDiagnostics by remember { mutableStateOf(false) }
    var liveProbe by remember { mutableStateOf<String?>(null) }

    Scaffold(
        topBar = {
            CompactTopBar(
                title = host.name,
                onBack = { if (!controller.goBack()) onBack() },
                actions = {
                    // 只保留「上一个」实例一个按钮：取最近用过的那台。
                    // 再多就走「更多 → 切换主机」，避免窄屏上把标题挤没。
                    val other = hosts.filter { it.id != host.id }.maxByOrNull { it.lastUsedAt }
                    if (other != null) {
                        TextButton(
                            onClick = { onSelectHost(other) },
                            contentPadding = PaddingValues(horizontal = 8.dp),
                            colors = ButtonDefaults.textButtonColors(
                                contentColor = MaterialTheme.colorScheme.onSurface,
                            ),
                            modifier = Modifier.height(36.dp),
                        ) {
                            Icon(
                                imageVector = Icons.Filled.SwapHoriz,
                                contentDescription = null,
                                modifier = Modifier.size(14.dp),
                            )
                            Spacer(Modifier.width(3.dp))
                            Text(
                                text = other.name,
                                style = MaterialTheme.typography.labelLarge,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.widthIn(max = 96.dp),
                            )
                        }
                    }
                    IconButton(
                        onClick = {
                            failure = null
                            controller.reload()
                        },
                        modifier = Modifier.size(CompactIconSize),
                    ) {
                        Icon(Icons.Filled.Refresh, contentDescription = "刷新")
                    }
                    Box {
                        IconButton(
                            onClick = { menuExpanded = true },
                            modifier = Modifier.size(CompactIconSize),
                        ) {
                            Icon(Icons.Filled.MoreVert, contentDescription = "更多操作")
                        }
                        DropdownMenu(
                            expanded = menuExpanded,
                            onDismissRequest = { menuExpanded = false },
                        ) {
                            DropdownMenuItem(
                                text = { Text("在浏览器打开") },
                                onClick = {
                                    menuExpanded = false
                                    openInBrowser(context, controller.currentUrl() ?: host.baseUrl)
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("切换主机") },
                                onClick = {
                                    menuExpanded = false
                                    onSwitchHost()
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("清除保存的密码") },
                                onClick = {
                                    menuExpanded = false
                                    onClearPassword()
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("诊断信息") },
                                onClick = {
                                    menuExpanded = false
                                    liveProbe = null
                                    showDiagnostics = true
                                    controller.evaluate(WebCompat.liveProbeScript) { liveProbe = it }
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("退出登录") },
                                onClick = {
                                    menuExpanded = false
                                    onSignOut()
                                },
                            )
                        }
                    }
                },
            )
        },
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(bottom = imeBottomDp),
        ) {
            if (progress in 1..99) {
                LinearProgressIndicator(
                    progress = { progress / 100f },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth(),
            ) {
                DshWebView(
                    host = host,
                    startUrl = startUrl,
                    controller = controller,
                    modifier = Modifier.fillMaxSize(),
                    onProgress = {
                        progress = it
                        if (it < 100) failure = null
                    },
                    onExpired = onExpired,
                    onHttpError = { failure = WebFailure.Server(it) },
                    onNetworkError = { failure = WebFailure.Network },
                    onSslError = { failure = WebFailure.Certificate },
                )
                failure?.let { current ->
                    FailurePanel(
                        failure = current,
                        onRetry = {
                            failure = null
                            controller.reload()
                        },
                    )
                }
            }
        }
    }

    if (showDiagnostics) {
        val clipboard = LocalClipboardManager.current
        val report = buildString {
            appendLine("WebView: ${WebCompat.webViewVersion(context)}")
            appendLine("页面: ${controller.currentUrl() ?: startUrl}")
            appendLine("记录: ${WebDiagnostics.size()} 条")
            appendLine("实时探测: ${liveProbe ?: "读取中…"}")
            appendLine()
            append(WebDiagnostics.snapshot())
        }
        AlertDialog(
            onDismissRequest = { showDiagnostics = false },
            title = { Text("诊断信息") },
            text = {
                Column(
                    modifier = Modifier
                        .heightIn(max = 360.dp)
                        .verticalScroll(rememberScrollState()),
                ) {
                    Text(report, style = MaterialTheme.typography.bodySmall)
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    clipboard.setText(AnnotatedString(report))
                    Toast.makeText(context, "已复制", Toast.LENGTH_SHORT).show()
                }) { Text("复制") }
            },
            dismissButton = {
                TextButton(onClick = { showDiagnostics = false }) { Text("关闭") }
            },
        )
    }
}

@Composable
private fun FailurePanel(failure: WebFailure, onRetry: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.background,
        modifier = Modifier.fillMaxSize(),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(32.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = when (failure) {
                    WebFailure.Network -> "无法连接到服务器，请检查网络"
                    is WebFailure.Server -> "服务器暂时不可用，请稍后重试（${failure.status}）"
                    WebFailure.Certificate -> "服务器证书校验失败，已停止连接"
                },
                style = MaterialTheme.typography.bodyLarge,
            )
            if (failure != WebFailure.Certificate) {
                Button(onClick = onRetry, modifier = Modifier.padding(top = 24.dp)) {
                    Text("重试")
                }
            }
        }
    }
}

private fun openInBrowser(context: Context, url: String) {
    try {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
    } catch (_: Exception) {
        Toast.makeText(context, "没有可以打开该链接的应用", Toast.LENGTH_SHORT).show()
    }
}












