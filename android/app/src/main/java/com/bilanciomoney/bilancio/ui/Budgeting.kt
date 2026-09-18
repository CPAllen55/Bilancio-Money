package com.bilanciomoney.bilancio.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.input.pointer.pointerInput
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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.TextButton
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.text.input.KeyboardType
import kotlinx.coroutines.launch
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
import com.bilanciomoney.bilancio.BudgetRow
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
 * Tapping a subcategory changes its plan -- one month, every month, or back to
 * what history suggests -- through the same endpoint the web editor uses.
 */
@Composable
fun BudgetingScreen() = Loader(Unit, { Bilancio.budget() to Bilancio.categories() }) { (b, cats): Pair<Budget, List<Category>>, reload ->
    var editing by remember { mutableStateOf<BudgetRow?>(null) }
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
                    /* Kept even at nothing planned: a category with no plan yet is
                       still somewhere a first plan can be set. */
                    if (kids.isEmpty()) return@forEach
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
                        /* Every subcategory, not only the ones with a figure: a plan of
                           nothing is still somewhere a plan can be set. */
                        kids.forEach { k ->
                            val kp = k.plan[month] ?: 0L
                            val ks = k.spent[month] ?: 0L
                            val byHand = month in k.pinned || k.baselineOverride != null
                            Row(
                                Modifier.fillMaxWidth().clickable { editing = k }
                                    .padding(start = 44.dp, end = 16.dp, top = 10.dp, bottom = 10.dp),
                                Arrangement.SpaceBetween,
                            ) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Dot(Color(k.colour)); Spacer(Modifier.width(8.dp))
                                    Text(k.label + (if (byHand) " · set by you" else "") + "  ✎",
                                        style = MaterialTheme.typography.bodyMedium)
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
            "Tap a subcategory to change its plan. Changes show on the website and the iPhone straight away.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(24.dp))
    }

    editing?.let { row ->
        EditPlan(row, b.months, b.currentMonth, month, onDone = { changed -> editing = null; if (changed) reload() })
    }
}

/**
 * Changing one subcategory's plan: this month only, every month, or back to
 * what history suggests. The same three edits the web's Budgeting makes, sent
 * to the same endpoint, so a change here is the change everywhere.
 *
 * With the year beside the box, as on the iPhone: a figure typed alone says
 * nothing about whether it is generous or impossible, and twelve bars say both
 * at a glance. Tapping a bar moves the edit to that month.
 *
 * Whole dollars, as on the web: a budget is not kept to the cent.
 */
