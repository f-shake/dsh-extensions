package com.fshake.dshremote.web

import android.webkit.PermissionRequest
import java.net.URI

/**
 * 网页权限请求的取舍规则。
 *
 * DSH 的语音输入只申请麦克风；其它资源（摄像头、画中画等）一律拒绝，
 * 免得页面顺手拉起用户没预期的系统权限弹窗。
 */
object WebPermission {

    /**
     * 页面里唯一放行的资源。
     *
     * 直接引用框架常量而不是抄一份字面量：取值由框架定义，抄一份只会让两者悄悄漂开。
     * 它是 Java 编译期常量，JVM 单测不需要加载框架实现。
     */
    private val audioCapture: String = PermissionRequest.RESOURCE_AUDIO_CAPTURE

    /**
     * 这次请求是否只申请音频采集。
     *
     * 同批带摄像头等资源的混合请求也整次拒绝：Chromium 对子集授权会让整个
     * `getUserMedia` 失败，与其让它以「设备不可用」的名义失败，不如这里明确拒掉。
     */
    fun isAudioOnly(resources: Array<String>?): Boolean =
        resources != null && resources.size == 1 && resources[0] == audioCapture

    /** 放行时交还给页面的资源：只有音频。 */
    fun grants(): Array<String> = arrayOf(audioCapture)

    /**
     * 请求来源是否属于应用认定的主机。
     *
     * 只比较主机名，与站内跳转判定保持一致：baseUrl 带端口时，整段 authority 与
     * `URI.host` 永远不相等。子框架的请求在跳转判定里是放行的，跨域 iframe 或注入
     * 脚本同样会走到授权回调；opaque origin（sandbox iframe 等）取不到主机名，
     * 按不可信处理。
     */
    fun isTrustedOrigin(origin: String?, expectedHost: String): Boolean {
        if (expectedHost.isEmpty()) return false
        val host = try {
            URI(origin ?: return false).host
        } catch (_: Exception) {
            return false
        }
        return host?.equals(expectedHost, ignoreCase = true) == true
    }
}
