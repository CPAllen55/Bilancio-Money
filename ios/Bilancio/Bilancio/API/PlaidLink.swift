//
//  PlaidLink.swift
//  Bilancio
//
//  Connecting a bank: the three calls either side of Plaid's own sheet.
//
//  1. link-token — a short-lived token Link opens with. The app says which
//     platform it is, because the OAuth redirect differs and a native client
//     handed the web URL returns into Safari and stops there.
//  2. Plaid Link runs. On success it hands back a public token.
//  3. exchange — swaps that for the long-lived access token, which is
//     encrypted and stored server-side. It never reaches the app.
//  4. sync — pulls the transactions, in rounds. Without it the bank is linked
//     and the app still shows nothing, which looks exactly like a failure;
//     without the rounds it shows a month of a two year history, which looks
//     like the bank only had a month.
//

import Foundation

struct LinkTokenResponse: Decodable {
    let linkToken: String
    let expiration: String?
}

struct SyncResponse: Decodable {
    let added: Int
    let modified: Int
    let removed: Int
    /// The Worker stopped short of the end and saved where it got to.
    ///
    /// A sync is capped per round — a Worker has a request budget and a two
    /// year backfill exceeds it — so the caller is expected to come back until
    /// this is false. Absent from older responses, so it defaults to done.
    let more: Bool?
    /// Banks Plaid has accepted but not finished pulling history from yet.
    let pending: [String]?
}

struct ExchangeResponse: Decodable {
    let ok: Bool
}

extension APIClient {
    /// A token for opening Link. Says `ios`, which is what makes the Worker
    /// send PLAID_REDIRECT_URI_IOS rather than the web page.
    func linkToken() async throws -> LinkTokenResponse {
        try await send("POST", "/api/plaid/link-token", body: ["platform": "ios"])
    }

    /// Update mode, for a bank whose login has expired. Same redirect, so it
    /// has to name the platform too.
    func updateLinkToken(itemId: String) async throws -> LinkTokenResponse {
        try await send("POST", "/api/plaid/link-token/update",
                       body: ["itemId": itemId, "platform": "ios"])
    }

    @discardableResult
    func exchange(publicToken: String) async throws -> ExchangeResponse {
        try await send("POST", "/api/plaid/exchange", body: ["publicToken": publicToken])
    }

    @discardableResult
    func syncTransactions() async throws -> SyncResponse {
        try await send("POST", "/api/plaid/sync")
    }

    /// Sync until the Worker says there is nothing left.
    ///
    /// One call is not a sync, it is a first instalment. A round is capped at a
    /// couple of hundred rows — a Worker's request budget will not carry a two
    /// year backfill — so it saves the cursor and answers `more`, and the
    /// caller is expected to come back.
    ///
    /// Nothing else collects the rest afterwards. Plaid's webhook fires when
    /// there is something NEW, not because a cursor was left unread, so an
    /// unfinished backfill simply waits until the next transaction on the
    /// account happens to wake it.
    ///
    /// Bounded, because a loop that trusts a server to eventually say no is a
    /// loop that can run forever. Forty rounds is the ceiling the web client
    /// uses, and far more than any first link needs.
    @MainActor
    @discardableResult
    func syncEverything(progress: (Int) -> Void = { _ in }) async throws -> SyncTotals {
        var totals = SyncTotals()
        while totals.rounds < 40 {
            let round = try await syncTransactions()
            totals.rounds += 1
            totals.added += round.added
            totals.modified += round.modified
            totals.removed += round.removed
            totals.pending = round.pending ?? []
            progress(totals.added)
            if round.more != true { return totals }
        }
        // Out of rounds rather than out of data: worth saying so, because the
        // honest answer is "there is more" and not "that was all of it".
        totals.unfinished = true
        return totals
    }
}

/// What a whole sync came to, across however many rounds it took.
struct SyncTotals {
    var added = 0
    var modified = 0
    var removed = 0
    var rounds = 0
    /// Banks Plaid has accepted but is still pulling history from.
    var pending: [String] = []
    /// The round ceiling was reached with the Worker still saying `more`.
    var unfinished = false
}
