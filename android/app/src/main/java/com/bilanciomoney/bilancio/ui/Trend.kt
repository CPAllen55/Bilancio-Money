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
 * Tapping a column picks a month. Tapping a category expands it in place (+/-)
 * to show its subcategories, and the chart follows, stacking those instead;
 * tapping it again, or Back, closes it. A subcategory opens its transactions.
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
    var listing by remember(t) { mutableStateOf<String?>(null) }
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
                AssistChip(onClick = { focus = null }, label = { Text("Show all categories") })
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

        SectionTitle("By category")
        /* Every category, always, in the chart's order; the open one shows its
           subcategories beneath it, as Budget and the web's +/- rows do. */
        val parentOrder = parents.sortedByDescending { c -> t.series.sumOf { it.byParent[c.slug] ?: 0L } }
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(vertical = 4.dp)) {
                val shown = parentOrder.filter { (m.byParent[it.slug] ?: 0L) > 0 || (before?.byParent?.get(it.slug) ?: 0L) > 0 }
                if (shown.isEmpty()) {
                    Text("Nothing spent this month.", Modifier.padding(16.dp))
                }
                shown.forEach { c ->
                    val kids = t.categories.filter { it.parentSlug == c.slug }
                    val open = if (kids.isEmpty()) listing == c.slug else focus?.slug == c.slug
                    BreakdownRow(
                        label = c.label, colour = Color(c.colour),
                        now = m.byParent[c.slug] ?: 0L, yearAgo = before?.byParent?.get(c.slug) ?: 0L,
                        toggle = open,
                        indent = false,
                        onClick = {
                            /* A category with no subcategories opens straight to its
                               transactions; one with them opens its subcategories. */
                            if (kids.isEmpty()) listing = if (open) null else c.slug
                            else { focus = if (open) null else c; listing = null }
                        },
                    )
                    if (open && kids.isEmpty()) {
                        MonthTransactions(c.slug, m.month, Color(c.colour))
                    }
                    if (open && kids.isNotEmpty()) {
                        kids.sortedByDescending { m.byCategory[it.slug] ?: 0L }
                            .filter { (m.byCategory[it.slug] ?: 0L) > 0 || (before?.byCategory?.get(it.slug) ?: 0L) > 0 }
                            .forEach { k ->
                                val kidOpen = listing == k.slug
                                BreakdownRow(
                                    label = k.label, colour = Color(k.colour),
                                    now = m.byCategory[k.slug] ?: 0L, yearAgo = before?.byCategory?.get(k.slug) ?: 0L,
                                    toggle = kidOpen, indent = true,
                                    onClick = { listing = if (kidOpen) null else k.slug },
                                )
                                if (kidOpen) MonthTransactions(k.slug, m.month, Color(k.colour))
                            }
                    }
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

/**
 * One category's transactions for one month, listed where it was opened -- the
 * iPhone's drill-down, which keeps the reader on the Trend rather than moving
 * them to another tab to answer "what was that?".
 *
 * A month holds a few dozen at most for one subcategory; the first fifty are
 * shown, and the rest is counted rather than hidden.
 */
@Composable
private fun MonthTransactions(slug: String, month: YearMonth, tint: Color) {
    val range = com.bilanciomoney.bilancio.Ranges.key(month, 1)
    Column(Modifier.fillMaxWidth().padding(start = 34.dp, end = 12.dp, bottom = 8.dp)) {
        Loader(slug to month, { Bilancio.transactions(range, bucket = slug, limit = 50) }) {
            page: com.bilanciomoney.bilancio.TransactionPage, _ ->
            if (page.rows.isEmpty()) {
                Text("No transactions.", Modifier.padding(8.dp), style = MaterialTheme.typography.bodySmall)
                return@Loader
            }
            Column {
                page.rows.forEach { tx ->
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 6.dp),
                        Arrangement.SpaceBetween,
                        Alignment.CenterVertically,
                    ) {
                        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                            MerchantLogo(tx.logo, tx.name, tint, size = 26.dp)
                            Spacer(Modifier.width(8.dp))
                            Column {
                                Text(tx.name, maxLines = 1, style = MaterialTheme.typography.bodyMedium)
                                Text(
                                    tx.date.format(java.time.format.DateTimeFormatter.ofPattern("MMM d")) +
                                        if (tx.pending) " · pending" else "",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                        Text(
                            tx.amount.asMoney(),
                            style = MaterialTheme.typography.bodyMedium,
                            color = if (tx.amount > 0) Positive else MaterialTheme.colorScheme.onSurface,
                        )
                    }
                }
                if (page.total > page.rows.size) {
                    Text(
                        "${page.total - page.rows.size} more this month",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun BreakdownRow(
    label: String,
    colour: Color,
    now: Long,
    yearAgo: Long,
    toggle: Boolean?,
    indent: Boolean,
    onClick: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick)
            .padding(start = if (indent) 34.dp else 16.dp, end = 16.dp, top = 10.dp, bottom = 10.dp),
        Arrangement.SpaceBetween,
        Alignment.CenterVertically,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                when (toggle) { true -> "−"; false -> "+"; null -> "" },
                Modifier.width(18.dp),
                fontWeight = FontWeight.Bold,
                color = if (indent) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
            )
            Dot(colour); Spacer(Modifier.width(8.dp))
            Text(label, style = if (indent) MaterialTheme.typography.bodyMedium else MaterialTheme.typography.bodyLarge)
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(now.asMoney(false), fontWeight = if (indent) FontWeight.Normal else FontWeight.Medium)
            if (yearAgo > 0) {
                Text(
                    "${yearAgo.asMoney(false)} a year ago",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
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
