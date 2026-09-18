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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.unit.dp
import com.bilanciomoney.bilancio.Bilancio
import com.bilanciomoney.bilancio.Category
import com.bilanciomoney.bilancio.Rule
import com.bilanciomoney.bilancio.ui.theme.Negative
import kotlinx.coroutines.launch

/**
 * The categories, and the merchant rules that file transactions into them.
 *
 * Subcategories can be added under any category, and ones you made can be
 * removed -- the server refuses while anything is still filed there, and says
 * so. Rules are made by "Always file ... here" on a transaction, and removed
 * here; removing one puts that merchant's transactions back to where Plaid put
 * them.
 */
@Composable
fun CategoriesScreen() {
    var refresh by remember { mutableStateOf(0) }
    Loader(refresh, { Bilancio.categories() to Bilancio.rules() }) { (cats, rules): Pair<List<Category>, List<Rule>>, _ ->
        CategoriesContent(cats, rules) { refresh++ }
    }
}

@Composable
private fun CategoriesContent(cats: List<Category>, rules: List<Rule>, onChanged: () -> Unit) {
    val scope = rememberCoroutineScope()
    var adding by remember { mutableStateOf<Category?>(null) }
    var name by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }

    fun act(block: suspend () -> Unit) {
        scope.launch {
            runCatching { block() }.onSuccess { message = null; onChanged() }.onFailure { message = it.message }
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        message?.let { Text(it, color = Negative, style = MaterialTheme.typography.bodyMedium); Spacer(Modifier.height(8.dp)) }

        cats.filter { it.parentSlug == null && it.kind == "spend" }.forEach { p ->
            SectionTitle(p.label)
            Card(Modifier.fillMaxWidth()) {
                Column {
                    cats.filter { it.parentSlug == p.slug }.forEach { k ->
                        Row(
                            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                            Arrangement.SpaceBetween,
                            Alignment.CenterVertically,
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Dot(Color(k.colour)); Spacer(Modifier.width(10.dp)); Text(k.label)
                            }
                            if (!k.isSystem) {
                                TextButton(onClick = { act { Bilancio.deleteCategory(k.id) } }) {
                                    Text("Remove", color = Negative)
                                }
                            }
                        }
                        HorizontalDivider()
                    }
                    Text(
                        "+ Add a subcategory",
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.fillMaxWidth().clickable { adding = p; name = "" }.padding(16.dp),
                    )
                }
            }
        }

        SectionTitle("Merchant rules")
        if (rules.isEmpty()) {
            Text(
                "None yet. Open a transaction and choose \"Always file … here\" to make one.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            Card(Modifier.fillMaxWidth()) {
                Column {
                    rules.forEach { r ->
                        Row(
                            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                            Arrangement.SpaceBetween,
                            Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(r.displayName, fontWeight = FontWeight.Medium)
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Dot(Color(r.colour)); Spacer(Modifier.width(6.dp))
                                    Text(r.label, style = MaterialTheme.typography.bodySmall)
                                }
                            }
                            TextButton(onClick = { act { Bilancio.deleteRule(r.id) } }) { Text("Remove", color = Negative) }
                        }
                        HorizontalDivider()
                    }
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }

    adding?.let { p ->
        AlertDialog(
            onDismissRequest = { adding = null },
            title = { Text("New subcategory under ${p.label}") },
            text = {
                OutlinedTextField(value = name, onValueChange = { name = it.take(40) }, label = { Text("Name") }, singleLine = true)
            },
            confirmButton = {
                TextButton(enabled = name.isNotBlank(), onClick = {
                    val label = name.trim(); adding = null
                    act { Bilancio.createCategory(label, p.slug) }
                }) { Text("Add") }
            },
            dismissButton = { TextButton(onClick = { adding = null }) { Text("Cancel") } },
        )
    }
}
