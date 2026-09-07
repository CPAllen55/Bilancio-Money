//
//  BudgetEditorView.swift
//  Bilancio
//
//  Changing what a category is expected to cost.
//
//  Two kinds of edit, and the difference is the whole design:
//
//  A BASELINE scales the year. Somebody moving groceries from $480 to $430 has
//  said "about a tenth less", not "every month is $430" — so December stays
//  December and the shape history gave the year survives the edit.
//
//  A PINNED MONTH is absolute, because naming one month is what that means.
//
//  Offering only the first would make a known one-off impossible to record.
//  Offering only the second would make an ordinary "spend a bit less" into
//  twelve separate edits. So both, said plainly, rather than one control whose
//  behaviour changes depending on where you touch it.
//
//  Which month is being pinned is chosen here rather than inherited. It used to
//  be whatever the strip behind the sheet was showing, which put the year's
//  chart in front of somebody who could only act on one column of it — the
//  information to decide that March is the heavy month, and no way to say so
//  without closing the sheet, moving the strip and opening it again. Touching a
//  bar now moves the edit to that month, and several months can be planned
//  before saving once.
//

import Charts
import ClerkKit
import SwiftUI

@MainActor
@Observable
final class BudgetEditor {
    let row: BudgetResponse.Row
    /// The whole window, so any of it can be planned rather than just the one
    /// month the sheet was opened on.
    let months: [String]
    let labels: [String]

    /// The month being pinned. Moves with the chart.
    var month: String

    /// Every pinned month, as it stands including unsaved edits. Held for the
    /// whole window rather than one month at a time so that planning March and
    /// then April does not throw March away, and so both go up in one write.
    var pinned: [String: Int]

    /// The scaling baseline, or nil to go back to what history says.
    var baseline: Int?

    private(set) var saving = false
    private(set) var error: String?

    private let client = APIClient(baseURL: Bilancio.apiBaseURL) {
        guard let session = Clerk.shared.session else { return nil }
        return try await session.getToken()
    }

    init(row: BudgetResponse.Row, month: String, months: [String], labels: [String]) {
        self.row = row
        // Fall back to the months the row itself carries. The window is the
        // same one; this only matters if a caller has the row and not the
        // response it came out of.
        let window = months.isEmpty ? row.plan.keys.sorted() : months
        self.months = window
        self.labels = labels
        // A month outside the window would leave the picker with nothing
        // selected and pin something the chart does not show.
        self.month = window.contains(month) ? month : (window.last ?? month)
        self.pinned = row.pinned
        self.baseline = row.baselineOverride
    }

    /// The month named the way the rest of the screen names it.
    func label(of m: String) -> String {
        if let i = months.firstIndex(of: m), labels.indices.contains(i) { return labels[i] }
        return Self.shortLabel(m)
    }

    var monthLabel: String { label(of: month) }

    /// The absolute figure for the month being edited, or nil to let the shape
    /// decide. Reads and writes the entry for whichever month is selected.
    var pinnedAmount: Int? {
        get { pinned[month] }
        set { pinned[month] = newValue }
    }

    /// Months whose pin differs from what the server holds — what a save would
    /// actually change, and what the chart marks.
    var pendingMonths: Set<String> {
        let keys = Set(pinned.keys).union(row.pinned.keys)
        return keys.filter { pinned[$0] != row.pinned[$0] }
    }

    /// Jan…Dec, for a window whose labels were not passed in.
    static func shortLabel(_ ym: String) -> String {
        let parts = ym.split(separator: "-")
        guard parts.count == 2, let m = Int(parts[1]), (1...12).contains(m) else { return ym }
        return ["Jan","Feb","Mar","Apr","May","Jun",
                "Jul","Aug","Sep","Oct","Nov","Dec"][m - 1]
    }

    /// What history alone says a month of this costs.
    var shaped: Int { row.baseline }

