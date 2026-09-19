package com.bilanciomoney.bilancio.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.bilanciomoney.bilancio.R
import androidx.compose.runtime.setValue
import androidx.compose.material3.FilterChip
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.bilanciomoney.bilancio.Category
import com.bilanciomoney.bilancio.Ranges
import com.bilanciomoney.bilancio.Bilancio
import com.bilanciomoney.bilancio.Trend
import com.bilanciomoney.bilancio.TrendMonth
import com.bilanciomoney.bilancio.asMoney
import com.bilanciomoney.bilancio.ui.theme.Negative
import com.bilanciomoney.bilancio.ui.theme.Positive
import java.time.YearMonth
import java.time.format.TextStyle
import java.util.Locale

/**
 * Spending month by month, stacked by category, with the month a year earlier
 * under each figure -- the comparison the web Trend and the iPhone make,
 * because "is this a lot?" is only answered against a like month.
 *
 * Tapping a segment names it -- category, amount, its share of the month and
 * the same month a year earlier -- and pressing and sliding scrubs across
 * segments, as the iPhone does; the key under the chart picks one out too. The
 * readout opens that category: its subcategories, stacked in its place (Back
 * closes them), or -- for one with none -- its transactions, just below.
 *
 * No list by category and no month summary here: Overview has both.
 */
@Composable
fun TrendScreen(onCategory: (slug: String, label: String, month: YearMonth) -> Unit) {
    var months by remember { mutableIntStateOf(12) }
    /* The range is set once and then read past, so it scrolls away with the
       page rather than holding the top of the screen. */
    val range: @Composable () -> Unit = {
        val options = listOf(6, 12, 24)
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(vertical = 16.dp)) {
            options.forEachIndexed { i, n ->
                SegmentedButton(
                    selected = months == n,
                    onClick = { months = n },
                    shape = SegmentedButtonDefaults.itemShape(i, options.size),
                ) { Text("$n months") }
            }
        }
    }
    Loader(months, { Bilancio.trend(months) }) { t: Trend, _ -> TrendContent(t, range, onCategory) }
}

