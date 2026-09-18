package com.bilanciomoney.bilancio.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.bilanciomoney.bilancio.Billing
import com.bilanciomoney.bilancio.Bilancio
import com.bilanciomoney.bilancio.ui.theme.Negative
import com.clerk.api.Clerk
import kotlinx.coroutines.launch

/**
 * The account rather than the money: subscription status, the legal pages,
 * signing out and deleting the account.
 *
 * No price and no way to buy here yet. Google Play requires its own billing for
 * a subscription sold inside the app, which is phase 3 of docs/android-plan.md;
 * until then this only reports the plan, and never points at the website's
 * checkout.
 */
@Composable
fun MoreScreen(onCalendar: () -> Unit, onBanks: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var billing by remember { mutableStateOf<Billing?>(null) }
    var deleting by remember { mutableStateOf(false) }
    var typed by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) { billing = runCatching { Bilancio.billing() }.getOrNull() }

    fun open(url: String) = context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Card(Modifier.fillMaxWidth()) {
            Column {
                Link("Calendar  ›", onClick = onCalendar)
                HorizontalDivider()
                Link("Banks  ›", onClick = onBanks)
            }
        }

        SectionTitle("Subscription")
        Card(Modifier.fillMaxWidth()) {
            Text(
                when (billing?.plan) {
                    null -> "Checking…"
                    "free" -> "Your account is comped — there is nothing to pay."
                    "active" -> if (billing?.manageAt == "apple")
                        "Subscribed through the App Store. Manage it on your iPhone."
                    else "Subscribed on bilanciomoney.com. Manage it there, from the Banks page."
                    "trial" -> billing?.planUntil?.let { "Free trial until ${it.take(10)}." }
                        ?: "Your 14-day free trial starts when you connect your first bank."
                    else -> "Your access has ended. Everything already here stays visible."
                },
                Modifier.padding(16.dp),
            )
        }

        SectionTitle("About")
        Card(Modifier.fillMaxWidth()) {
            Column {
                Link("Terms of Service") { open("${Bilancio.BASE_URL}/terms/") }
                HorizontalDivider()
                Link("Privacy Policy") { open("${Bilancio.BASE_URL}/privacy/") }
                HorizontalDivider()
                Link("Support") { open("${Bilancio.BASE_URL}/support/") }
            }
        }

        SectionTitle("Account")
        Card(Modifier.fillMaxWidth()) {
            Column {
                Link("Sign out") { scope.launch { Clerk.auth.signOut() } }
                HorizontalDivider()
                Link("Delete account", danger = true) { deleting = true }
            }
        }
        message?.let {
            Spacer(Modifier.height(12.dp))
            Text(it)
        }
    }

    if (deleting) {
        /* Two steps, the second typed: a mis-tap cannot take somebody's
           financial history with it. */
        AlertDialog(
            onDismissRequest = { deleting = false; typed = "" },
            title = { Text("Delete your Bilancio account?") },
            text = {
                Column {
                    Text(
                        "Every linked bank is revoked at Plaid, and all of your accounts, transactions, " +
                            "categories and rules are deleted, along with your sign-in. A subscription bought " +
                            "on the website is cancelled; one bought in the iPhone app must be cancelled with " +
                            "Apple. This cannot be undone.",
                    )
                    Spacer(Modifier.height(12.dp))
                    OutlinedTextField(value = typed, onValueChange = { typed = it }, label = { Text("Type DELETE") })
                }
            },
            confirmButton = {
                TextButton(
                    enabled = typed == "DELETE",
                    onClick = {
                        deleting = false
                        scope.launch {
                            runCatching { Bilancio.deleteAccount() }
                                .onSuccess { appleLive ->
                                    message = if (appleLive)
                                        "Deleted. Your App Store subscription is still active — cancel it in your Apple account."
                                    else "Your account has been deleted."
                                    Clerk.auth.signOut()
                                }
                                .onFailure { message = it.message }
                        }
                    },
                ) { Text("Delete", color = Negative) }
            },
            dismissButton = { TextButton(onClick = { deleting = false; typed = "" }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun Link(text: String, danger: Boolean = false, onClick: () -> Unit) {
    Text(
        text,
        color = if (danger) Negative else MaterialTheme.colorScheme.onSurface,
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(16.dp),
    )
}
