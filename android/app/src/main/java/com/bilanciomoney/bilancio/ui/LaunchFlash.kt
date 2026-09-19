package com.bilanciomoney.bilancio.ui

import android.provider.Settings
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.ui.graphics.luminance
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import com.bilanciomoney.bilancio.R
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/**
 * The owl, still, with the light moving across his chart -- the iPhone's
 * LaunchFlash, from the same two pictures and the same measurements.
 *
 * It covers the moment the app is doing its least interesting work -- Clerk
 * restoring the session -- so the wait becomes the mark rather than a spinner.
 * The drawing arrives whole and fades in; then one band of lighter gold crosses
 * the five stacks from left to right, each taking the light and handing it on,
 * so it is the money that glints and not the owl.
 *
 * `owl_launch` is the drawing with the icon's plate taken off; `owl_field` is
 * that drawing blurred until only its gold ground is left, carried out tall
 * enough for any phone, so the owl never sits in a visible rectangle. Both are
 * drawn at the full width of the screen and centred, which puts every point of
 * the field exactly where it was blurred from. See ios/.../LaunchFlash.swift.
 *
 * Drawn over the app rather than before it, so signing in carries on beneath.
 */
@Composable
fun LaunchFlash(onDone: () -> Unit) {
    val context = LocalContext.current
    val field = ImageBitmapRes(R.drawable.owl_field)
    val owl = ImageBitmapRes(R.drawable.owl_launch)
    /* The app's own appearance, which may differ from the phone's. */
    val dark = androidx.compose.material3.MaterialTheme.colorScheme.background.luminance() < 0.5f

    val settled = remember { Animatable(0f) }
    val fade = remember { Animatable(1f) }
    val glow = remember { List(STACKS.size) { Animatable(0f) } }

    LaunchedEffect(Unit) {
        /* Animations switched off on the phone are a request not to be moved
           at: the drawing still arrives, the light does not travel. */
        val still = Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        if (still) {
            settled.snapTo(1f)
            delay(900)
        } else {
            settled.animateTo(1f, tween(340, easing = LinearOutSlowInEasing))
            /* Long enough for the drawing to be seen before the light moves. */
            delay(750 - 340)
            /* Left to right, each stack a breath behind the one before. */
            glow.forEachIndexed { i, a ->
                launch {
                    delay(i * 140L)
                    a.animateTo(1f, tween(400, easing = FastOutSlowInEasing))
                    a.animateTo(0f, tween(450, easing = FastOutSlowInEasing))
                }
            }
            delay(1450 + 260)
        }
        fade.animateTo(0f, tween(300))
        onDone()
    }

    Canvas(Modifier.fillMaxSize()) {
        val w = size.width
        val scale = w / ART_W
        val artH = ART_H * scale
        val fieldH = FIELD_H * scale
        val originY = (size.height - artH) / 2
        val a = fade.value

        drawImage(
            field,
            dstOffset = IntOffset(0, ((size.height - fieldH) / 2).roundToInt()),
            dstSize = IntSize(w.roundToInt(), fieldH.roundToInt()),
            alpha = a,
            filterQuality = FilterQuality.High,
        )
        drawImage(
            owl,
            dstOffset = IntOffset(0, originY.roundToInt()),
            dstSize = IntSize(w.roundToInt(), artH.roundToInt()),
            alpha = settled.value * a,
            filterQuality = FilterQuality.High,
        )
        /* Gold with the light on it, not white, which would grey the chart. */
        STACKS.forEachIndexed { i, (from, to) ->
            val top = originY + TOPS[i] * scale
            drawRect(
                SHEEN.copy(alpha = glow[i].value * PEAK * a),
                Offset(from * scale, top),
                Size((to - from) * scale, originY + artH - top),
            )
        }
        /* A full screen of gold is a lot of gold at night. */
        if (dark) drawRect(Color.Black.copy(alpha = 0.18f * a))
    }
}

@Composable
private fun ImageBitmapRes(id: Int) = androidx.compose.ui.graphics.ImageBitmap.imageResource(id)

/* owl_launch and owl_field, in their own pixels. */
private const val ART_W = 764f
private const val ART_H = 824f
private const val FIELD_H = 1900f

/* x range of each stack, measured against the outlines (not the shadows), and
   the painted top of each -- so the light crosses the chart, not the air. */
private val STACKS = listOf(120f to 202f, 219f to 315f, 333f to 429f, 450f to 549f, 571f to 673f)
private val TOPS = listOf(743f, 681f, 613f, 562f, 515f)

private const val PEAK = 0.45f
private val SHEEN = Color(1.0f, 0.94f, 0.74f)
