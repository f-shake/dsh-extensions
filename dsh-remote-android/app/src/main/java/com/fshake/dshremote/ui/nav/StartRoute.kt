package com.fshake.dshremote.ui.nav

import com.fshake.dshremote.data.AppState
import com.fshake.dshremote.data.HostEntry

/**
 * 冷启动、或进程被系统回收后重建时，应该直接回到哪台主机。
 *
 * `selectedHostId` 是「上次进入过的主机」：进入实例时写入，退回列表时清空，
 * 所以它记的正是用户离开那一刻停留的界面。主机已被删除时不恢复，回到列表。
 */
fun hostToRestore(state: AppState): HostEntry? =
    state.selectedHostId?.let { id -> state.hosts.firstOrNull { it.id == id } }
