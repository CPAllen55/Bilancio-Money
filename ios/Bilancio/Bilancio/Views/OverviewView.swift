//
//  OverviewView.swift
//  Bilancio
//
//  The first screen, and deliberately the smallest one that proves anything:
//  Clerk issues a token, the Worker's requireUser accepts it, and a real figure
//  comes back out of Neon. Every later screen is a variation on this.
//
//  The headline is totals.net. It is NOT safeToSpend.remaining, which is
//  floored at zero and so reads a month that spent more than it earned as 0
//  rather than as a loss — the web app's headline had that bug and had to be
//  changed. See docs/ios-app-api.md.
//

import ClerkKit
import SwiftUI

@MainActor
@Observable
final class OverviewModel {
    enum State {
        case loading
        case loaded(SummaryResponse)
        case failed(String)
    }

    private(set) var state: State = .loading

    private let client = APIClient(baseURL: Bilancio.apiBaseURL) {
        // Optional-chaining `session?.getToken()` would give a String?? here,
        // and a nil session is a different thing from a session that returned
        // no token, so the two are unwrapped separately.
        guard let session = Clerk.shared.session else { return nil }
        return try await session.getToken()
    }

    func load() async {
        do {
            state = .loaded(try await client.summary(range: .thisMonth))
        } catch let error as APIError {
            state = .failed(error.localizedDescription)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}

struct OverviewView: View {
    @Environment(Clerk.self) private var clerk
    @State private var model = OverviewModel()

    var body: some View {
        NavigationStack {
            Group {
                switch model.state {
                case .loading:
                    ProgressView("Loading this month…")

                case .failed(let message):
                    ContentUnavailableView {
                        Label("Could not load the summary", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Try again") { Task { await model.load() } }
                            .buttonStyle(.borderedProminent)
                    }

                case .loaded(let summary):
                    LoadedOverview(summary: summary)
                }
            }
            .navigationTitle("Overview")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Sign out") {
                        Task { try? await clerk.auth.signOut() }
                    }
                }
            }
            .refreshable { await model.load() }
        }
        .task { await model.load() }
    }
}

private struct LoadedOverview: View {
    let summary: SummaryResponse

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(summary.range.label)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                    // A deficit should read as one, so the sign is kept and the
                    // colour follows it rather than the figure being made absolute.
                    Text(summary.totals.net.asMoney)
                        .font(.system(size: 44, weight: .semibold, design: .rounded))
                        .foregroundStyle(summary.totals.net < 0 ? Color.red : Color.primary)

                    Text(summary.totals.net < 0 ? "Overspent" : "Kept")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                VStack(spacing: 0) {
                    Row(label: "Money in", value: summary.totals.income.asMoney)
                    Divider()
                    Row(label: "Money out", value: summary.totals.expense.asMoney)
                }
                .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))

                // Zero accounts is not zero spending. Without saying so, an
                // untouched install looks identical to a broken one.
                if summary.accountsCounted == 0 {
                    Label(
                        "No bank accounts linked yet, so every figure here is zero. The auth chain still worked.",
                        systemImage: "info.circle"
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }

                Spacer()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
        .background(Color(.systemGroupedBackground))
    }
}

private struct Row: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label)
            Spacer()
            Text(value).monospacedDigit()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}
