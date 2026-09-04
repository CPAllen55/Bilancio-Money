//
//  NetWorth.swift
//  Bilancio
//
//  GET /api/assets — what is owned, what is owed, and how it moved.
//

import Foundation

struct NetWorthResponse: Decodable {
    let months: Int
    let totals: Totals
    let opening: Opening
    let change: Change
    let credit: Credit
    let coverage: Coverage
    let series: [Point]
    let byClass: [Group]
    let byInstitution: [Group]

    struct Totals: Decodable {
        let assets: Int
        let liabilities: Int
        let netWorth: Int
        /// What could be reached this week. A house is an asset and is not this.
        let liquid: Int
    }

    struct Opening: Decodable {
        let label: String
        let netWorth: Int
    }

    struct Change: Decodable {
        let netWorth: Int
        let assets: Int
        let liabilities: Int
        /// Absent against a zero or negative opening, where a percentage is
        /// not a number anyone should read.
        let netWorthPct: Double?
    }

    struct Credit: Decodable {
        let limit: Int
        let used: Int
        /// A fraction, not a percentage. Null when no limit is known.
        let utilisation: Double?
    }

    /// Whether every point on the chart is derived from real movement rather
    /// than assumed. Balances are reconstructed backwards from transactions,
    /// and an account with no history is held flat.
    struct Coverage: Decodable {
        let reconstructed: Int
        let heldFlat: Int
        let exact: Bool
    }

    struct Point: Decodable, Identifiable {
        let month: String
        let label: String
        let assets: Int
        let liabilities: Int
        let netWorth: Int
        let liquid: Int
        var id: String { month }
    }

    struct Group: Decodable, Identifiable {
        let key: String
        let label: String
        let assets: Int
        let liabilities: Int
        let net: Int
        let accounts: Int
        var id: String { key }
    }
}

extension APIClient {
    func netWorth(months: Int = 12) async throws -> NetWorthResponse {
        try await get("/api/assets", query: [URLQueryItem(name: "months", value: String(months))])
    }
}
