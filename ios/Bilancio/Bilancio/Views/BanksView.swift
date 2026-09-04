//
//  BanksView.swift
//  Bilancio
//
//  The connections behind every figure in the app, and whether they are
//  currently working.
//

import ClerkKit
import SwiftUI

@MainActor
@Observable
final class BanksModel {
    enum State { case loading, loaded([BankItemsResponse.Item]), failed(String) }
    private(set) var state: State = .loading

    private let client = APIClient(baseURL: Bilancio.apiBaseURL) {
        guard let session = Clerk.shared.session else { return nil }
        return try await session.getToken()
    }

    func load() async {
        do { state = .loaded(try await client.bankItems().items) }
        catch { state = .failed(error.localizedDescription) }
    }
}

struct BanksView: View {
    @Environment(Clerk.self) private var clerk
    @State private var model = BanksModel()

    var body: some View {
        Group {
            switch model.state {
            case .loading:
                ProgressView("Loading…")

            case .failed(let message):
                ContentUnavailableView {
                    Label("Could not load your banks", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try again") { Task { await model.load() } }
                        .buttonStyle(.borderedProminent)
                }

            case .loaded(let items):
                List {
                    if items.isEmpty {
                        Text("No banks linked yet.")
                            .foregroundStyle(Theme.quietText)
                    }

                    ForEach(items) { item in
                        Section {
                            ForEach(item.accounts) { account in
                                HStack {
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(account.name ?? "Account")
                                            .font(Theme.body)
                                        Text([account.subtype ?? account.type,
                                              account.mask.map { "••\($0)" }]
                                                .compactMap { $0 }
                                                .joined(separator: " · "))
                                            .font(.caption2)
                                            .foregroundStyle(Theme.quietText)
                                    }
                                    Spacer(minLength: 8)
                                    if let balance = account.currentBalance {
                                        Text(balance.asMoney)
                                            .font(Theme.body)
                                            .monospacedDigit()
                                    }
                                }
                            }
                        } header: {
                            HStack {
                                Text(item.institution ?? "Bank")
                                Spacer()
                                status(for: item)
                            }
                        }
                    }

                    Section {
                        Button("Sign out", role: .destructive) {
                            Task { try? await clerk.auth.signOut() }
                        }
                    }
                }
            }
        }
        .navigationTitle("Banks")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.load() }
        .task { await model.load() }
    }

    /// Only two states are worth saying out loud: the one that needs a person
    /// to do something, and the one where nothing has arrived yet. A healthy
    /// connection is the expectation and does not need a badge to confirm it.
    @ViewBuilder private func status(for item: BankItemsResponse.Item) -> some View {
        if item.needsAttention {
            Label("Needs sign-in", systemImage: "exclamationmark.triangle.fill")
                .font(.caption2)
                .foregroundStyle(Theme.negative)
        } else if item.awaitingFirstSync {
            Label("Not synced yet", systemImage: "clock")
                .font(.caption2)
                .foregroundStyle(Theme.caution)
        }
    }
}
