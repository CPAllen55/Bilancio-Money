package com.bilanciomoney.bilancio.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.bilanciomoney.bilancio.Bilancio
import com.bilanciomoney.bilancio.Budget
import com.bilanciomoney.bilancio.asMoney
import com.bilanciomoney.bilancio.ui.theme.Negative
import com.bilanciomoney.bilancio.ui.theme.Positive
import java.time.YearMonth
import java.time.format.TextStyle
import java.util.Locale

/**
 * Income and spending, month by month, one behind the other -- the iPhone's
 * MoneyOverTime.
 *
 * Income is the wide bar behind; spending the narrow one in front. The gap
 * above the front bar is what the month keeps, and a month where the front bar
 * overtops the one behind is a month that did not -- the whole question,
 * answered without reading a figure. One chart rather than two, because the
 * sizes only mean anything against each other.
 *
 * Months to come are the plan, at full strength; months already over are drawn
 * faintly behind them. This screen is the plan, and the history is what it was
 * built from.
 */
@Composable
fun MoneyOverTime(b: Budget) {
    var picked by remember(b) { mutableStateOf<Int?>(null) }
    var showLastYear by LastYear

    data class Point(val month: YearMonth, val income: Long, val expense: Long, val projected: Boolean)
    val points = remember(b) {
        b.months.map { m ->
            /* A month has happened when income has a record for it: an absent
               month and a month of nothing both sum to zero, so the categories
               cannot say. */
            val earned = b.incomeSpent[m]
            Point(
                YearMonth.parse(m),
                earned ?: b.incomePlan[m] ?: 0L,
                if (earned == null) b.rows.sumOf { it.plan[m] ?: 0L } else b.rows.sumOf { it.spent[m] ?: 0L },
                earned == null,
            )
        }
    }

    /* Last year's actuals, shifted forward a year onto the months drawn here --
       from 24 months of Trend, which reaches the year-ago side of every month
       to come as well as those gone. Fetched quietly; without it the chart is
       simply the chart. */
    var lastYear by remember(b) { mutableStateOf<Map<YearMonth, Pair<Long, Long>>>(emptyMap()) }
    LaunchedEffect(b) {
        runCatching { Bilancio.trend(24) }.onSuccess { t ->
            val byMonth = t.series.associate { it.month to (it.income to it.expense) }
            lastYear = points.mapNotNull { p -> byMonth[p.month.minusYears(1)]?.let { p.month to it } }.toMap()
        }
    }

    Maximisable("Income and spending over time", 190.dp) { chartHeight, _ ->
        Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween, Alignment.CenterVertically) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Swatch(Positive.copy(alpha = 0.3f), wide = true); Text(" Income  ", style = MaterialTheme.typography.labelMedium)
                Swatch(Negative.copy(alpha = 0.95f), wide = false); Text(" Spending", style = MaterialTheme.typography.labelMedium)
            }
            LastYearToggle(showLastYear, lastYear.isNotEmpty()) { showLastYear = it }
        }

        val track = MaterialTheme.colorScheme.surfaceVariant
        val top = maxOf(
            points.maxOfOrNull { maxOf(it.income, it.expense) } ?: 0L,
            if (showLastYear) lastYear.values.maxOfOrNull { maxOf(it.first, it.second) } ?: 0L else 0L,
            1L,
        ).toFloat()

        Canvas(
            Modifier.fillMaxWidth().height(chartHeight).padding(top = 6.dp).pointerInput(b) {
                detectTapGestures { pos ->
                    val i = (pos.x / (size.width.toFloat() / points.size)).toInt().coerceIn(0, points.lastIndex)
                    picked = if (picked == i) null else i
                }
            },
        ) {
            val band = size.width / points.size
            val y = { v: Long -> size.height - size.height * (v / top) }
            points.forEachIndexed { i, p ->
                if (i == picked) drawRoundRect(track, Offset(i * band, 0f), Size(band, size.height), CornerRadius(6f))
                val wide = band * 0.94f
                val narrow = band * 0.44f
                drawRoundRect(
                    Positive.copy(alpha = if (p.projected) 0.3f else 0.16f),
                    Offset(i * band + (band - wide) / 2, y(p.income)), Size(wide, size.height - y(p.income)), CornerRadius(4f),
                )
                drawRoundRect(
                    Negative.copy(alpha = if (p.projected) 0.95f else 0.4f),
                    Offset(i * band + (band - narrow) / 2, y(p.expense)), Size(narrow, size.height - y(p.expense)), CornerRadius(4f),
                )
            }
            /* Last year as lines, not more bars -- three bars a month is a
               picket fence, and "higher or lower than then" is a shape. */
            if (showLastYear) {
                val at = points.map { lastYear[it.month] }
                yearAgoLine(at.map { it?.second }, band, y, Negative, dash = floatArrayOf(14f, 8f), square = false)
                yearAgoLine(at.map { it?.first }, band, y, Positive, dash = floatArrayOf(5f, 8f), square = true)
            }
        }
        Row(Modifier.fillMaxWidth()) {
            points.forEachIndexed { i, p ->
                Text(
                    p.month.month.getDisplayName(TextStyle.NARROW, Locale.getDefault()),
                    Modifier.weight(1f),
                    style = MaterialTheme.typography.labelSmall,
                    color = if (i == picked) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        /* One touch, both figures: a month is what the two bars answer, so a
           month is what a touch picks -- in, out, and the difference. */
        picked?.let { i ->
            val p = points[i]
            val net = p.income - p.expense
            val before = lastYear[p.month]
            Column(
                Modifier.fillMaxWidth().padding(top = 8.dp)
                    .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp))
                    .padding(horizontal = 10.dp, vertical = 6.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        p.month.month.getDisplayName(TextStyle.FULL, Locale.getDefault()) + " " + p.month.year +
                            /* Said, not left to a fade: a planned month read as a
                               record is the one mistake this chart can cause. */
                            if (p.projected) " · planned" else "",
                        Modifier.weight(1f),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(net.asMoney(false), fontWeight = FontWeight.SemiBold, color = if (net < 0) Negative else Positive)
                    TextButton(onClick = { picked = null }) { Text("✕") }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                    Figure("In", p.income, Positive)
                    Figure("Out", p.expense, Negative)
                    if (showLastYear && before != null) Figure("Out a year ago", before.second, MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }

        Text(
            "Solid months are the plan; faded months already happened. Where the narrow bar rises above the wide one, " +
                "the month spent more than it earned." + if (showLastYear) " Dashed lines are the same months a year ago." else "",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 8.dp),
        )
    }
}

@Composable
private fun Swatch(colour: Color, wide: Boolean) {
    Box(Modifier.size(width = if (wide) 14.dp else 7.dp, height = 10.dp).background(colour, RoundedCornerShape(2.dp)))
}

@Composable
private fun Figure(label: String, cents: Long, tint: Color) {
    Column {
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(cents.asMoney(false), style = MaterialTheme.typography.bodyMedium, color = tint)
    }
}

/* A year-ago line with a mark on each month; months with no record break it. */
private fun DrawScope.yearAgoLine(
    values: List<Long?>, band: Float, y: (Long) -> Float, colour: Color, dash: FloatArray, square: Boolean,
) {
    val path = Path()
    var drawing = false
    values.forEachIndexed { i, v ->
        if (v == null) { drawing = false; return@forEachIndexed }
        val x = i * band + band / 2
        if (drawing) path.lineTo(x, y(v)) else path.moveTo(x, y(v))
        drawing = true
    }
    drawPath(path, colour, style = Stroke(width = 4f, pathEffect = PathEffect.dashPathEffect(dash)))
    values.forEachIndexed { i, v ->
        if (v == null) return@forEachIndexed
        val c = Offset(i * band + band / 2, y(v))
        if (square) drawRect(colour, Offset(c.x - 5f, c.y - 5f), Size(10f, 10f)) else drawCircle(colour, 6f, c)
    }
}
