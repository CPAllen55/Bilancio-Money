package com.bilanciomoney.bilancio.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val Light = lightColorScheme(
    primary = Gold,
    onPrimary = Color.White,
    secondary = Navy,
    onSecondary = Color.White,
    background = Paper,
    onBackground = Navy,
    surface = Color.White,
    onSurface = Navy,
    surfaceVariant = Color(0xFFEDE6D6),
    onSurfaceVariant = Color(0xFF55606F),
)

private val Dark = darkColorScheme(
    primary = GoldPale,
    onPrimary = Navy,
    secondary = GoldPale,
    background = Night,
    onBackground = Color(0xFFE9E4D8),
    surface = NightCard,
    onSurface = Color(0xFFE9E4D8),
    surfaceVariant = Color(0xFF223049),
    onSurfaceVariant = Color(0xFFAAB3C2),
)

/**
 * Bilancio's own colours, not the phone's wallpaper.
 *
 * The template turned on dynamic colour, which repaints the app in whatever the
 * user's wallpaper suggests. Right for a launcher; wrong for an app whose green
 * and red mean money in and money out, and whose gold is the brand.
 */
@Composable
fun BilancioTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) Dark else Light,
        typography = Typography,
        content = content,
    )
}
