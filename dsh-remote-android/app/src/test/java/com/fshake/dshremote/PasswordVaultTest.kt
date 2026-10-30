package com.fshake.dshremote

import com.fshake.dshremote.auth.CipherBox
import com.fshake.dshremote.auth.PasswordVault
import com.fshake.dshremote.auth.SecretStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FakeSecretStore : SecretStore {
    val map = mutableMapOf<String, String>()
    override fun get(key: String): String? = map[key]
    override fun put(key: String, value: String) {
        map[key] = value
    }

    override fun remove(key: String) {
        map.remove(key)
    }
}

class FakeCipherBox : CipherBox {
    var failEncrypt = false
    var failDecrypt = false

    override fun encrypt(plain: String): String {
        if (failEncrypt) throw IllegalStateException("密钥库不可用")
        return "enc:$plain"
    }

    override fun decrypt(blob: String): String {
        if (failDecrypt) throw IllegalStateException("解密失败")
        if (!blob.startsWith("enc:")) throw IllegalArgumentException("格式不正确")
        return blob.removePrefix("enc:")
    }
}

class PasswordVaultTest {

    private val store = FakeSecretStore()
    private val cipher = FakeCipherBox()
    private val vault = PasswordVault(store, cipher)

    @Test
    fun `保存后能读回原文`() {
        assertTrue(vault.save("host-1", "secret"))
        assertEquals("secret", vault.read("host-1"))
    }

    @Test
    fun `存储里只有密文`() {
        vault.save("host-1", "secret")
        // 明文不能以任何形式落进存储
        assertFalse(store.map.values.any { it == "secret" })
        assertEquals("enc:secret", store.get("pwd_host-1"))
    }

    @Test
    fun `未保存过返回 null`() {
        assertNull(vault.read("host-2"))
        assertFalse(vault.has("host-2"))
    }

    @Test
    fun `清除后读不到`() {
        vault.save("host-1", "secret")
        vault.clear("host-1")

        assertNull(vault.read("host-1"))
        assertFalse(vault.has("host-1"))
    }

    @Test
    fun `保存空密码等于清除`() {
        vault.save("host-1", "secret")
        assertTrue(vault.save("host-1", ""))

        assertNull(vault.read("host-1"))
    }

    @Test
    fun `加密失败时返回 false 且不留下半条记录`() {
        cipher.failEncrypt = true

        assertFalse(vault.save("host-1", "secret"))
        assertNull(store.get("pwd_host-1"))
    }

    @Test
    fun `解密失败时静默丢弃该条记录`() {
        vault.save("host-1", "secret")
        cipher.failDecrypt = true

        assertNull(vault.read("host-1"))
        assertNull(store.get("pwd_host-1"))
    }

    @Test
    fun `不同主机互不影响`() {
        vault.save("host-1", "one")
        vault.save("host-2", "two")

        assertEquals("one", vault.read("host-1"))
        assertEquals("two", vault.read("host-2"))

        vault.clear("host-1")
        assertEquals("two", vault.read("host-2"))
    }
}
