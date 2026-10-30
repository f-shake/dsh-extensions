package com.fshake.dshremote.data

import kotlinx.serialization.Serializable

/** 一台可远程连接的主机。baseUrl 只保留归一化后的 origin。 */
@Serializable
data class HostEntry(
    val id: String,
    val name: String,
    val baseUrl: String,
    val createdAt: Long,
    val lastUsedAt: Long = 0L,
    val sessionExpiresAt: Long = 0L,
)

@Serializable
data class AppState(
    val hosts: List<HostEntry> = emptyList(),
    val selectedHostId: String? = null,
    val rememberPassword: Boolean = true,
)
