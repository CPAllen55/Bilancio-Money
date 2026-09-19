package com.bilanciomoney.bilancio

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.TopAppBar
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
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
import com.bilanciomoney.bilancio.ui.CategoriesScreen
import com.bilanciomoney.bilancio.ui.ForecastScreen
import com.bilanciomoney.bilancio.ui.NetWorthScreen
import com.bilanciomoney.bilancio.ui.SubPage
import com.bilanciomoney.bilancio.ui.TrendScreen
import com.bilanciomoney.bilancio.ui.Bucket
import com.bilanciomoney.bilancio.ui.MoreScreen
import com.bilanciomoney.bilancio.ui.OverviewScreen
import com.bilanciomoney.bilancio.ui.Period
import com.bilanciomoney.bilancio.ui.TransactionsScreen
import com.bilanciomoney.bilancio.ui.theme.BilancioTheme
import com.bilanciomoney.bilancio.ui.theme.Appearance
import com.clerk.api.Clerk
import com.clerk.ui.auth.AuthView
import kotlinx.coroutines.flow.combine

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Appearance.load(this)
        setContent {
            val appearance by Appearance.current.collectAsState()
            val dark = when (appearance) {
                Appearance.System -> androidx.compose.foundation.isSystemInDarkTheme()
                Appearance.Light -> false
                Appearance.Dark -> true
            }
            /* The status and navigation bar icons follow the app's choice, not
               the phone's -- dark icons on a dark app would vanish. */
            androidx.compose.runtime.LaunchedEffect(dark) {
                val clear = android.graphics.Color.TRANSPARENT
                enableEdgeToEdge(
                    statusBarStyle = if (dark) androidx.activity.SystemBarStyle.dark(clear)
                        else androidx.activity.SystemBarStyle.light(clear, clear),
                    navigationBarStyle = if (dark) androidx.activity.SystemBarStyle.dark(clear)
                        else androidx.activity.SystemBarStyle.light(clear, clear),
                )
            }
            BilancioTheme(darkTheme = dark) {
                Root()
            }
        }
    }
}

private enum class AuthState { Loading, SignedIn, SignedOut }

/* The iPhone's five, in the iPhone's order. Calendar and Banks live under
   More there too: both are visited, not watched. */
private enum class Tab(val label: String, val icon: Int) {
    Overview("Overview", R.drawable.ic_tab_overview),
    Trend("Trend", R.drawable.ic_tab_trend),
    Budgeting("Budget", R.drawable.ic_tab_budget),
    Transactions("Transactions", R.drawable.ic_tab_transactions),
    More("More", R.drawable.ic_tab_more),
}

private enum class MorePage(val title: String) {
    Calendar("Calendar"), Banks("Banks"), Forecast("Year ahead"), NetWorth("Net worth"), Categories("Categories")
}

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

    /* Once per launch, and not again on rotation. */
    var launching by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(true) }
    Box(Modifier.fillMaxSize()) {
        when (state) {
            AuthState.Loading ->
                Box(Modifier.fillMaxSize(), Alignment.Center) { if (!launching) CircularProgressIndicator() }
            AuthState.SignedOut ->
                Box(Modifier.fillMaxSize(), Alignment.Center) { AuthView() }
            AuthState.SignedIn -> SignedIn()
        }
        if (launching) com.bilanciomoney.bilancio.ui.LaunchFlash(onDone = { launching = false })
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SignedIn() {
    var tab by remember { mutableStateOf(Tab.Overview) }
    /* One period for every money screen, so the month chosen on the Overview is
       the month the ledger opens on -- the same agreement the web app keeps. */
    var period by remember { mutableStateOf(Period()) }
    var bucket by remember { mutableStateOf<Bucket?>(null) }
    var morePage by remember { mutableStateOf<MorePage?>(null) }
    /* Catches up any Play purchase -- a renewal, a plan change, one whose
       hand-over was interrupted -- each time the app opens. */
    val context = androidx.compose.ui.platform.LocalContext.current
    androidx.compose.runtime.LaunchedEffect(Unit) { PlayStore.sync(context) }
    Scaffold(
        /* The screen's name with the owl beside it, as on the iPhone; on a page
           opened from More, a way back instead of the owl. */
        topBar = {
            val page = if (tab == Tab.More) morePage else null
            TopAppBar(
                title = { Text(page?.title ?: tab.label) },
                navigationIcon = {
                    if (page != null) {
                        IconButton(onClick = { morePage = null }) { Text("‹", style = MaterialTheme.typography.headlineMedium) }
                    } else {
                        Image(
                            painterResource(R.mipmap.ic_launcher_foreground),
                            contentDescription = null,
                            /* Bigger than a toolbar icon: the mark is the
                               brand arriving, not a control. Sized to the bar
                               rather than beyond it, so nothing else moves. */
                            modifier = Modifier.padding(start = 6.dp).size(58.dp),
                        )
                    }
                },
            )
        },
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
                        icon = { Icon(painterResource(t.icon), contentDescription = null) },
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
                    null -> MoreScreen(onOpen = { morePage = MorePage.valueOf(it) })
                    else -> SubPage(onBack = { morePage = null }) {
                        when (morePage!!) {
                            MorePage.Calendar -> CalendarScreen()
                            MorePage.Banks -> BanksScreen()
                            MorePage.Forecast -> ForecastScreen()
                            MorePage.NetWorth -> NetWorthScreen()
                            MorePage.Categories -> CategoriesScreen()
                        }
                    }
                }
            }
        }
    }
}
