//
//  BudgetingView.swift
//  Bilancio
//
//  What a month is supposed to cost, and what it actually did.
//
//  Only subcategories are budgeted. buildShapedPlan skips any category without
//  a parent, so money filed directly on a top-level category — and everything
//  in Unsorted, which has no parent — is spending with no budget line against
//  it. The total here is expected to sit below actual spend, and the screen
//  says so rather than letting it look like an error.
//

import ClerkKit
import SwiftUI

@MainActor
@Observable
final class BudgetingModel {
    enum State {
        case loading
        case loaded(BudgetResponse)
        case failed(String)
    }

    private(set) var state: State = .loading
    var month: String?

    /// Spending in the month still running, per category slug.
    ///
    /// /api/budget reports spending only for *complete* months: a partial
    /// month taken as evidence drags every baseline down, so history stops at
    /// the last finished one and the current month is planned rather than
    /// learned from. That leaves no `spent` entry for it — which is not the
    /// same as zero, and rendering it as zero says a month with real spending
    /// in it has none. The figure comes from /api/summary instead, which is
    /// where the Overview gets the same number.
    private(set) var spentThisMonth: [String: Int] = [:]

    private let client = APIClient(baseURL: Bilancio.apiBaseURL) {
        guard let session = Clerk.shared.session else { return nil }
        return try await session.getToken()
    }

    func load() async {
        do {
            let data = try await client.budget()
            state = .loaded(data)
            spentThisMonth = (try? await client.summary(range: .thisMonth))?
                .totals.byCategory ?? [:]
            // Opens on the month in progress, which is the one a person came
            // to look at. Any other default is a click before the screen is
            // showing what was asked for.
            if month == nil { month = data.currentMonth }
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}

struct BudgetingView: View {
    /// True when this is pushed onto somebody else's stack. A NavigationStack
    /// inside a NavigationStack swallows the back button and leaves the screen
    /// with no way out of it.
    var embedded = false

    @State private var model = BudgetingModel()
    /// The category whose plan is being edited.
    @State private var editing: BudgetResponse.Row?

    var body: some View {
        Group {
            if embedded {
                inner
            } else {
                NavigationStack { inner }.tint(Theme.accent)
            }
        }
        .task { await model.load() }
        .sheet(item: $editing) { row in
            BudgetEditorView(row: row,
                             month: editingMonth,
                             monthLabel: monthLabel) {
                Task { await model.load() }
            }
        }
    }

    private var inner: some View {
        Group {
                switch model.state {
                case .loading:
                    ProgressView("Loading…")

                case .failed(let message):
                    ContentUnavailableView {
                        Label("Could not load the budget", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Try again") { Task { await model.load() } }
                            .buttonStyle(.borderedProminent)
                    }

                case .loaded(let data):
                    content(data)
                }
            }
        .navigationTitle("Budgeting")
        .navigationBarTitleDisplayMode(embedded ? .inline : .large)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink {
                    ForecastView()
                } label: {
                    Label("The year ahead", systemImage: "calendar")
                }
            }
        }
        .refreshable { await model.load() }
    }

    /// Whichever month the strip is showing. Never the row's own slug, which
    /// an earlier version fell back to — a category name where a `YYYY-MM` is
    /// expected pins nothing and silently edits no month at all.
    private var editingMonth: String {
        if let chosen = model.month { return chosen }
        if case .loaded(let data) = model.state { return data.currentMonth }
        return ""
    }

    /// The same month, named the way the strip names it.
    private var monthLabel: String {
        guard case .loaded(let data) = model.state,
              let i = data.months.firstIndex(of: editingMonth),
              data.labels.indices.contains(i)
        else { return "this month" }
        return data.labels[i]
    }

    private func content(_ data: BudgetResponse) -> some View {
        let month = model.month ?? data.currentMonth
        let isCurrent = month == data.currentMonth
        let live = isCurrent ? model.spentThisMonth : [:]
        let planned = data.categories.compactMap { $0.plan[month] }.reduce(0, +)
        let spent = data.categories
            .compactMap { live[$0.slug] ?? $0.spent[month] }
            .reduce(0, +)

        return ScrollView {
            VStack(spacing: Theme.sectionGap) {
                MonthStrip(months: data.months, labels: data.labels,
                           current: data.currentMonth,
                           selection: Bindable(model).month)

                Card {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Planned for this month")
                            .font(Theme.tileLabel)
                            .foregroundStyle(Theme.quietText)

                        Text(planned.asMoney)
                            .font(Theme.figure(32))
                            .monospacedDigit()
                            .lineLimit(1)
                            .minimumScaleFactor(0.6)

                        ProportionBar(label: "Spent", amount: spent, planned: planned,
                                      fallbackScale: max(spent, planned),
                                      tint: spent > planned ? Theme.negative : Theme.positive,
                                      verb: "spent")
                    }
                }

                CategoryPlanCard(rows: data.categories, month: month, live: live, editing: $editing)

                Text("Only subcategories are budgeted, so anything filed straight onto a top-level category — and everything in Unsorted — is spending with no line here. The plan is shaped from \(data.monthsOfHistory) month\(data.monthsOfHistory == 1 ? "" : "s") of history.")
                    .font(Theme.note)
                    .foregroundStyle(Theme.quietText)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding()
        }
        .background(Theme.background)
    }
}

/// Twelve months across a phone do not fit, so they scroll.
private struct MonthStrip: View {
    let months: [String]
    let labels: [String]
    let current: String
    @Binding var selection: String?

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(Array(months.enumerated()), id: \.element) { i, m in
                        let isOn = (selection ?? current) == m
                        Button {
                            selection = m
                        } label: {
                            Text(labels.indices.contains(i) ? labels[i] : m)
                                .font(Theme.note)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 7)
                                .background(isOn ? Theme.accent : Theme.surface,
                                            in: .capsule)
                                .foregroundStyle(isOn ? Color.white : Theme.text)
                        }
                        .buttonStyle(.plain)
                        .id(m)
                    }
                }
                .padding(.horizontal, 1)
            }
            .onAppear { proxy.scrollTo(selection ?? current, anchor: .center) }
        }
    }
}