@Composable
private fun TrendContent(t: Trend, range: @Composable () -> Unit, onCategory: (String, String, YearMonth) -> Unit) {
    if (t.series.isEmpty()) {
        Column(Modifier.padding(horizontal = 16.dp)) {
            range()
            Text("Nothing to chart yet.")
        }
        return
    }
    var picked by remember(t) { mutableIntStateOf(t.series.lastIndex) }
    /* The category that has been opened, or null for all of them. */
    var focus by remember(t) { mutableStateOf<Category?>(null) }
    var listing by remember(t) { mutableStateOf<String?>(null) }
    /* The segment touched on the chart: its category slug, in month `picked`. */
    var hit by remember(t, focus) { mutableStateOf<String?>(null) }
    var showLastYear by LastYear
    BackHandler(enabled = focus != null) { focus = null }

    val bySlug = remember(t) { t.categories.associateBy { it.slug } }
    val parents = remember(t) { t.categories.filter { it.parentSlug == null && it.kind == "spend" } }

    /* What is stacked: the parents, or the opened category's subcategories. */
    val slices: List<Category> = focus?.let { f -> t.categories.filter { it.parentSlug == f.slug } } ?: parents
    val valueOf: (TrendMonth?, String) -> Long = { m, slug ->
        if (m == null) 0L else if (focus == null) m.byParent[slug] ?: 0L else m.byCategory[slug] ?: 0L
    }
    /* One fixed order in every column, largest overall first, so a slice sits
       in the same place month after month and a change in height stands out. */
    val order = slices.sortedByDescending { c -> t.series.sumOf { valueOf(it, c.slug) } }
    val columnTotal: (TrendMonth) -> Long = { m -> order.sumOf { valueOf(m, it.slug) } }
    val top = maxOf(t.series.maxOf(columnTotal), 1L).toFloat()
    val track = MaterialTheme.colorScheme.surfaceVariant

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
        range()
        focus?.let { f ->
            Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween, Alignment.CenterVertically) {
                AssistChip(onClick = { focus = null }, label = { Text("Show all categories") })
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Dot(Color(f.colour)); Spacer(Modifier.width(6.dp))
                    Text(f.label, fontWeight = FontWeight.SemiBold)
                }
            }
            Spacer(Modifier.height(6.dp))
        }

        val m = t.series[picked]
        val before = t.prior.getOrNull(picked)

        Maximisable(if (focus == null) "Spend by category" else "Inside ${focus!!.label}", 200.dp) { chartHeight, close ->
                val ago: List<Long> = t.series.indices.map { i ->
                    t.prior.getOrNull(i)?.let { p -> order.sumOf { valueOf(p, it.slug) } } ?: 0L
                }
                LastYearToggle(showLastYear, available = ago.any { it > 0 }) { showLastYear = it }
                val top = maxOf(top, if (showLastYear) (ago.maxOrNull() ?: 0L).toFloat() else 0f)
                /* Which segment a point lands on: the column from x, then the
                   figure from y, found by stacking that month's categories in
                   the order they were drawn until the running total passes it.
                   Above the stack is empty space, and names nothing. */
                fun touch(x: Float, y: Float, w: Float, h: Float) {
                    val i = (x / (w / t.series.size)).toInt().coerceIn(0, t.series.lastIndex)
                    picked = i
                    val value = (h - y) / h * top
                    var running = 0f
                    hit = null
                    for (c in order) {
                        val v = valueOf(t.series[i], c.slug)
                        if (v <= 0) continue
                        running += v
                        if (value <= running) { hit = c.slug; break }
                    }
                }
                Canvas(
                    Modifier.fillMaxWidth().height(chartHeight)
                        .pointerInput(t, focus) {
                            detectTapGestures { pos -> touch(pos.x, pos.y, size.width.toFloat(), size.height.toFloat()) }
                        }
                        /* A press held before sliding, so an ordinary swipe
                           still scrolls the page rather than scrubbing. */
                        .pointerInput(t, focus) {
                            detectDragGesturesAfterLongPress(
                                onDragStart = { pos -> touch(pos.x, pos.y, size.width.toFloat(), size.height.toFloat()) },
                                onDrag = { change, _ ->
                                    touch(change.position.x, change.position.y.coerceIn(0f, size.height.toFloat()),
                                        size.width.toFloat(), size.height.toFloat())
                                },
                            )
                        },
                ) {
                    val band = size.width / t.series.size
                    val barW = band * 0.64f
                    t.series.forEachIndexed { i, m ->
                        val x = i * band + (band - barW) / 2
                        if (i == picked) {
                            drawRoundRect(track, Offset(i * band, 0f), Size(band, size.height), CornerRadius(6f))
                        }
                        var y = size.height
                        order.forEach { c ->
                            val v = valueOf(m, c.slug)
                            if (v <= 0) return@forEach
                            val h = size.height * (v / top)
                            y -= h
                            /* The touched category stays full strength in every
                               month, so its own shape across the year shows. */
                            val alpha = if (hit == null || hit == c.slug) 1f else 0.3f
                            drawRect(Color(c.colour).copy(alpha = alpha), Offset(x, y), Size(barW, h))
                        }
                    }
                    /* Last year as one line through the bars: a line has a
                       shape, and the shape is the answer. Months with nothing
                       a year ago are left out, not drawn at zero -- a line on
                       the floor claims a year that spent nothing. */
                    if (showLastYear) {
                        drawYearAgo(ago.map { if (it > 0) it.toFloat() else null }, band) { v -> size.height - size.height * (v / top) }
                    }
                }
                MonthLabels(t.series, picked)
                /* The key: which colour is which, in the stack's own order.
                   Tapping one picks it out, as touching its segment does. */
                Legend(order.filter { c -> t.series.any { valueOf(it, c.slug) > 0 } }, hit) { slug ->
                    hit = if (hit == slug) null else slug
                }

        hit?.let { slug ->
            val c = bySlug[slug] ?: return@let
            val amount = valueOf(m, slug)
            val total = columnTotal(m)
            val yearAgo = valueOf(before, slug)
            val kids = t.categories.any { it.parentSlug == slug }
            androidx.compose.material3.HorizontalDivider(Modifier.padding(top = 8.dp))
            run {
                Row(
                    /* The readout is the way through, not just a label: it
                       already names a category and a month, which is all the
                       drill-down needs. */
                    Modifier.fillMaxWidth().clickable {
                        if (focus == null && kids) { focus = c; listing = null }
                        /* Transactions open just below the chart, so a
                           full-screen chart steps aside to show them. */
                        else { listing = slug; close() }
                        hit = null
                    }.padding(vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Dot(Color(c.colour)); Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text(c.label, fontWeight = FontWeight.SemiBold)
                        Text(
                            m.month.month.getDisplayName(TextStyle.FULL, Locale.getDefault()) +
                                (if (total > 0) " · ${amount * 100 / total}% of spending" else "") +
                                (if (yearAgo > 0) " · ${yearAgo.asMoney(false)} a year ago" else ""),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Text(amount.asMoney(false), fontWeight = FontWeight.SemiBold)
                    Text("  ›", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    TextButton(onClick = { hit = null }) { Text("✕") }
                }
            }
        }
        }
        /* A category's transactions for the picked month, opened from the
           readout -- the way through from a segment to what made it. */
        listing?.let { slug ->
            val c = bySlug[slug] ?: return@let
            Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween, Alignment.CenterVertically) {
                SectionTitle(c.label + " · " + m.month.month.getDisplayName(TextStyle.FULL, Locale.getDefault()))
                TextButton(onClick = { listing = null }) { Text("✕") }
            }
            Card(Modifier.fillMaxWidth()) {
                InlineTransactions(Ranges.key(m.month, 1), slug, Color(c.colour), indent = 12.dp)
            }
        }

        NetChart(t, showLastYear, onLastYear = { showLastYear = it })
        RunningTotalChart(t)
        YearAgoCard(t)

        Spacer(Modifier.height(24.dp))
    }
}

