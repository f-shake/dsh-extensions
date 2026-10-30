package com.fshake.dshremote.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val BrandBlue = Color(0xFF2563EB)
private val BrandTeal = Color(0xFF0F9A8A)

private val LightColors = lightColorScheme(
    primary = BrandBlue,
    secondary = BrandTeal,
    background = Color(0xFFFFFFFF),
    surface = Color(0xFFF7F8FA),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF7BA6FF),
    secondary = Color(0xFF56C9BC),
    background = Color(0xFF101418),
    surface = Color(0xFF171C22),
)

@Composable
fun DshRemoteTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        content = content,
    )
}
