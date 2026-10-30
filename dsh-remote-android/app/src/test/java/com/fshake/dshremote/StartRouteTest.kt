package com.fshake.dshremote

import com.fshake.dshremote.data.AppState
import com.fshake.dshremote.data.HostEntry
import com.fshake.dshremote.ui.nav.hostToRestore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class StartRouteTest {

    private fun host(id: String) = HostEntry(
        id = id,
        name = id,
        baseUrl = "https://$id.example.com",
        createdAt = 1L,
    )

    @Test
    fun `上次停留的主机会被恢复`() {
        val nas = host("nas")
        val state = AppState(hosts = listOf(nas, host("work")), selectedHostId = "nas")

        assertEquals(nas, hostToRestore(state))
    }

    @Test
    fun `退回列表后不再恢复`() {
        val state = AppState(hosts = listOf(host("nas")), selectedHostId = null)

        assertNull(hostToRestore(state))
    }

    @Test
    fun `主机已被删除时回到列表`() {
        val state = AppState(hosts = listOf(host("nas")), selectedHostId = "gone")

        assertNull(hostToRestore(state))
    }
}
