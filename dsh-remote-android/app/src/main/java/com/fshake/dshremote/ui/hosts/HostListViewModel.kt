package com.fshake.dshremote.ui.hosts

import com.fshake.dshremote.data.AppState
import com.fshake.dshremote.data.HostEntry
import com.fshake.dshremote.data.HostRepository
import kotlin.math.ceil

/**
 * 主机列表的排序与状态文案。
 *
 * 排序与文案都是纯函数，直接按传入的状态与时间断言，不依赖 Android。
 */
class HostListViewModel(
    private val repository: HostRepository,
    private val now: () -> Long = System::currentTimeMillis,
) {

    fun hosts(state: AppState): List<HostEntry> = state.hosts.sortedWith(
        compareByDescending<HostEntry> { it.lastUsedAt }.thenBy { it.createdAt },
    )

    fun statusLabel(host: HostEntry, at: Long = now()): String {
        val expiresAt = host.sessionExpiresAt
        if (expiresAt <= 0L) return "需登录"
        val remaining = expiresAt - at
        if (remaining <= 0L) return "登录已过期"
        val days = ceil(remaining / DAY_MS.toDouble()).toInt()
        return if (days <= 0) "剩余不足 1 天" else "剩余 $days 天"
    }

    fun needsLogin(host: HostEntry, at: Long = now()): Boolean =
        host.sessionExpiresAt <= at

    fun toggleRememberPassword(enabled: Boolean) = repository.setRememberPassword(enabled)

    companion object {
        private const val DAY_MS = 24 * 60 * 60 * 1000L
    }
}
