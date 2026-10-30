package com.fshake.dshremote.ui.hostedit

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.fshake.dshremote.core.HostUrl
import com.fshake.dshremote.core.HostUrlResult
import com.fshake.dshremote.core.LayoutPolicy
import com.fshake.dshremote.data.HostEntry
import com.fshake.dshremote.data.HostRepository

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HostEditScreen(
    existing: HostEntry?,
    repository: HostRepository,
    onDone: () -> Unit,
) {
    var name by remember { mutableStateOf(existing?.name.orEmpty()) }
    var url by remember { mutableStateOf(existing?.baseUrl.orEmpty()) }
    var error by remember { mutableStateOf<String?>(null) }

    fun save() {
        when (val parsed = HostUrl.parse(url)) {
            is HostUrlResult.Error -> error = parsed.message
            is HostUrlResult.Ok -> {
                val result = if (existing == null) {
                    repository.add(name, parsed.normalized).map { }
                } else {
                    repository.update(existing.id, name, parsed.normalized)
                }
                result.fold(
                    onSuccess = { onDone() },
                    onFailure = { error = it.message ?: "保存失败" },
                )
            }
        }
    }

    Scaffold(
        topBar = {
            CompactTopBar(
                title = if (existing == null) "添加主机" else "编辑主机",
                onBack = onDone,
            )
        },
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
        ) {
            Column(
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .widthIn(max = LayoutPolicy.MAX_FORM_WIDTH_DP.dp)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 24.dp, vertical = 16.dp),
            ) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it.take(HostRepository.MAX_NAME_LENGTH) },
                    label = { Text("名称") },
                    placeholder = { Text("留空则使用主机名") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = url,
                    onValueChange = {
                        url = it
                        error = null
                    },
                    label = { Text("主机地址") },
                    placeholder = { Text("https://dsn.example.com") },
                    singleLine = true,
                    isError = error != null,
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Uri,
                        imeAction = ImeAction.Done,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    text = "只支持 https；路径与查询参数会被忽略",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 8.dp),
                )
                error?.let {
                    Text(
                        text = it,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
                Spacer(Modifier.height(24.dp))
                Button(
                    onClick = ::save,
                    enabled = url.isNotBlank(),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("保存")
                }
            }
        }
    }
}


