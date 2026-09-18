package com.bilanciomoney.bilancio.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.bilanciomoney.bilancio.Bilancio
import com.bilanciomoney.bilancio.Category
import com.bilanciomoney.bilancio.Transaction
import com.bilanciomoney.bilancio.TransactionPage
import com.bilanciomoney.bilancio.asMoney
import com.bilanciomoney.bilancio.ui.theme.Negative
import com.bilanciomoney.bilancio.ui.theme.Positive
import kotlinx.coroutines.launch
import java.time.format.DateTimeFormatter

private val SHORT = DateTimeFormatter.ofPattern("MMM d")

/**
 * One category's transactions for a range, listed where it was opened -- the
 * iPhone's drill-down, which keeps the reader on the screen they were reading
 * rather than moving them to another tab to answer "what was that?".
 *
 * The first fifty are shown and the rest counted rather than hidden. Tapping a
 * row opens it, where its category can be changed.
 */
@Composable
fun InlineTransactions(range: String, bucket: String, tint: Color, indent: Dp = 34.dp) {
    var refresh by remember { mutableStateOf(0) }
    var open by remember { mutableStateOf<Transaction?>(null) }
    Column(Modifier.fillMaxWidth().padding(start = indent, end = 12.dp, bottom = 8.dp)) {
        Loader(Triple(range, bucket, refresh), { Bilancio.transactions(range, bucket = bucket, limit = 50) }) {
            page: TransactionPage, _ ->
            if (page.rows.isEmpty()) {
                Text("No transactions.", Modifier.padding(8.dp), style = MaterialTheme.typography.bodySmall)
                return@Loader
            }
            Column {
                page.rows.forEach { tx ->
                    CompactRow(tx, tint) { open = tx }
                }
                if (page.total > page.rows.size) {
                    Text(
                        "${page.total - page.rows.size} more",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
            open?.let { tx ->
                TransactionSheet(tx, page.categories) { changed -> open = null; if (changed) refresh++ }
            }
        }
    }
}

@Composable
fun CompactRow(tx: Transaction, tint: Color, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 6.dp),
        Arrangement.SpaceBetween,
        Alignment.CenterVertically,
    ) {
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
            MerchantLogo(tx.logo, tx.name, tint, size = 26.dp)
            Spacer(Modifier.width(8.dp))
            Column {
                Text(tx.name, maxLines = 1, style = MaterialTheme.typography.bodyMedium)
                Text(
                    tx.date.format(SHORT) + if (tx.pending) " · pending" else "",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Text(
            tx.amount.asMoney(),
            style = MaterialTheme.typography.bodyMedium,
            color = if (tx.amount > 0) Positive else MaterialTheme.colorScheme.onSurface,
        )
    }
}

/**
 * A transaction, opened: what it was, and where it is filed -- with the choice
 * of every category to move it to, and whether every transaction from the same
 * merchant should go there too from now on (a merchant rule, the same one the
 * web and the iPhone make).
 *
 * The categories offered are the ones on the same side of the ledger: money
 * out goes to spending categories, money in to income ones, and either can be
 * a transfer, which is neither.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TransactionSheet(tx: Transaction, categories: List<Category>, onDone: (changed: Boolean) -> Unit) {
    val scope = rememberCoroutineScope()
    var always by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val current = categories.firstOrNull { it.slug == tx.category }
    val side = if (tx.amount > 0) "income" else "spend"
    val parents = categories.filter { it.parentSlug == null && (it.kind == side || it.kind == "transfer") }

    ModalBottomSheet(onDismissRequest = { if (!saving) onDone(false) }) {
        Column(Modifier.padding(horizontal = 20.dp).verticalScroll(rememberScrollState())) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                MerchantLogo(tx.logo, tx.name, Color(current?.colour ?: 0xFF888888), size = 40.dp)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(tx.name, style = MaterialTheme.typography.titleMedium)
                    Text(
                        tx.date.format(DateTimeFormatter.ofPattern("EEEE, MMMM d, yyyy")) + if (tx.pending) " · pending" else "",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Text(tx.amount.asMoney(), fontWeight = FontWeight.SemiBold,
                    color = if (tx.amount > 0) Positive else MaterialTheme.colorScheme.onSurface)
            }
            Spacer(Modifier.height(12.dp))
            Text("Filed under " + (current?.label ?: "Uncategorised"), style = MaterialTheme.typography.bodyMedium)
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable { always = !always }) {
                Checkbox(checked = always, onCheckedChange = { always = it })
                Text("Always file ${tx.name} here", style = MaterialTheme.typography.bodyMedium)
            }
            error?.let { Text(it, color = Negative, style = MaterialTheme.typography.bodySmall) }
            SectionTitle("Move to")
            parents.forEach { p ->
                val kids = categories.filter { it.parentSlug == p.slug }
                val choices = if (kids.isEmpty()) listOf(p) else kids
                Text(p.label, style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 10.dp, bottom = 2.dp))
                choices.forEach { c ->
                    val here = c.slug == tx.category
                    Row(
                        Modifier.fillMaxWidth()
                            .clickable(enabled = !saving && !here) {
                                saving = true; error = null
                                scope.launch {
                                    runCatching { Bilancio.recategorise(tx.id, c.id, always) }
                                        .onSuccess { onDone(true) }
                                        .onFailure { error = it.message; saving = false }
                                }
                            }
                            .padding(vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Dot(Color(c.colour)); Spacer(Modifier.width(10.dp))
                        Text(c.label + if (here) "  ✓" else "",
                            fontWeight = if (here) FontWeight.SemiBold else FontWeight.Normal)
                    }
                    HorizontalDivider()
                }
            }
            Spacer(Modifier.height(32.dp))
        }
    }
}
