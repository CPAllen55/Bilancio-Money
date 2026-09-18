package com.bilanciomoney.bilancio.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
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
import androidx.compose.runtime.setValue
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
 * Tapping a column picks a month. Tapping a category opens it: the bars then
 * stack its subcategories, and the breakdown lists them, which is the web's
 * drill-down. Back, or "All categories", closes it again.
 */
@Composable
fun TrendScreen(onCategory: (slug: String, label: String, month: YearMonth) -> Unit) {
    var months by remember { mutableIntStateOf(12) }
    Column(Modifier.fillMaxSize()) {
        val options = listOf(6, 12, 24)
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(16.dp)) {
            options.forEachIndexed { i, n ->
                SegmentedButton(
                    selected = months == n,
                    onClick = { months = n },
                    shape = SegmentedButtonDefaults.itemShape(i, options.size),
                ) { Text("$n months") }
            }
        }
        Loader(months, { Bilancio.trend(months) }) { t: Trend, _ -> TrendContent(t, onCategory) }
    }
}

@Composable
private fun TrendContent(t: Trend, onCategory: (String, String, YearMonth) -> Unit) {
    if (t.series.isEmpty()) {
        Text("Nothing to chart yet.", Modifier.padding(16.dp)); return
    }
    var picked by remember(t) { mutableIntStateOf(t.series.lastIndex) }
    /* The category that has been opened, or null for all of them. */
    var focus by remember(t) { mutableStateOf<Category?>(null) }
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
        focus?.let { f ->
            Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween, Alignment.CenterVertically) {
                AssistChip(onClick = { focus = null }, label = { Text("‹ All categories") })
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Dot(Color(f.colour)); Spacer(Modifier.width(6.dp))
                    Text(f.label, fontWeight = FontWeight.SemiBold)
                }
            }
            Spacer(Modifier.height(6.dp))
        }

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp)) {
                Canvas(
                    Modifier.fillMaxWidth().height(200.dp).pointerInput(t) {
                        detectTapGestures { pos ->
                            val band = size.width / t.series.size
                            picked = (pos.x / band).toInt().coerceIn(0, t.series.lastIndex)
                        }
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
                            drawRect(Color(c.colour), Offset(x, y), Size(barW, h))
                        }
                    }
                }
                Row(Modifier.fillMaxWidth()) {
                    t.series.forEachIndexed { i, m ->
                        /* Every label on a short range; on a long one, only
                           every third, so they stay legible. */
                        val show = t.series.size <= 12 || i % 3 == 0
                        Text(
                            if (show) m.month.month.getDisplayName(TextStyle.NARROW, Locale.getDefault()) else "",
                            Modifier.weight(1f),
                            style = MaterialTheme.typography.labelSmall,
                            color = if (i == picked) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }

        val m = t.series[picked]
        val before = t.prior.getOrNull(picked)
        SectionTitle(m.month.month.getDisplayName(TextStyle.FULL, Locale.getDefault()) + " " + m.month.year)
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                val f = focus
                if (f != null) {
                    Figure("${f.label} spent", columnTotal(m), before?.let(columnTotal))
                    TextButton(onClick = { onCategory(f.slug, f.label, m.month) }) {
                        Text("See its transactions this month ›")
                    }
                } else {
                    Figure("Spent", m.expense, before?.expense)
                    Figure("Came in", m.income, before?.income)
                    val net = m.income - m.expense
                    Row(Modifier.fillMaxWidth().padding(top = 6.dp), Arrangement.SpaceBetween) {
                        Text("Net")
                        Text(net.asMoney(false), fontWeight = FontWeight.SemiBold, color = if (net < 0) Negative else Positive)
                    }
                }
            }
        }

        SectionTitle(if (focus == null) "By category — tap one to open it" else "By subcategory")
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(vertical = 4.dp)) {
                val shown = order.filter { valueOf(m, it.slug) > 0 || valueOf(before, it.slug) > 0 }
                if (shown.isEmpty()) {
                    Text("Nothing spent here this month.", Modifier.padding(16.dp))
                }
                shown.forEach { c ->
                    val v = valueOf(m, c.slug)
                    val was = valueOf(before, c.slug)
                    val opensSubcategories = focus == null && t.categories.any { it.parentSlug == c.slug }
                    Row(
                        Modifier.fillMaxWidth()
                            .clickable {
                                if (opensSubcategories) focus = c
                                else onCategory(c.slug, c.label, m.month)
                            }
                            .padding(horizontal = 16.dp, vertical = 10.dp),
                        Arrangement.SpaceBetween,
                        Alignment.CenterVertically,
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Dot(Color(c.colour)); Spacer(Modifier.width(8.dp))
                            Text(c.label + if (opensSubcategories) "  ›" else "")
                        }
                        Column(horizontalAlignment = Alignment.End) {
                            Text(v.asMoney(false), fontWeight = FontWeight.Medium)
                            if (was > 0) {
                                Text(
                                    "${was.asMoney(false)} a year ago",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun Figure(label: String, now: Long, yearAgo: Long?) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), Arrangement.SpaceBetween) {
        Text(label)
        Column(horizontalAlignment = Alignment.End) {
            Text(now.asMoney(false), fontWeight = FontWeight.SemiBold)
            if (yearAgo != null && yearAgo > 0) {
                Text(
                    "${yearAgo.asMoney(false)} a year ago",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
