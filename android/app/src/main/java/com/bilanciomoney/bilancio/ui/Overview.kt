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
import java.time.LocalDate

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

        StandingCard(s)

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

/**
 * The answer first: what was kept, or what was overspent, then the two figures
 * it is worked out from. The iPhone's StandingCard and the web Overview card,
 * line for line: the net against its plan as a bar, the net itself large, a
 * sentence about the days left, income and expenses as captioned bars, and
 * where spending stands against its budget.
 */
@Composable
private fun StandingCard(s: Summary) {
    val net = s.net
    val overspent = net < 0
    /* 0 is "no plan", as the Worker treats it: a budget of zero is the absence
       of the information, not a plan to earn or spend nothing. */
    val plannedIncome = maxOf(0L, s.budgetIncome ?: 0L)
    val plannedExpense = maxOf(0L, s.budgetExpense ?: 0L)
    val plannedNet = if (plannedIncome > 0 || plannedExpense > 0) s.budgetNet else null
    val noPlanScale = maxOf(s.income, s.expense)

    /* From the range's own end date rather than a day count: a span reports
       no days left by construction, even one ending in the running month. */
    val ended = s.rangeEnd.isNotBlank() && s.rangeEnd < LocalDate.now().toString()
    val daysLeft = s.daysLeft ?: 0
    val plural = if (daysLeft == 1) "" else "s"
    val subline = when {
        ended -> "This period is complete."
        daysLeft <= 0 -> if (overspent) "${(-net).asMoney(false)} more out than in so far." else "${net.asMoney(false)} kept so far."
        overspent -> "${(-net).asMoney(false)} more out than in, with $daysLeft day$plural still to go."
        else -> "About ${(s.perDay ?: 0).asMoney(false)} a day for the $daysLeft day$plural left."
    }

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Text(s.label, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(6.dp))
            ProportionBar(
                label = null, amount = net, planned = plannedNet ?: 0, fallbackScale = noPlanScale,
                tint = if (overspent) Negative else Positive, verb = "kept", incomeSide = true,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                net.asMoney(false),
                style = MaterialTheme.typography.displaySmall,
                fontWeight = FontWeight.SemiBold,
                color = if (overspent) Negative else Positive,
                maxLines = 1,
            )
            Text(subline, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(14.dp))
            ProportionBar(
                label = "Income", amount = s.income, planned = plannedIncome, fallbackScale = noPlanScale,
                tint = Positive, verb = "earned", incomeSide = true,
            )
            Spacer(Modifier.height(12.dp))
            ProportionBar(
                label = "Expenses", amount = s.expense, planned = plannedExpense, fallbackScale = noPlanScale,
                tint = Negative, verb = "spent", incomeSide = false,
            )
            /* Against the budget, not against elapsed days: rent clears on the
               1st, and a pace indicator that cries wolf for a week every month
               teaches people to ignore it. */
            if (plannedExpense > 0) {
                val over = s.expense - plannedExpense
                Spacer(Modifier.height(12.dp))
                Text(
                    if (over > 0) "⚠  ${over.asMoney(false)} over budget"
                    else "✓  ${(-over).asMoney(false)} left in budget to spend",
                    color = if (over > 0) Negative else Positive,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}
