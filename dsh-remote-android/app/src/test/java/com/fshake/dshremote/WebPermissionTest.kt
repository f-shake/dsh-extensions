package com.fshake.dshremote

import com.fshake.dshremote.web.WebPermission
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebPermissionTest {

    // 框架 PermissionRequest.RESOURCE_* 的取值，独立写一份当规格：
    // 生产代码引用框架常量，所以取值一旦变化，这里的断言就会红
    private val audio = "android.webkit.resource.AUDIO_CAPTURE"
    private val video = "android.webkit.resource.VIDEO_CAPTURE"

    @Test
    fun `只申请音频时放行`() {
        assertTrue(WebPermission.isAudioOnly(arrayOf(audio)))
    }

    @Test
    fun `不含音频或混合请求一律拒绝`() {
        assertFalse(WebPermission.isAudioOnly(null))
        assertFalse(WebPermission.isAudioOnly(emptyArray()))
        assertFalse(WebPermission.isAudioOnly(arrayOf(video)))
        assertFalse(WebPermission.isAudioOnly(arrayOf(video, audio)))
    }

    @Test
    fun `放行时只回音频`() {
        assertArrayEquals(arrayOf(audio), WebPermission.grants())
    }

    @Test
    fun `同主机名的来源可信`() {
        assertTrue(WebPermission.isTrustedOrigin("https://dsh-nas.fshake.com", "dsh-nas.fshake.com"))
        assertTrue(WebPermission.isTrustedOrigin("https://DSH-NAS.fshake.com:8791", "dsh-nas.fshake.com"))
    }

    @Test
    fun `跨域与取不到主机名的来源不可信`() {
        assertFalse(WebPermission.isTrustedOrigin("https://evil.example.com", "dsh-nas.fshake.com"))
        assertFalse(WebPermission.isTrustedOrigin(null, "dsh-nas.fshake.com"))
        assertFalse(WebPermission.isTrustedOrigin("", "dsh-nas.fshake.com"))
        assertFalse(WebPermission.isTrustedOrigin("https://dsh-nas.fshake.com", ""))
    }
}
