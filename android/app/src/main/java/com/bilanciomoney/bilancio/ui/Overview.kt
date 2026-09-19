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
import com.bilanciomoney.bilancio.Summary
import com.bilanciomoney.bilancio.asMoney
import com.bilanciomoney.bilancio.ui.theme.Caution
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
) = Loader(period.key, { Bilancio.summary(period.key) }) { s: Summary, _ ->
    /* The category open, and the subcategory whose transactions are listed. */
    var openParent by remember(s) { mutableStateOf<String?>(null) }
    var openLeaf by remember(s) { mutableStateOf<String?>(null) }
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
        /* Ordered by what it cost, because the question here is where the
           money went -- not by what it was planned at. */
        val parents = s.categories.filter { it.parentSlug == null && it.kind == "spend" }
            .map { it to ((s.byParent[it.slug] ?: 0L) to s.budgetByParent[it.slug]) }
            .filter { (_, v) -> v.first > 0 || (v.second ?: 0) > 0 }
            .sortedByDescending { (_, v) -> v.first }

        if (parents.isEmpty() && s.income == 0L) {
            Text("Nothing spent in this period.", style = MaterialTheme.typography.bodyMedium)
        }
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(vertical = 4.dp)) {
                /* Income first, and fixed there. A list of what every category
                   cost says nothing about the other half of the plan: a month
                   can be inside every spending budget it has and still be a bad
                   month. Pinned rather than sorted in, so it does not move
                   about as the months change. */
                if (s.income > 0 || (s.budgetIncome ?: 0L) > 0) {
                    val open = openParent == "income"
                    Column(
                        Modifier.fillMaxWidth()
                            .clickable { openParent = if (open) null else "income"; openLeaf = null }
                            .padding(horizontal = 16.dp, vertical = 10.dp),
                    ) {
                        LabelledRow(
                            left = {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(if (open) "−" else "+", Modifier.width(18.dp), fontWeight = FontWeight.Bold)
                                    /* Named from the tree: Income is a category
                                       like any other, and the name shown here is
                                       the one it is called everywhere else. */
                                    Text(
                                        s.categories.firstOrNull { it.slug == "income" }?.label ?: "Income",
                                        fontWeight = FontWeight.Medium,
                                    )
                                }
                            },
                            right = {
                                Text(
                                    s.income.asMoney(false) + (s.budgetIncome?.let { " of ${it.asMoney(false)}" } ?: ""),
                                    /* Arriving is the point of income, so more
                                       than expected is the good case and never
                                       a warning. */
                                    color = if ((s.budgetIncome ?: 0L) > 0 && s.income >= s.budgetIncome!!) Positive
                                        else MaterialTheme.colorScheme.onSurface,
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                            },
                        )
                        Spacer(Modifier.height(6.dp))
                        PlanBar(s.income, s.budgetIncome, Positive)
                    }
                    if (open) {
                        /* Its sources carry no budget of their own: income is
                           planned as one monthly figure, and these are shares
                           of what came in. */
                        s.byIncomeParent.entries.filter { it.value > 0 }.sortedByDescending { it.value }
                            .forEach { (slug, cents) ->
                                val label = s.categories.firstOrNull { it.slug == slug }?.label ?: slug
                                val leafOpen = openLeaf == slug
                                Column(
                                    Modifier.fillMaxWidth()
                                        .clickable { openLeaf = if (leafOpen) null else slug }
                                        .padding(start = 34.dp, end = 16.dp, top = 8.dp, bottom = 8.dp),
                                ) {
                                    LabelledRow(
                                        left = {
                                            Row(verticalAlignment = Alignment.CenterVertically) {
                                                Text(if (leafOpen) "−" else "+", Modifier.width(18.dp),
                                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                                                Text(label, style = MaterialTheme.typography.bodyMedium)
                                            }
                                        },
                                        right = {
                                            Text(cents.asMoney(false), style = MaterialTheme.typography.bodySmall,
                                                color = Positive)
                                        },
                                    )
                                }
                                if (leafOpen) InlineTransactions(period.key, slug, Positive, indent = 52.dp)
                            }
                    }
                }
                parents.forEach { (cat, v) ->
                    val (spent, plan) = v
                    val tone = planTone(spent, plan)
                    val kids = s.categories.filter { it.parentSlug == cat.slug }
                    val open = openParent == cat.slug
                    Column(
                        Modifier.fillMaxWidth()
                            .clickable {
                                openParent = if (open) null else cat.slug
                                openLeaf = null
                            }
                            .padding(horizontal = 16.dp, vertical = 10.dp),
                    ) {
                        LabelledRow(
                            left = {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(if (open) "−" else "+", Modifier.width(18.dp), fontWeight = FontWeight.Bold)
                                    Text(cat.label)
                                }
                            },
                            right = {
                                Text(
                                    spent.asMoney(false) + (plan?.let { " of ${it.asMoney(false)}" } ?: ""),
                                    color = tone ?: MaterialTheme.colorScheme.onSurface,
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                            },
                        )
                        Spacer(Modifier.height(6.dp))
                        PlanBar(spent, plan, tone ?: Positive)
                    }
                    if (open && kids.isEmpty()) {
                        InlineTransactions(period.key, cat.slug, tone ?: Positive)
                    }
                    if (open && kids.isNotEmpty()) {
                        kids.map { it to ((s.byCategory[it.slug] ?: 0L) to s.budgetByCategory[it.slug]) }
                            .filter { (_, kv) -> kv.first > 0 || (kv.second ?: 0L) > 0 }
                            .sortedByDescending { (_, kv) -> kv.first }
                            .forEach { (k, kv) ->
                                val (ks, kp) = kv
                                val leafOpen = openLeaf == k.slug
                                Column(
                                    Modifier.fillMaxWidth()
                                        .clickable { openLeaf = if (leafOpen) null else k.slug }
                                        .padding(start = 34.dp, end = 16.dp, top = 8.dp, bottom = 8.dp),
                                ) {
                                    LabelledRow(
                                        left = {
                                            Row(verticalAlignment = Alignment.CenterVertically) {
                                                Text(if (leafOpen) "−" else "+", Modifier.width(18.dp),
                                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                                                Text(k.label, style = MaterialTheme.typography.bodyMedium)
                                            }
                                        },
                                        right = {
                                            Text(
                                                ks.asMoney(false) + (kp?.let { " of ${it.asMoney(false)}" } ?: ""),
                                                style = MaterialTheme.typography.bodySmall,
                                                color = planTone(ks, kp) ?: MaterialTheme.colorScheme.onSurface,
                                            )
                                        },
                                    )
                                    Spacer(Modifier.height(4.dp))
                                    PlanBar(ks, kp, planTone(ks, kp) ?: Positive)
                                }
                                if (leafOpen) {
                                    InlineTransactions(period.key, k.slug, planTone(ks, kp) ?: Positive, indent = 52.dp)
                                }
                            }
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

/**
 * How a spending line stands against its budget, as a colour: green inside it,
 * amber in its last twentieth, red past it. Null when nothing is planned --
 * there is no standing to report, and colouring it green would claim one.
 *
 * The same three the iPhone uses, and they replace the category's own colour
 * here: this section answers "am I within the plan", and a palette that says
 * which category it is cannot also say that.
 */
internal fun planTone(spent: Long, plan: Long?): Color? = when {
    plan == null || plan <= 0L -> null
    spent > plan -> Negative
    spent >= plan * 95 / 100 -> Caution
    else -> Positive
}
