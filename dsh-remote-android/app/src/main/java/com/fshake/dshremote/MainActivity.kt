package com.fshake.dshremote

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.mutableIntStateOf
import com.fshake.dshremote.ui.common.installImeTargetListener
import com.fshake.dshremote.ui.nav.AppRoot
import com.fshake.dshremote.ui.theme.DshRemoteTheme

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val container = (application as DshRemoteApp).container
        // 键盘的终点高度：动画一开始就拿到，页面布局只跟着变一次
        val imeBottom = mutableIntStateOf(0)
        installImeTargetListener(window, imeBottom)
        setContent {
            DshRemoteTheme {
                AppRoot(container, imeBottom)
            }
        }
    }
}
