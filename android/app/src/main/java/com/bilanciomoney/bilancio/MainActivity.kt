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
import com.bilanciomoney.bilancio.ui.OverviewScreen
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

private enum class Tab(val label: String) {
    Overview("Overview"), Transactions("Transactions"), Banks("Banks")
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
    Scaffold(
        bottomBar = {
            NavigationBar {
                Tab.entries.forEach { t ->
                    NavigationBarItem(
                        selected = tab == t,
                        onClick = { tab = t },
                        icon = {},
                        label = { Text(t.label) },
                    )
                }
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when (tab) {
                Tab.Overview -> OverviewScreen()
                Tab.Transactions -> TransactionsScreen()
                Tab.Banks -> BanksScreen()
            }
        }
    }
}
