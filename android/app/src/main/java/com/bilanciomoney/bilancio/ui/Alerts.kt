package com.bilanciomoney.bilancio.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.bilanciomoney.bilancio.Alerts
import com.bilanciomoney.bilancio.Bilancio
import com.bilanciomoney.bilancio.Category
import com.bilanciomoney.bilancio.Push
import com.bilanciomoney.bilancio.ui.theme.Negative
import kotlinx.coroutines.launch

/**
 * Which subcategories say something when they are nearly spent or over --
 * the iPhone's Budget alerts, against the same endpoints.
 *
 * Nothing is chosen by default: an app that starts by alerting on everything
 * is an app whose alerts are turned off within a week. What has already been
 * said this month is listed, with a way to say "enough for now", which keeps
 * that category quiet until the month turns.
 */
@Composable
fun AlertsScreen() {
    var refresh by remember { mutableStateOf(0) }
    Loader(refresh, { Bilancio.alerts() to Bilancio.categories() }) { (a, cats): Pair<Alerts, List<Category>>, _ ->
        AlertsContent(a, cats) { refresh++ }
    }
}

@Composable
private fun AlertsContent(a: Alerts, cats: List<Category>, onChanged: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var message by remember { mutableStateOf<String?>(null) }
    var chosen by remember(a) { mutableStateOf(a.selected) }

    /* Android 13 and later will not show a notification until it has been
       allowed. Asked for on arriving here, which is the one screen where the
       reason for it is on the page. */
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) Push.register(context)
        else message = "Notifications are switched off for Bilancio in Android settings."
    }
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= 33) ask.launch(Manifest.permission.POST_NOTIFICATIONS)
        else Push.register(context)
    }

    fun set(ids: List<String>, on: Boolean) {
        chosen = if (on) chosen + ids else chosen - ids.toSet()
        scope.launch {
            runCatching { Bilancio.setAlertCategories(ids, on) }
                .onSuccess { onChanged() }
                .onFailure { message = it.message }
        }
    }

    val parents = cats.filter { it.parentSlug == null && it.kind == "spend" }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Text(
            when {
                !a.configured || !Push.configured ->
                    "Alerts are not switched on yet for this app. Choose categories now and they will " +
                        "start arriving once they are."
                a.devices == 0 -> "This phone is not registered for alerts yet. It registers itself when you allow notifications."
                else -> "You are told once when a category is nearly spent, and once when it goes over."
            },
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        message?.let {
            Spacer(Modifier.height(8.dp))
            Text(it, color = Negative, style = MaterialTheme.typography.bodySmall)
        }

        if (a.alerts.isNotEmpty()) {
            SectionTitle("Said this month")
            Card(Modifier.fillMaxWidth()) {
                Column {
                    a.alerts.forEach { said ->
                        Row(
                            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                            Arrangement.SpaceBetween,
                            Alignment.CenterVertically,
                        ) {
                            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                                Dot(Color(said.colour)); Spacer(Modifier.width(10.dp))
                                Column {
                                    Text(said.label)
                                    Text(
                                        if (said.level == "over") "over its budget" else "nearly spent",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                            if (said.acknowledged) {
                                Text("quiet", style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            } else {
                                TextButton(onClick = {
                                    scope.launch {
                                        runCatching { Bilancio.acknowledgeAlert(said.categoryId) }
                                            .onSuccess { onChanged() }
                                            .onFailure { message = it.message }
                                    }
                                }) { Text("Enough for now") }
                            }
                        }
                        HorizontalDivider()
                    }
                }
            }
        }

        parents.forEach { p ->
            val kids = cats.filter { it.parentSlug == p.slug }
            if (kids.isEmpty()) return@forEach
            val ids = kids.map { it.id }
            val all = ids.all { it in chosen }
            Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween, Alignment.CenterVertically) {
                SectionTitle(p.label)
                TextButton(onClick = { set(ids, !all) }) { Text(if (all) "None" else "All") }
            }
            Card(Modifier.fillMaxWidth()) {
                Column {
                    kids.forEach { k ->
                        Row(
                            Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 4.dp, bottom = 4.dp),
                            Arrangement.SpaceBetween,
                            Alignment.CenterVertically,
                        ) {
                            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                                Dot(Color(k.colour)); Spacer(Modifier.width(10.dp))
                                Text(k.label, style = MaterialTheme.typography.bodyMedium)
                            }
                            Switch(checked = k.id in chosen, onCheckedChange = { on -> set(listOf(k.id), on) })
                        }
                        HorizontalDivider()
                    }
                }
            }
        }
        Spacer(Modifier.height(12.dp))
        Text(
            "Only subcategories with a budget can be alerted on, and each is said once a month at most.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontWeight = FontWeight.Normal,
        )
        Spacer(Modifier.height(24.dp))
    }
}
