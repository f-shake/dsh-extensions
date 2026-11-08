package com.fshake.dshremote

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableIntStateOf
import com.fshake.dshremote.ui.common.installImeTargetListener
import com.fshake.dshremote.ui.nav.AppRoot
import com.fshake.dshremote.ui.theme.DshRemoteTheme

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // 屏幕常亮：看的是远处那台机器上的进度，屏幕自己灭掉会让人以为连接断了。
        // 只在本窗口可见时生效，退回桌面或被别的应用盖住后系统照常息屏。
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val container = (application as DshRemoteApp).container
        // 键盘的终点高度：动画一开始就拿到，页面布局只跟着变一次
        val imeBottom = mutableIntStateOf(0)
        installImeTargetListener(window, imeBottom)
        setContent {
            val darkTheme = isSystemInDarkTheme()
            // uiMode 在 configChanges 里：系统切换深浅色时 Activity 不会重建，
            // 而窗口装饰（状态栏/导航栏图标明暗）只在 onCreate 设过一次。
            // 以 Compose 主题为唯一来源重设一次，避免浅色主题下留着白色图标。
            LaunchedEffect(darkTheme) { enableEdgeToEdge() }
            DshRemoteTheme(darkTheme = darkTheme) {
                AppRoot(container, imeBottom)
            }
        }
    }
}
