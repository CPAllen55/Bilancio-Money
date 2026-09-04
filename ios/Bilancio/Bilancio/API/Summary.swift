//
//  Summary.swift
//  Bilancio
//
//  GET /api/summary — the Overview, and GET /api/trend — the shape behind it.
//  Only the fields the app draws are decoded; both endpoints return more.
//

import Foundation

struct SummaryResponse: Decodable {
    let range: Period
    let comparison: Period
    let totals: Totals
    let previous: Totals
    let safeToSpend: SafeToSpend
    let budget: Budget?
    /// Spending accounts the figures were built from. Zero means no bank has
    /// been linked yet, which is a different thing from a month of no activity.
    let accountsCounted: Int

    struct Period: Decodable {
        let label: String
        let start: String
        let end: String
        /// Absent on `comparison`, which is described rather than requested.
        let key: String?
    }

    /// Money in cents, always. Positive is money IN and negative is money OUT —
    /// Plaid's convention is the opposite and is flipped once, at the boundary,
    /// in src/summary-routes.ts. Nothing here flips it back.
    struct Totals: Decodable {
        let income: Int
        let expense: Int
        let net: Int

        /// Not a field on the response. The Worker puts `savingsRate` on
        /// `budget` and nowhere else, so the one for the actual period is
        /// worked out here.
        var savingsRate: Double? {
            income > 0 ? Double(net) / Double(income) * 100 : nil
        }
    }

    struct SafeToSpend: Decodable {
        /// Floored at zero by the Worker. A period that spent more than it
        /// earned reads 0 here, not the loss — use `totals.net` for that.
        let remaining: Int
        let perDay: Int
        let daysLeft: Int
        let daysElapsed: Int
        let daysInPeriod: Int
        let spent: Int
        let budget: Int
        let onPace: Bool
    }

    /// What the period was expected to cost. `available` is false until there
    /// is enough history to fit a shape to, and every figure is meaningless
    /// until it is true.
    struct Budget: Decodable {
        let available: Bool
        let method: String?
        let monthsOfHistory: Int?
        let income: Int
        let expense: Int
        let net: Int
        let savingsRate: Double?
    }
}

/// GET /api/trend — twelve months of each figure, for the sparklines.
///
/// Cosmetic only. A failure here leaves the tiles without their lines and
/// changes nothing else, so it is never allowed to fail the screen.
struct TrendResponse: Decodable {
    let sparklines: Sparklines
    /// One entry per month shown, oldest first.
    let series: [Month]
    /// The same months a year earlier, for the year-ago comparison.
    let priorSeries: [Month]

    struct Month: Decodable, Identifiable {
        /// `YYYY-MM`.
        let month: String
        let income: Int
        let expense: Int

        /// Worked out, not decoded. The trend buckets carry `total`, `income`,
        /// `expense` and the per-category breakdown, and no `net` — declaring
        /// one here failed the decode of the whole response, and because the
        /// sparklines are deliberately fetched with `try?` it failed silently:
        /// the tiles simply lost their lines with nothing logged anywhere.
        var net: Int { income - expense }

        var id: String { month }

        /// "Sep", and "Sep 25" each January so a twelve-month run does not
        /// silently wrap without saying which year it landed in.
        var shortLabel: String {
            let parts = month.split(separator: "-")
            guard parts.count == 2, let m = Int(parts[1]), (1...12).contains(m) else { return month }
            let name = ["Jan","Feb","Mar","Apr","May","Jun",
                        "Jul","Aug","Sep","Oct","Nov","Dec"][m - 1]
            return m == 1 ? "\(name) \(parts[0].suffix(2))" : name
        }
    }

    struct Sparklines: Decodable {
        let income: [Int]
        let expense: [Int]
        let net: [Int]
        let savingsRate: [Double]
    }
}

/// The ranges /summary accepts. `month:` and `span:` are what let the app show
/// history; everything else is an aggregate ending today.
enum SummaryRange: Hashable, CaseIterable {
    case thisMonth
    case lastMonth
    case yearToDate

    var queryValue: String {
        switch self {
        case .thisMonth:  return "this-month"
        case .lastMonth:  return "last-month"
        case .yearToDate: return "ytd"
        }
    }

    var label: String {
        switch self {
        case .thisMonth:  return "This month"
        case .lastMonth:  return "Last month"
        case .yearToDate: return "Year to date"
        }
    }
}

extension APIClient {
    func summary(range: SummaryRange = .thisMonth) async throws -> SummaryResponse {
        try await get("/api/summary", query: [URLQueryItem(name: "range", value: range.queryValue)])
    }

    func trend(months: Int = 12) async throws -> TrendResponse {
        try await get("/api/trend", query: [URLQueryItem(name: "months", value: String(months))])
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

    /// The same, without the trailing cents. Four of these sit side by side on
    /// a phone, and "$1,247" fits where "$1,247.00" does not.
    var asShortMoney: String {
        (Decimal(self) / 100).formatted(
            .currency(code: "USD").precision(.fractionLength(0))
        )
    }
}
