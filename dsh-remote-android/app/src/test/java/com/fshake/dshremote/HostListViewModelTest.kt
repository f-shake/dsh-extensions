package com.fshake.dshremote

import com.fshake.dshremote.data.AppState
import com.fshake.dshremote.data.HostEntry
import com.fshake.dshremote.data.HostRepository
import com.fshake.dshremote.data.HostStore
import com.fshake.dshremote.ui.hosts.HostListViewModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HostListViewModelTest {

    private val storage = InMemoryStorage()
    private val now = 1_800_000_000_000L
    private val day = 24 * 60 * 60 * 1000L

    private fun repository(): HostRepository = HostRepository(
        store = HostStore(storage),
        now = { now },
    )

    private fun host(
        id: String = "h1",
        expiresAt: Long = 0L,
        lastUsedAt: Long = 0L,
        createdAt: Long = 1L,
    ) = HostEntry(
        id = id,
        name = id,
        baseUrl = "https://$id.example.com",
        createdAt = createdAt,
        lastUsedAt = lastUsedAt,
        sessionExpiresAt = expiresAt,
    )

    @Test
    fun `未登录显示需登录`() {
        val viewModel = HostListViewModel(repository(), now = { now })
        assertEquals("需登录", viewModel.statusLabel(host(expiresAt = 0L)))
    }

    @Test
    fun `已过期显示登录已过期`() {
        val viewModel = HostListViewModel(repository(), now = { now })
        assertEquals("登录已过期", viewModel.statusLabel(host(expiresAt = now - 1000)))
    }

    @Test
    fun `剩余时间按天向上取整`() {
        val viewModel = HostListViewModel(repository(), now = { now })
        assertEquals("剩余 3 天", viewModel.statusLabel(host(expiresAt = now + 3 * day)))
        assertEquals("剩余 1 天", viewModel.statusLabel(host(expiresAt = now + day / 2)))
    }

    @Test
    fun `是否需要登录与到期时间一致`() {
        val viewModel = HostListViewModel(repository(), now = { now })
        assertTrue(viewModel.needsLogin(host(expiresAt = now - 1)))
        assertFalse(viewModel.needsLogin(host(expiresAt = now + day)))
    }

    @Test
    fun `最近使用的主机排在前面`() {
        val viewModel = HostListViewModel(repository(), now = { now })
        val state = AppState(
            hosts = listOf(
                host(id = "a", lastUsedAt = 0, createdAt = 1),
                host(id = "b", lastUsedAt = 100, createdAt = 2),
                host(id = "c", lastUsedAt = 50, createdAt = 3),
            ),
        )

        assertEquals(listOf("b", "c", "a"), viewModel.hosts(state).map { it.id })
    }

    @Test
    fun `从未使用的主机按创建顺序排列`() {
        val viewModel = HostListViewModel(repository(), now = { now })
        val state = AppState(
            hosts = listOf(
                host(id = "late", lastUsedAt = 0, createdAt = 20),
                host(id = "early", lastUsedAt = 0, createdAt = 10),
            ),
        )

        assertEquals(listOf("early", "late"), viewModel.hosts(state).map { it.id })
    }

    @Test
    fun `记住密码开关写回仓库`() {
        val repository = repository()
        val viewModel = HostListViewModel(repository, now = { now })

        viewModel.toggleRememberPassword(false)

        assertEquals(false, repository.state.value.rememberPassword)
    }
}
