package com.waexporter.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

private val DarkColorScheme = darkColorScheme(
    primary          = Teal80,
    onPrimary        = Teal20,
    primaryContainer = Teal30,
    onPrimaryContainer = Teal90,
    secondary        = Green80,
    onSecondary      = Green20,
    secondaryContainer = Green30,
    onSecondaryContainer = Green90,
    background       = DarkSurface,
    surface          = DarkSurface2,
    surfaceVariant   = DarkSurface3,
    error            = DeletedRed,
)

private val LightColorScheme = lightColorScheme(
    primary          = Teal40,
    onPrimary        = androidx.compose.ui.graphics.Color.White,
    primaryContainer = Teal90,
    onPrimaryContainer = Teal10,
    secondary        = Green40,
    onSecondary      = androidx.compose.ui.graphics.Color.White,
    secondaryContainer = Green90,
    onSecondaryContainer = Green10,
)

@Composable
fun WaExporterTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    val colorScheme = if (darkTheme) DarkColorScheme else LightColorScheme

    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            window.statusBarColor = colorScheme.background.toArgb()
            WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = !darkTheme
        }
    }

    MaterialTheme(
        colorScheme = colorScheme,
        typography  = AppTypography,
        content     = content
    )
}
