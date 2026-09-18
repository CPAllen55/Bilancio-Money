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
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.TextButton
import androidx.compose.ui.text.input.KeyboardType
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
    var splitting by remember { mutableStateOf(false) }
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
            if (tx.partOf != null) {
                Text(
                    "Part of a ${tx.partOf.asMoney()} transaction that is split between categories.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (splitting) {
                SplitEditor(tx, categories, parents, current, onCancel = { splitting = false }, onSaved = { onDone(true) })
                Spacer(Modifier.height(32.dp))
                return@Column
            }
            TextButton(onClick = { splitting = true }, enabled = !saving, contentPadding = PaddingValues(0.dp)) {
                Text(if (tx.splits.isNotEmpty() || tx.partOf != null) "Edit split" else "Split between categories")
            }
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

/**
 * One transaction divided between categories -- the web's and the iPhone's
 * split. Only the parts carved out are stored; whatever is left over stays
 * where the transaction is filed, so the parts can never add up to anything
 * but the whole. Amounts are typed as plain dollars and given the
 * transaction's own direction here; the server refuses parts that exceed it.
 */
@Composable
private fun SplitEditor(
    tx: Transaction,
    categories: List<Category>,
    parents: List<Category>,
    current: Category?,
    onCancel: () -> Unit,
    onSaved: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val whole = tx.partOf ?: tx.amount
    val sign = if (whole < 0) -1 else 1
    val choices = parents.flatMap { p ->
        val kids = categories.filter { it.parentSlug == p.slug }
        if (kids.isEmpty()) listOf(p) else kids
    }.filter { it.slug != current?.slug }
    val rows = remember {
        androidx.compose.runtime.mutableStateListOf<Pair<Category?, String>>().apply {
            tx.splits.forEach { (id, cents) ->
                add(categories.firstOrNull { it.id == id } to "%.2f".format(kotlin.math.abs(cents) / 100.0))
            }
            if (isEmpty()) add(null to "")
        }
    }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun cents(s: String): Long? =
        if (s.isBlank()) 0L else s.trim().removePrefix("$").toBigDecimalOrNull()
            ?.movePointRight(2)?.setScale(0, java.math.RoundingMode.HALF_UP)?.toLong()

    val parsed = rows.map { cents(it.second) }
    val carved = parsed.sumOf { it ?: 0L }
    val left = kotlin.math.abs(whole) - carved

    SectionTitle("Split ${whole.asMoney()}")
    rows.forEachIndexed { i, (cat, amount) ->
        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            var menu by remember { mutableStateOf(false) }
            Column(Modifier.weight(1f)) {
                OutlinedButton(onClick = { menu = true }, modifier = Modifier.fillMaxWidth()) {
                    if (cat != null) { Dot(Color(cat.colour)); Spacer(Modifier.width(6.dp)) }
                    Text(cat?.label ?: "Choose a category", maxLines = 1)
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    choices.forEach { c ->
                        DropdownMenuItem(
                            text = { Text(c.label) },
                            leadingIcon = { Dot(Color(c.colour)) },
                            onClick = { rows[i] = c to amount; menu = false },
                        )
                    }
                }
            }
            Spacer(Modifier.width(8.dp))
            OutlinedTextField(
                value = amount,
                onValueChange = { v -> rows[i] = cat to v.filter { it.isDigit() || it == '.' }.take(10) },
                modifier = Modifier.width(110.dp),
                singleLine = true,
                prefix = { Text("$") },
                isError = parsed[i] == null,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            )
            TextButton(onClick = { rows.removeAt(i); if (rows.isEmpty()) rows.add(null to "") }) { Text("✕") }
        }
    }
    TextButton(onClick = { rows.add(null to "") }, contentPadding = PaddingValues(0.dp)) { Text("+ Another part") }
    Text(
        if (left >= 0) (sign * left).asMoney() + " stays in " + (current?.label ?: "its category")
        else "The parts are " + (-left).asMoney() + " more than the transaction",
        style = MaterialTheme.typography.bodyMedium,
        color = if (left < 0) Negative else MaterialTheme.colorScheme.onSurface,
    )
    error?.let { Text(it, color = Negative, style = MaterialTheme.typography.bodySmall) }
    Spacer(Modifier.height(8.dp))
    Row {
        Button(
            enabled = !saving && left >= 0 && parsed.all { it != null } &&
                rows.all { (c, a) -> c != null || cents(a) == 0L },
            onClick = {
                saving = true; error = null
                val parts = rows.mapNotNull { (c, a) ->
                    val n = cents(a) ?: 0L
                    if (c == null || n == 0L) null else c.id to sign * n
                }
                scope.launch {
                    runCatching { Bilancio.setSplits(tx.id, parts) }
                        .onSuccess { onSaved() }
                        .onFailure { error = it.message; saving = false }
                }
            },
        ) { Text("Save split") }
        Spacer(Modifier.width(8.dp))
        TextButton(onClick = onCancel, enabled = !saving) { Text("Cancel") }
        if (tx.splits.isNotEmpty() || tx.partOf != null) {
            Spacer(Modifier.weight(1f))
            TextButton(enabled = !saving, onClick = {
                saving = true; error = null
                scope.launch {
                    runCatching { Bilancio.setSplits(tx.id, emptyList()) }
                        .onSuccess { onSaved() }
                        .onFailure { error = it.message; saving = false }
                }
            }) { Text("Unsplit", color = Negative) }
        }
    }
}
