//
//  BudgetGroupEditorView.swift
//  Bilancio
//
//  Setting a budget for a whole category, which the API has no such thing as.
//
//  Only subcategories are budgeted — buildShapedPlan skips any category without
//  a parent — so a parent's budget is the sum of its children and nothing else.
//  Naming a figure for the parent therefore has to become a figure for each
//  child, and the only distribution that leaves the plan recognisable is the
//  one it already has: each child keeps its share.
//
//  The reverse direction needs no code at all. Change one subcategory and the
//  parent's total is the new sum, its siblings untouched — which is what
//  "incremental to the category" means, and it falls out of the parent having
//  no stored figure of its own to contradict them.
//

import ClerkKit
import SwiftUI

/// Splits a total across shares, exactly.
///
/// Exactly, not approximately: rounding each share independently loses or
/// invents cents, and a category whose children do not add up to it is the one
/// thing this screen must never produce. Everything is rounded down and the
/// remainder handed to the largest share, where a few cents cannot be seen.
func distribute(_ total: Int, across current: [Int]) -> [Int] {
    guard !current.isEmpty else { return [] }
    let sum = current.reduce(0, +)

    guard sum > 0 else {
        // Nothing planned yet, so there is no shape to keep. An even split is
        // the only honest reading of "spread this across them".
        let base = total / current.count
        var out = Array(repeating: base, count: current.count)
        out[0] += total - base * current.count
        return out
    }

    var out = current.map { Int((Double(total) * Double($0) / Double(sum)).rounded(.down)) }
    let short = total - out.reduce(0, +)
    if short != 0, let biggest = current.indices.max(by: { current[$0] < current[$1] }) {
        out[biggest] += short
    }
    return out
}

@MainActor
@Observable
final class BudgetGroupEditor {
    let parentLabel: String
    let rows: [BudgetResponse.Row]
    let month: String
    let monthLabel: String

    /// The new total for the month, or nil to leave the month alone.
    var monthTotal: Int?
    /// The new total for a typical month, or nil to leave the year alone.
    var yearTotal: Int?

    private(set) var saving = false
    private(set) var error: String?

    private let client = APIClient(baseURL: Bilancio.apiBaseURL) {
        guard let session = Clerk.shared.session else { return nil }
        return try await session.getToken()
    }

    init(parentLabel: String, rows: [BudgetResponse.Row], month: String, monthLabel: String) {
        self.parentLabel = parentLabel
        self.rows = rows
        self.month = month
        self.monthLabel = monthLabel
    }

    var currentMonthPlan: Int { rows.reduce(0) { $0 + ($1.plan[month] ?? 0) } }
    var currentYearPlan: Int { rows.reduce(0) { $0 + ($1.baselineOverride ?? $1.baseline) } }

    var changed: Bool { monthTotal != nil || yearTotal != nil }
    var canSave: Bool { changed && !saving }

    /// What each child would become, for showing before it is committed.
    func preview(_ total: Int, keyPath: (BudgetResponse.Row) -> Int) -> [(String, Int)] {
        let shares = distribute(total, across: rows.map(keyPath))
        return zip(rows, shares).map { ($0.label, $1) }
    }

    func save() async -> Bool {
        guard canSave else { return false }
        saving = true
        error = nil
        defer { saving = false }

        var edits: [BudgetEdit] = []

        if let monthTotal {
            let shares = distribute(monthTotal, across: rows.map { $0.plan[month] ?? 0 })
            for (row, share) in zip(rows, shares) {
                edits.append(BudgetEdit(slug: row.slug, month: month, amount: .some(share)))
            }
        }

        if let yearTotal {
            let shares = distribute(yearTotal, across: rows.map { $0.baselineOverride ?? $0.baseline })
            for (row, share) in zip(rows, shares) {
                edits.append(BudgetEdit(slug: row.slug, baseline: .some(share)))
            }
        }

        do {
            // One request. The Worker groups by category so a category named
            // twice in a batch is still read once and written once, which is
            // exactly what happens when both a month and a year are set here.
            try await client.saveBudget(edits)
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }
}

struct BudgetGroupEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var editor: BudgetGroupEditor
    let onSaved: () -> Void

    init(parentLabel: String, rows: [BudgetResponse.Row], month: String,
         monthLabel: String, onSaved: @escaping () -> Void) {
        _editor = State(initialValue: BudgetGroupEditor(
            parentLabel: parentLabel, rows: rows, month: month, monthLabel: monthLabel
        ))
        self.onSaved = onSaved
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Planned now", value: editor.currentMonthPlan.asMoney)
                    LabeledContent("Subcategories", value: "\(editor.rows.count)")
                } footer: {
                    Text("A category has no budget of its own — this shares a figure across what is inside it, keeping the proportions they already have.")
                }

                Section {
                    if editor.monthTotal == nil {
                        Button("Set a total for \(editor.monthLabel)") {
                            editor.monthTotal = editor.currentMonthPlan
                        }
                    } else {
                        HStack {
                            Text("Total")
                            Spacer()
                            MoneyField(cents: Binding(
                                get: { editor.monthTotal ?? 0 },
                                set: { editor.monthTotal = $0 }
                            ))
                        }
                        ForEach(editor.preview(editor.monthTotal ?? 0, keyPath: { $0.plan[editor.month] ?? 0 }), id: \.0) { name, share in
                            LabeledContent(name, value: share.asMoney)
                                .font(Theme.note)
                                .foregroundStyle(Theme.quietText)
                        }
                        Button("Leave \(editor.monthLabel) alone", role: .destructive) {
                            editor.monthTotal = nil
                        }
                    }
                } header: {
                    Text("Just \(editor.monthLabel)")
                }

                Section {
                    if editor.yearTotal == nil {
                        Button("Set a total for every month") {
                            editor.yearTotal = editor.currentYearPlan
                        }
                    } else {
                        HStack {
                            Text("Every month, about")
                            Spacer()
                            MoneyField(cents: Binding(
                                get: { editor.yearTotal ?? 0 },
                                set: { editor.yearTotal = $0 }
                            ))
                        }
                        Button("Leave the year alone", role: .destructive) {
                            editor.yearTotal = nil
                        }
                    }
                } header: {
                    Text("The whole year")
                } footer: {
                    Text("Each subcategory keeps its share and its own seasonal shape — a heavy December stays a heavy December.")
                }

                if let error = editor.error {
                    Section {
                        Label(error, systemImage: "xmark.octagon")
                            .foregroundStyle(Theme.negative)
                    }
                }
            }
            .navigationTitle(editor.parentLabel)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            if await editor.save() { onSaved(); dismiss() }
                        }
                    }
                    .disabled(!editor.canSave)
                }
            }
        }
    }
}