/**
 * The chart's key, as the iPhone draws it under the stack. The one picked out
 * on the chart is shown picked out here too.
 */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun Legend(items: List<Category>, picked: String?, onTap: (String) -> Unit) {
    androidx.compose.foundation.layout.FlowRow(
        Modifier.fillMaxWidth().padding(top = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        items.forEach { c ->
            val dim = picked != null && picked != c.slug
            Row(
                Modifier.clickable { onTap(c.slug) }.padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Dot(Color(c.colour).copy(alpha = if (dim) 0.3f else 1f)); Spacer(Modifier.width(5.dp))
                Text(
                    c.label,
                    style = MaterialTheme.typography.labelMedium,
                    color = if (dim) MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f)
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                    fontWeight = if (picked == c.slug) FontWeight.SemiBold else FontWeight.Normal,
                )
            }
        }
    }
}

/* ------------------------------------------------------------ shared bits -- */

/** One Last year switch for every chart that can draw it, as on the iPhone:
    somebody who wants the comparison wants it wherever they are reading. */
val LastYear = mutableStateOf(false)

@Composable
fun LastYearToggle(on: Boolean, available: Boolean, onChange: (Boolean) -> Unit) {
    /* Hidden rather than disabled when there is no year to compare with: a
       switch that does nothing is a question about what is broken. */
    if (!available) return
    FilterChip(selected = on, onClick = { onChange(!on) }, label = { Text("Last year") })
}

private val quiet = Color(0xFF8A8F98)

/** The dashed year-ago line with a bullet on each month; nulls break it. */
private fun DrawScope.drawYearAgo(values: List<Float?>, band: Float, y: (Float) -> Float) {
    val path = Path()
    var drawing = false
    values.forEachIndexed { i, v ->
        if (v == null) { drawing = false; return@forEachIndexed }
        val x = i * band + band / 2
        if (drawing) path.lineTo(x, y(v)) else path.moveTo(x, y(v))
        drawing = true
    }
    drawPath(path, quiet, style = Stroke(width = 4f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(12f, 9f))))
    values.forEachIndexed { i, v -> if (v != null) drawCircle(quiet, 6f, Offset(i * band + band / 2, y(v))) }
}

