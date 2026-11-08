package com.fshake.dshremote

import com.fshake.dshremote.web.WebBack
import com.fshake.dshremote.web.WebCompat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 返回键脚本与页面标记的契约：标记改名、层名改字或判断顺序被调换时，这里先亮红灯。
 */
class WebCompatScriptTest {

    private val script = WebCompat.backDismissScript

    @Test
    fun `脚本回报的层名与解析表一致`() {
        // 脚本每个分支都 return '层名'；用正则把它抽出来，和 WebBack 认得的那组名字对齐。
        // 改坏一个 return 字面量（例如 right 写成 rightbar）会在这里当场失败。
        val returned = Regex("""return '([a-z]+)'""")
            .findAll(script)
            .map { it.groupValues[1] }
            .toSet()
        assertEquals(WebBack.names + WebBack.NONE, returned)
    }

    @Test
    fun `脚本按从高到低的层级顺序判断`() {
        val order = listOf(
            "[role=\"menu\"]",
            "[role=\"listbox\"]",
            "[data-shortcut-modal=\"sidebar\"]",
            "[data-sidebar-mask]",
            "[data-dockkit-float]",
            "[data-sidebar-right-panel=\"fullscreen\"]",
        )
        val positions = order.map { marker ->
            val index = script.indexOf(marker)
            assertTrue("脚本缺少 $marker", index >= 0)
            index
        }
        assertEquals("判断顺序应与层级一致", positions.sorted(), positions)
    }

    @Test
    fun `返回键脚本认得各类官方浮层标记`() {
        listOf(
            "[role=\"menu\"]",
            "[role=\"listbox\"]",
            "[role=\"dialog\"][aria-modal=\"true\"]",
            // 左侧抽屉也带 aria-modal，必须从对话框分支里排除，否则会被当成「已关闭」
            ":not([data-shortcut-modal=\"sidebar\"])",
            "[data-sidebar-mask]",
            "data-sidebar-collapsed",
            "[data-sidebar-right-panel=\"fullscreen\"]",
            "data-sidebar-right-open",
            "[data-dockkit-float]",
            "data-dockkit-float-dock",
            "getClientRects",
            "key: 'Escape'",
            "bubbles: true",
            "'none'",
        ).forEach { marker ->
            assertTrue("脚本缺少 $marker", script.contains(marker))
        }
    }

    @Test
    fun `脚本不把会自动消失的提示当成浮层`() {
        assertFalse(script.contains("role=\"tooltip\""))
        assertFalse(script.contains("role=\"status\""))
    }
}
