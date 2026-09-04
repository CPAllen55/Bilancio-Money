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

    struct Row: Decodable, Identifiable {
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
        let baseline: Int
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

extension APIClient {
    func budget() async throws -> BudgetResponse {
        try await get("/api/budget")
    }
}