    /// What the plan currently says for the month being edited.
    var currentPlan: Int { row.plan[month] ?? 0 }

    /// What each month of the plan year would be if this were saved.
    ///
    /// Recomputed live rather than read back, so the chart moves as the figure
    /// is typed — the whole point of showing it is to answer "compared with
    /// what?" while the answer can still change.
    func projected(_ m: String) -> Int {
        if let pin = pinned[m] { return pin }
        // No pin: the shape, scaled if a baseline is being typed. `computed`
        // rather than `plan`, because `plan` still carries a pin that has just
        // been removed and would show the cleared figure as if it stood.
        let shape = row.computed[m] ?? 0
        guard let baseline, baseline > 0, shaped > 0 else { return shape }
        return Int((Double(shape) * Double(baseline) / Double(shaped)).rounded())
    }

    /// What the year would become at the baseline being typed.
    ///
    /// Shown because a scaling edit is the one thing a reader cannot predict:
    /// typing 430 against a shaped 480 does not make this month 430, it makes
    /// it about a tenth less than whatever this month already was.
    var previewForMonth: Int? {
        guard pinnedAmount == nil else { return nil }
        guard let baseline, baseline > 0, shaped > 0 else { return nil }
        let computed = row.computed[month] ?? 0
        return Int((Double(computed) * Double(baseline) / Double(shaped)).rounded())
    }

    var changed: Bool {
        !pendingMonths.isEmpty || baseline != row.baselineOverride
    }

    var canSave: Bool { changed && !saving }

    func clearPin() { pinned[month] = nil }
    func clearBaseline() { baseline = nil }

    /// True once saved, so the caller reloads and dismisses.
    func save() async -> Bool {
        guard canSave else { return false }
        saving = true
        error = nil
        defer { saving = false }

        // Only what actually moved. Sending an unchanged baseline alongside a
        // month pin would rewrite the whole year to say the same thing, and a
        // no-op write is still a write somebody has to reason about later.
        var edits: [BudgetEdit] = []
        for m in pendingMonths.sorted() {
            edits.append(BudgetEdit(slug: row.slug, month: m,
                                    amount: .some(pinned[m])))
        }
        if baseline != row.baselineOverride {
            edits.append(BudgetEdit(slug: row.slug, baseline: .some(baseline)))
        }
        guard !edits.isEmpty else { return true }

        do {
            try await client.saveBudget(edits)
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }
}

struct BudgetEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var editor: BudgetEditor
    let onSaved: () -> Void

    init(row: BudgetResponse.Row, month: String, months: [String], labels: [String],
         onSaved: @escaping () -> Void) {
        _editor = State(initialValue: BudgetEditor(row: row, month: month,
                                                   months: months, labels: labels))
        self.onSaved = onSaved
    }

    private var selectedMonth: Binding<String> {
        Binding(get: { editor.month }, set: { editor.month = $0 })
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Planned now", value: editor.currentPlan.asMoney)
                    LabeledContent("History says", value: editor.shaped.asMoney)
                } footer: {
                    Text("“History says” is what \(editor.row.label.lowercased()) has actually cost, shaped across the year.")
                }

                Section {
                    PlanHistoryChart(editor: editor)
                        .listRowInsets(EdgeInsets(top: 10, leading: 12, bottom: 6, trailing: 12))
                } header: {
                    Text("Against the year")
                } footer: {
                    Text("Solid is what was spent. Faded is what the plan expects, and it moves as you type. Touch a month to plan that one instead.")
                }

