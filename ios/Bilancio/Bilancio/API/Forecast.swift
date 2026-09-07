//
//  Forecast.swift
//  Bilancio
//
//  GET /api/forecast — the year, month by month: what already happened, then
//  what the plan says the rest of it costs.
//

import Foundation

struct ForecastResponse: Decodable {
    let year: Int
    /// The first month that is a projection rather than a record. Null once
    /// the year is complete.
    let firstProjectedMonth: String?
    let months: [Month]
    let totals: Totals

    struct Month: Decodable, Identifiable {
        let month: String
        /// False for months that have already happened.
        let projected: Bool
        let income: Int
        let expense: Int
        let net: Int
        var id: String { month }

        var shortLabel: String {
            let parts = month.split(separator: "-")
            guard parts.count == 2, let m = Int(parts[1]), (1...12).contains(m) else { return month }
            return ["Jan","Feb","Mar","Apr","May","Jun",
                    "Jul","Aug","Sep","Oct","Nov","Dec"][m - 1]
        }
    }

    struct Totals: Decodable {
        let savedSoFar: Int
        let projectedRemainingIncome: Int
        let projectedRemainingExpense: Int
        let projectedRemainingNet: Int
        let projectedYearEndNet: Int
    }
}

/// GET /api/plaid/items — the connections and their health.
struct BankItemsResponse: Decodable {
    let items: [Item]

    struct Item: Decodable, Identifiable {
        let id: String
        let institution: String?
        let status: String?
        let lastSyncedAt: String?
        /// A linked-but-never-synced item should not look identical to one
        /// holding a year of history.
        let awaitingFirstSync: Bool
        let accounts: [Account]

        struct Account: Decodable, Identifiable {
            let id: String
            let name: String?
            let mask: String?
            let type: String?
            let subtype: String?
            let currentBalance: Int?
        }

        /// The one status worth acting on: the bank wants a fresh login and
        /// every sync fails until it gets one.
        var needsAttention: Bool { status == "login_required" }
    }
}

extension APIClient {
    func forecast() async throws -> ForecastResponse {
        try await get("/api/forecast")
    }

    func bankItems() async throws -> BankItemsResponse {
        try await get("/api/plaid/items")
    }
}
