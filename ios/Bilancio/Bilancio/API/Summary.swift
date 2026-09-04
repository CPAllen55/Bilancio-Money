//
//  Summary.swift
//  Bilancio
//
//  GET /api/summary — the Overview. Only the fields this screen reads are
//  decoded; the endpoint returns considerably more (per-category breakdowns,
//  the budget, the previous period) and will grow.
//

import Foundation

struct SummaryResponse: Decodable {
    let range: Period
    let totals: Totals
    /// Spending accounts the figures were built from. Zero means no bank has
    /// been linked yet, which is a different thing from a month of no activity.
    let accountsCounted: Int

    struct Period: Decodable {
        let key: String
        let label: String
        let start: String
        let end: String
    }

    /// Money in cents, always. Positive is money IN and negative is money OUT —
    /// Plaid's convention is the opposite and is flipped once, at the boundary,
    /// in src/summary-routes.ts. Nothing here flips it back.
    struct Totals: Decodable {
        let income: Int
        let expense: Int
        let net: Int
    }
}

/// The ranges /summary accepts. `month:` and `span:` are what let the app show
/// history; everything else is an aggregate ending today.
enum SummaryRange {
    case thisMonth
    case lastMonth
    case yearToDate
    case month(String)

    var queryValue: String {
        switch self {
        case .thisMonth:      return "this-month"
        case .lastMonth:      return "last-month"
        case .yearToDate:     return "ytd"
        case .month(let ym):  return "month:\(ym)"
        }
    }
}

extension APIClient {
    func summary(range: SummaryRange = .thisMonth) async throws -> SummaryResponse {
        try await get("/api/summary", query: [URLQueryItem(name: "range", value: range.queryValue)])
    }
}

extension Int {
    /// Cents to something a person reads.
    ///
    /// Money is an integer everywhere in this API and only becomes a Decimal to
    /// be printed — never a Double, which cannot hold a cent exactly.
    var asMoney: String {
        (Decimal(self) / 100).formatted(.currency(code: "USD"))
    }
}
