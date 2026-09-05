//
//  Transactions.swift
//  Bilancio
//
//  GET /api/transactions — the ledger, and the drill-down behind any category.
//

import Foundation

struct TransactionsResponse: Decodable {
    /// The whole filtered set. `transactions` is one page of it.
    let total: Int
    let sum: Sum
    /// Rolled up over the whole set, not the page — a merchant breakdown is
    /// built from this rather than by grouping the rows on screen.
    let vendors: [Vendor]
    /// Every merchant name seen in the period, up to 400 — the Worker builds
    /// this over the whole window rather than the page, so it is a complete
    /// menu rather than a description of what happens to be loaded.
    let merchants: [String]?
    let categories: [Category]
    let transactions: [Row]

    struct Sum: Decodable {
        let `in`: Int
        let out: Int
        let net: Int
    }

    struct Vendor: Decodable, Identifiable {
        let key: String
        let name: String
        let cents: Int
        let count: Int
        /// A filename, never a URL — see MerchantLogo.
        let logo: String?
        var id: String { key }
    }

    struct Category: Decodable, Identifiable {
        let id: String
        let slug: String
        let label: String
        let colour: String
        let parentSlug: String?
        let kind: String
    }

    struct Row: Decodable, Identifiable, Hashable {
        let id: String
        let date: String
        let name: String
        /// Positive is money in. Already flipped out of Plaid's convention by
        /// the Worker; nothing here flips it back.
        let amount: Int
        let pending: Bool
        /// The resolved category slug — an override, then a merchant rule,
        /// then Plaid's guess. Not a column; trust what arrives.
        let category: String?
        /// Which of the three decided: "user", "rule" or "plaid".
        let categorySource: String?
        /// A filename, never a URL — see MerchantLogo.
        let logo: String?
        /// The parts this transaction has been carved into, if any.
        ///
        /// Only the carved-off pieces are stored; the remainder is computed and
        /// keeps whatever the row itself resolved to. Storing both halves would
        /// mean two numbers that have to agree, and two numbers that have to
        /// agree eventually do not.
        let splits: [Part]?

        struct Part: Decodable, Hashable {
            let categoryId: String
            /// Reader's convention, the same way round as `amount`.
            let amount: Int
        }
    }
}

extension TransactionsResponse.Category {
    /// Transactions belong to leaves. A parent is a rollup, and filing a row on
    /// one would double-count it against its own children.
    var isLeaf: Bool { parentSlug != nil }
}

extension APIClient {
    func transactions(
        range: SummaryRange = .thisMonth,
        bucket: String? = nil,
        /// Matched as a substring against the name as displayed — the merchant
        /// name where Plaid supplies one, the raw bank string otherwise. The
        /// Worker filters on what is on screen rather than on the raw column,
        /// so a search matches what a reader can actually see.
        merchant: String? = nil,
        limit: Int = 100,
        offset: Int = 0
    ) async throws -> TransactionsResponse {
        var query = [
            URLQueryItem(name: "range", value: range.queryValue),
            // The Worker caps this at 200; asking for more is silently trimmed
            // rather than refused, which would look like missing data.
            URLQueryItem(name: "limit", value: String(min(limit, 200))),
            URLQueryItem(name: "offset", value: String(offset)),
        ]
        if let bucket { query.append(URLQueryItem(name: "bucket", value: bucket)) }
        if let merchant, !merchant.isEmpty {
            query.append(URLQueryItem(name: "merchant", value: merchant))
        }
        return try await get("/api/transactions", query: query)
    }
}

struct SplitsResponse: Decodable {
    let splits: [TransactionsResponse.Row.Part]
    /// What is left on the original category. Zero means fully reassigned.
    let remainder: Int
}

extension APIClient {
    /// Replaces the whole set of parts for a transaction.
    ///
    /// Wholesale rather than incremental, because that is what the Worker does:
    /// clearing the editor and saving has to leave nothing behind, and a part
    /// moved between categories must not linger under both. An empty array
    /// removes every split.
    ///
    /// Amounts go in the reader's convention — the same way round as the
    /// transaction's own `amount` — and every part must carry that sign. The
    /// Worker refuses a mixed set rather than storing arithmetic that holds
    /// while the meaning does not.
    func saveSplits(
        transactionId: String,
        parts: [TransactionsResponse.Row.Part]
    ) async throws -> SplitsResponse {
        try await send(
            "PUT",
            "/api/transactions/\(transactionId)/splits",
            body: ["splits": parts.map { ["categoryId": $0.categoryId, "amount": $0.amount] }]
        )
    }
}

extension TransactionsResponse.Row {
    /// `YYYY-MM-DD` is what the API speaks. Parsed once per row for grouping
    /// and for the day headers.
    var day: Date? {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone(identifier: "UTC")
        return f.date(from: date)
    }
}
