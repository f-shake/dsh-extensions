package com.fshake.dshremote.web

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.ConsoleMessage
import android.webkit.DownloadListener
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewCompat
import com.fshake.dshremote.BuildConfig
import com.fshake.dshremote.core.UrlMatchers
import com.fshake.dshremote.data.HostEntry

/** 页面之外的命令通道，供工具栏调用。 */
class WebViewController {
    internal var webView: WebView? = null

    /** 连按返回时只处理一次，避免一次按键被消费两次或连续回退两层。 */
    private var dismissingOverlay = false

    /** 每次发起或作废返回检查都递增；迟到的脚本回调据此丢弃。 */
    private var backCheck = 0

    fun reload() {
        webView?.reload()
    }

    fun load(url: String) {
        webView?.loadUrl(url)
    }

    fun canGoBack(): Boolean = webView?.canGoBack() == true

    fun goBack(): Boolean {
        val view = webView ?: return false
        if (!view.canGoBack()) return false
        view.goBack()
        return true
    }

    fun currentUrl(): String? = webView?.url

    /** 现场执行一段脚本，结果原样回传；页面还没建好时回 null。 */
    fun evaluate(script: String, onResult: (String?) -> Unit) {
        val view = webView
        if (view == null) {
            onResult(null)
            return
        }
        view.evaluateJavascript(script) { result -> onResult(result) }
    }

    /**
     * 先关页面里的浮层（菜单 / 候选 / 对话框 / 抽屉 / 浮窗 / 右栏）。
     *
     * 网页里的这些层不进入 WebView 历史，goBack() 看不见它们，所以返回键要先问页面。
     * 页面还没建好或脚本异常时回调 false，调用方继续走网页历史 / 回列表。
     */
    fun dismissOverlayIfOpen(onResult: (Boolean) -> Unit) {
        if (dismissingOverlay) return
        val view = webView
        if (view == null) {
            onResult(false)
            return
        }
        dismissingOverlay = true
        val id = ++backCheck
        var settled = false
        fun settle(dismissed: Boolean) {
            if (settled || id != backCheck) return
            settled = true
            dismissingOverlay = false
            onResult(dismissed)
        }
        // 回调迟迟不来（页面卡死、渲染进程崩溃）时按「没有浮层」放行：
        // 否则标志永远为 true，之后每次返回都会被无声吞掉。
        view.postDelayed({ settle(false) }, OVERLAY_TIMEOUT_MS)
        view.evaluateJavascript(WebCompat.backDismissScript) { raw ->
            val dismissed = WebBack.overlayDismissed(raw)
            if (dismissed && !settled) WebDiagnostics.add("[back] overlay=${WebBack.overlayName(raw)}")
            settle(dismissed)
        }
    }

    /** WebView 被销毁时作废未完成的检查，避免返回键卡在「处理中」。 */
    fun releaseView() {
        webView = null
        backCheck++
        dismissingOverlay = false
    }

    private companion object {
        /** 留给页面脚本的正常执行窗口；超过就当作没有浮层。 */
        const val OVERLAY_TIMEOUT_MS = 1500L
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun DshWebView(
    host: HostEntry,
    startUrl: String,
    controller: WebViewController,
    modifier: Modifier = Modifier,
    onProgress: (Int) -> Unit,
    onExpired: () -> Unit,
    onHttpError: (Int) -> Unit,
    onNetworkError: () -> Unit,
    onSslError: () -> Unit,
) {
    val context = LocalContext.current
    val currentOnProgress by rememberUpdatedState(onProgress)
    val currentOnExpired by rememberUpdatedState(onExpired)
    val currentOnHttpError by rememberUpdatedState(onHttpError)
    val currentOnNetworkError by rememberUpdatedState(onNetworkError)
    val currentOnSslError by rememberUpdatedState(onSslError)

    // 站内判定只比较主机名：baseUrl 里带 :端口 时，整段 authority 与 URI.host 永远不相等，
    // 会把站内跳转全部甩给系统浏览器。
    val expectedHost = remember(host.baseUrl) { UrlMatchers.hostOf(host.baseUrl).orEmpty() }
    var pendingFileCallback by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
    var pendingDownload by remember { mutableStateOf<DownloadRequest?>(null) }
    // 页面要麦克风时先把请求挂起，等系统授权结果回来再答复它
    var pendingMicRequest by remember { mutableStateOf<PermissionRequest?>(null) }
    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
    ) { granted ->
        val request = pendingDownload
        pendingDownload = null
        when {
            request == null -> Unit
            granted -> enqueueDownload(context.applicationContext, request)
            else -> Toast.makeText(context, "未授予存储权限，无法保存到下载目录", Toast.LENGTH_SHORT).show()
        }
    }
    val micLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
    ) { granted ->
        val request = pendingMicRequest
        pendingMicRequest = null
        if (request != null) {
            // 被拒也要明确答复：不回话时页面会一直停在「等待授权」，录音按钮点了没反应
            if (granted) request.grant(WebPermission.grants()) else request.deny()
        }
        // 页面只会显示「无法开始录音」，用户看不出是权限问题；这里补一句，并指到系统设置，
        // 因为第二次拒绝之后系统不再弹窗，再点麦克风只会静默失败
        if (!granted) {
            Toast.makeText(context, "未授予录音权限，语音输入不可用；可在系统设置里允许", Toast.LENGTH_LONG)
                .show()
        }
        WebDiagnostics.add("[perm] mic granted=$granted")
    }

