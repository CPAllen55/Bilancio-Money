package com.bilanciomoney.bilancio.ui

import androidx.activity.compose.rememberLauncherForActivityResult
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
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.bilanciomoney.bilancio.BankItem
import com.bilanciomoney.bilancio.Banks
import com.bilanciomoney.bilancio.Bilancio
import com.bilanciomoney.bilancio.asMoney
import com.bilanciomoney.bilancio.ui.theme.Negative
import com.plaid.link.OpenPlaidLink
import com.plaid.link.Plaid
import com.plaid.link.configuration.linkTokenConfiguration
import com.plaid.link.result.LinkExit
import com.plaid.link.result.LinkSuccess
import kotlinx.coroutines.launch

/**
 * Connections, their accounts, and the three things done to them: connect,
 * sync, disconnect.
 *
 * Connecting is Plaid Link, opened with a token from our own server -- which is
 * where the trial's two-bank limit and the view-only rule are enforced, so a
 * refusal arrives here as the server's own sentence rather than being guessed
 * at by the app.
 */
@Composable
fun BanksScreen() {
    var refresh by remember { mutableStateOf(0) }
    Loader(refresh, { Bilancio.banks() }) { banks: Banks, _ ->
        BanksContent(banks, onChanged = { refresh++ })
    }
}

@Composable
private fun BanksContent(banks: Banks, onChanged: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var message by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf<BankItem?>(null) }
    /* Set while Link is open to repair a connection rather than make one. In
       update mode the connection already exists and its token is still ours,
       so the public token Link returns is NOT exchanged -- exchanging would
       mint a second connection to the same bank. */
    var repairing by remember { mutableStateOf<BankItem?>(null) }

    /* Link hands back a public token; the server swaps it for the real access
       token, then the history is pulled in rounds until the server says done. */
    val link = rememberLauncherForActivityResult(OpenPlaidLink()) { result ->
        when (result) {
            is LinkSuccess -> scope.launch {
                busy = true
                val repaired = repairing
                repairing = null
                message = if (repaired != null) "Signed back in. Catching up…" else "Storing the connection…"
                runCatching {
                    if (repaired == null) {
                        Bilancio.exchange(result.publicToken)
                        message = "Linked. Pulling transactions…"
                    }
                    Bilancio.syncAll { n -> message = "Pulling transactions… $n so far" }
                }.onSuccess { r ->
                    message = if (r.pending.isNotEmpty())
                        "${r.pending.joinToString()} is still preparing transactions. Sync again in a moment."
                    else "Done — ${r.added} transactions in."
                    onChanged()
                }.onFailure { message = it.message }
                busy = false
            }
            is LinkExit -> { repairing = null; message = result.error?.displayMessage ?: "Link closed." }
        }
    }

    val atLimit = banks.trialMax != null && (banks.trialUsed ?: 0) >= banks.trialMax

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Text("Linked banks", style = MaterialTheme.typography.titleLarge)
        Text(
            "Bilancio reads your accounts. It cannot move money, and your bank sign-in goes to Plaid, never to us.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(12.dp))

        if (banks.items.isEmpty()) {
            Text("No banks connected yet.")
        }
        banks.items.forEach { item ->
            Card(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                Column(Modifier.padding(16.dp)) {
                    Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween) {
                        Text(item.institution, fontWeight = FontWeight.SemiBold)
                        TextButton(onClick = { confirming = item }, enabled = !busy) {
                            Text("Disconnect", color = Negative)
                        }
                    }
                    val note = when {
                        item.closed -> "Closed — history kept, not syncing"
                        item.needsSignIn -> "Needs you to sign in again"
                        item.awaitingFirstSync -> "Waiting for transactions"
                        else -> null
                    }
                    if (note != null) {
                        Text(note, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (item.needsSignIn && !item.closed) {
                        /* Offered before Disconnect, and as the primary of the two:
                           a bank asking for a fresh sign-in is repaired by signing
                           in, not by throwing two years of history away. */
                        Button(
                            enabled = !busy,
                            onClick = {
                                scope.launch {
                                    busy = true
                                    message = "Opening ${item.institution}…"
                                    runCatching { Bilancio.repairToken(item.id) }
                                        .onSuccess { token ->
                                            message = null
                                            repairing = item
                                            link.launch(Plaid.createPlaidLinkSession(context, linkTokenConfiguration { this.token = token }))
                                        }
                                        .onFailure { message = it.message }
                                    busy = false
                                }
                            },
                            modifier = Modifier.padding(top = 8.dp),
                        ) { Text("Sign in again") }
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
            Spacer(Modifier.height(4.dp))
            Text(
                "${minOf(banks.trialUsed ?: 0, banks.trialMax)} of ${banks.trialMax} bank connections used during your free trial" +
                    if (atLimit) " — subscribe to connect more." else ".",
                style = MaterialTheme.typography.bodySmall,
            )
        }

        Spacer(Modifier.height(16.dp))
        Row {
            Button(
                enabled = !busy && !atLimit,
                onClick = {
                    scope.launch {
                        busy = true
                        message = "Opening Plaid…"
                        runCatching { Bilancio.linkToken() }
                            .onSuccess { token ->
                                message = null
                                val session = Plaid.createPlaidLinkSession(
                                    context,
                                    linkTokenConfiguration { this.token = token },
                                )
                                link.launch(session)
                            }
                            .onFailure { message = it.message }
                        busy = false
                    }
                },
            ) { Text("Connect a bank") }
            Spacer(Modifier.width(12.dp))
            OutlinedButton(
                enabled = !busy && banks.items.isNotEmpty(),
                onClick = {
                    scope.launch {
                        busy = true
                        message = "Syncing…"
                        runCatching { Bilancio.syncAll { n -> message = "Syncing… $n so far" } }
                            .onSuccess { r ->
                                message = when {
                                    r.readOnly -> "Syncing is paused while your account is view-only."
                                    r.pending.isNotEmpty() -> "${r.pending.joinToString()} is still preparing transactions."
                                    else -> "${r.added} new transactions."
                                }
                                onChanged()
                            }
                            .onFailure { message = it.message }
                        busy = false
                    }
                },
            ) { Text("Sync") }
        }

        message?.let {
            Spacer(Modifier.height(12.dp))
            Text(it, style = MaterialTheme.typography.bodyMedium)
        }
    }

    confirming?.let { item ->
        AlertDialog(
            onDismissRequest = { confirming = null },
            title = { Text("Disconnect ${item.institution}?") },
            text = {
                Text(
                    "Bilancio will tell Plaid to revoke access, then delete this bank's accounts and " +
                        "transactions along with any categories you changed on them. Your own categories " +
                        "and merchant rules are kept.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirming = null
                    scope.launch {
                        busy = true
                        runCatching { Bilancio.disconnect(item.id) }
                            .onSuccess { message = "${item.institution} disconnected and its data deleted."; onChanged() }
                            .onFailure { message = it.message }
                        busy = false
                    }
                }) { Text("Disconnect", color = Negative) }
            },
            dismissButton = { TextButton(onClick = { confirming = null }) { Text("Cancel") } },
        )
    }
}
