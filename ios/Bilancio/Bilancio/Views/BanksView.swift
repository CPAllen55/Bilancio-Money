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
    private(set) var deleting = false
    private(set) var deleteError: String?

    private(set) var syncing = false
    /// Rows in so far this run, so a long backfill can say so.
    private(set) var pulled = 0
    /// What the last sync came to, kept until the next one starts.
    private(set) var syncResult: String?

    private let client = APIClient(baseURL: Bilancio.apiBaseURL) {
        guard let session = Clerk.shared.session else { return nil }
        return try await session.getToken()
    }

    func load() async {
        do { state = .loaded(try await client.bankItems().items) }
        catch { state = .failed(error.localizedDescription) }
    }

    /// Pull whatever the banks have that we do not.
    ///
    /// Here because it is the only other place in the app that can: linking a
    /// bank syncs, and nothing else did. A first link that stopped short — or a
    /// bank that has been quiet since — had no way to be caught up from the
    /// phone at all, and the answer was to go and use the website.
    func sync() async {
        syncing = true
        pulled = 0
        syncResult = nil
        defer { syncing = false }
        do {
            let totals = try await client.syncEverything { self.pulled = $0 }
            await load()
            syncResult = Self.describe(totals)
        } catch {
            syncResult = error.localizedDescription
        }
    }

    private static func describe(_ t: SyncTotals) -> String {
        var parts: [String] = []
        if t.added > 0 { parts.append("\(t.added) new") }
        if t.modified > 0 { parts.append("\(t.modified) updated") }
        if t.removed > 0 { parts.append("\(t.removed) removed") }
        if parts.isEmpty { parts.append("Nothing new") }
        var out = parts.joined(separator: ", ") + "."
        // Said plainly rather than implied by a number that looks complete.
        if t.unfinished { out += " There is more still to come — sync again." }
        if !t.pending.isEmpty {
            out += " \(t.pending.joined(separator: ", ")) is still being prepared by Plaid."
        }
        return out
    }

    /// True once everything is gone, so the caller can sign out.
    func deleteAccount() async -> Bool {
        deleting = true
        deleteError = nil
        defer { deleting = false }
        do {
            try await client.deleteAccount()
            return true
        } catch {
            // The Worker deletes nothing if a bank cannot be revoked at Plaid,
            // so a failure here means the account still exists intact. Saying
            // so is the whole point of surfacing it.
            deleteError = error.localizedDescription
            return false
        }
    }
}

struct BanksView: View {
    @Environment(Clerk.self) private var clerk
    @State private var model = BanksModel()
    @State private var confirming = false

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

                    Section {
                        ConnectBankButton(onConnected: { Task { await model.load() } },
                                          label: "Connect a bank",
                                          prominent: false)

                        if !items.isEmpty {
                            Button {
                                Task { await model.sync() }
                            } label: {
                                HStack(spacing: 8) {
                                    if model.syncing { ProgressView() }
                                    Text(model.syncing
                                         ? (model.pulled > 0 ? "Pulling \(model.pulled)…" : "Syncing…")
                                         : "Sync now")
                                }
                            }
                            .disabled(model.syncing)
                        }

                        if let result = model.syncResult {
                            Text(result)
                                .font(Theme.note)
                                .foregroundStyle(Theme.quietText)
                        }
                    } footer: {
                        if !items.isEmpty {
                            Text("Banks are pulled when you connect them and whenever your bank tells us there is something new. This asks now.")
                        }
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
                        Button("Sign out") {
                            Task { try? await clerk.auth.signOut() }
                        }
                    }

                    Section {
                        Button("Delete account", role: .destructive) {
                            confirming = true
                        }
                        .disabled(model.deleting)

                        if model.deleting {
                            HStack(spacing: 8) {
                                ProgressView()
                                Text("Disconnecting banks and erasing…")
                                    .font(Theme.note)
                                    .foregroundStyle(Theme.quietText)
                            }
                        }

                        if let error = model.deleteError {
                            // Nothing was deleted when this appears. Saying so
                            // matters more than the error text: the reader has
                            // just been told an irreversible thing failed, and
                            // needs to know which side of it they are on.
                            VStack(alignment: .leading, spacing: 4) {
                                Label("Nothing was deleted", systemImage: "exclamationmark.triangle")
                                    .foregroundStyle(Theme.negative)
                                Text(error)
                                    .font(Theme.note)
                                    .foregroundStyle(Theme.quietText)
                            }
                        }
                    } footer: {
                        Text("Deleting your account disconnects every bank at Plaid and erases your transactions, categories and rules. It cannot be undone.")
                    }
                }
            }
        }
        .navigationTitle("Banks")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.load() }
        .task { await model.load() }
        // A confirmation rather than a second tap on the same button: this is
        // the one action in the app with nothing behind it, and the sentence
        // that says so belongs between the intent and the deed.
        .confirmationDialog(
            "Delete your account?",
            isPresented: $confirming,
            titleVisibility: .visible
        ) {
            Button("Delete everything", role: .destructive) {
                Task {
                    if await model.deleteAccount() {
                        // The Clerk identity is gone too, so there is nothing
                        // left to sign out of — this only clears the session
                        // the app is still holding.
                        try? await clerk.auth.signOut()
                    }
                }
            }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("Every bank is disconnected and all of your data is erased. This cannot be undone.")
        }
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
