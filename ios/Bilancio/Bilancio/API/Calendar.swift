//
//  Calendar.swift
//  Bilancio
//
//  GET /api/calendar — a month laid out as days, with what each one cost and
//  which subscriptions land on it.
//

import Foundation

struct CalendarResponse: Decodable {
    /// `YYYY-MM`.
    let month: String
    /// `YYYY-MM-DD`. Days after this one have not happened.
    let today: String
    /// Every day of the month, quiet ones included — the Worker fills the gaps
    /// so that two places do not each decide how many days February has.
    let days: [Day]
    let total: Total

    struct Day: Decodable, Identifiable {
        /// `YYYY-MM-DD`.
        let date: String
        let spent: Int
        /// How many transactions, which is not the same question as how much:
        /// a quiet day with one large charge and a busy day of small ones look
        /// alike by money alone.
        let count: Int
        let subs: [Sub]

        var id: String { date }

        /// The day of the month, for the grid.
        var dayOfMonth: Int {
            Int(date.split(separator: "-").last ?? "") ?? 0
        }
    }

    struct Sub: Decodable, Identifiable, Hashable {
        let name: String
        let cents: Int
        /// Expected rather than recorded — a charge this merchant has always
        /// made by now and has not made yet.
        let projected: Bool
        var id: String { "\(name)-\(cents)-\(projected)" }
    }

    struct Total: Decodable {
        let spent: Int
        let subscriptions: Int
    }
}

extension APIClient {
    func calendar(month: String?) async throws -> CalendarResponse {
        try await get("/api/calendar", query: month.map { [URLQueryItem(name: "month", value: $0)] } ?? [])
    }
}
