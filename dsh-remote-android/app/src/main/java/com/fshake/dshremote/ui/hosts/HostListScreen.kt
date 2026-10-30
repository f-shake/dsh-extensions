package com.fshake.dshremote.ui.hosts

import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.fshake.dshremote.ui.common.CompactIconSize
import com.fshake.dshremote.ui.common.CompactTopBar
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.fshake.dshremote.core.LayoutPolicy
import com.fshake.dshremote.data.AppState
import com.fshake.dshremote.data.HostEntry

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HostListScreen(
    state: AppState,
    viewModel: HostListViewModel,
    onOpen: (HostEntry) -> Unit,
    onEdit: (HostEntry) -> Unit,
    onSignOut: (HostEntry) -> Unit,
    onDelete: (HostEntry) -> Unit,
    onAdd: () -> Unit,
) {
    val context = LocalContext.current
    var pendingDelete by remember { mutableStateOf<HostEntry?>(null) }
    var showSettings by remember { mutableStateOf(false) }
    val hosts = remember(state) { viewModel.hosts(state) }

    Scaffold(
        topBar = {
            CompactTopBar(
                title = "DSH 远程",
                actions = {
                    IconButton(
                        onClick = { showSettings = true },
                        modifier = Modifier.size(CompactIconSize),
                    ) {
                        Icon(Icons.Outlined.Settings, contentDescription = "设置")
                    }
                },
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = onAdd,
                icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                text = { Text("添加主机") },
            )
        },
    ) { innerPadding ->
        BoxWithConstraints(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
        ) {
            val widthDp = maxWidth.value.toInt()
            val columns = LayoutPolicy.hostListColumns(widthDp)
            val contentWidth = LayoutPolicy.listContentWidth(widthDp).dp

            if (hosts.isEmpty()) {
                EmptyHosts(onAdd)
            } else {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
                    LazyVerticalGrid(
                        columns = GridCells.Fixed(columns),
                        modifier = Modifier
                            .width(contentWidth)
                            .fillMaxHeight(),
                        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 96.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        items(hosts, key = { it.id }) { host ->
                            HostCard(
                                host = host,
                                statusLabel = viewModel.statusLabel(host),
                                needsLogin = viewModel.needsLogin(host),
                                onOpen = { onOpen(host) },
                                onEdit = { onEdit(host) },
                                onSignOut = { onSignOut(host) },
                                onDelete = { pendingDelete = host },
                            )
                        }
                    }
                }
            }
        }
    }

    pendingDelete?.let { host ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text("删除主机") },
            text = { Text("将从列表中删除 ${host.name}，已保存的登录状态与密码也会一并清理。") },
            confirmButton = {
                TextButton(onClick = {
                    pendingDelete = null
                    onDelete(host)
                }) { Text("删除") }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) { Text("取消") }
            },
        )
    }

    if (showSettings) {
        AlertDialog(
            onDismissRequest = { showSettings = false },
            title = { Text("设置") },
            text = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("记住密码")
                        Text(
                            "密码由系统密钥库加密保存，只省略输入；动态验证码仍需每次登录时填写。",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(
                        checked = state.rememberPassword,
                        onCheckedChange = {
                            viewModel.toggleRememberPassword(it)
                            Toast.makeText(
                                context,
                                if (it) "已开启记住密码" else "已关闭记住密码",
                                Toast.LENGTH_SHORT,
                            ).show()
                        },
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = { showSettings = false }) { Text("关闭") }
            },
        )
    }
}

@Composable
private fun EmptyHosts(onAdd: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("还没有主机", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(8.dp))
        Text(
            "添加一台 DSH 主机地址，例如 https://dsn.example.com",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(16.dp))
        TextButton(onClick = onAdd) { Text("添加主机") }
    }
}

@Composable
private fun HostCard(
    host: HostEntry,
    statusLabel: String,
    needsLogin: Boolean,
    onOpen: () -> Unit,
    onEdit: () -> Unit,
    onSignOut: () -> Unit,
    onDelete: () -> Unit,
) {
    var menuExpanded by remember { mutableStateOf(false) }

    Surface(
        onClick = onOpen,
        shape = MaterialTheme.shapes.medium,
        tonalElevation = 1.dp,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(start = 16.dp, top = 12.dp, bottom = 12.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = host.name,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = host.baseUrl.removePrefix("https://"),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    text = statusLabel,
                    style = MaterialTheme.typography.labelMedium,
                    color = if (needsLogin) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                )
            }
            Box {
                IconButton(onClick = { menuExpanded = true }) {
                    Icon(Icons.Filled.MoreVert, contentDescription = "更多操作")
                }
                DropdownMenu(expanded = menuExpanded, onDismissRequest = { menuExpanded = false }) {
                    DropdownMenuItem(text = { Text("编辑") }, onClick = {
                        menuExpanded = false
                        onEdit()
                    })
                    DropdownMenuItem(text = { Text("退出登录") }, onClick = {
                        menuExpanded = false
                        onSignOut()
                    })
                    DropdownMenuItem(text = { Text("删除") }, onClick = {
                        menuExpanded = false
                        onDelete()
                    })
                }
            }
        }
    }
}