private struct CategoryPlanCard: View {
    let rows: [BudgetResponse.Row]
    let month: String
    let live: [String: Int]
    @Binding var editing: BudgetResponse.Row?

    private func spent(_ row: BudgetResponse.Row) -> Int {
        live[row.slug] ?? row.spent[month] ?? 0
    }

    /// Biggest plan first. A budget is read to find what dominates it, and
    /// alphabetical order buries that under whatever begins with an A.
    private var ordered: [BudgetResponse.Row] {
        rows.filter { ($0.plan[month] ?? 0) > 0 || spent($0) > 0 }
            .sorted { ($0.plan[month] ?? 0) > ($1.plan[month] ?? 0) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("By category")
                .font(Theme.tileLabel)
                .foregroundStyle(Theme.quietText)
                .frame(maxWidth: .infinity, alignment: .leading)

            if ordered.isEmpty {
                Card {
                    Text("Nothing planned or spent in this month.")
                        .font(Theme.note)
                        .foregroundStyle(Theme.quietText)
                }
            } else {
                Card(padding: 0) {
                    VStack(spacing: 0) {
                        ForEach(Array(ordered.enumerated()), id: \.element.id) { i, row in
                            Button {
                                editing = row
                            } label: {
                                PlanRow(row: row, month: month, spent: spent(row))
                            }
                            .buttonStyle(.plain)

                            if i < ordered.count - 1 {
                                Divider().padding(.leading, 14)
                            }
                        }
                    }
                }
            }
        }
    }
}

private struct PlanRow: View {
    let row: BudgetResponse.Row
    let month: String
    let spent: Int

    private var plan: Int { row.plan[month] ?? 0 }
    private var over: Bool { plan > 0 && spent > plan }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Color(hex: row.colour))
                    .frame(width: 3, height: 22)

                VStack(alignment: .leading, spacing: 1) {
                    Text(row.label).font(Theme.body).lineLimit(1)
                    if let parent = row.parentSlug {
                        Text(parent.replacingOccurrences(of: "-", with: " ").capitalized)
                            .font(.caption2)
                            .foregroundStyle(Theme.quietText)
                    }
                }

                Spacer(minLength: 8)

                VStack(alignment: .trailing, spacing: 1) {
                    Text(spent.asShortMoney)
                        .font(Theme.body)
                        .monospacedDigit()
                        .foregroundStyle(over ? Theme.negative : Theme.text)
                    HStack(spacing: 3) {
                        // A pinned month and a shaped one read identically and
                        // behave completely differently when the shape moves
                        // underneath them, so the pin is worth one glyph.
                        if row.isPinned(month) {
                            Image(systemName: "pin.fill")
                                .font(.system(size: 8))
                                .foregroundStyle(Theme.accent)
                        }
                        Text("of \(plan.asShortMoney)")
                            .monospacedDigit()
                    }
                    .font(.caption2)
                    .foregroundStyle(Theme.quietText)
                }

                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.quietText)
            }

            GeometryReader { geo in
                let scale = max(plan, spent)
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.hairline.opacity(0.4))
                    Capsule()
                        .fill(over ? Theme.negative : Color(hex: row.colour))
                        .frame(width: scale > 0
                               ? max(2, geo.size.width * Double(spent) / Double(scale))
                               : 2)
                }
            }
            .frame(height: 5)
            .padding(.leading, 11)
        }
        .padding(.vertical, 9)
        .padding(.trailing, 14)
        .padding(.leading, 14)
        .contentShape(.rect)
    }
}