                Section {
                    // The same choice the chart makes, said in words. A chart
                    // is a fine way to point at March and a poor way to be
                    // sure you did.
                    Picker("Month", selection: selectedMonth) {
                        ForEach(editor.months, id: \.self) { m in
                            Text(editor.label(of: m)).tag(m)
                        }
                    }
                    .pickerStyle(.menu)

                    if editor.pinnedAmount == nil {
                        Button("Pin \(editor.monthLabel) to an amount") {
                            editor.pinnedAmount = editor.currentPlan
                        }
                    } else {
                        HStack {
                            Text("Amount")
                            Spacer()
                            MoneyField(cents: Binding(
                                get: { editor.pinnedAmount ?? 0 },
                                set: { editor.pinnedAmount = $0 }
                            ))
                        }
                        Button("Use the plan instead", role: .destructive) {
                            editor.clearPin()
                        }
                    }
                } header: {
                    Text("Just \(editor.monthLabel)")
                } footer: {
                    Text("A pinned month is exact. Every other month is left alone. Plan as many months as you like — they all go up together when you save.")
                }

                if !editor.pendingMonths.isEmpty {
                    Section("Not saved yet") {
                        ForEach(editor.pendingMonths.sorted(), id: \.self) { m in
                            Button {
                                editor.month = m
                            } label: {
                                LabeledContent(editor.label(of: m)) {
                                    Text(editor.pinned[m]?.asMoney ?? "Back to the plan")
                                        .foregroundStyle(Theme.quietText)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                Section {
                    HStack {
                        Text("Every month, about")
                        Spacer()
                        MoneyField(cents: Binding(
                            get: { editor.baseline ?? editor.shaped },
                            set: { editor.baseline = $0 }
                        ))
                    }

                    if let preview = editor.previewForMonth {
                        LabeledContent("\(editor.monthLabel) becomes", value: preview.asMoney)
                    }

                    if editor.baseline != nil {
                        Button("Back to what history says", role: .destructive) {
                            editor.clearBaseline()
                        }
                    }
                } header: {
                    Text("The whole year")
                } footer: {
                    // The one thing about this control that is not obvious, and
                    // the reason the preview above it exists.
                    Text("This scales the year rather than flattening it. Moving \(editor.shaped.asMoney) to a tenth less makes every month a tenth less — a heavy December stays a heavy December.")
                }

                if editor.pinnedAmount != nil {
                    Section {
                        Label("\(editor.monthLabel) is pinned, so the figure above does not apply to it.",
                              systemImage: "pin.fill")
                            .font(Theme.note)
                            .foregroundStyle(Theme.quietText)
                    }
                }

                if let error = editor.error {
                    Section {
                        Label(error, systemImage: "xmark.octagon")
                            .foregroundStyle(Theme.negative)
                    }
                }
            }
            .navigationTitle(editor.row.label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            if await editor.save() {
                                onSaved()
                                dismiss()
                            }
                        }
                    }
                    .disabled(!editor.canSave)
                }
            }
        }
    }
}

/// Money entry in whole cents. The field holds an integer and formats it
/// rather than parsing a decimal string back into one — money is an integer
/// everywhere in this app, and a field that accepts "12.3" and has to decide
/// what that means is where a rounding argument starts.
struct MoneyField: View {
    @Binding var cents: Int

    var body: some View {
        TextField(
            "0.00",
            value: Binding(
                get: { Decimal(cents) / 100 },
                set: { cents = max(0, NSDecimalNumber(decimal: $0 * 100).intValue) }
            ),
            format: .currency(code: "USD")
        )
        .keyboardType(.decimalPad)
        .multilineTextAlignment(.trailing)
        .monospacedDigit()
    }
}

// MARK: - The year, spent and planned

/// Twelve months of one category: what it cost, and what the plan expects.
///
/// The point of it is comparison while the figure can still change — a number
/// typed into a box says nothing about whether it is generous or impossible,
/// and the twelve bars beside it say both at a glance.
///
/// Spent and planned are drawn in one series rather than two side by side. A
/// month is either behind us or ahead of us and never both, so there is nothing
/// to compare within a month — only across them.
private struct PlanHistoryChart: View {
    let editor: BudgetEditor
    @State private var picked: String?