@Composable
private fun MonthLabels(series: List<TrendMonth>, picked: Int?) {
    Row(Modifier.fillMaxWidth()) {
        series.forEachIndexed { i, m ->
            val show = series.size <= 12 || i % 3 == 0
            Text(
                if (show) m.month.month.getDisplayName(TextStyle.NARROW, Locale.getDefault()) else "",
                Modifier.weight(1f),
                style = MaterialTheme.typography.labelSmall,
                color = if (i == picked) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** What a touched month came to, with the way to put it away. */
@Composable
private fun Readout(month: YearMonth, value: Long, caption: String, secondary: Long?, tint: Color, onClose: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(
                month.month.getDisplayName(TextStyle.FULL, Locale.getDefault()) + " " + month.year,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(verticalAlignment = Alignment.Bottom) {
                Text(value.asMoney(false), fontWeight = FontWeight.SemiBold, color = tint)
                Text("  " + caption, style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (secondary != null) {
                Text("${secondary.asMoney(false)} a year ago", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        TextButton(onClick = onClose) { Text("✕") }
    }
}

private fun tintFor(cents: Long) = if (cents < 0) Negative else Positive

/* ------------------------------------------------------ net, month by month -- */

/**
 * What each month kept: in less out, green above the line and red below. The
 * months that went backwards are the ones worth finding at a glance, which is
 * why each bar is coloured for itself.
 */
@Composable
private fun NetChart(t: Trend, showLastYear: Boolean, onLastYear: (Boolean) -> Unit) {
    var picked by remember(t) { mutableStateOf<Int?>(null) }
    val net = t.series.map { it.income - it.expense }
    /* Every month plotted whatever its sign, zero included: a year that broke
       even is a finding, not a gap. */
    val ago: List<Long?> = t.series.indices.map { i -> t.prior.getOrNull(i)?.let { it.income - it.expense } }
    val agoAny = ago.any { it != null && it != 0L }
    val shown = net + if (showLastYear) ago.filterNotNull() else emptyList()
    val hi = maxOf(shown.maxOrNull() ?: 0L, 0L).toFloat()
    val lo = minOf(shown.minOrNull() ?: 0L, 0L).toFloat()
    val span = maxOf(hi - lo, 1f)
    val axis = MaterialTheme.colorScheme.outlineVariant

    Maximisable("Net, month by month", 170.dp) { chartHeight, _ ->
        run {
            LastYearToggle(showLastYear, agoAny, onLastYear)
            Canvas(
                Modifier.fillMaxWidth().height(chartHeight).pointerInput(t) {
                    detectTapGestures { pos ->
                        picked = (pos.x / (size.width.toFloat() / t.series.size)).toInt().coerceIn(0, t.series.lastIndex)
                    }
                },
            ) {
                val band = size.width / t.series.size
                val barW = band * 0.6f
                val y = { v: Float -> size.height * (hi - v) / span }
                val zero = y(0f)
                drawLine(axis, Offset(0f, zero), Offset(size.width, zero), strokeWidth = 2f)
                net.forEachIndexed { i, v ->
                    val alpha = if (picked == null || picked == i) 1f else 0.3f
                    val top = minOf(y(v.toFloat()), zero)
                    val h = kotlin.math.abs(y(v.toFloat()) - zero)
                    drawRect(tintFor(v).copy(alpha = alpha), Offset(i * band + (band - barW) / 2, top), Size(barW, h))
                }
                if (showLastYear) drawYearAgo(ago.map { it?.toFloat() }, band) { v -> y(v) }
            }
            MonthLabels(t.series, picked)
            val p = picked
            if (p != null) {
                Readout(
                    t.series[p].month, net[p],
                    if (net[p] < 0) "more out than in" else "more in than out",
                    if (showLastYear) ago[p] else null, tintFor(net[p]),
                ) { picked = null }
            } else {
                Text("Touch a month for what it came to.", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
            }
        }
    }
}

/* ---------------------------------------------------------- running total -- */

/**
 * The same months summed left to right. Its own chart rather than a line over
 * the bars: a year of monthly figures adds up to ten times any one of them, and
 * one axis can only serve one of the two.
 */
@Composable
private fun RunningTotalChart(t: Trend) {
    var picked by remember(t) { mutableStateOf<Int?>(null) }
    val points = remember(t) {
        var total = 0L
        t.series.map { m -> total += m.income - m.expense; total }
    }
    val hi = maxOf(points.maxOrNull() ?: 0L, 0L).toFloat()
    val lo = minOf(points.minOrNull() ?: 0L, 0L).toFloat()
    val span = maxOf(hi - lo, 1f)
    val axis = MaterialTheme.colorScheme.outlineVariant
    val tint = tintFor(points.lastOrNull() ?: 0L)

    Maximisable("Running total", 160.dp) { chartHeight, _ ->
        run {
            Canvas(
                Modifier.fillMaxWidth().height(chartHeight).pointerInput(t) {
                    detectTapGestures { pos ->
                        picked = (pos.x / (size.width.toFloat() / t.series.size)).toInt().coerceIn(0, t.series.lastIndex)
                    }
                },
            ) {
                val band = size.width / t.series.size
                val y = { v: Float -> size.height * (hi - v) / span }
                val zero = y(0f)
                drawLine(axis, Offset(0f, zero), Offset(size.width, zero), strokeWidth = 2f)
                val line = Path()
                val area = Path()
                points.forEachIndexed { i, v ->
                    val x = i * band + band / 2
                    if (i == 0) { line.moveTo(x, y(v.toFloat())); area.moveTo(x, zero); area.lineTo(x, y(v.toFloat())) }
                    else { line.lineTo(x, y(v.toFloat())); area.lineTo(x, y(v.toFloat())) }
                }
                area.lineTo((points.size - 1) * band + band / 2, zero)
                area.close()
                drawPath(area, tint.copy(alpha = 0.14f))
                drawPath(line, tint, style = Stroke(width = 5f))
                /* The touched month, marked on the line: there are no bars to
                   darken, so without it nothing says which point is meant. */
                picked?.let { i ->
                    drawCircle(tintFor(points[i]), 12f, Offset(i * band + band / 2, y(points[i].toFloat())))
                }
            }
            MonthLabels(t.series, picked)
            val p = picked
            if (p != null) {
                Readout(t.series[p].month, points[p], "by the end of it", null, tintFor(points[p])) { picked = null }
            } else {
                Text(
                    "${(points.lastOrNull() ?: 0L).asMoney(false)} across the ${t.series.size} months shown",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
        }
    }
}

/* ------------------------------------------------ against the year before -- */

@Composable
private fun YearAgoCard(t: Trend) {
    /* Absent rather than empty when the history does not reach back a year. */
    if (t.prior.isEmpty() || t.prior.all { it.income == 0L && it.expense == 0L }) return
    val now = t.series.sumOf { it.expense }
    val before = t.prior.sumOf { it.expense }
    SectionTitle("Against the year before")
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Row(Modifier.fillMaxWidth()) {
                Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Spent now", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(now.asMoney(false), fontWeight = FontWeight.SemiBold)
                }
                Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Same months before", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(before.asMoney(false), fontWeight = FontWeight.SemiBold)
                }
            }
            if (before > 0) {
                val change = (now - before).toDouble() / before * 100
                /* A tenth of a point below ten: rounding 0.46% to 0% reports a
                   real difference as none. */
                val size = if (kotlin.math.abs(change) < 10) "%.1f".format(kotlin.math.abs(change))
                    else "%.0f".format(kotlin.math.abs(change))
                Text(
                    if (change >= 0) "↗ $size% more than a year ago" else "↘ $size% less than a year ago",
                    color = if (change >= 0) Negative else Positive,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(top = 10.dp),
                )
            }
        }
    }
}

/* ------------------------------------------------------------ full screen -- */

/**
 * A chart that can be given the whole screen -- the iPhone's Maximisable. The
 * same content is drawn in both places, with the same state, so a month or
 * segment picked in one is picked in the other; only the chart's height
 * changes. Turned on its side, the full-screen chart simply gets wider.
 *
 * `content` gets the chart height to use, and a way to step out of full
 * screen for anything that opens below the charts.
 */
@Composable
fun Maximisable(title: String, height: Dp, content: @Composable (chartHeight: Dp, close: () -> Unit) -> Unit) {
    var big by rememberSaveable { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween, Alignment.CenterVertically) {
        SectionTitle(title)
        IconButton(onClick = { big = true }) {
            Icon(painterResource(R.drawable.ic_expand), contentDescription = "Full screen",
                tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
        }
    }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp)) { content(height) {} }
    }
    if (big) {
        Dialog(onDismissRequest = { big = false }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
            Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                BoxWithConstraints(Modifier.fillMaxSize().systemBarsPadding().padding(16.dp)) {
                    /* Room left for the title, the Last year switch, the month
                       labels and a readout; never smaller than the card's own. */
                    val chartHeight = maxOf(maxHeight - 200.dp, height)
                    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                        Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween, Alignment.CenterVertically) {
                            Text(title, style = MaterialTheme.typography.titleLarge)
                            TextButton(onClick = { big = false }) { Text("Done") }
                        }
                        content(chartHeight) { big = false }
                    }
                }
            }
        }
    }
}
