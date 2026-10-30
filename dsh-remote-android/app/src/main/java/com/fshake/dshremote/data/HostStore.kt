package com.fshake.dshremote.data

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** 同步键值存储的抽象；实现放在 Android 侧，单测用内存替身。 */
interface KeyValueStorage {
    fun read(key: String): String?
    fun write(key: String, value: String)
}

/**
 * 主机配置的序列化与持久化。
 *
 * 首次运行时预置两台主机；此后以存储内容为准，删掉预置项不会自动长回来。
 * 解析失败时同样回到预置状态 —— 与其让应用起不来，不如让用户重新确认一次主机。
 */
class HostStore(private val storage: KeyValueStorage) {

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    fun load(): AppState {
        val raw = storage.read(KEY) ?: return presetState().also { save(it) }
        return try {
            json.decodeFromString<AppState>(raw)
        } catch (_: Exception) {
            presetState().also { save(it) }
        }
    }

    fun save(state: AppState) {
        storage.write(KEY, json.encodeToString(state))
    }

    companion object {
        const val KEY = "app_state_v1"
        const val PRESET_NAS_URL = "https://dsn.example.com"
        const val PRESET_WORK_URL = "https://dw.example.com"

        fun presetState(createdAt: Long = System.currentTimeMillis()): AppState = AppState(
            hosts = listOf(
                HostEntry(
                    id = "preset-nas",
                    name = "dsn",
                    baseUrl = PRESET_NAS_URL,
                    createdAt = createdAt,
                ),
                HostEntry(
                    id = "preset-work",
                    name = "dw",
                    baseUrl = PRESET_WORK_URL,
                    createdAt = createdAt + 1,
                ),
            ),
        )
    }
}