    // 回调闭包会随重组更新，避免 factory 捕获到旧的状态
    val currentRequestDownload = rememberUpdatedState<(DownloadRequest) -> Unit> { request ->
        val needsPermission = Build.VERSION.SDK_INT <= Build.VERSION_CODES.P &&
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.WRITE_EXTERNAL_STORAGE,
            ) != PackageManager.PERMISSION_GRANTED
        if (needsPermission) {
            pendingDownload = request
            permissionLauncher.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        } else {
            enqueueDownload(context.applicationContext, request)
        }
    }
    val historyCleared = remember { java.util.concurrent.atomic.AtomicBoolean(false) }
    // 页面被淘汰或退出后会 destroy，延时回调不能再碰它
    val released = remember { java.util.concurrent.atomic.AtomicBoolean(false) }
    val fileChooserLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val callback = pendingFileCallback
        pendingFileCallback = null
        val data = result.data
        val parsed = WebChromeClient.FileChooserParams.parseResult(result.resultCode, data)
        // 部分 ROM（MIUI 等）的选择器不全按文件选择契约返回，parseResult 会拿到 null，
        // 这里按 data/clipData 兜一层，避免「选完没反应」。
        val uris = parsed ?: if (result.resultCode == android.app.Activity.RESULT_OK && data != null) {
            val clip = data.clipData
            when {
                clip != null && clip.itemCount > 0 -> Array(clip.itemCount) { index -> clip.getItemAt(index).uri }
                data.data != null -> arrayOf(data.data!!)
                else -> null
            }
        } else {
            null
        }
        WebDiagnostics.add(
            "[file] code=${result.resultCode} data=${data?.data} clip=${data?.clipData?.itemCount ?: 0} " +
                "parsed=${parsed?.size ?: -1} uris=${uris?.size ?: -1} hasCallback=${callback != null}",
        )
        callback?.onReceiveValue(uris)
    }

    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            WebView(ctx).apply {
                WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
                CookieManager.getInstance().setAcceptCookie(true)
                settings.configureDsh()
                controller.webView = this

                // 页面脚本执行前补缺失的 JS API；不支持的 WebView 退化为 onPageStarted 里注入
                if (WebCompat.supportsDocumentStartScript()) {
                    WebViewCompat.addDocumentStartJavaScript(
                        this,
                        WebCompat.documentStartScript,
                        setOf("*"),
                    )
                }

                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(
                        view: WebView,
                        request: WebResourceRequest,
                    ): Boolean {
                        val url = request.url.toString()
                        // 子框架的跳转不该拉起系统浏览器，也不该改写应用状态
                        if (!request.isForMainFrame) return false
                        if (UrlMatchers.isLoginPage(url)) {
                            currentOnExpired()
                            return true
                        }
                        if (!UrlMatchers.isHttpScheme(url)) {
                            openExternally(ctx, url)
                            return true
                        }
                        if (!UrlMatchers.isSameHost(url, expectedHost)) {
                            openExternally(ctx, url)
                            return true
                        }
                        return false
                    }

                    override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                        super.onPageStarted(view, url, favicon)
                        WebDiagnostics.add("[nav] $url")
                        if (!WebCompat.supportsDocumentStartScript()) {
                            view.evaluateJavascript(WebCompat.documentStartScript, null)
                        }
                        // 服务端 302 到登录页时不会走 shouldOverrideUrlLoading，这里补一道
                        if (UrlMatchers.isLoginPage(url)) {
                            view.stopLoading()
                            currentOnExpired()
                        }
                    }

                    override fun onPageFinished(view: WebView, url: String) {
                        super.onPageFinished(view, url)
                        currentOnProgress(100)
                        // 预加载的空白页只用于量视口，不参与诊断与自愈
                        if (url.startsWith("data:") || url == "about:blank") return
                        // 登录时先落到 /?token=…，DSH 换完 cookie 再跳到 /。
                        // 那个 token 只能用一次，留在历史里会导致「返回一次变白屏」，
                        // 所以在落到正式页面后清一次历史。
                        if (!historyCleared.get() && !url.contains("token=") && url.startsWith(host.baseUrl)) {
                            historyCleared.set(true)
                            view.clearHistory()
                            WebDiagnostics.add("[history] cleared at $url")
                        }
                        // 视口自检：极少数设备在 WebView 拿到真实尺寸前就开始加载，会把 100vh 缓存成 0，
                        // 表现为「splash 之后整页塌成 0 高」。这里量一次记录到诊断里，真塌了才查得到。
                        view.evaluateJavascript(WebCompat.viewportProbeScript) { result ->
                            val vh = result?.trim()?.toIntOrNull() ?: -1
                            WebDiagnostics.add("[vh] $vh size=${view.width}x${view.height}")
                        }
                        // 页面渲染是异步的，等一会儿再取一次内部状态，用于诊断白屏
                        view.postDelayed({
                            if (released.get()) return@postDelayed
                            view.evaluateJavascript(WebCompat.probeScript) { probe ->
                                WebDiagnostics.add("[probe] ${probe?.replace("\\n", " ")}")
                            }
                        }, 2500)
                    }

                    override fun onReceivedHttpError(
                        view: WebView,
                        request: WebResourceRequest,
                        errorResponse: WebResourceResponse,
                    ) {
                        super.onReceivedHttpError(view, request, errorResponse)
                        val status = errorResponse.statusCode
                        WebDiagnostics.add("[http $status] ${request.url}")
                        if (request.isForMainFrame && status in 502..504) {
                            currentOnHttpError(status)
                        }
                    }

                    override fun onReceivedError(
                        view: WebView,
                        request: WebResourceRequest,
                        error: WebResourceError,
                    ) {
                        super.onReceivedError(view, request, error)
                        WebDiagnostics.add("[net-error] ${error.errorCode} ${error.description} ${request.url}")
                        if (request.isForMainFrame) currentOnNetworkError()
                    }

                    override fun onReceivedSslError(
                        view: WebView,
                        handler: SslErrorHandler,
                        error: android.net.http.SslError,
                    ) {
                        handler.cancel()
                        WebDiagnostics.add("[ssl-error] ${error.url}")
                        currentOnSslError()
                    }
                }

                webChromeClient = object : WebChromeClient() {
                    override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                        val line = "[console.${message.messageLevel()}] ${message.message()} " +
                            "@${message.sourceId()}:${message.lineNumber()}"
                        WebDiagnostics.add(line)
                        return true
                    }

                    override fun onProgressChanged(view: WebView, newProgress: Int) {
                        currentOnProgress(newProgress)
                    }

                    override fun onPermissionRequest(request: PermissionRequest) {
                        val resources = request.resources
                        val origin = request.origin?.toString()
                        // 只信应用自己的主机：子框架请求在跳转判定里是放行的，跨域 iframe
                        // 或注入脚本同样能走到这里。按来源放行，麦克风才不会变成整页可用
                        if (!WebPermission.isTrustedOrigin(origin, expectedHost)) {
                            WebDiagnostics.add("[perm] deny origin=$origin")
                            request.deny()
                            return
                        }
                        // 摄像头等资源直接拒：语音输入只申请麦克风
                        if (!WebPermission.isAudioOnly(resources)) {
                            WebDiagnostics.add("[perm] deny ${resources.joinToString()}")
                            request.deny()
                            return
                        }
                        val granted = ContextCompat.checkSelfPermission(
                            ctx,
                            Manifest.permission.RECORD_AUDIO,
                        ) == PackageManager.PERMISSION_GRANTED
                        if (granted) {
                            WebDiagnostics.add("[perm] grant audio")
                            request.grant(WebPermission.grants())
                            return
                        }
                        // 同一时刻只挂一个：旧的先拒掉，免得授权结果回给过期的请求
                        pendingMicRequest?.deny()
                        pendingMicRequest = request
                        micLauncher.launch(Manifest.permission.RECORD_AUDIO)
                    }

                    override fun onShowFileChooser(
                        webView: WebView,
                        filePathCallback: ValueCallback<Array<Uri>>,
                        fileChooserParams: FileChooserParams,
                    ): Boolean {
                        pendingFileCallback?.onReceiveValue(null)
                        pendingFileCallback = filePathCallback
                        return try {
                            fileChooserLauncher.launch(
                                fileChooserParams.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                                    type = "*/*"
                                },
                            )
                            true
                        } catch (_: Exception) {
                            pendingFileCallback = null
                            false
                        }
                    }
                }

                setDownloadListener(
                    DownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
                        currentRequestDownload.value(
                            DownloadRequest(url, userAgent, contentDisposition, mimeType),
                        )
                    },
                )

                // 先等 WebView 拿到真实尺寸，再量一次空白页的 100vh：
                // 等 WebView 拿到真实尺寸再加载：尺寸为 0 时加载，部分设备会把布局视口
                // 缓存成 0，页面里 100vh / 高度百分比全部失效。
                // 注意不要在加载前先塞一个空白页——它会占用 WebView 历史，
                // 导致「返回一次」退到空白页而不是退出网页页。
                var started = false
                fun startWhenSized() {
                    if (started || released.get()) return
                    if (width <= 0 || height <= 0) return
                    started = true
                    WebDiagnostics.add("[size] ${width}x${height} density=${resources.displayMetrics.density}")
                    loadUrl(startUrl)
                    // 兜底：即使 onPageFinished 迟迟不来（页面挂着长连接），也要把登录时的
                    // 一次性 token 地址从历史里清掉，否则返回一次会退到一个已失效的空白页。
                    postDelayed({
                        if (released.get()) return@postDelayed
                        if (historyCleared.compareAndSet(false, true)) {
                            clearHistory()
                            WebDiagnostics.add("[history] cleared by timer")
                        }
                    }, 3000)
                }

                addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> startWhenSized() }
                post { startWhenSized() }
            }
        },
        // 退出登录、删除主机、超限淘汰时会离开组合。只从视图树移除不会停掉页面，
        // 脚本、长连接与渲染资源会一直跟着进程活着，所以这里显式销毁。
        onRelease = { view ->
            released.set(true)
            // 视图销毁后不会再有人答复页面，挂起的授权直接拒掉
            pendingMicRequest?.deny()
            pendingMicRequest = null
            controller.releaseView()
            WebDiagnostics.add("[release] ${runCatching { view.url }.getOrNull() ?: "unknown"}")
            runCatching {
                view.stopLoading()
                view.webChromeClient = null
                view.webViewClient = WebViewClient()
                (view.parent as? ViewGroup)?.removeView(view)
                view.destroy()
            }
        },
    )
}

