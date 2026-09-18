package com.bilanciomoney.bilancio.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.bilanciomoney.bilancio.Bilancio
import com.bilanciomoney.bilancio.CalendarDay
import com.bilanciomoney.bilancio.CalendarMonth
import com.bilanciomoney.bilancio.Ranges
import com.bilanciomoney.bilancio.TransactionPage
import com.bilanciomoney.bilancio.asMoney
import com.bilanciomoney.bilancio.ui.theme.Negative
import java.time.LocalDate
import java.time.YearMonth
import java.time.format.DateTimeFormatter

/**
 * The month as a grid, heaviest days darkest, with a dot where a subscription
 * lands -- including the ones still to come this month, which is the point of
 * looking ahead. Tapping a day lists what happened on it.
 */
@Composable
fun CalendarScreen() {
    var month by remember { mutableStateOf(YearMonth.now()) }
    var open by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.padding(start = 8.dp, top = 8.dp)) {
            TextButton(onClick = { open = true }) {
                Text(Ranges.label(month) + "  ▾", style = MaterialTheme.typography.titleMedium)
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                Ranges.recent().forEach { m ->
                    DropdownMenuItem(text = { Text(Ranges.label(m)) }, onClick = { open = false; month = m })
                }
            }
        }
        Loader(month, { Bilancio.calendar(month) }) { c: CalendarMonth, _ -> MonthGrid(c) }
    }
}

@Composable
private fun MonthGrid(c: CalendarMonth) {
    var picked by remember(c) { mutableStateOf<CalendarDay?>(null) }
    val heaviest = maxOf(c.days.maxOfOrNull { it.spent } ?: 0L, 1L).toFloat()
    val today = LocalDate.now()
    /* Weeks start on Sunday, as a US calendar does. */
    val lead = c.month.atDay(1).dayOfWeek.value % 7

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
        Text(
            "${c.spent.asMoney(false)} spent · ${c.subscriptions.asMoney(false)} in subscriptions",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(8.dp))
        Row(Modifier.fillMaxWidth()) {
            listOf("S", "M", "T", "W", "T", "F", "S").forEach {
                Text(it, Modifier.weight(1f), style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        val cells: List<CalendarDay?> = List(lead) { null } + c.days
        cells.chunked(7).forEach { week ->
            Row(Modifier.fillMaxWidth(), Arrangement.spacedBy(4.dp)) {
                (0 until 7).forEach { i ->
                    val d = week.getOrNull(i)
                    Box(Modifier.weight(1f).aspectRatio(0.8f).padding(vertical = 2.dp)) {
                        if (d != null) DayCell(d, d.spent / heaviest, d.date == today, d == picked) { picked = d }
                    }
                }
            }
        }

        picked?.let { d -> DayDetail(d) }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun DayCell(d: CalendarDay, weight: Float, isToday: Boolean, isPicked: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(6.dp)
    Box(
        Modifier.fillMaxSize().clip(shape)
            .background(Negative.copy(alpha = if (d.spent > 0) 0.10f + 0.70f * weight else 0.04f))
            .then(if (isPicked || isToday) Modifier.border(2.dp, MaterialTheme.colorScheme.primary, shape) else Modifier)
            .clickable(onClick = onClick)
            .padding(3.dp),
    ) {
        Text("${d.date.dayOfMonth}", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold)
        if (d.spent > 0) {
            Text(
                d.spent.asMoney(false),
                Modifier.align(Alignment.BottomStart),
                fontSize = 9.sp,
                maxLines = 1,
                color = if (weight > 0.5f) Color.White else MaterialTheme.colorScheme.onSurface,
            )
        }
        if (d.subs.isNotEmpty()) {
            Box(
                Modifier.align(Alignment.TopEnd).padding(1.dp).height(6.dp).aspectRatio(1f)
                    .clip(RoundedCornerShape(3.dp)).background(MaterialTheme.colorScheme.primary),
            )
        }
    }
}

@Composable
private fun DayDetail(d: CalendarDay) {
    SectionTitle(d.date.format(DateTimeFormatter.ofPattern("EEEE, MMMM d")))
    if (d.subs.isNotEmpty()) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp)) {
                d.subs.forEach { s ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), Arrangement.SpaceBetween) {
                        Text(s.name + if (s.projected) " (due)" else "")
                        Text(s.cents.asMoney())
                    }
                }
            }
        }
        Spacer(Modifier.height(8.dp))
    }
    if (d.count == 0) {
        Text("Nothing spent on this day.", style = MaterialTheme.typography.bodyMedium)
        return
    }
    Loader(d.date, { Bilancio.transactions("day:${d.date}", limit = 100) }) { page: TransactionPage, _ ->
        val cats = page.categories.associateBy { it.slug }
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(vertical = 4.dp)) {
                page.rows.forEach { t ->
                    val cat = cats[t.category]
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                        Arrangement.SpaceBetween,
                        Alignment.CenterVertically,
                    ) {
                        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                            MerchantLogo(t.logo, t.name, Color(cat?.colour ?: 0xFF888888), size = 28.dp)
                            Spacer(Modifier.padding(start = 10.dp))
                            Column {
                                Text(t.name, maxLines = 1)
                                Text(cat?.label ?: "", style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        Text(t.amount.asMoney(), fontWeight = FontWeight.Medium)
                    }
                }
            }
        }
    }
}
