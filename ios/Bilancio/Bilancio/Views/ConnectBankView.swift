//
//  ConnectBankView.swift
//  Bilancio
//
//  The button that opens Plaid Link, and everything that has to happen after
//  it closes.
//

import ClerkKit
import LinkKit
import SwiftUI

@MainActor
@Observable
final class ConnectBankModel {
    enum Phase: Equatable {
        case idle
        /// Asking the Worker for a token to open Link with.
        case preparing
        /// Plaid's sheet is up. Nothing to do but wait for it.
        case linking(String)
        /// Link succeeded; the public token is being exchanged and synced.
        case finishing
        case failed(String)
    }

    private(set) var phase: Phase = .idle

    /// Whether an item that was linked needs a first sync. Kept separate from
    /// `phase` because a sync that fails leaves a working connection with no
    /// transactions, which is a different thing from a failed link.
    private(set) var linkedButUnsynced = false

    private let client = APIClient(baseURL: Bilancio.apiBaseURL) {
        guard let session = Clerk.shared.session else { return nil }
        return try await session.getToken()
    }

    var isPresentingLink: Bool {
        if case .linking = phase { return true }
        return false
    }

    func begin() async {
        phase = .preparing
        do {
            phase = .linking(try await client.linkToken().linkToken)
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    func cancel() { phase = .idle }

    /// Called with the public token Plaid hands back.
    ///
    /// Exchange then sync, in that order and both before the screen says it is
    /// done. A bank that is linked but never synced holds no transactions, and
    /// an app that says "connected" over an empty ledger is indistinguishable
    /// from one that is broken.
    func finish(publicToken: String, onDone: @escaping () -> Void) async {
        phase = .finishing
        do {
            try await client.exchange(publicToken: publicToken)
        } catch {
            phase = .failed(error.localizedDescription)
            return
        }

        do {
            _ = try await client.syncTransactions()
            linkedButUnsynced = false
        } catch {
            // The connection is real either way. Plaid populates a new item
            // asynchronously, so the first sync can legitimately arrive before
            // there is anything to pull — this is not a failed link and must
            // not be reported as one.
            linkedButUnsynced = true
        }

        phase = .idle
        onDone()
    }

    func failed(_ message: String) { phase = .failed(message) }
}

/// A button, Plaid's sheet, and the work either side of it.
struct ConnectBankButton: View {
    /// Called once a bank is connected and pulled, so the caller can reload.
    let onConnected: () -> Void
    var label: String = "Connect a bank"
    var prominent = true

    @State private var model = ConnectBankModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                Task { await model.begin() }
            } label: {
                HStack(spacing: 8) {
                    if isWorking { ProgressView() }
                    Text(isWorking ? "Working…" : label)
                }
            }
            .disabled(isWorking)
            .modifier(Prominence(on: prominent))

            if case .failed(let message) = model.phase {
                Label(message, systemImage: "exclamationmark.triangle")
                    .font(Theme.note)
                    .foregroundStyle(Theme.negative)
            }

            if model.linkedButUnsynced {
                // Said plainly rather than hidden: the bank is connected and
                // the transactions have not arrived yet, which looks identical
                // to a broken link if nobody says which it is.
                Label("Connected. Transactions are still arriving — pull to refresh in a moment.",
                      systemImage: "clock")
                    .font(Theme.note)
                    .foregroundStyle(Theme.quietText)
            }
        }
        .sheet(isPresented: .constant(model.isPresentingLink), onDismiss: model.cancel) {
            if case .linking(let token) = model.phase {
                PlaidLinkView(token: token) { success in
                    Task { await model.finish(publicToken: success.publicToken, onDone: onConnected) }
                } onExit: { exit in
                    // Leaving without linking is an ordinary thing to do and is
                    // not an error. Only an actual error becomes one.
                    if let error = exit.error {
                        model.failed(error.localizedDescription)
                    } else {
                        model.cancel()
                    }
                } onEvent: { _ in
                } errorView: { error in
                    VStack(spacing: 12) {
                        Text("Could not open Plaid").font(.headline)
                        Text(error.localizedDescription)
                            .font(Theme.note)
                            .foregroundStyle(Theme.quietText)
                            .multilineTextAlignment(.center)
                        Button("Close") { model.cancel() }
                            .buttonStyle(.borderedProminent)
                    }
                    .padding()
                }
            }
        }
    }

    private var isWorking: Bool {
        switch model.phase {
        case .preparing, .finishing: return true
        default: return false
        }
    }
}

/// Applied as a modifier so the same button can lead an empty state or sit
/// quietly in a list without two copies of it existing.
private struct Prominence: ViewModifier {
    let on: Bool

    func body(content: Content) -> some View {
        if on {
            content.buttonStyle(.borderedProminent)
        } else {
            content
        }
    }
}
