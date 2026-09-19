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
import com.bilanciomoney.bilancio.Summary
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
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
fun BudgetingScreen() = Loader(Unit, {
    /* The month in progress has no `spent` in /api/budget -- history stops at
       the last complete month, because a partial one taken as evidence drags
       every baseline down -- so what it has cost so far comes from the same
       summary the Overview reads. Decoration: without it the screen still
       works, one month short of a figure. */
    Triple(Bilancio.budget(), Bilancio.categories(), runCatching { Bilancio.summary("this-month") }.getOrNull())
}) { (b, cats, live): Triple<Budget, List<Category>, Summary?>, reload ->
    var editing by remember { mutableStateOf<BudgetRow?>(null) }
    var editingGroup by remember { mutableStateOf<String?>(null) }
    var month by remember(b) { mutableStateOf(b.currentMonth.takeIf { it in b.months } ?: b.months.lastOrNull().orEmpty()) }
    var open by remember { mutableStateOf(setOf<String>()) }
    /* /api/budget carries the leaves only -- parents are not budgeted -- so a
       parent's name and colour come from the category tree. */
    val parents = remember(cats) { cats.filter { it.parentSlug == null }.associateBy { it.slug } }
    val isCurrent = month == b.currentMonth
    val spentOf: (BudgetRow) -> Long = { r ->
        (if (isCurrent) live?.byCategory?.get(r.slug) else null) ?: r.spent[month] ?: 0L
    }

    val income = b.incomePlan[month] ?: 0L
    val planned = b.rows.sumOf { it.plan[month] ?: 0L }
    val spent = b.rows.sumOf(spentOf)
    val net = income - planned

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        MonthStrip(b.months, b.labels, month) { month = it }
        Spacer(Modifier.height(10.dp))

        /* Planned income, planned spending, and the difference -- the figure
           the whole screen is really about. Both halves, because both are
           editable: a plan that only budgets spending says what a month costs
           and never whether it can be afforded. */
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Text("Planned net", style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(
                    net.asMoney(false),
                    style = MaterialTheme.typography.displaySmall,
                    fontWeight = FontWeight.SemiBold,
                    color = if (net < 0) Negative else Positive,
                )
                Text(
                    if (net < 0) "This month plans to spend more than it earns." else "What the plan expects to keep.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(14.dp))
                Row(Modifier.fillMaxWidth()) {
                    HeroFigure("Income planned", income, Positive)
                    HeroFigure("Spending planned", planned, Negative)
                }
                Spacer(Modifier.height(14.dp))
                ProportionBar(
                    label = "Spent so far", amount = spent, planned = planned,
                    fallbackScale = maxOf(spent, planned),
                    tint = if (spent > planned) Negative else Positive,
                    verb = "spent", incomeSide = false,
                )
                Text(
                    "${b.savingsAnnual.asMoney(false)} planned to keep this year.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
        }

        MoneyOverTime(b)

        SectionTitle("Money in")
        Card(Modifier.fillMaxWidth()) {
            PlanRow(
                b.incomeRow, month,
                (if (isCurrent) live?.income else null) ?: b.incomeSpent[month] ?: 0L,
                parentLabel = null,
            ) { editing = b.incomeRow }
        }

        SectionTitle("By category")
        /* Grouped by parent, biggest plan first: a budget is read to find what
           dominates it, and alphabetical order buries that under whatever
           begins with an A. Inside a parent, the same rule for the same reason. */
        val groups = b.rows
            .filter { (it.plan[month] ?: 0L) > 0 || spentOf(it) > 0 }
            .groupBy { it.parentSlug ?: it.slug }
            .map { (slug, kids) ->
                val ordered = kids.sortedByDescending { it.plan[month] ?: 0L }
                Triple(slug, ordered, ordered.sumOf { it.plan[month] ?: 0L })
            }
            .sortedByDescending { it.third }

        if (groups.isEmpty()) {
            Card(Modifier.fillMaxWidth()) {
                Text("Nothing planned or spent in this month.", Modifier.padding(16.dp),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        groups.forEach { (slug, kids, plan) ->
            val known = parents[slug]
            val label = known?.label ?: slug.replace('-', ' ').replaceFirstChar { it.uppercase() }
            val colour = Color(known?.colour ?: kids.first().colour)
            val used = kids.sumOf(spentOf)
            val expanded = slug in open
            Card(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
                Column {
                    ParentRow(label, colour, kids.size, plan, used, expanded) {
                        open = if (expanded) open - slug else open + slug
                    }
                    if (expanded) {
                        HorizontalDivider(Modifier.padding(start = 14.dp))
                        Text(
                            "Set a total for $label  ›",
                            color = MaterialTheme.colorScheme.primary,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.fillMaxWidth().clickable { editingGroup = slug }
                                .padding(horizontal = 14.dp, vertical = 10.dp),
                        )
                        kids.forEach { k ->
                            HorizontalDivider(Modifier.padding(start = 14.dp))
                            PlanRow(k, month, spentOf(k), parentLabel = label) { editing = k }
                        }
                    }
                }
            }
        }

        Spacer(Modifier.height(4.dp))
        Text(
            "Only subcategories are budgeted, so anything filed straight onto a top-level category — and " +
                "everything in Unsorted — is spending with no line here. The plan is shaped from " +
                "${b.monthsOfHistory} month${if (b.monthsOfHistory == 1) "" else "s"} of history, and drives the " +
                "website and the iPhone too.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(24.dp))
    }

    editing?.let { row ->
        EditPlan(row, b.months, b.currentMonth, month, onDone = { changed -> editing = null; if (changed) reload() })
    }
    editingGroup?.let { slug ->
        val kids = b.rows.filter { (it.parentSlug ?: it.slug) == slug }
        GroupEditor(
            parents[slug]?.label ?: slug, kids, month,
            onDone = { changed -> editingGroup = null; if (changed) reload() },
        )
    }
}

/** Twelve months do not fit across a phone, so they scroll -- opened on the
    month being read. */
@Composable
private fun MonthStrip(months: List<String>, labels: List<String>, selected: String, onPick: (String) -> Unit) {
    val state = rememberLazyListState()
    LaunchedEffect(selected) {
        val i = months.indexOf(selected)
        if (i >= 0) state.animateScrollToItem(maxOf(0, i - 2))
    }
    LazyRow(state = state, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        items(months.size) { i ->
            val m = months[i]
            FilterChip(
                selected = m == selected,
                onClick = { onPick(m) },
                label = { Text(labels.getOrNull(i) ?: YearMonth.parse(m).month.getDisplayName(TextStyle.SHORT, Locale.getDefault())) },
            )
        }
    }
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.HeroFigure(label: String, cents: Long, tint: Color) {
    Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(cents.asMoney(false), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = tint)
    }
}

/** The parent line: what it costs in total, and the way into what is inside. */
@Composable
private fun ParentRow(
    label: String, colour: Color, kids: Int, plan: Long, spent: Long, open: Boolean, toggle: () -> Unit,
) {
    val over = plan > 0 && spent > plan
    Column(Modifier.fillMaxWidth().clickable(onClick = toggle).padding(horizontal = 14.dp, vertical = 10.dp)) {
        Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween, Alignment.CenterVertically) {
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                Text(if (open) "⌄" else "›", Modifier.width(16.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant, fontWeight = FontWeight.Bold)
                ColourBar(colour, 20.dp)
                Spacer(Modifier.width(10.dp))
                Column {
                    Text(label, maxLines = 1)
                    Text(
                        "$kids subcategor${if (kids == 1) "y" else "ies"}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(spent.asMoney(false), color = if (over) Negative else MaterialTheme.colorScheme.onSurface)
                Text("of ${plan.asMoney(false)}", style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Spacer(Modifier.height(6.dp))
        Row(Modifier.padding(start = 26.dp)) { PlanBar(spent, plan, if (over) Negative else colour) }
    }
}

/** One budgeted line: what it has cost against what it is planned at. */
@Composable
private fun PlanRow(row: BudgetRow, month: String, spent: Long, parentLabel: String?, onClick: () -> Unit) {
    val plan = row.plan[month] ?: 0L
    val over = plan > 0 && spent > plan
    Column(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 9.dp)) {
        Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween, Alignment.CenterVertically) {
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                ColourBar(Color(row.colour), 22.dp)
                Spacer(Modifier.width(10.dp))
                Column {
                    Text(row.label, maxLines = 1)
                    if (parentLabel != null) {
                        Text(parentLabel, style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(spent.asMoney(false), color = if (over) Negative else MaterialTheme.colorScheme.onSurface)
                /* A pinned month and a shaped one read identically and behave
                   completely differently when the shape moves underneath, so
                   the pin is worth one glyph. */
                Text(
                    (if (month in row.pinned) "📌 " else "") + "of ${plan.asMoney(false)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text("  ›", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.height(6.dp))
        Row(Modifier.padding(start = 12.dp)) { PlanBar(spent, plan, if (over) Negative else Color(row.colour)) }
    }
}

@Composable
private fun ColourBar(colour: Color, height: androidx.compose.ui.unit.Dp) {
    Box(Modifier.width(3.dp).height(height).background(colour, RoundedCornerShape(2.dp)))
}

/**
 * A budget for a whole category, which the API has no such thing as.
 *
 * Only subcategories are budgeted, so a parent's budget is the sum of its
 * children and nothing else. Naming a figure for the parent therefore has to
 * become a figure for each child, and the only distribution that leaves the
 * plan recognisable is the one it already has: each child keeps its share.
 */
@Composable
private fun GroupEditor(label: String, rows: List<BudgetRow>, month: String, onDone: (changed: Boolean) -> Unit) {
    val scope = rememberCoroutineScope()
    val monthPlan = rows.sumOf { it.plan[month] ?: 0L }
    val yearPlan = rows.sumOf { it.baselineOverride ?: it.baseline }
    var monthTyped by remember { mutableStateOf("") }
    var yearTyped by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val monthLabel = YearMonth.parse(month).month.getDisplayName(TextStyle.FULL, Locale.getDefault())
    val monthCents = monthTyped.filter { it.isDigit() }.toLongOrNull()?.times(100)
    val yearCents = yearTyped.filter { it.isDigit() }.toLongOrNull()?.times(100)

    AlertDialog(
        onDismissRequest = { if (!saving) onDone(false) },
        title = { Text("Set a total for $label") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text(
                    "$monthLabel is planned at ${monthPlan.asMoney(false)} across ${rows.size} subcategories. " +
                        "A total set here is split between them in the shares they already have.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = monthTyped,
                    onValueChange = { monthTyped = it.filter { c -> c.isDigit() }.take(7) },
                    label = { Text("Total for $monthLabel") },
                    prefix = { Text("$") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = yearTyped,
                    onValueChange = { yearTyped = it.filter { c -> c.isDigit() }.take(7) },
                    label = { Text("Total for a typical month") },
                    prefix = { Text("$") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                )
                Text(
                    "Typically ${yearPlan.asMoney(false)} a month now.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                /* What each child would become, before it is committed. */
                val preview = monthCents?.let { distribute(it, rows.map { r -> r.plan[month] ?: 0L }) }
                if (preview != null) {
                    Spacer(Modifier.height(12.dp))
                    Text("$monthLabel would become", style = MaterialTheme.typography.labelMedium)
                    rows.forEachIndexed { i, r ->
                        Row(Modifier.fillMaxWidth().padding(top = 4.dp), Arrangement.SpaceBetween) {
                            Text(r.label, style = MaterialTheme.typography.bodySmall)
                            Text(preview[i].asMoney(false), style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
                error?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, color = Negative, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !saving && (monthCents != null || yearCents != null),
                onClick = {
                    saving = true; error = null
                    val edits = buildList {
                        monthCents?.let { total ->
                            distribute(total, rows.map { it.plan[month] ?: 0L }).forEachIndexed { i, share ->
                                add(Bilancio.budgetEdit(rows[i].slug, month, share))
                            }
                        }
                        yearCents?.let { total ->
                            distribute(total, rows.map { it.baselineOverride ?: it.baseline }).forEachIndexed { i, share ->
                                add(Bilancio.budgetEdit(rows[i].slug, cents = share))
                            }
                        }
                    }
                    scope.launch {
                        runCatching { Bilancio.saveBudget(edits) }
                            .onSuccess { onDone(true) }
                            .onFailure { error = it.message; saving = false }
                    }
                },
            ) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = { onDone(false) }, enabled = !saving) { Text("Cancel") } },
    )
}

/**
 * Splits a total across shares, exactly.
 *
 * Exactly, not approximately: rounding each share on its own loses or invents
 * cents, and children that do not add up to their parent is the one thing this
 * must never produce. Everything rounds down and the remainder goes to the
 * largest share, where a few cents cannot be seen.
 */
internal fun distribute(total: Long, current: List<Long>): List<Long> {
    if (current.isEmpty()) return emptyList()
    val sum = current.sum()
    if (sum <= 0L) {
        /* Nothing planned yet, so there is no shape to keep: an even split is
           the only honest reading of "spread this across them". */
        val base = total / current.size
        return current.indices.map { if (it == 0) base + total - base * current.size else base }
    }
    val out = current.map { total * it / sum }.toMutableList()
    val short = total - out.sum()
    if (short != 0L) {
        val biggest = current.indices.maxByOrNull { current[it] } ?: 0
        out[biggest] = out[biggest] + short
    }
    return out
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

