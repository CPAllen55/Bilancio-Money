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
import com.bilanciomoney.bilancio.PlayStore
import androidx.compose.runtime.collectAsState
import com.bilanciomoney.bilancio.ui.theme.Negative
import com.clerk.api.Clerk
import kotlinx.coroutines.launch

/**
 * The account rather than the money: subscription status, the legal pages,
 * signing out and deleting the account.
 *
 * Subscriptions are sold through Google Play Billing -- Play requires it for
 * anything bought inside the app -- and never by pointing at the website's
 * checkout. Prices come from Play, localised, never from us.
 */
@Composable
fun MoreScreen(onOpen: (page: String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var billing by remember { mutableStateOf<Billing?>(null) }
    var deleting by remember { mutableStateOf(false) }
    var typed by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }

    val changed by PlayStore.changed.collectAsState()
    val storeMessage by PlayStore.message.collectAsState()
    LaunchedEffect(changed) { billing = runCatching { Bilancio.billing() }.getOrNull() }

    fun open(url: String) = context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Card(Modifier.fillMaxWidth()) {
            Column {
                /* The iPhone's More, in its order: the places visited rather
                   than watched. */
                Link("Calendar  ›") { onOpen("Calendar") }
                HorizontalDivider()
                Link("Year ahead  ›") { onOpen("Forecast") }
                HorizontalDivider()
                Link("Net worth  ›") { onOpen("NetWorth") }
                HorizontalDivider()
                Link("Categories & rules  ›") { onOpen("Categories") }
                HorizontalDivider()
                Link("Banks  ›") { onOpen("Banks") }
            }
        }

        SectionTitle("Subscription")
        Card(Modifier.fillMaxWidth()) {
            Column {
                Text(
                    when (billing?.plan) {
                        null -> "Checking…"
                        "free" -> "Your account is comped — there is nothing to pay."
                        "active" -> when (billing?.manageAt) {
                            "apple" -> "Subscribed through the App Store. Manage it on your iPhone."
                            "google" -> "Subscribed through Google Play" +
                                (billing?.planUntil?.let { " — renews or ends ${it.take(10)}." } ?: ".")
                            else -> "Subscribed on bilanciomoney.com. Manage it there, from the Banks page."
                        }
                        "trial" -> billing?.planUntil?.let { "Free trial until ${it.take(10)}." }
                            ?: "Your 14-day free trial starts when you connect your first bank."
                        else -> "Your access has ended. Everything already here stays visible."
                    },
                    Modifier.padding(16.dp),
                )
                billing?.let { b ->
                    if (b.manageAt == "google" && b.plan == "active") {
                        HorizontalDivider()
                        Link("Manage in Google Play  ›") {
                            open("https://play.google.com/store/account/subscriptions?sku=${PlayStore.PRODUCT_ID}&package=${context.packageName}")
                        }
                    }
                    /* Offered unless they are comped or paying some other way:
                       a Google subscriber may switch between monthly and yearly
                       here, an Apple or website one manages it where they bought. */
                    val elsewhere = b.plan == "active" && b.manageAt != "google"
                    if (b.canSubscribeHere && b.plan != "free" && !elsewhere) {
                        HorizontalDivider()
                        PlayPlans(b)
                    }
                }
            }
        }
        storeMessage?.let {
            Text(it, Modifier.padding(top = 8.dp).clickable { PlayStore.clearMessage() },
                style = MaterialTheme.typography.bodyMedium)
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
                            "on the website or through Google Play is cancelled; one bought in the iPhone app " +
                            "must be cancelled with Apple. This cannot be undone.",
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

/**
 * The two plans as Play prices them, the yearly one with what it comes to a
 * month -- the same comparison the website and the iPhone make. Buying opens
 * Play's own sheet; the server hears about it and the status above updates.
 */
@Composable
private fun PlayPlans(billing: Billing) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var plans by remember { mutableStateOf<List<PlayStore.Plan>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { plans = PlayStore.plans(context) }

    Column(Modifier.padding(16.dp)) {
        Text(
            if (billing.plan == "trial") "Subscribe now — billing starts today" else "Subscribe",
            style = MaterialTheme.typography.titleSmall,
        )
        when {
            plans == null -> Text("Loading plans…", style = MaterialTheme.typography.bodySmall)
            plans!!.isEmpty() -> Text("Subscriptions are not available just now.", style = MaterialTheme.typography.bodySmall)
            else -> {
                val monthly = plans!!.firstOrNull { it.period == "P1M" }
                plans!!.forEach { p ->
                    val yearly = p.period == "P1Y"
                    val perMonth = if (yearly) p.micros / 12 else null
                    val saving = if (yearly && monthly != null)
                        (100 - (p.micros * 100 / (monthly.micros * 12))).toInt().takeIf { it > 0 } else null
                    androidx.compose.material3.OutlinedButton(
                        onClick = {
                            val activity = context.findActivity() ?: return@OutlinedButton
                            scope.launch { error = PlayStore.buy(activity, p, billing.accountToken) }
                        },
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(if (yearly) "Yearly" else "Monthly")
                            Text(
                                if (yearly) "Billed once a year, renews automatically" else "Billed monthly, renews automatically",
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                        Column(horizontalAlignment = androidx.compose.ui.Alignment.End) {
                            Text(p.price + if (yearly) " / year" else " / month")
                            if (perMonth != null) {
                                Text(
                                    "about " + java.text.NumberFormat.getCurrencyInstance().apply { currency = java.util.Currency.getInstance(p.currency) }.format(perMonth / 1_000_000.0) + " a month" +
                                        (saving?.let { " · save $it%" } ?: ""),
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            }
                        }
                    }
                }
                Text(
                    "Cancel any time in Google Play. By subscribing you agree to the Terms of Service.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
        }
        error?.let { Text(it, color = Negative, style = MaterialTheme.typography.bodySmall) }
    }
}

private fun android.content.Context.findActivity(): android.app.Activity? {
    var c: android.content.Context? = this
    while (c is android.content.ContextWrapper) {
        if (c is android.app.Activity) return c
        c = c.baseContext
    }
    return null
}
