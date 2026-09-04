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
        .task { await bootstrap.start() }
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
        TabView {
            Tab("Overview", systemImage: "chart.pie") {
                OverviewView()
            }
            Tab("Transactions", systemImage: "list.bullet") {
                TransactionsView()
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
