package com.fshake.dshremote

import android.app.Application
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStoreFile
import com.fshake.dshremote.auth.CipherBox
import com.fshake.dshremote.auth.CookieBridge
import com.fshake.dshremote.auth.LoginClient
import com.fshake.dshremote.auth.PasswordVault
import com.fshake.dshremote.auth.SecretStore
import com.fshake.dshremote.data.HostRepository
import com.fshake.dshremote.data.HostStore
import com.fshake.dshremote.data.KeyValueStorage
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import java.security.KeyStore
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class DshRemoteApp : Application() {

    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}

/** 依赖装配。全局单例，页面按需取用。 */
class AppContainer(context: Context) {

    private val appContext = context.applicationContext

    val repository = HostRepository(HostStore(DataStoreKeyValueStorage(appContext)))
    val passwordVault = PasswordVault(SharedPreferencesSecretStore(appContext), AndroidCipherBox())
    val loginClient = LoginClient()

    // CookieManager 依赖 WebView 提供者，延迟到真正需要时再取，避免在 Application.onCreate 里提前初始化
    val cookieBridge: CookieBridge by lazy { CookieBridge() }
}

/**
 * 配置持久化。
 *
 * 读仍是同步的：整个进程只读一次（构造 HostRepository 时），之后状态都在内存里。
 * 写则丢到单线程里串行执行——它发生在点击、登录、退出这些交互路径上，
 * 留在主线程等于每次点主机都等一次磁盘。代价是进程被强杀时可能丢最后一次写入，
 * 丢的是「最近使用时间 / 到期时间」这类可恢复信息，可以接受。
 */
class DataStoreKeyValueStorage(context: Context) : KeyValueStorage {

    private val store = PreferenceDataStoreFactory.create(
        produceFile = { context.preferencesDataStoreFile("dsh_remote_settings") },
    )

    private val writer = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "dsh-settings-writer").apply { isDaemon = true }
    }

    override fun read(key: String): String? = runBlocking {
        store.data.first()[stringPreferencesKey(key)]
    }

    override fun write(key: String, value: String) {
        writer.execute {
            runBlocking {
                store.edit { it[stringPreferencesKey(key)] = value }
            }
        }
    }
}

class SharedPreferencesSecretStore(context: Context) : SecretStore {

    private val prefs = context.getSharedPreferences("dsh_remote_secrets", Context.MODE_PRIVATE)

    override fun get(key: String): String? = prefs.getString(key, null)

    override fun put(key: String, value: String) {
        prefs.edit().putString(key, value).apply()
    }

    override fun remove(key: String) {
        prefs.edit().remove(key).apply()
    }
}

/**
 * 密码加解密。密钥由 Android Keystore 生成与保管，不可导出；
 * 密文格式为 base64(iv):base64(cipher)。换机或密钥被清除时解密会抛异常，
 * 由 PasswordVault 统一降级为「没有保存过密码」。
 */
class AndroidCipherBox : CipherBox {

    override fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val encrypted = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" +
            Base64.encodeToString(encrypted, Base64.NO_WRAP)
    }

    override fun decrypt(blob: String): String {
        val parts = blob.split(':')
        require(parts.size == 2) { "密文格式不正确" }
        val iv = Base64.decode(parts[0], Base64.NO_WRAP)
        val data = Base64.decode(parts[1], Base64.NO_WRAP)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, iv))
        return String(cipher.doFinal(data), Charsets.UTF_8)
    }

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        val existing = keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry
        if (existing != null) return existing.secretKey

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    companion object {
        private const val KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "dsh_remote_password"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
