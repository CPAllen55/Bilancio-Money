package com.bilanciomoney.bilancio.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.bilanciomoney.bilancio.Bilancio
import com.bilanciomoney.bilancio.Budget
import com.bilanciomoney.bilancio.Category
import com.bilanciomoney.bilancio.asMoney
import com.bilanciomoney.bilancio.ui.theme.Negative
import com.bilanciomoney.bilancio.ui.theme.Positive
import java.time.YearMonth
import java.time.format.TextStyle
import java.util.Locale

/**
 * The plan: this year, month by month, per category, from /api/budget -- the
 * same plan the Overview's bars are measured against, so the two cannot
 * disagree.
 *
 * A month already over shows what was actually spent beside what was planned,
 * as the web's Budgeting does by default; a month still to come shows the plan.
 *
 * Read-only for now. Changing a plan is done on the website, which has the
 * whole editor -- baselines, single months, and putting a month back.
 */
@Composable
fun BudgetingScreen() = Loader(Unit, { Bilancio.budget() to Bilancio.categories() }) { (b, cats): Pair<Budget, List<Category>>, _ ->
    var month by remember(b) { mutableStateOf(b.currentMonth.takeIf { it in b.months } ?: b.months.lastOrNull().orEmpty()) }
    var open by remember { mutableStateOf(setOf<String>()) }
    val parents = remember(cats) { cats.filter { it.parentSlug == null && it.kind == "spend" } }
    val done = month < b.currentMonth

    val income = b.incomePlan[month] ?: 0L
    val spending = b.rows.sumOf { it.plan[month] ?: 0L }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Row(Modifier.horizontalScroll(rememberScrollState())) {
            b.months.forEach { m ->
                val ym = YearMonth.parse(m)
                FilterChip(
                    selected = m == month,
                    onClick = { month = m },
                    label = { Text(ym.month.getDisplayName(TextStyle.SHORT, Locale.getDefault())) },
                    modifier = Modifier.padding(end = 6.dp),
                )
            }
        }
        Spacer(Modifier.height(8.dp))

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                val ym = YearMonth.parse(month)
                Text(
                    ym.month.getDisplayName(TextStyle.FULL, Locale.getDefault()) + " " + ym.year +
                        if (done) " · what happened" else " · the plan",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(10.dp))
                PlanLine("Income planned", income, if (done) b.incomeSpent[month] else null, Positive)
                PlanLine("Spending planned", spending, if (done) b.rows.sumOf { it.spent[month] ?: 0L } else null, Negative)
                val kept = income - spending
                Row(Modifier.fillMaxWidth().padding(top = 8.dp), Arrangement.SpaceBetween) {
                    Text("Planned to keep")
                    Text(kept.asMoney(false), fontWeight = FontWeight.SemiBold, color = if (kept < 0) Negative else Positive)
                }
                Text(
                    "${b.savingsAnnual.asMoney(false)} planned to keep this year.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        SectionTitle("By category")
        Card(Modifier.fillMaxWidth()) {
            Column {
                parents.forEach { p ->
                    val kids = b.rows.filter { it.parentSlug == p.slug }
                    val plan = kids.sumOf { it.plan[month] ?: 0L }
                    val spent = kids.sumOf { it.spent[month] ?: 0L }
                    if (plan <= 0 && spent <= 0) return@forEach
                    val expanded = p.slug in open
                    Column(
                        Modifier.fillMaxWidth()
                            .clickable { open = if (expanded) open - p.slug else open + p.slug }
                            .padding(horizontal = 16.dp, vertical = 12.dp),
                    ) {
                        Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween, Alignment.CenterVertically) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(if (expanded) "−" else "+", Modifier.width(18.dp), fontWeight = FontWeight.Bold)
                                Dot(Color(p.colour)); Spacer(Modifier.width(8.dp))
                                Text(p.label, fontWeight = FontWeight.Medium)
                            }
                            Text(
                                if (done) "${spent.asMoney(false)} of ${plan.asMoney(false)}" else plan.asMoney(false),
                                color = if (done && spent > plan) Negative else MaterialTheme.colorScheme.onSurface,
                            )
                        }
                        if (done) {
                            Spacer(Modifier.height(6.dp)); PlanBar(spent, plan, Color(p.colour))
                        }
                    }
                    if (expanded) {
                        kids.filter { (it.plan[month] ?: 0L) > 0 || (it.spent[month] ?: 0L) > 0 }.forEach { k ->
                            val kp = k.plan[month] ?: 0L
                            val ks = k.spent[month] ?: 0L
                            Row(
                                Modifier.fillMaxWidth().padding(start = 44.dp, end = 16.dp, top = 6.dp, bottom = 6.dp),
                                Arrangement.SpaceBetween,
                            ) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Dot(Color(k.colour)); Spacer(Modifier.width(8.dp))
                                    Text(k.label, style = MaterialTheme.typography.bodyMedium)
                                }
                                Text(
                                    if (done) "${ks.asMoney(false)} of ${kp.asMoney(false)}" else kp.asMoney(false),
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = if (done && ks > kp) Negative else MaterialTheme.colorScheme.onSurface,
                                )
                            }
                        }
                        Spacer(Modifier.height(6.dp))
                    }
                    HorizontalDivider()
                }
            }
        }
        Spacer(Modifier.height(12.dp))
        Text(
            "To change a plan, use Budgeting on bilanciomoney.com. Changes there show here straight away.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun PlanLine(label: String, plan: Long, actual: Long?, colour: Color) {
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween) {
            Text(label)
            Text(
                if (actual != null) "${actual.asMoney(false)} of ${plan.asMoney(false)}" else plan.asMoney(false),
                fontWeight = FontWeight.SemiBold,
            )
        }
        if (actual != null) {
            Spacer(Modifier.height(4.dp)); PlanBar(actual, plan, colour)
        }
    }
}
