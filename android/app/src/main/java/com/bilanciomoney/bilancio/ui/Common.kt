package com.bilanciomoney.bilancio.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.bilanciomoney.bilancio.Ranges
import com.bilanciomoney.bilancio.asMoney
import java.time.YearMonth

/** The period every money screen shows: a month, and how many months back. */
data class Period(val month: YearMonth = YearMonth.now(), val trailing: Int = 1) {
    val key get() = Ranges.key(month, trailing)
}

/**
 * One way of loading a screen, so every screen fails the same way.
 *
 * A failure is shown as the sentence the server sent -- the Worker's `reason` is
 * written to be read by a person ("Your free trial has ended...") and burying it
 * under a status code helps nobody. `key` reloads when it changes.
 */
@Composable
fun <T> Loader(
    key: Any?,
    load: suspend () -> T,
    content: @Composable (T, reload: () -> Unit) -> Unit,
) {
    var value by remember(key) { mutableStateOf<T?>(null) }
    var error by remember(key) { mutableStateOf<String?>(null) }
    var attempt by remember { mutableIntStateOf(0) }

    LaunchedEffect(key, attempt) {
        error = null
        runCatching { load() }
            .onSuccess { value = it }
            .onFailure { error = it.message ?: "Something went wrong." }
    }

    val reload = { attempt += 1 }
    val current = value
    when {
        error != null && current == null -> Column(
            Modifier.fillMaxSize().padding(24.dp),
            Arrangement.Center,
            Alignment.CenterHorizontally,
        ) {
            Text(error!!, style = MaterialTheme.typography.bodyLarge)
            Spacer(Modifier.height(16.dp))
            Button(onClick = reload) { Text("Try again") }
        }
        current == null -> Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
        else -> content(current, reload)
    }
}

/** Month menu and the trailing 1 / 3 / 6 / 12 control, as on the web and iPhone. */
@Composable
fun PeriodBar(period: Period, onChange: (Period) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        Box {
            TextButton(onClick = { open = true }) {
                Text(Ranges.label(period.month) + "  ▾", style = MaterialTheme.typography.titleMedium)
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                Ranges.recent().forEach { m ->
                    DropdownMenuItem(
                        text = { Text(Ranges.label(m)) },
                        onClick = { open = false; onChange(period.copy(month = m)) },
                    )
                }
            }
        }
        val options = listOf(1, 3, 6, 12)
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            options.forEachIndexed { i, n ->
                SegmentedButton(
                    selected = period.trailing == n,
                    onClick = { onChange(period.copy(trailing = n)) },
                    shape = SegmentedButtonDefaults.itemShape(i, options.size),
                ) { Text(if (n == 1) "1 month" else "$n months") }
            }
        }
    }
}

/**
 * A bar against a plan: the fill is what happened, the tick is the plan.
 *
 * Scaled to whichever is larger, so an overspent category runs to the end and
 * the tick sits inside it -- the same reading as the web app's bars, where the
 * tick overhangs the bar so it can be seen against any fill.
 */
@Composable
fun PlanBar(actual: Long, plan: Long?, colour: Color, modifier: Modifier = Modifier) {
    val scale = maxOf(actual, plan ?: 0L, 1L).toFloat()
    val fill = (actual / scale).coerceIn(0f, 1f)
    val tick = plan?.let { (it / scale).coerceIn(0f, 1f) }
    Box(modifier.fillMaxWidth().height(14.dp)) {
        Box(
            Modifier.fillMaxWidth().height(8.dp).align(Alignment.Center)
                .clip(RoundedCornerShape(4.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant),
        )
        Box(
            Modifier.fillMaxWidth(fill).height(8.dp).align(Alignment.CenterStart)
                .clip(RoundedCornerShape(4.dp))
                .background(colour),
        )
        if (tick != null) {
            TickAt(tick)
        }
    }
}

@Composable
private fun TickAt(fraction: Float) {
    var width by remember { mutableIntStateOf(0) }
    val density = LocalDensity.current
    Box(
        Modifier.fillMaxWidth().fillMaxHeight()
            .onSizeChanged { width = it.width },
    ) {
        val x = with(density) { (width * fraction).toDp() - 1.5.dp }
        Box(
            Modifier.offset(x = x).width(3.dp).fillMaxHeight()
                .background(MaterialTheme.colorScheme.onSurface),
        )
    }
}

/**
 * A thick bar with its figure written inside it -- "$5,200 earned of $7,000" --
 * and the plan marked by a tick that overhangs the bar, green on the income side
 * and red on the spending side, as the web draws them.
 *
 * The caption is drawn twice, once over the track and once over the fill,
 * clipped to the fill, so it stays readable wherever the fill ends.
 *
 * Net can be negative: in deficit the fill is the size of the loss against the
 * plan, in red.
 */
@Composable
fun ProportionBar(
    label: String?,
    amount: Long,
    planned: Long,
    fallbackScale: Long,
    tint: Color,
    verb: String,
    incomeSide: Boolean,
) {
    val magnitude = kotlin.math.abs(amount)
    val scale = maxOf(if (planned > 0) maxOf(magnitude, planned) else fallbackScale, 1L).toFloat()
    val fill = (magnitude / scale).coerceIn(0f, 1f)
    val mark = if (planned > 0) (planned / scale).coerceIn(0f, 1f) else null
    val caption = if (planned > 0) "${amount.asMoney(false)} $verb of ${planned.asMoney(false)}"
        else "${amount.asMoney(false)} $verb"
    val markColour = if (incomeSide) Color(0xFF3FE08F) else Color(0xFFFF7F93)

    Column(Modifier.fillMaxWidth()) {
        if (label != null) {
            Text(
                label.uppercase(),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(4.dp))
        }
        Box(Modifier.fillMaxWidth().height(32.dp)) {
            val shape = RoundedCornerShape(7.dp)
            Box(
                Modifier.fillMaxWidth().height(26.dp).align(Alignment.Center)
                    .clip(shape).background(tint.copy(alpha = 0.16f)),
                contentAlignment = Alignment.CenterStart,
            ) {
                Text(caption, Modifier.padding(horizontal = 10.dp), maxLines = 1,
                    style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
            }
            Box(
                Modifier.fillMaxWidth(fill).height(26.dp).align(Alignment.CenterStart)
                    .clip(shape).background(tint),
                contentAlignment = Alignment.CenterStart,
            ) {
                Text(caption, Modifier.padding(horizontal = 10.dp).wrapContentWidth(Alignment.Start, unbounded = true),
                    color = Color.White, maxLines = 1, softWrap = false,
                    style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
            }
            if (mark != null) MarkAt(mark, markColour)
        }
    }
}

@Composable
private fun MarkAt(fraction: Float, colour: Color) {
    var width by remember { mutableIntStateOf(0) }
    val density = LocalDensity.current
    Box(Modifier.fillMaxWidth().fillMaxHeight().onSizeChanged { width = it.width }) {
        val x = with(density) { (width * fraction).toDp() - 2.dp }
        Box(
            Modifier.offset(x = x).width(4.dp).fillMaxHeight()
                .clip(RoundedCornerShape(2.dp))
                .background(colour),
        )
    }
}

@Composable
fun SectionTitle(text: String) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(top = 20.dp, bottom = 8.dp),
    )
}

@Composable
fun Dot(colour: Color) {
    Box(Modifier.width(10.dp).height(10.dp).clip(RoundedCornerShape(5.dp)).background(colour))
}

@Composable
fun LabelledRow(left: @Composable () -> Unit, right: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween, Alignment.CenterVertically) {
        left(); right()
    }
}
