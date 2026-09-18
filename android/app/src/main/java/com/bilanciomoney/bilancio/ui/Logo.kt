package com.bilanciomoney.bilancio.ui

import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.bilanciomoney.bilancio.Bilancio
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

/**
 * Merchant art, fetched from our own origin -- never from Plaid's CDN.
 *
 * The API sends a filename, not a URL, and it has to stay that way. Loading
 * Plaid's logo_url directly would work and would quietly break what SECURITY.md
 * and the privacy policy both say: that the app makes no third-party requests.
 * Forty logos would be forty requests carrying the reader's IP address and, by
 * the filename, the name of a merchant they bank with.
 *
 * /api/logo/:file is public merchant art behind a strict filename allowlist, so
 * it needs no token. Held in memory for the life of the process; the Worker's
 * cache and the phone's own HTTP cache sit behind it.
 */
private object Logos {
    /* A remembered miss as well as a hit: most merchants have no art, and
       asking again every time the list scrolls would be a request per row. */
    private val cache = LruCache<String, Result<ImageBitmap>>(300)

    fun cached(file: String): Result<ImageBitmap>? = cache.get(file)

    suspend fun load(file: String): ImageBitmap? {
        cache.get(file)?.let { return it.getOrNull() }
        val result = withContext(Dispatchers.IO) {
            runCatching {
                val c = URL("${Bilancio.BASE_URL}/api/logo/$file").openConnection() as HttpURLConnection
                c.connectTimeout = 10_000
                c.readTimeout = 15_000
                c.useCaches = true
                try {
                    if (c.responseCode != 200) error("no logo")
                    c.inputStream.use { BitmapFactory.decodeStream(it) }?.asImageBitmap() ?: error("unreadable")
                } finally {
                    c.disconnect()
                }
            }
        }
        cache.put(file, result)
        return result.getOrNull()
    }
}

/**
 * The logo, or the merchant's first letter tinted to its category -- which is
 * what a person uses to find a row in a list they are scanning, and the
 * ordinary case rather than a failure, since many merchants have no art.
 */
@Composable
fun MerchantLogo(file: String?, name: String, tint: Color, size: Dp = 32.dp) {
    var image by remember(file) { mutableStateOf(file?.let { Logos.cached(it)?.getOrNull() }) }
    if (file != null && image == null) {
        LaunchedEffect(file) { image = Logos.load(file) }
    }
    val shape = RoundedCornerShape(size * 0.24f)
    Box(
        Modifier.size(size).clip(shape)
            .background(if (image != null) Color.White else tint.copy(alpha = 0.16f))
            .border(0.5.dp, MaterialTheme.colorScheme.outlineVariant, shape),
        contentAlignment = Alignment.Center,
    ) {
        val img = image
        if (img != null) {
            Image(img, contentDescription = null, modifier = Modifier.size(size))
        } else {
            Text(
                name.trim().take(1).uppercase(),
                color = tint,
                fontWeight = FontWeight.SemiBold,
                fontSize = (size.value * 0.45f).sp,
            )
        }
    }
}