@Composable
private fun EditPlan(row: BudgetRow, months: List<String>, currentMonth: String, startMonth: String, onDone: (changed: Boolean) -> Unit) {
    val scope = rememberCoroutineScope()
    var month by remember(row) { mutableStateOf(startMonth) }
    val now = row.plan[month] ?: 0L
    val suggested = row.computed[month] ?: 0L
    var typed by remember(row, month) { mutableStateOf((now / 100).toString()) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val cents = typed.filter { it.isDigit() }.toLongOrNull()?.times(100)
    val label = YearMonth.parse(month).month.getDisplayName(TextStyle.FULL, Locale.getDefault())
    val byHand = month in row.pinned || row.baselineOverride != null

    fun save(action: suspend () -> Unit) {
        saving = true; error = null
        scope.launch {
            runCatching { action() }
                .onSuccess { onDone(true) }
                .onFailure { error = it.message; saving = false }
        }
    }

    AlertDialog(
        onDismissRequest = { if (!saving) onDone(false) },
        title = { Text(row.label) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                PlanHistoryChart(row, months, currentMonth, month, onPick = { month = it })
                Spacer(Modifier.height(12.dp))
                Text("Your history suggests ${suggested.asMoney(false)} for $label.",
                    style = MaterialTheme.typography.bodyMedium)
                if (row.baselineOverride != null) {
                    Text("You set every month to ${row.baselineOverride.asMoney(false)}.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = typed,
                    onValueChange = { typed = it.filter { c -> c.isDigit() }.take(7) },
                    label = { Text("Plan for $label, in dollars") },
                    prefix = { Text("$") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                )
                Spacer(Modifier.height(12.dp))
                Button(
                    enabled = !saving && cents != null,
                    onClick = { save { Bilancio.pinMonth(row.slug, month, cents) } },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Set $label only") }
                OutlinedButton(
                    enabled = !saving && cents != null && cents > 0,
                    onClick = { save { Bilancio.setBaseline(row.slug, cents) } },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Set every month") }
                if (byHand) {
                    TextButton(
                        enabled = !saving,
                        onClick = {
                            save {
                                if (month in row.pinned) Bilancio.pinMonth(row.slug, month, null)
                                else Bilancio.setBaseline(row.slug, null)
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(if (month in row.pinned) "Put $label back to ${suggested.asMoney(false)}"
                             else "Put every month back to what history says")
                    }
                }
                error?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, color = Negative, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = { onDone(false) }, enabled = !saving) { Text("Cancel") } },
    )
}

/**
 * The year for one subcategory: what each finished month cost, faded, and what
 * each month to come is planned at, solid -- the iPhone's PlanHistoryChart.
 * Weight means planned, because this is where a plan is set: the months already
 * spent are the evidence behind it.
 *
 * A dashed line marks the average of the months already spent, which is the
 * figure most people budget against, and the same months a year earlier are
 * totalled beneath when there is a record of them.
 */
@Composable
private fun PlanHistoryChart(
    row: BudgetRow,
    months: List<String>,
    currentMonth: String,
    picked: String,
    onPick: (String) -> Unit,
) {
    val colour = Color(row.colour)
    val spentMonths = months.filter { it < currentMonth && it in row.spent }
    val amounts = months.map { m -> if (m < currentMonth && m in row.spent) row.spent[m] ?: 0L else row.plan[m] ?: 0L }
    val average = spentMonths.map { row.spent[it] ?: 0L }.let { if (it.isEmpty()) null else it.sum() / it.size }
    val top = maxOf(amounts.maxOrNull() ?: 0L, average ?: 0L, 1L).toFloat()
    val track = MaterialTheme.colorScheme.surfaceVariant
    val ink = MaterialTheme.colorScheme.onSurfaceVariant

    val i = months.indexOf(picked).coerceAtLeast(0)
    val pickedDone = picked < currentMonth && picked in row.spent
    Text(
        YearMonth.parse(picked).month.getDisplayName(TextStyle.SHORT, Locale.getDefault()) + ": " +
            (amounts.getOrNull(i) ?: 0L).asMoney(false) + if (pickedDone) " spent" else " planned",
        style = MaterialTheme.typography.labelLarge,
        color = colour,
    )
    Spacer(Modifier.height(4.dp))
    Canvas(
        Modifier.fillMaxWidth().height(140.dp).pointerInput(months) {
            detectTapGestures { pos ->
                val band = size.width / months.size
                onPick(months[(pos.x / band).toInt().coerceIn(0, months.lastIndex)])
            }
        },
    ) {
        val band = size.width / months.size
        val barW = band * 0.62f
        amounts.forEachIndexed { k, v ->
            val m = months[k]
            if (m == picked) {
                drawRoundRect(track, Offset(k * band, 0f), Size(band, size.height), CornerRadius(6f))
            }
            val h = size.height * (v / top)
            val done = m < currentMonth && m in row.spent
            drawRoundRect(
                colour.copy(alpha = if (done) 0.35f else 1f),
                Offset(k * band + (band - barW) / 2, size.height - h),
                Size(barW, h),
                CornerRadius(3f),
            )
        }
        if (average != null && average > 0) {
            val y = size.height - size.height * (average / top)
            drawLine(
                ink, Offset(0f, y), Offset(size.width, y), strokeWidth = 2f,
                pathEffect = PathEffect.dashPathEffect(floatArrayOf(10f, 8f)),
            )
        }
    }
    Row(Modifier.fillMaxWidth()) {
        months.forEach { m ->
            Text(
                YearMonth.parse(m).month.getDisplayName(TextStyle.NARROW, Locale.getDefault()),
                Modifier.weight(1f),
                style = MaterialTheme.typography.labelSmall,
                color = if (m == picked) colour else ink,
            )
        }
    }
    Spacer(Modifier.height(4.dp))
    Text(
        "Faded is what was spent; solid is the plan. Tap a month to plan it." +
            (average?.let { " Dashed line: ${it.asMoney(false)} average spent so far this year." } ?: ""),
        style = MaterialTheme.typography.bodySmall,
        color = ink,
    )
    /* Absent rather than zero when history does not reach back: a year-ago
       total of $0 built from months with no record reads as spending nothing. */
    val prior = row.priorSpent.values.sum()
    if (prior > 0) {
        Text(
            "${prior.asMoney(false)} in the same months a year ago.",
            style = MaterialTheme.typography.bodySmall,
            color = ink,
        )
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
