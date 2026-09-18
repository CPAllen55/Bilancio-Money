package com.bilanciomoney.bilancio.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.bilanciomoney.bilancio.Bilancio
import com.bilanciomoney.bilancio.Forecast
import com.bilanciomoney.bilancio.NetWorth
import com.bilanciomoney.bilancio.WorthGroup
import com.bilanciomoney.bilancio.asMoney
import com.bilanciomoney.bilancio.ui.theme.Negative
import com.bilanciomoney.bilancio.ui.theme.Positive
import java.time.YearMonth
import java.time.format.TextStyle
import java.util.Locale

/* ------------------------------------------------------------- year ahead -- */

/**
 * The year: months already over at what happened, months to come at the plan --
 * the plan is the forecast, so the two cannot say different things about next
 * month. What has been kept so far, and what the year ends at if the plan holds.
 */
@Composable
fun ForecastScreen() = Loader(Unit, { Bilancio.forecast() }) { f: Forecast, _ ->
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Text("${f.year}, if the plan holds", color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(
                    f.yearEndNet.asMoney(false),
                    style = MaterialTheme.typography.displaySmall,
                    fontWeight = FontWeight.SemiBold,
                    color = if (f.yearEndNet < 0) Negative else Positive,
                )
                Text("kept by the end of the year", color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(12.dp))
                Line("Kept so far", f.savedSoFar)
                Line("Still to come in", f.remainingIncome)
                Line("Still to go out", -f.remainingExpense)
            }
        }

        SectionTitle("Month by month")
        val top = maxOf(f.months.maxOfOrNull { maxOf(it.income, it.expense) } ?: 0L, 1L).toFloat()
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp)) {
                /* Two bars a month, in and out; months to come drawn lighter,
                   because they are a plan rather than a record. */
                Canvas(Modifier.fillMaxWidth().height(160.dp)) {
                    val band = size.width / maxOf(f.months.size, 1)
                    val w = band * 0.32f
                    f.months.forEachIndexed { i, m ->
                        val a = if (m.projected) 0.4f else 1f
                        val hi = size.height * (m.income / top)
                        val ho = size.height * (m.expense / top)
                        drawRect(Positive.copy(alpha = a), Offset(i * band + band * 0.14f, size.height - hi), Size(w, hi))
                        drawRect(Negative.copy(alpha = a), Offset(i * band + band * 0.54f, size.height - ho), Size(w, ho))
                    }
                }
                Row(Modifier.fillMaxWidth()) {
                    f.months.forEach { m ->
                        Text(
                            runCatching { YearMonth.parse(m.month).month.getDisplayName(TextStyle.NARROW, Locale.getDefault()) }
                                .getOrDefault(""),
                            Modifier.weight(1f),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                Text(
                    "Green is money in, red money out. Lighter months are the plan; darker ones happened.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        Spacer(Modifier.height(8.dp))
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                f.months.forEach { m ->
                    val ym = runCatching { YearMonth.parse(m.month) }.getOrNull()
                    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), Arrangement.SpaceBetween) {
                        Text(
                            (ym?.month?.getDisplayName(TextStyle.FULL, Locale.getDefault()) ?: m.month) +
                                if (m.projected) " · plan" else "",
                            color = if (m.projected) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                        )
                        Text(m.net.asMoney(false), color = if (m.net < 0) Negative else Positive)
                    }
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun Line(label: String, cents: Long) {
    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), Arrangement.SpaceBetween) {
        Text(label)
        Text(cents.asMoney(false), fontWeight = FontWeight.Medium)
    }
}

/* -------------------------------------------------------------- net worth -- */

/**
 * What is owned, what is owed, and how the difference moved. The history is
 * rebuilt by undoing transactions backwards from today's balances, so where it
 * could not be, the page says the figures are held flat rather than implying a
 * record that does not exist.
 */
@Composable
fun NetWorthScreen() {
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
        Loader(months, { Bilancio.netWorth(months) }) { w: NetWorth, _ -> WorthContent(w) }
    }
}

@Composable
private fun WorthContent(w: NetWorth) {
    val line = MaterialTheme.colorScheme.primary
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Text("Net worth", color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(
                    w.netWorth.asMoney(false),
                    style = MaterialTheme.typography.displaySmall,
                    fontWeight = FontWeight.SemiBold,
                )
                if (w.openingLabel.isNotBlank()) {
                    Text(
                        (if (w.change >= 0) "Up " else "Down ") + kotlin.math.abs(w.change).asMoney(false) +
                            (w.changePct?.let { " (%.1f%%)".format(it) } ?: "") + " since " + w.openingLabel,
                        color = if (w.change < 0) Negative else Positive,
                    )
                }
                if (w.series.size >= 2) {
                    Spacer(Modifier.height(12.dp))
                    val lo = w.series.minOf { it.netWorth }.toFloat()
                    val hi = w.series.maxOf { it.netWorth }.toFloat()
                    val span = maxOf(hi - lo, 1f)
                    Canvas(Modifier.fillMaxWidth().height(120.dp)) {
                        val step = size.width / (w.series.size - 1)
                        val path = Path()
                        w.series.forEachIndexed { i, p ->
                            val x = i * step
                            val y = size.height - size.height * ((p.netWorth - lo) / span)
                            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
                        }
                        drawPath(path, line, style = Stroke(width = 5f))
                    }
                    Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween) {
                        Text(w.series.first().label, style = MaterialTheme.typography.labelSmall)
                        Text(w.series.last().label, style = MaterialTheme.typography.labelSmall)
                    }
                }
                Spacer(Modifier.height(12.dp))
                Line("What you own", w.assets)
                Line("What you owe", -w.liabilities)
                Line("Cash to hand", w.liquid)
                if (w.creditLimit > 0) {
                    Line("Credit used", w.creditUsed)
                    Text(
                        "of ${w.creditLimit.asMoney(false)} available — " +
                            "%.0f%% used".format(100.0 * w.creditUsed / w.creditLimit),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (!w.exact) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "Some accounts could not be traced back through their transactions, so their earlier balances are held at today's.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        Groups("By kind", w.byClass)
        Groups("By bank", w.byInstitution)
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun Groups(title: String, groups: List<WorthGroup>) {
    if (groups.isEmpty()) return
    SectionTitle(title)
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
            groups.forEach { g ->
                Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), Arrangement.SpaceBetween) {
                    Column {
                        Text(g.label)
                        Text(
                            "${g.accounts} account" + if (g.accounts == 1) "" else "s",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Text(g.net.asMoney(false), fontWeight = FontWeight.Medium,
                        color = if (g.net < 0) Negative else MaterialTheme.colorScheme.onSurface)
                }
            }
        }
    }
}

