package com.fshake.dshremote

import com.fshake.dshremote.web.WebCompat
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 视口单位垫片的契约。两个真机事故各留守卫：
 *
 * 1. 曾把带 vh 的规则抄进 `!important` 覆盖表，窄屏的 `height:100%` 被顶掉，
 *    设置浮层从全屏抽屉变成 800px 的居中弹窗。
 * 2. 设置浮层挂在 body 下、靠 `height:100%` 拿高度，而这类 WebView 的初始包含块高度是 0，
 *    没有定位祖先时百分比解析成 0，浮层塌成 0 高。
 *
 * 这里断言的是脚本的结构（调用的位置、参数、守卫先后），不只是「出现过某个词」：
 * 删掉关键调用、丢掉优先级、把守卫挪到写之后，都应该在这里失败。
 */
class WebCompatViewportTest {

    private val script = WebCompat.documentStartScript

    private fun at(marker: String): Int {
        val index = script.indexOf(marker)
        assertTrue("脚本缺少 $marker", index >= 0)
        return index
    }

    /** 取某个顶层函数的正文（到下一个两格缩进的右花括号为止）。 */
    private fun body(name: String): String {
        val start = at("function $name(")
        val end = script.indexOf("\n  }", start)
        assertTrue("找不到 $name 的结尾", end > start)
        return script.substring(start, end)
    }

    @Test
    fun `改写是就地设置属性并带上原优先级`() {
        // 整条调用要完整：属性名、按原值重算、原优先级缺一不可
        at("entry.style.setProperty(entry.prop, vhToPx(original.value, h), original.priority)")
        assertFalse("不得再插入 dsh-remote-vh 覆盖表", script.contains("dsh-remote-vh"))
        assertFalse("不得再拼 !important 覆盖值", script.contains("' !important;'"))
    }

    @Test
    fun `视口高度变化时真的把补丁写回去`() {
        // 这条调用是整段补丁的落点：删掉它，改写就变成死代码
        val rewrite = body("rewriteViewportUnits")
        val guard = rewrite.indexOf("if (!needsViewportFix()) return;")
        val scan = rewrite.indexOf("scanViewportUnits();")
        val apply = rewrite.indexOf("applyViewportUnits(h);")
        assertTrue("缺守卫", guard >= 0)
        assertTrue("缺扫描", scan >= 0)
        assertTrue("缺落点", apply >= 0)
        assertTrue("守卫必须在写之前", guard < apply)
        assertTrue("必须先扫描再写", scan < apply)
    }

    @Test
    fun `100vh 与 innerHeight 对不上才算坏且按视口高度缓存`() {
        // 只判「等于 0」会把旋转后缓存了旧高度的设备误判成健康
        val broken = body("viewportBroken")
        assertTrue(broken.contains("Math.abs(measured - inner) > 1"))
        assertTrue(broken.contains("height:100vh"))
        // 判定落在 resize 热路径上：视口高度没变就复用上次结论，别每次都强制整页布局
        assertTrue(broken.contains("inner === vhBrokenAt"))
    }

    @Test
    fun `写过补丁之后不再因判定翻转而撒手`() {
        // 一旦写过，某次误判成「健康」把补丁冻住比一直修更糟
        assertTrue(body("needsViewportFix").contains("vhPatched ||"))
        val guards = Regex("""if \(!needsViewportFix\(\)\) return;""").findAll(script).count()
        assertTrue("改写与钉高各需一道 needsViewportFix 守卫，实际 $guards 道", guards >= 2)
        assertTrue(body("pinLayoutHeight").contains("vhPatched = true;"))
    }

    @Test
    fun `视口坏掉时把 body 变成定位祖先`() {
        at("body{position:relative}")
        at("html,body,#root{height:100%}")
        // 选择器必须是 body：设置浮层就挂在 body 下，改 #root 接不住
        assertFalse(script.contains("#root{position:relative}"))
    }

    @Test
    fun `改写记录原值以便视口变化后重算`() {
        at("WeakMap")
        at("record[prop] = { value: value, priority: priority }")
    }

    @Test
    fun `页面重建样式表时会重新扫描并丢掉失效声明`() {
        // 原地改写最怕页面把 <style> 内容整体换掉：声明对象作废，补丁失效
        at("characterData")
        at("node.nodeType === 3 && node.parentNode && node.parentNode.tagName === 'STYLE'")
        // <link> 原地换 href / 切 media 也是换表
        at("attributeFilter: ['href', 'media', 'disabled']")
        // 失效的声明对象必须剪掉，否则每次 resize 的循环越来越长
        at("live.has(vhRules[k].style)")
        at("vhSeen.delete(vhRules[k].style)")
    }

    @Test
    fun `暂时 disabled 的样式表不被当成失效`() {
        // 切主题靠 sheet.disabled：按「本轮可见」剪枝会把原值一起删掉，重新启用就接不上了
        val scan = body("scanViewportUnits")
        assertFalse("扫描时不得跳过 disabled 的表", scan.contains("sheet.disabled"))
    }

    @Test
    fun `不动字符串与 url 里的 vh 字样`() {
        at("url\\(|[\"']")
    }

    @Test
    fun `返回键脚本不受视口改动影响`() {
        assertTrue(WebCompat.backDismissScript.contains("[data-sidebar-mask]"))
        assertFalse("视口脚本不该混进返回键的选择器", script.contains("[data-sidebar-mask]"))
    }
}