private fun WebSettings.configureDsh() {
    javaScriptEnabled = true
    domStorageEnabled = true
    // 必须走标准 viewport 处理：关掉 useWideViewPort 时，部分 ROM 的 WebView 会把
    // 100vh 算成 0，整页高度塌陷（实测 1200x2344 的 WebView 上 vh 仍为 0）
    useWideViewPort = true
    loadWithOverviewMode = true
    builtInZoomControls = true
    displayZoomControls = false
    mediaPlaybackRequiresUserGesture = false
    mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
    allowFileAccess = false
    allowContentAccess = false
    cacheMode = WebSettings.LOAD_DEFAULT
}

private fun openExternally(context: Context, url: String) {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
    try {
        context.startActivity(intent)
    } catch (_: Exception) {
        Toast.makeText(context, "没有可以打开该链接的应用", Toast.LENGTH_SHORT).show()
    }
}

/** 页面发起的一次下载；先记下来再决定是直接下载还是先要存储权限。 */
private data class DownloadRequest(
    val url: String,
    val userAgent: String,
    val contentDisposition: String,
    val mimeType: String,
)

private fun enqueueDownload(context: Context, request: DownloadRequest) {
    try {
        val fileName = URLUtil.guessFileName(request.url, request.contentDisposition, request.mimeType)
        val download = DownloadManager.Request(Uri.parse(request.url))
            .setMimeType(request.mimeType)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
            .addRequestHeader("Cookie", CookieManager.getInstance().getCookie(request.url).orEmpty())
            .addRequestHeader("User-Agent", request.userAgent)
        val manager = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        manager.enqueue(download)
        Toast.makeText(context, "已开始下载", Toast.LENGTH_SHORT).show()
    } catch (_: Exception) {
        Toast.makeText(context, "下载失败", Toast.LENGTH_SHORT).show()
    }
}
