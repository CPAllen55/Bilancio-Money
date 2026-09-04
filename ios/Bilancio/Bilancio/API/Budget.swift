//
//  Budget.swift
//  Bilancio
//
//  GET /api/budget — what a month should cost, per subcategory, twelve months
//  out, alongside what was actually spent.
//
//  The app reads this rather than fitting its own curve. src/plan.ts and
//  src/budget-shape.ts are the single definition of the plan, shared by four
//  dashboards precisely so they cannot disagree; a fifth opinion computed on a
//  phone would be a fifth thing to reconcile.
//

import Foundation

struct BudgetResponse: Decodable {
    /// `YYYY-MM`, twelve of them, oldest first.
    let months: [String]
    let labels: [String]
    let currentMonth: String
    let monthsOfHistory: Int
    let categories: [Row]
    let income: Income
    let savings: Savings

    struct Row: Decodable, Identifiable, Hashable {
        let id: String
        let slug: String
        let label: String
        let colour: String
        let parentSlug: String?
        /// Keyed by `YYYY-MM`. Only months already elapsed appear.
        let spent: [String: Int]
        /// What the plan says each month should cost, after the reader's edits.
        let plan: [String: Int]
        /// The same before any edits, so a reset has something to return to.
        let computed: [String: Int]
        /// What history says a month of this costs, before any edit.
        let baseline: Int
        /// The reader's own baseline, when they have set one. Null means the
        /// plan is still whatever history shaped.
        let baselineOverride: Int?
        /// Months pinned to an absolute figure, keyed by `YYYY-MM`.
        let pinned: [String: Int]

        /// Whether this month's figure was chosen rather than derived. A pinned
        /// month and a shaped one look identical on screen and behave
        /// completely differently when the shape moves under them.
        func isPinned(_ month: String) -> Bool { pinned[month] != nil }
    }

    struct Income: Decodable {
        let plan: [String: Int]
        let spent: [String: Int]
        let baseline: Int
    }

    struct Savings: Decodable {
        let annual: Int
        let monthly: Int
    }
}

/// One change to the plan.
///
/// Two kinds, and the difference matters more than it looks:
///
/// A **baseline** scales the year rather than replacing it. Somebody moving
/// groceries from $480 to $430 has said "about a tenth less", not "every month
/// is $430" — so December stays December, and the shape history gave the year
/// survives the edit. See `applyOverride` in src/plan.ts.
///
/// A **pinned month** is absolute, because naming one month is what that means.
struct BudgetEdit: Encodable {
    let slug: String
    /// Cents. Null returns the category to what history says.
    var baseline: Int??
    /// `YYYY-MM`.
    var month: String?
    /// Cents. Null unpins the month named above.
    var amount: Int??

    var payload: [String: Any] {
        var out: [String: Any] = ["slug": slug]
        if let baseline { out["baseline"] = baseline as Any? ?? NSNull() }
        if let month {
            out["month"] = month
            out["amount"] = (amount ?? nil) as Any? ?? NSNull()
        }
        return out
    }
}

extension APIClient {
    func budget() async throws -> BudgetResponse {
        try await get("/api/budget")
    }

    /// Sent as a batch even for one change, so the response shape is the same
    /// either way — the Worker answers a bare edit differently for the benefit
    /// of callers that predate batching, and matching only one of those two
    /// shapes is a decode that works until somebody edits two things.
    @discardableResult
    func saveBudget(_ edits: [BudgetEdit]) async throws -> BudgetSaveResponse {
        try await send("PUT", "/api/budget", body: ["edits": edits.map(\.payload)])
    }
}

struct BudgetSaveResponse: Decodable {
    let ok: Bool
}
