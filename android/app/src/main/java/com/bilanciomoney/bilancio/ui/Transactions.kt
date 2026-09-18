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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AssistChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.bilanciomoney.bilancio.Bilancio
import com.bilanciomoney.bilancio.Transaction
import com.bilanciomoney.bilancio.TransactionPage
import com.bilanciomoney.bilancio.asMoney
import com.bilanciomoney.bilancio.ui.theme.Positive
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.format.DateTimeFormatter

private val DAY = DateTimeFormatter.ofPattern("EEE, MMM d")

/** A category drill-down, arriving from the Overview. */
data class Bucket(val slug: String, val label: String)

/**
 * The ledger for the period, a day at a time, newest first. A category tapped
 * on the Overview arrives here as a filter, which is the drill-down the web app
 * and the iPhone both have; clearing it shows everything again.
 */
@Composable
fun TransactionsScreen(
    period: Period,
    onPeriod: (Period) -> Unit,
    bucket: Bucket?,
    onClearBucket: () -> Unit,
) {
    var typed by remember { mutableStateOf("") }
    var search by remember { mutableStateOf("") }
    /* Searched after a pause in typing, not on every keystroke: each search is
       a query over the whole period's ledger. */
    LaunchedEffect(typed) { delay(350); search = typed.trim() }

    Column(Modifier.fillMaxSize()) {
        Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp)) {
            PeriodBar(period, onPeriod)
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = typed,
                onValueChange = { typed = it },
                placeholder = { Text("Search merchants") },
                singleLine = true,
                trailingIcon = {
                    if (typed.isNotEmpty()) TextButton(onClick = { typed = "" }) { Text("✕") }
                },
                modifier = Modifier.fillMaxWidth(),
            )
            if (bucket != null) {
                Spacer(Modifier.height(8.dp))
                AssistChip(onClick = onClearBucket, label = { Text("${bucket.label}  ✕") })
            }
        }
        Ledger(period, bucket, search)
    }
}

@Composable
private fun Ledger(period: Period, bucket: Bucket?, search: String) = Loader(
    Triple(period.key, bucket, search),
    { Bilancio.transactions(period.key, bucket?.slug, merchant = search) },
) { first: TransactionPage, reload ->
    var rows by remember(first) { mutableStateOf(first.rows) }
    var open by remember(first) { mutableStateOf<Transaction?>(null) }
    var loading by remember(first) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val categories = remember(first) { first.categories.associateBy { it.slug } }

    LazyColumn(Modifier.fillMaxSize()) {
        item {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                Text(
                    "${first.total} transactions · in ${first.moneyIn.asMoney(false)} · out ${first.moneyOut.asMoney(false)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        if (rows.isEmpty()) {
            item {
                Text(
                    if (search.isNotEmpty()) "Nothing matching “$search” in this period. Try a shorter word, or a wider period."
                    else "Nothing here yet.",
                    Modifier.padding(16.dp),
                )
            }
        }

        rows.groupBy { it.date }.forEach { (date, dayRows) ->
            item(key = "d$date") {
                Text(
                    date.format(DAY),
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(start = 16.dp, top = 14.dp, bottom = 4.dp),
                )
            }
            items(dayRows, key = { it.id }) { t -> TransactionRow(t, categories[t.category]) { open = t } }
        }

        if (rows.size < first.total) {
            item {
                TextButton(
                    enabled = !loading,
                    onClick = {
                        loading = true
                        scope.launch {
                            runCatching { Bilancio.transactions(period.key, bucket?.slug, offset = rows.size, merchant = search) }
                                .onSuccess { rows = rows + it.rows }
                            loading = false
                        }
                    },
                    modifier = Modifier.fillMaxWidth().padding(16.dp),
                ) { Text(if (loading) "Loading…" else "Show more") }
            }
        }
    }
    open?.let { t ->
        TransactionSheet(t, first.categories) { changed -> open = null; if (changed) reload() }
    }
}

@Composable
private fun TransactionRow(t: Transaction, category: com.bilanciomoney.bilancio.Category?, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp),
        Arrangement.SpaceBetween,
        Alignment.CenterVertically,
    ) {
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
            MerchantLogo(t.logo, t.name, Color(category?.colour ?: 0xFF888888))
            Spacer(Modifier.width(12.dp))
            Column {
                Text(t.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    (category?.label ?: "Uncategorised") + if (t.pending) " · pending" else "",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Spacer(Modifier.width(12.dp))
        /* Positive is money in, as the API sends it; money in is green, and
           money out is plain rather than red -- red would make every coffee
           read as a warning. */
        Text(
            t.amount.asMoney(),
            fontWeight = FontWeight.Medium,
            color = if (t.amount > 0) Positive else MaterialTheme.colorScheme.onSurface,
        )
    }
    HorizontalDivider(Modifier.padding(start = 60.dp))
}
