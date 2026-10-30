package com.fshake.dshremote

import com.fshake.dshremote.auth.LoginReason
import com.fshake.dshremote.auth.SessionGate
import com.fshake.dshremote.auth.StartDecision
import com.fshake.dshremote.data.HostEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionGateTest {

    private val now = 1_800_000_000_000L

    private fun host(expiresAt: Long) = HostEntry(
        id = "h1",
        name = "h1",
        baseUrl = "https://h1.example.com",
        createdAt = 1L,
        sessionExpiresAt = expiresAt,
    )

    private fun reasonFor(expiresAt: Long): StartDecision.NeedLogin {
        val decision = SessionGate.decide(host(expiresAt), now)
        assertTrue("期望需要登录，实际 $decision", decision is StartDecision.NeedLogin)
        return decision as StartDecision.NeedLogin
    }

    @Test
    fun `从未登录时按首次登录处理`() {
        assertEquals(LoginReason.FIRST_TIME, reasonFor(0L).reason)
    }

    @Test
    fun `会话已过期时按过期处理`() {
        assertEquals(LoginReason.EXPIRED, reasonFor(now - 1_000L).reason)
    }

    @Test
    fun `距到期不足一分钟视为需要登录`() {
        assertEquals(LoginReason.EXPIRED, reasonFor(now + 59_000L).reason)
    }

    @Test
    fun `正好卡在余量边界上仍要求登录`() {
        assertEquals(LoginReason.EXPIRED, reasonFor(now + SessionGate.EXPIRY_SKEW_MS).reason)
    }

    @Test
    fun `余量之外直接进网页`() {
        assertEquals(
            StartDecision.OpenWeb,
            SessionGate.decide(host(now + SessionGate.EXPIRY_SKEW_MS + 1L), now),
        )
    }
}
