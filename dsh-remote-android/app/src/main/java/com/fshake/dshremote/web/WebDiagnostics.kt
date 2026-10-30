package com.fshake.dshremote.web

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 网页侧诊断信息的环形缓冲。
 *
 * 用户看不到 DevTools，白屏时唯一的证据来源就是这里：控制台报错、加载失败的请求、
 * 以及 WebView 版本。条数固定，避免长时间使用后无限增长。
 */
object WebDiagnostics {

    private const val CAPACITY = 200

    private val lines = ArrayDeque<String>()
    private val timeFormat = SimpleDateFormat("HH:mm:ss", Locale.getDefault())

    @Synchronized
    fun add(line: String) {
        if (line.isEmpty()) return
        lines.addLast("${timeFormat.format(Date())} $line")
        while (lines.size > CAPACITY) lines.removeFirst()
    }

    @Synchronized
    fun clear() {
        lines.clear()
    }

    @Synchronized
    fun snapshot(): String = if (lines.isEmpty()) {
        "暂无记录"
    } else {
        lines.joinToString("\n")
    }

    @Synchronized
    fun size(): Int = lines.size
}
