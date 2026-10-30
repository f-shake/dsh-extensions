package com.fshake.dshremote.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.UUID

/**
 * 主机列表的增删改与状态写入。
 *
 * 这里只管「列表里有什么、状态是什么」，不负责地址合法性（由 core.HostUrl 判定），
 * 也不负责界面状态（由 ViewModel 持有）。
 */
class HostRepository(
    private val store: HostStore,
    private val now: () -> Long = System::currentTimeMillis,
    private val newId: () -> String = { UUID.randomUUID().toString() },
) {

    private val _state = MutableStateFlow(store.load())
    val state: StateFlow<AppState> = _state.asStateFlow()

    fun host(id: String): HostEntry? = _state.value.hosts.firstOrNull { it.id == id }

    /** 最近使用优先，未使用过的按创建顺序排在后面。 */
    fun sortedHosts(): List<HostEntry> = _state.value.hosts.sortedWith(
        compareByDescending<HostEntry> { it.lastUsedAt }.thenBy { it.createdAt },
    )

    fun add(name: String, normalizedUrl: String): Result<HostEntry> {
        if (_state.value.hosts.any { it.baseUrl.equals(normalizedUrl, ignoreCase = true) }) {
            return Result.failure(IllegalArgumentException("该主机已存在"))
        }
        val fallbackName = normalizedUrl.substringAfter("://").substringBefore('/')
        val entry = HostEntry(
            id = newId(),
            name = name.trim().ifEmpty { fallbackName }.take(MAX_NAME_LENGTH),
            baseUrl = normalizedUrl,
            createdAt = now(),
        )
        mutate { it.copy(hosts = it.hosts + entry) }
        return Result.success(entry)
    }

    fun update(id: String, name: String, normalizedUrl: String): Result<Unit> {
        val current = host(id) ?: return Result.failure(IllegalArgumentException("主机不存在"))
        if (_state.value.hosts.any { it.id != id && it.baseUrl.equals(normalizedUrl, ignoreCase = true) }) {
            return Result.failure(IllegalArgumentException("该主机已存在"))
        }
        val fallbackName = normalizedUrl.substringAfter("://").substringBefore('/')
        val updated = current.copy(
            name = name.trim().ifEmpty { fallbackName }.take(MAX_NAME_LENGTH),
            baseUrl = normalizedUrl,
            // 地址换了，旧会话属于旧主机，留着会被当成「还能直接进网页」
            sessionExpiresAt = if (normalizedUrl == current.baseUrl) current.sessionExpiresAt else 0L,
        )
        mutate { state -> state.copy(hosts = state.hosts.map { if (it.id == id) updated else it }) }
        return Result.success(Unit)
    }

    fun remove(id: String) {
        mutate { state ->
            state.copy(
                hosts = state.hosts.filterNot { it.id == id },
                selectedHostId = state.selectedHostId?.takeIf { it != id },
            )
        }
    }

    fun select(id: String?) {
        mutate { it.copy(selectedHostId = id) }
    }

    fun markUsed(id: String) {
        val usedAt = now()
        mutate { state ->
            state.copy(
                selectedHostId = id,
                hosts = state.hosts.map { if (it.id == id) it.copy(lastUsedAt = usedAt) else it },
            )
        }
    }

    fun setSessionExpiry(id: String, expiresAt: Long) {
        mutate { state ->
            state.copy(hosts = state.hosts.map { if (it.id == id) it.copy(sessionExpiresAt = expiresAt) else it })
        }
    }

    fun clearSession(id: String) {
        mutate { state ->
            state.copy(hosts = state.hosts.map { if (it.id == id) it.copy(sessionExpiresAt = 0L) else it })
        }
    }

    fun setRememberPassword(enabled: Boolean) {
        mutate { it.copy(rememberPassword = enabled) }
    }

    private fun mutate(block: (AppState) -> AppState) {
        val next = block(_state.value)
        _state.value = next
        store.save(next)
    }

    companion object {
        const val MAX_NAME_LENGTH = 40
    }
}
