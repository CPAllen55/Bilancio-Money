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
//  4. sync — pulls the transactions. Without it the bank is linked and the
//     app still shows nothing, which looks exactly like a failure.
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
}
