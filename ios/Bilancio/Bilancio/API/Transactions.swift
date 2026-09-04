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

    struct Row: Decodable, Identifiable {
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
    }
}

extension APIClient {
    func transactions(
        range: SummaryRange = .thisMonth,
        bucket: String? = nil,
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
        return try await get("/api/transactions", query: query)
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
