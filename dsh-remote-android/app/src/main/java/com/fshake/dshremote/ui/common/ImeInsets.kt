package com.fshake.dshremote.ui.common

import android.view.Window
import androidx.compose.runtime.MutableIntState
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat

/**
 * 键盘高度：动画一开始就换成终点值写进 [target]，布局因此只让位一次。
 *
 * 逐帧跟着动画长高会让整页每帧重排一遍（一次 500ms 的键盘动画有三十多次），
 * 页面越复杂越卡；而「动画结束后再跳」又会有一段页面被键盘盖住的时间。
 *
 * 方向只看**我们自己下发的值**：收起动画的 `upperBound` 仍报「完全展开」的高度，
 * 所以「终点 == 当前让位」是收起，其余都按终点处理（弹出、换成更高或更矮的键盘）。
 * 不能拿窗口 inset 判方向——有的 ROM 在回调触发时已经把它更新成终点值了。
 *
 * 另有一条兜底：键盘已经显示或撤销、却没有动画回调（Activity 重建时键盘还在、
 * 窗口失焦直接撤键盘），此时按窗口上报的真实 inset 校正，避免页面停在旧高度。
 * 这次校正必须推迟一帧：Android 16 上有 ROM 先派发终点 inset、同一毫秒内才回调
 * onStart，若当场采用，onStart 就会把自己的终点值误判成「收起」，页面先弹回再让位。
 */
fun installImeTargetListener(window: Window, target: MutableIntState) {
    val decor = window.decorView
    val imeType = WindowInsetsCompat.Type.ime()

    /** 此刻窗口上报的 IME 高度。 */
    fun currentImeInset(): Int =
        ViewCompat.getRootWindowInsets(decor)
            ?.getInsets(imeType)
            ?.bottom
            ?: 0

    /** 动画进行中以动画给出的终点为准，结束后交给窗口 inset 兜底。 */
    var animating = false

    ViewCompat.setOnApplyWindowInsetsListener(decor) { _, insets ->
        if (!animating) {
            val actual = insets.getInsets(imeType).bottom
            val current = target.intValue
            if (actual != current) {
                // 推一帧再采用，把优先权让给即将到来的 onStart；真的没有动画时由这次兜底校正。
                decor.post {
                    if (!animating && target.intValue == current) target.intValue = actual
                }
            }
        }
        insets
    }

    ViewCompat.setWindowInsetsAnimationCallback(
        decor,
        object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
            override fun onStart(
                animation: WindowInsetsAnimationCompat,
                bounds: WindowInsetsAnimationCompat.BoundsCompat,
            ): WindowInsetsAnimationCompat.BoundsCompat {
                if (animation.typeMask and imeType != 0) {
                    animating = true
                    val upper = bounds.upperBound.bottom.coerceAtLeast(0)
                    target.intValue = if (upper == target.intValue) 0 else upper
                }
                return bounds
            }

            override fun onProgress(
                insets: WindowInsetsCompat,
                runningAnimations: MutableList<WindowInsetsAnimationCompat>,
            ): WindowInsetsCompat = insets

            override fun onEnd(animation: WindowInsetsAnimationCompat) {
                if (animation.typeMask and imeType != 0) {
                    animating = false
                    target.intValue = currentImeInset().coerceAtLeast(0)
                }
            }
        },
    )
}