    private struct Bar: Identifiable {
        let month: String
        let label: String
        let amount: Int
        /// Actual money that left, rather than an expectation about it.
        let isSpent: Bool
        let isEdited: Bool
        var id: String { month }
    }

    private var bars: [Bar] {
        editor.months.map { m in
            let spent = editor.row.spent[m]
            return Bar(
                month: m,
                label: BudgetEditor.shortLabel(m),
                amount: spent ?? editor.projected(m),
                isSpent: spent != nil,
                isEdited: m == editor.month
            )
        }
    }

    var body: some View {
        let data = bars
        let colour = Color(hex: editor.row.colour)

        VStack(alignment: .leading, spacing: 6) {
            Chart {
                ForEach(data) { bar in
                BarMark(
                    x: .value("Month", bar.label),
                    y: .value("Amount", Double(bar.amount) / 100)
                )
                // Weight means spent, and only spent. Giving the edited month
                // full weight too made September solid against a caption that
                // says solid is what was spent — and September has not happened
                // yet, so that drew a projection as history in the one place
                // the whole chart exists to keep them apart. The annotation
                // below is emphasis enough.
                .foregroundStyle(colour.opacity(bar.isSpent ? 1 : 0.35))
                .opacity(picked == nil || picked == bar.label ? 1 : 0.35)
                .annotation(position: .top, spacing: 2) {
                    if picked == bar.label {
                        VStack(spacing: 0) {
                            Text(bar.amount.asShortMoney)
                            Text(bar.isSpent ? "spent" : "plan").opacity(0.7)
                        }
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(colour)
                    } else if bar.isEdited && picked == nil {
                        VStack(spacing: 0) {
                            Text(bar.amount.asShortMoney)
                            if !bar.isSpent { Text("plan").opacity(0.7) }
                        }
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(colour)
                    }
                }
                }

                // A month with an unsaved figure on it. Marked rather than
                // recoloured: the bar's own weight already means spent or not,
                // and a second meaning loaded onto the same channel would make
                // both unreadable.
                ForEach(data.filter { editor.pendingMonths.contains($0.month) }) { bar in
                    PointMark(
                        x: .value("Month", bar.label),
                        y: .value("Amount", Double(bar.amount) / 100)
                    )
                    .symbolSize(26)
                    .foregroundStyle(Theme.accent)
                }
            }
            .chartXSelection(value: $picked)
            // Touching the chart moves the edit, which is the point of showing
            // the year while a figure can still be typed. Nothing is lost by
            // moving: each month's figure is held against that month, so
            // stepping away and back returns to what was typed.
            .onChange(of: picked) { _, chosen in
                guard let chosen, let bar = bars.first(where: { $0.label == chosen }) else { return }
                editor.month = bar.month
            }
            .animation(.snappy(duration: 0.2), value: picked)
            .chartYAxis {
                AxisMarks(format: .currency(code: "USD").precision(.fractionLength(0)))
            }
            .chartXAxis {
                // Every third month. Twelve labels at this width overlap into a
                // band, and the edited month is called out above its own bar.
                AxisMarks(values: .automatic(desiredCount: 4)) { value in
                    AxisGridLine()
                    AxisValueLabel {
                        if let s = value.as(String.self) { Text(s) }
                    }
                }
            }
            .frame(height: 150)

            if let prior = priorTotal, prior > 0 {
                Label("\(prior.asMoney) in the same months a year ago",
                      systemImage: "clock.arrow.circlepath")
                    .font(.caption2)
                    .foregroundStyle(Theme.quietText)
            }
        }
    }

    /// Absent rather than zero when the history does not reach back — a
    /// year-ago figure of $0 built from months with no record reads as a year
    /// of spending nothing.
    private var priorTotal: Int? {
        guard let prior = editor.row.priorSpent, !prior.isEmpty else { return nil }
        let sum = prior.values.reduce(0, +)
        return sum > 0 ? sum : nil
    }

}
