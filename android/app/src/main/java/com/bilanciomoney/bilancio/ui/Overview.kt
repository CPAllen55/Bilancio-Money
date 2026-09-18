package com.bilanciomoney.bilancio.ui

import androidx.compose.foundation.clickable
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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.bilanciomoney.bilancio.Bilancio
import com.bilanciomoney.bilancio.Summary
import com.bilanciomoney.bilancio.asMoney
import com.bilanciomoney.bilancio.ui.theme.Negative
import com.bilanciomoney.bilancio.ui.theme.Positive

/**
 * Where the period stands: income, spending and net against the plan, then each
 * category against its own. The same three figures and the same reading as the
 * web Overview and the iPhone's StandingCard, so the three apps agree.
 */
@Composable
fun OverviewScreen(
    period: Period,
    onPeriod: (Period) -> Unit,
    onCategory: (slug: String, label: String) -> Unit,
) = Loader(period.key, { Bilancio.summary(period.key) }) { s: Summary, _ ->
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        PeriodBar(period, onPeriod)
        Spacer(Modifier.height(12.dp))

        if (s.accountsCounted == 0) {
            /* No bank yet is not a month with no spending, and a bare zero says
               the wrong one. */
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    Text("No banks connected yet", fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "Every figure here is zero until an account is linked. Connect one on the Banks tab.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
            return@Loader
        }

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Text(s.label, style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(12.dp))
                Standing("Income", s.income, s.budgetIncome, Positive)
                Standing("Expenses", s.expense, s.budgetExpense, Negative)
                /* Net can go below zero; the bar shows its size, and the colour
                   says which side of zero it is on. */
                Standing(
                    "Net balance",
                    s.net,
                    s.budgetNet?.takeIf { it > 0 },
                    if (s.net < 0) Negative else Positive,
                    signed = true,
                )
                if (s.perDay != null && (s.daysLeft ?: 0) > 0) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "${s.perDay.asMoney(false)} a day for the ${s.daysLeft} days left.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                if (s.previousExpense != null && s.comparison.isNotBlank()) {
                    val diff = s.expense - s.previousExpense
                    Text(
                        (if (diff >= 0) "${diff.asMoney(false)} more" else "${(-diff).asMoney(false)} less") +
                            " spent than ${s.comparison}.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        SectionTitle("Against the plan")
        val parents = s.categories.filter { it.parentSlug == null && it.kind == "spend" }
            .map { it to ((s.byParent[it.slug] ?: 0L) to s.budgetByParent[it.slug]) }
            .filter { (_, v) -> v.first > 0 || (v.second ?: 0) > 0 }
            .sortedByDescending { (_, v) -> maxOf(v.first, v.second ?: 0) }

        if (parents.isEmpty()) {
            Text("Nothing spent in this period.", style = MaterialTheme.typography.bodyMedium)
        }
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(vertical = 4.dp)) {
                parents.forEach { (cat, v) ->
                    val (spent, plan) = v
                    val over = plan != null && spent > plan
                    Column(
                        Modifier.fillMaxWidth()
                            .clickable { onCategory(cat.slug, cat.label) }
                            .padding(horizontal = 16.dp, vertical = 10.dp),
                    ) {
                        LabelledRow(
                            left = {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Dot(Color(cat.colour))
                                    Spacer(Modifier.width(8.dp))
                                    Text(cat.label)
                                }
                            },
                            right = {
                                Text(
                                    spent.asMoney(false) + (plan?.let { " of ${it.asMoney(false)}" } ?: ""),
                                    color = if (over) Negative else MaterialTheme.colorScheme.onSurface,
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                            },
                        )
                        Spacer(Modifier.height(6.dp))
                        PlanBar(spent, plan, Color(cat.colour))
                    }
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun Standing(label: String, amount: Long, plan: Long?, colour: Color, signed: Boolean = false) {
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween) {
            Text(label)
            Text(
                amount.asMoney(false),
                fontWeight = FontWeight.SemiBold,
                color = if (signed && amount < 0) Negative else MaterialTheme.colorScheme.onSurface,
            )
        }
        Spacer(Modifier.height(4.dp))
        PlanBar(kotlin.math.abs(amount), plan, colour)
        if (plan != null) {
            Text(
                "Budget ${plan.asMoney(false)}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
