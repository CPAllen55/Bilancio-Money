package com.bilanciomoney.bilancio

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.bilanciomoney.bilancio.ui.BanksScreen
import com.bilanciomoney.bilancio.ui.BudgetingScreen
import com.bilanciomoney.bilancio.ui.CalendarScreen
import com.bilanciomoney.bilancio.ui.SubPage
import com.bilanciomoney.bilancio.ui.TrendScreen
import com.bilanciomoney.bilancio.ui.Bucket
import com.bilanciomoney.bilancio.ui.MoreScreen
import com.bilanciomoney.bilancio.ui.OverviewScreen
import com.bilanciomoney.bilancio.ui.Period
import com.bilanciomoney.bilancio.ui.TransactionsScreen
import com.bilanciomoney.bilancio.ui.theme.BilancioTheme
import com.clerk.api.Clerk
import com.clerk.ui.auth.AuthView
import kotlinx.coroutines.flow.combine

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            BilancioTheme {
                Root()
            }
        }
    }
}

private enum class AuthState { Loading, SignedIn, SignedOut }

/* The iPhone's five, in the iPhone's order. Calendar and Banks live under
   More there too: both are visited, not watched. */
private enum class Tab(val label: String) {
    Overview("Overview"), Trend("Trend"), Budgeting("Budget"), Transactions("Transactions"), More("More")
}

private enum class MorePage { Calendar, Banks }

/**
 * Signed out shows Clerk's own screen, which signs in and creates accounts
 * both; signed in shows the app. Nothing is drawn until Clerk has finished
 * loading, because a sign-in screen flashing in front of somebody who is
 * already signed in reads as having been signed out.
 */
@Composable
private fun Root() {
    val state by remember {
        combine(Clerk.isInitialized, Clerk.userFlow) { ready, user ->
            when {
                !ready -> AuthState.Loading
                user != null -> AuthState.SignedIn
                else -> AuthState.SignedOut
            }
        }
    }.collectAsState(initial = AuthState.Loading)

    when (state) {
        AuthState.Loading ->
            Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
        AuthState.SignedOut ->
            Box(Modifier.fillMaxSize(), Alignment.Center) { AuthView() }
        AuthState.SignedIn -> SignedIn()
    }
}

@Composable
private fun SignedIn() {
    var tab by remember { mutableStateOf(Tab.Overview) }
    /* One period for every money screen, so the month chosen on the Overview is
       the month the ledger opens on -- the same agreement the web app keeps. */
    var period by remember { mutableStateOf(Period()) }
    var bucket by remember { mutableStateOf<Bucket?>(null) }
    var morePage by remember { mutableStateOf<MorePage?>(null) }
    Scaffold(
        bottomBar = {
            NavigationBar {
                Tab.entries.forEach { t ->
                    NavigationBarItem(
                        selected = tab == t,
                        /* Choosing the ledger from the bar means all of it; a
                           category filter only arrives by tapping a category. */
                        onClick = {
                            if (t == Tab.Transactions) bucket = null
                            if (t == Tab.More) morePage = null
                            tab = t
                        },
                        icon = {},
                        label = { Text(t.label) },
                    )
                }
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when (tab) {
                Tab.Overview -> OverviewScreen(
                    period = period,
                    onPeriod = { period = it },
                )
                Tab.Transactions -> TransactionsScreen(
                    period = period,
                    onPeriod = { period = it },
                    bucket = bucket,
                    onClearBucket = { bucket = null },
                )
                Tab.Trend -> TrendScreen(onCategory = { slug, label, month ->
                    period = Period(month, 1); bucket = Bucket(slug, label); tab = Tab.Transactions
                })
                Tab.Budgeting -> BudgetingScreen()
                Tab.More -> when (morePage) {
                    null -> MoreScreen(
                        onCalendar = { morePage = MorePage.Calendar },
                        onBanks = { morePage = MorePage.Banks },
                    )
                    MorePage.Calendar -> SubPage("Calendar", onBack = { morePage = null }) { CalendarScreen() }
                    MorePage.Banks -> SubPage("Banks", onBack = { morePage = null }) { BanksScreen() }
                }
            }
        }
    }
}
