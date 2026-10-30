package com.fshake.dshremote

import com.fshake.dshremote.data.HostEntry
import com.fshake.dshremote.data.HostRepository
import com.fshake.dshremote.data.HostStore
import com.fshake.dshremote.data.KeyValueStorage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InMemoryStorage : KeyValueStorage {
    val map = mutableMapOf<String, String>()
    override fun read(key: String): String? = map[key]
    override fun write(key: String, value: String) {
        map[key] = value
    }
}

class HostRepositoryTest {

    private val storage = InMemoryStorage()
    private var clock = 1_800_000_000_000L

    private fun repository(): HostRepository = HostRepository(
        store = HostStore(storage),
        now = { clock++ },
    )

    @Test
    fun `空存储时预置两台主机`() {
        val repository = repository()
        assertEquals(2, repository.state.value.hosts.size)
        assertEquals("https://dsn.example.com", repository.state.value.hosts[0].baseUrl)
        assertEquals("https://dw.example.com", repository.state.value.hosts[1].baseUrl)
    }

    @Test
    fun `新增主机时名称留空回落为主机名`() {
        val repository = repository()
        val added = repository.add("", "https://new.example.com").getOrThrow()

        assertEquals("new.example.com", added.name)
        assertEquals(3, repository.state.value.hosts.size)
    }

    @Test
    fun `重复地址被拒绝`() {
        val repository = repository()
        val result = repository.add("重复", "https://dsn.example.com")

        assertTrue(result.isFailure)
        assertEquals("该主机已存在", result.exceptionOrNull()?.message)
    }

    @Test
    fun `名称超长被截断`() {
        val repository = repository()
        val added = repository.add("x".repeat(80), "https://new.example.com").getOrThrow()

        assertEquals(HostRepository.MAX_NAME_LENGTH, added.name.length)
    }

    @Test
    fun `更新名称与地址`() {
        val repository = repository()
        val preset = repository.state.value.hosts.first()

        val result = repository.update(preset.id, "改名", "https://renamed.example.com")

        assertTrue(result.isSuccess)
        val updated = repository.host(preset.id)!!
        assertEquals("改名", updated.name)
        assertEquals("https://renamed.example.com", updated.baseUrl)
    }

    @Test
    fun `更新成已存在的地址被拒绝`() {
        val repository = repository()
        val preset = repository.state.value.hosts.first()

        val result = repository.update(preset.id, "改名", "https://dw.example.com")

        assertTrue(result.isFailure)
        assertEquals("该主机已存在", result.exceptionOrNull()?.message)
    }

    @Test
    fun `更新不存在的主机返回失败`() {
        val result = repository().update("missing", "x", "https://x.example.com")
        assertEquals("主机不存在", result.exceptionOrNull()?.message)
    }

    @Test
    fun `改地址会清掉旧会话`() {
        val repository = repository()
        repository.setSessionExpiry("preset-nas", 9_999L)

        repository.update("preset-nas", "改名", "https://other.example.com")

        assertEquals(0L, repository.host("preset-nas")!!.sessionExpiresAt)
    }

    @Test
    fun `只改名字不动会话`() {
        val repository = repository()
        repository.setSessionExpiry("preset-nas", 9_999L)

        repository.update("preset-nas", "新名字", "https://dsn.example.com")

        assertEquals(9_999L, repository.host("preset-nas")!!.sessionExpiresAt)
    }

    @Test
    fun `删除主机同时清掉选中项`() {
        val repository = repository()
        val preset = repository.state.value.hosts.first()
        repository.select(preset.id)

        repository.remove(preset.id)

        assertNull(repository.host(preset.id))
        assertNull(repository.state.value.selectedHostId)
        assertEquals(1, repository.state.value.hosts.size)
    }

    @Test
    fun `最近使用的主机排到最前`() {
        val repository = repository()
        repository.markUsed("preset-work")

        assertEquals("preset-work", repository.sortedHosts().first().id)
        assertEquals("preset-work", repository.state.value.selectedHostId)
    }

    @Test
    fun `写入与清除会话到期时间`() {
        val repository = repository()
        repository.setSessionExpiry("preset-nas", 1234L)
        assertEquals(1234L, repository.host("preset-nas")!!.sessionExpiresAt)

        repository.clearSession("preset-nas")
        assertEquals(0L, repository.host("preset-nas")!!.sessionExpiresAt)
    }

    @Test
    fun `记住密码开关被持久化`() {
        val repository = repository()
        repository.setRememberPassword(false)

        assertEquals(false, repository.state.value.rememberPassword)
        assertEquals(false, repository().state.value.rememberPassword)
    }

    @Test
    fun `重建仓库后数据仍在`() {
        val repository = repository()
        repository.add("新机", "https://new.example.com")
        repository.setSessionExpiry("preset-nas", 999L)

        val reopened = repository()

        assertEquals(3, reopened.state.value.hosts.size)
        assertEquals(999L, reopened.host("preset-nas")!!.sessionExpiresAt)
    }

    @Test
    fun `存储内容损坏时回到预置状态`() {
        storage.map[HostStore.KEY] = "{ not json"

        val repository = repository()

        assertEquals(2, repository.state.value.hosts.size)
    }

    @Test
    fun `主机数据模型默认值符合预期`() {
        val entry = HostEntry(id = "a", name = "n", baseUrl = "https://a.com", createdAt = 1L)
        assertEquals(0L, entry.lastUsedAt)
        assertEquals(0L, entry.sessionExpiresAt)
    }
}
