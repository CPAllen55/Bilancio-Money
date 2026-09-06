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
    var body: some View {
        TabView(selection: .constant("b")) {
            // In the order the questions get asked: where things stand, how
            // that compares with before, what it was supposed to be, and then
            // the rows behind all three. Transactions sits last because it is
            // the one you arrive at from the others as often as you open it.
            Tab("Overview", systemImage: "chart.pie", value: "o") {
                OverviewView()
            }
            Tab("Trend", systemImage: "chart.bar", value: "r") {
                TrendView()
            }
            Tab("Budgeting", systemImage: "slider.horizontal.3", value: "b") {
                BudgetingView()
            }
            Tab("Transactions", systemImage: "list.bullet", value: "t") {
                TransactionsView()
            }
            // A tab bar holds five. There are seven dashboards, so the fifth
            // slot is the way to the rest rather than one more of them — which
            // is better than letting iOS build its own overflow list, and
            // better than leaving Budgeting reachable only from inside Tracker.
            Tab("More", systemImage: "ellipsis.circle", value: "m") {
                MoreView()
            }
        }
    }
}

private struct SignedOutView: View {
    let signIn: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Text("Bilancio")
                .font(.largeTitle.weight(.semibold))
            Text("Sign in to see this month.")
                .foregroundStyle(.secondary)
            Button("Sign in", action: signIn)
                .buttonStyle(.borderedProminent)
                .padding(.top, 8)
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
