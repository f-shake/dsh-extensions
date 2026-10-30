package com.fshake.dshremote.auth

/** 键值存储与加解密的抽象；Android 实现见 DshRemoteApp，单测注入替身。 */
interface SecretStore {
    fun get(key: String): String?
    fun put(key: String, value: String)
    fun remove(key: String)
}

interface CipherBox {
    fun encrypt(plain: String): String
    fun decrypt(blob: String): String
}

/**
 * 记住密码的落地。
 *
 * 只存密文；解密失败（换机、密钥被系统清掉）就静默丢弃这一条，
 * 让用户重新输入 —— 报错给用户看没有任何可操作性。
 */
class PasswordVault(
    private val store: SecretStore,
    private val box: CipherBox,
) {

    fun save(hostId: String, password: String): Boolean {
        if (password.isEmpty()) {
            clear(hostId)
            return true
        }
        return try {
            store.put(key(hostId), box.encrypt(password))
            true
        } catch (_: Exception) {
            clear(hostId)
            false
        }
    }

    fun read(hostId: String): String? {
        val blob = store.get(key(hostId)) ?: return null
        return try {
            box.decrypt(blob)
        } catch (_: Exception) {
            store.remove(key(hostId))
            null
        }
    }

    fun has(hostId: String): Boolean = store.get(key(hostId)) != null

    fun clear(hostId: String) {
        store.remove(key(hostId))
    }

    private fun key(hostId: String): String = "pwd_$hostId"
}
