//
//  RootView.swift
//  Bilancio
//
//  Two gates before the Overview: Clerk has to be configured, and there has to
//  be a session. Both are states rather than side effects so that a failure at
//  either is visible and retryable instead of a blank screen.
//

import ClerkKit
import ClerkKitUI
import SwiftUI

struct RootView: View {
    @State private var bootstrap = ClerkBootstrap()
    /// Applied at the root so it reaches sheets and pushed screens too — set
    /// deeper it would colour the tab that changed it and nothing else.
    @AppStorage("appearance") private var appearance: Appearance = .system
    /// Shown over everything on a cold start, and never again for the life of
    /// the process — it belongs to launching, not to appearing.
    @State private var launching = true

    var body: some View {
        Group {
            switch bootstrap.state {
            case .configuring:
                ProgressView("Starting…")

            case .failed(let message):
                StartupFailureView(message: message) {
                    Task { await bootstrap.start() }
                }

            case .ready(let clerk):
                SessionGate()
                    .environment(clerk)
            }
        }
        // Filled before the overlay is attached. An overlay takes the size of
        // what it covers, and at launch that is a ProgressView the size of a
        // coin — which is exactly how big the launch screen came out.
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task { await bootstrap.start() }
        .preferredColorScheme(appearance.colorScheme)
        .overlay {
            if launching {
                // Over the top rather than before it, so the work underneath —
                // fetching the key, configuring Clerk, restoring the session —
                // happens during the animation instead of after it.
                LaunchFlash(showing: $launching)
                    .transition(.opacity)
            }
        }
    }
}

/// Signed in or not — but only once Clerk has finished restoring whatever
/// session was in the keychain. Deciding before `isLoaded` shows the sign-in
/// screen for a frame to someone who is already signed in.
private struct SessionGate: View {
    @Environment(Clerk.self) private var clerk
    @State private var showingAuth = false

    var body: some View {
        Group {
            if !clerk.isLoaded {
                ProgressView("Restoring session…")
            } else if clerk.user != nil {
                SignedIn()
            } else {
                SignedOutView { showingAuth = true }
            }
        }
        .sheet(isPresented: $showingAuth) {
            // Dismissible, so it closes itself once the session is active.
            AuthView()
        }
    }
}

/// The dashboards, one per tab.
///
/// A tab bar rather than the web's horizontal switcher: nine views do not fit
/// across a phone, and the ones that are built are the ones that appear —
/// an empty tab is a worse answer than an absent one.
private struct SignedIn: View {
    enum Screen: Hashable { case overview, trend, budgeting, transactions, more }

    @State private var screen: Screen = .overview
    /// Watched so that opening a budget alert lands on the Overview, which is
    /// where the category it is about is drawn.
    private let alerts = BudgetAlerts.shared

    var body: some View {
        TabView(selection: $screen) {
            // In the order the questions get asked: where things stand, how
            // that compares with before, what it was supposed to be, and then
            // the rows behind all three. Transactions sits last because it is
            // the one you arrive at from the others as often as you open it.
            Tab("Overview", systemImage: "chart.pie", value: Screen.overview) {
                OverviewView()
            }
            Tab("Trend", systemImage: "chart.bar", value: Screen.trend) {
                TrendView()
            }
            Tab("Budgeting", systemImage: "slider.horizontal.3", value: Screen.budgeting) {
                BudgetingView()
            }
            Tab("Transactions", systemImage: "list.bullet", value: Screen.transactions) {
                TransactionsView()
            }
            // A tab bar holds five. There are seven dashboards, so the fifth
            // slot is the way to the rest rather than one more of them — which
            // is better than letting iOS build its own overflow list, and
            // better than leaving Budgeting reachable only from inside Tracker.
            Tab("More", systemImage: "ellipsis.circle", value: Screen.more) {
                MoreView()
            }
        }
        .onChange(of: alerts.opened) { screen = .overview }
        /* iOS can hand out a new token at any launch, so an app with
           permission re-registers each time. Never asks for permission here --
           that only happens when somebody switches alerts on. */
        .task { await alerts.refreshIfAllowed() }
    }
}

private struct SignedOutView: View {
    let signIn: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            OwlMark(height: 64)
            Text("Bilancio")
                .font(.largeTitle.weight(.semibold))
            Text("Sign in to see this month.")
                .foregroundStyle(.secondary)
            Button("Sign in", action: signIn)
                .buttonStyle(.borderedProminent)
                .padding(.top, 8)

            /* Sign-up is open. The same Clerk screen signs in and creates an
             * account, so somebody new is sent there too -- but told, in words,
             * that they can make one, rather than left to guess that "Sign in"
             * is also the way to start.
             */
            VStack(spacing: 4) {
                Text("New to Bilancio? Create an account — 14 days free.")
                    .font(Theme.note)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button("Create an account", action: signIn)
                    .font(Theme.note)
            }
            .padding(.top, 20)
        }
        .padding()
    }
}

private struct StartupFailureView: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("Cannot reach Bilancio", systemImage: "wifi.exclamationmark")
        } description: {
            Text(message)
        } actions: {
            Button("Try again", action: retry)
                .buttonStyle(.borderedProminent)
        }
    }
}
