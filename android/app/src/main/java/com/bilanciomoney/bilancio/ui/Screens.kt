package com.bilanciomoney.bilancio.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.bilanciomoney.bilancio.Bilancio
import com.bilanciomoney.bilancio.Banks
import com.bilanciomoney.bilancio.Summary
import com.bilanciomoney.bilancio.Transaction
import com.bilanciomoney.bilancio.asMoney

/**
 * One way of loading a screen, so every screen fails the same way.
 *
 * A failure is shown as the sentence the server sent — the Worker's `reason` is
 * written to be read by a person ("Your free trial has ended...") and burying it
 * under a status code helps nobody.
 */
@Composable
fun <T> Loader(load: suspend () -> T, content: @Composable (T, reload: () -> Unit) -> Unit) {
    var value by remember { mutableStateOf<T?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableStateOf(0) }

    androidx.compose.runtime.LaunchedEffect(attempt) {
        error = null
        value = null
        runCatching { load() }
            .onSuccess { value = it }
            .onFailure { error = it.message ?: "Something went wrong." }
    }

    val reload = { attempt += 1 }
    when {
        error != null -> Column(
            Modifier.fillMaxSize().padding(24.dp),
            Arrangement.Center,
            Alignment.CenterHorizontally,
        ) {
            Text(error!!, style = MaterialTheme.typography.bodyLarge)
            Spacer(Modifier.height(16.dp))
            Button(onClick = reload) { Text("Try again") }
        }
        value == null -> androidx.compose.foundation.layout.Box(
            Modifier.fillMaxSize(),
            Alignment.Center,
        ) { CircularProgressIndicator() }
        else -> content(value!!, reload)
    }
}

@Composable
fun OverviewScreen() = Loader({ Bilancio.summary() }) { s: Summary, reload ->
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text(s.label, style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(12.dp))

        if (s.accountsCounted == 0) {
            /* No bank yet is not a month with no spending, and showing a bare
               zero says the wrong one. */
            Text("Connect a bank on the Banks tab and this fills up.")
            return@Loader
        }

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Figure("Income", s.income, s.budgetIncome)
                Spacer(Modifier.height(8.dp))
                Figure("Expenses", s.expense, s.budgetExpense)
                Spacer(Modifier.height(8.dp))
                Figure("Net balance", s.net, null)
            }
        }

        if (s.perDay != null && (s.daysLeft ?: 0) > 0) {
            Spacer(Modifier.height(16.dp))
            Text("${s.perDay.asMoney()} a day for the ${s.daysLeft} days left.")
        }
        Spacer(Modifier.height(24.dp))
        Button(onClick = reload) { Text("Refresh") }
    }
}

@Composable
private fun Figure(label: String, amount: Long, budget: Long?) {
    Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween) {
        Text(label)
        Column(horizontalAlignment = Alignment.End) {
            Text(amount.asMoney(), fontWeight = FontWeight.SemiBold)
            if (budget != null) {
                Text("of ${budget.asMoney()} planned", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
fun TransactionsScreen() = Loader({ Bilancio.transactions() }) { rows: List<Transaction>, _ ->
    if (rows.isEmpty()) {
        Column(Modifier.fillMaxSize().padding(24.dp), Arrangement.Center, Alignment.CenterHorizontally) {
            Text("Nothing here yet.")
        }
        return@Loader
    }
    LazyColumn(Modifier.fillMaxSize()) {
        items(rows, key = { it.id }) { t ->
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
                Arrangement.SpaceBetween,
            ) {
                Column(Modifier.fillMaxWidth(0.65f)) {
                    Text(t.name, maxLines = 1)
                    Text(
                        t.date + (if (t.pending) " · pending" else ""),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                Text(t.amount.asMoney(), fontWeight = FontWeight.Medium)
            }
            HorizontalDivider()
        }
    }
}

@Composable
fun BanksScreen() = Loader({ Bilancio.banks() }) { banks: Banks, reload ->
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        if (banks.items.isEmpty()) {
            Text("No banks connected yet.")
        }
        banks.items.forEach { item ->
            Card(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                Column(Modifier.padding(16.dp)) {
                    Text(item.institution, fontWeight = FontWeight.SemiBold)
                    val note = when {
                        item.closed -> "Closed — history kept, not syncing"
                        item.needsSignIn -> "Needs you to sign in again"
                        item.awaitingFirstSync -> "Waiting for transactions"
                        else -> null
                    }
                    if (note != null) {
                        Text(note, style = MaterialTheme.typography.bodySmall)
                    }
                    item.accounts.forEach { a ->
                        Row(Modifier.fillMaxWidth().padding(top = 8.dp), Arrangement.SpaceBetween) {
                            Text(a.name + (a.mask?.let { " ••$it" } ?: ""))
                            Text(a.balance?.asMoney() ?: "—")
                        }
                    }
                }
            }
        }
        if (banks.trialMax != null) {
            Spacer(Modifier.height(8.dp))
            Text(
                "${banks.trialUsed} of ${banks.trialMax} bank connections used during your free trial.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Spacer(Modifier.height(16.dp))
        Button(onClick = reload) { Text("Refresh") }
    }
}
