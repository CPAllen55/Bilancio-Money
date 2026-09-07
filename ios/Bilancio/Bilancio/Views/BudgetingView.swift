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

import Charts
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

    /// Parents, by slug.
    ///
    /// /api/budget returns leaves only — it has no parent rows because parents
    /// are not budgeted — so a parent's name and colour have to come from the
    /// category tree. Title-casing the slug instead gave "Giving Work" and
    /// "Food", which are not what those categories are called anywhere else in
    /// the product.
    private(set) var parents: [String: TransactionsResponse.Category] = [:]

    /// Twelve months of actuals, and the same twelve a year earlier.
    ///
    /// /api/budget carries prior-year spending per category but nothing for
    /// income, and a year-over-year chart that could only draw half the
    /// question is not worth the room. /api/trend answers both in one call.
    ///
    /// Decoration, so it never fails the screen.
    private(set) var trend: TrendResponse?

    private let client = APIClient(baseURL: Bilancio.apiBaseURL) {
        guard let session = Clerk.shared.session else { return nil }
        return try await session.getToken()
    }

    func load() async {
        do {
            let data = try await client.budget()
            state = .loaded(data)
            let summary = try? await client.summary(range: .thisMonth)
            spentThisMonth = summary?.totals.byCategory ?? [:]
            parents = Dictionary(
                uniqueKeysWithValues: (summary?.categoryList ?? [])
                    .filter { $0.parentSlug == nil }
                    .map { ($0.slug, $0) }
            )
            // Two years, not one. The plan runs to December and its
            // year-ago counterparts run to December before that — twelve
            // months of history stops at last October and leaves the
            // projection months with nothing behind them to compare against.
            trend = try? await client.trend(months: 24)
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
    /// Set when this is presented as a sheet, which needs a way out of its own.
    var onDone: (() -> Void)?

    @State private var model = BudgetingModel()
    /// The category whose plan is being edited.
    @State private var editing: BudgetResponse.Row?
    /// The parent whose whole plan is being shared out.
    @State private var editingGroup: ParentGroup?

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
                             months: windowMonths,
                             labels: windowLabels) {
                Task { await model.load() }
            }
        }
        .sheet(item: $editingGroup) { group in
            BudgetGroupEditorView(parentLabel: group.label,
                                  rows: group.rows,
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
        .modifier(MarkWhenRoot(on: !embedded && onDone == nil))
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink {
                    ForecastView()
                } label: {
                    Label("The year ahead", systemImage: "calendar")
                }
            }
            if let onDone {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done", action: onDone)
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

    /// The window the strip covers, handed to the editor so a plan can be made
    /// for any of it rather than only the month the sheet was opened on.
    private var windowMonths: [String] {
        guard case .loaded(let data) = model.state else { return [] }
        return data.months
    }

    private var windowLabels: [String] {
        guard case .loaded(let data) = model.state else { return [] }
        return data.labels
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

                PlanHero(data: data, month: month, spent: spent)
                MoneyOverTime(data: data, month: month, trend: model.trend)

                if let incomeRow = data.incomeRow {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Money in")
                            .font(Theme.tileLabel)
                            .foregroundStyle(Theme.quietText)
                            .frame(maxWidth: .infinity, alignment: .leading)

                        Card(padding: 0) {
                            Button {
                                editing = incomeRow
                            } label: {
                                PlanRow(row: incomeRow, month: month,
                                        spent: incomeRow.spent[month]
                                            ?? model.spentThisMonth["income"] ?? 0)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                CategoryPlanCard(rows: data.categories, month: month, live: live,
                                 parents: model.parents,
                                 editing: $editing, editingGroup: $editingGroup)

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

/// A parent and the subcategories under it, gathered for editing together.
struct ParentGroup: Identifiable {
    let slug: String
    let label: String
    let colour: String
    let rows: [BudgetResponse.Row]
    var id: String { slug }
}

private struct CategoryPlanCard: View {
    let rows: [BudgetResponse.Row]
    let month: String
    let live: [String: Int]
    let parents: [String: TransactionsResponse.Category]
    @Binding var editing: BudgetResponse.Row?
    @Binding var editingGroup: ParentGroup?

    @State private var expanded: Set<String> = []

    private func spent(_ row: BudgetResponse.Row) -> Int {
        live[row.slug] ?? row.spent[month] ?? 0
    }

    /// Grouped by parent, biggest plan first.
    ///
    /// A budget is read to find what dominates it, and alphabetical order
    /// buries that under whatever begins with an A. Inside a parent the same
    /// rule applies for the same reason.
    private var groups: [(ParentGroup, Int, Int)] {
        let live = rows.filter { ($0.plan[month] ?? 0) > 0 || spent($0) > 0 }
        let byParent = Dictionary(grouping: live) { $0.parentSlug ?? $0.slug }

        return byParent.map { parent, kids in
            let ordered = kids.sorted { ($0.plan[month] ?? 0) > ($1.plan[month] ?? 0) }
            let plan = ordered.reduce(0) { $0 + ($1.plan[month] ?? 0) }
            let used = ordered.reduce(0) { $0 + spent($1) }
            // The tree's own name and colour, falling back to the slug only
            // when a parent is somehow missing from it.
            let known = parents[parent]
            let group = ParentGroup(
                slug: parent,
                label: known?.label ?? parent.replacingOccurrences(of: "-", with: " ").capitalized,
                colour: known?.colour ?? ordered.first?.colour ?? "#888888",
                rows: ordered
            )
            return (group, plan, used)
        }
        .sorted { $0.1 > $1.1 }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("By category")
                .font(Theme.tileLabel)
                .foregroundStyle(Theme.quietText)
                .frame(maxWidth: .infinity, alignment: .leading)

            let list = groups

            if list.isEmpty {
                Card {
                    Text("Nothing planned or spent in this month.")
                        .font(Theme.note)
                        .foregroundStyle(Theme.quietText)
                }
            } else {
                ForEach(list, id: \.0.id) { group, plan, used in
                    Card(padding: 0) {
                        VStack(spacing: 0) {
                            ParentRow(group: group, plan: plan, spent: used,
                                      open: expanded.contains(group.slug)) {
                                if expanded.contains(group.slug) {
                                    expanded.remove(group.slug)
                                } else {
                                    expanded.insert(group.slug)
                                }
                            }

                            if expanded.contains(group.slug) {
                                Divider().padding(.leading, 14)

                                Button {
                                    editingGroup = group
                                } label: {
                                    HStack(spacing: 8) {
                                        Image(systemName: "square.split.2x1")
                                            .font(.system(size: 12))
                                        Text("Set a total for \(group.label)")
                                            .font(Theme.note)
                                        Spacer()
                                        Image(systemName: "chevron.right")
                                            .font(.system(size: 10, weight: .semibold))
                                            .foregroundStyle(Theme.quietText)
                                    }
                                    .foregroundStyle(Theme.accent)
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 10)
                                    .contentShape(.rect)
                                }
                                .buttonStyle(.plain)

                                ForEach(group.rows) { row in
                                    Divider().padding(.leading, 14)
                                    Button {
                                        editing = row
                                    } label: {
                                        PlanRow(row: row, month: month, spent: spent(row))
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// The parent line: what it costs in total, and the way into what is inside it.
private struct ParentRow: View {
    let group: ParentGroup
    let plan: Int
    let spent: Int
    let open: Bool
    let toggle: () -> Void

    private var over: Bool { plan > 0 && spent > plan }

    var body: some View {
        Button(action: toggle) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.quietText)
                        .rotationEffect(.degrees(open ? 90 : 0))

                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color(hex: group.colour))
                        .frame(width: 3, height: 20)

                    VStack(alignment: .leading, spacing: 1) {
                        Text(group.label).font(Theme.body).lineLimit(1)
                        Text("\(group.rows.count) subcategor\(group.rows.count == 1 ? "y" : "ies")")
                            .font(.caption2)
                            .foregroundStyle(Theme.quietText)
                    }

                    Spacer(minLength: 8)

                    VStack(alignment: .trailing, spacing: 1) {
                        Text(spent.asShortMoney)
                            .font(Theme.body)
                            .monospacedDigit()
                            .foregroundStyle(over ? Theme.negative : Theme.text)
                        Text("of \(plan.asShortMoney)")
                            .font(.caption2)
                            .monospacedDigit()
                            .foregroundStyle(Theme.quietText)
                    }
                }

                GeometryReader { geo in
                    let scale = max(plan, spent)
                    ZStack(alignment: .leading) {
                        Capsule().fill(Theme.hairline.opacity(0.4))
                        Capsule()
                            .fill(over ? Theme.negative : Color(hex: group.colour))
                            .frame(width: scale > 0
                                   ? max(2, geo.size.width * Double(spent) / Double(scale))
                                   : 2)
                    }
                }
                .frame(height: 5)
                .padding(.leading, 30)
            }
            .padding(.vertical, 10)
            .padding(.horizontal, 14)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
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

// MARK: - What the plan comes to

/// Planned income, planned spending, and the difference — which is the figure
/// the whole screen is really about.
///
/// Both halves are shown because both are editable. A plan that only budgets
/// spending can tell you what a month costs and never whether you can afford
/// it; the answer to that is one subtraction away and was not being drawn.
private struct PlanHero: View {
    let data: BudgetResponse
    let month: String
    /// What has actually gone out, for the bar underneath.
    let spent: Int

    private var income: Int { data.plannedIncome(month) }
    private var expense: Int { data.plannedExpense(month) }
    private var net: Int { data.plannedNet(month) }

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Planned net")
                        .font(Theme.tileLabel)
                        .foregroundStyle(Theme.quietText)

                    Text(net.asMoney)
                        .font(Theme.figure(36))
                        .monospacedDigit()
                        .foregroundStyle(Theme.tint(forNet: net))
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)

                    Text(net < 0
                         ? "This month plans to spend more than it earns."
                         : "What the plan expects to keep.")
                        .font(Theme.note)
                        .foregroundStyle(Theme.quietText)
                }

                HStack(spacing: 0) {
                    figure("Income planned", income, Theme.incomeTint)
                    Divider().frame(height: 34)
                    figure("Spending planned", expense, Theme.expenseTint)
                }

                ProportionBar(label: "Spent so far", amount: spent, planned: expense,
                              fallbackScale: max(spent, expense),
                              tint: spent > expense ? Theme.negative : Theme.positive,
                              verb: "spent")
            }
        }
    }

    private func figure(_ label: String, _ cents: Int, _ tint: Color) -> some View {
        VStack(spacing: 2) {
            Text(label)
                .font(Theme.tileLabel)
                .foregroundStyle(Theme.quietText)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(cents.asShortMoney)
                .font(.system(.headline, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Money over time

/// Income and spending, month by month, one behind the other.
///
/// Income is the wider bar and sits behind; spending is narrower and sits in
/// front of it. The gap you can see above the front bar is what the month
/// keeps, and the months where the front bar overtops the one behind it are the
/// months that did not — which is the whole question, answered without reading
/// a single figure.
///
/// One chart rather than two, because the sizes only mean anything relative to
/// each other. Two charts side by side with their own axes can make a month
/// that earned twice what it spent look identical to one that spent twice what
/// it earned.
private struct MoneyOverTime: View {
    let data: BudgetResponse
    let month: String
    /// Last year, when it is wanted. Nil when the fetch failed, which leaves
    /// the chart exactly as it was rather than failing the screen.
    let trend: TrendResponse?

    /// Remembered rather than reset each visit. Somebody who turned the lines
    /// off found them too busy, and showing them again tomorrow is not a
    /// feature — it is the same complaint on a loop.
    @AppStorage("budgetShowLastYear") private var showLastYear = false

    private struct Point: Identifiable {
        let month: String
        let label: String
        let income: Int
        let expense: Int
        /// No record yet — these are the plan's expectations rather than what
        /// happened, and are drawn faintly to say so.
        let projected: Bool
        var id: String { month }
    }

    /// Last year's actuals, keyed by the month they are drawn under.
    ///
    /// Built by shifting the series back a year rather than by reading
    /// priorSeries. priorSeries only covers the months the series itself
    /// covers, which ends today — so the projection months, whose year-ago
    /// counterparts are perfectly well recorded, had nothing to draw. Twenty
    /// four months of series reaches every one of them.
    private var lastYear: [String: (income: Int, expense: Int)] {
        guard let trend else { return [:] }
        let byMonth = Dictionary(uniqueKeysWithValues: trend.series.map {
            ($0.month, (income: $0.income, expense: $0.expense))
        })
        var out: [String: (income: Int, expense: Int)] = [:]
        for m in data.months {
            if let year = Self.yearBefore(m), let found = byMonth[year] {
                out[m] = found
            }
        }
        return out
    }

    /// "2026-12" a year earlier is "2025-12".
    static func yearBefore(_ ym: String) -> String? {
        let parts = ym.split(separator: "-")
        guard parts.count == 2, let y = Int(parts[0]) else { return nil }
        return "\(y - 1)-\(parts[1])"
    }

    private var hasLastYear: Bool { !lastYear.isEmpty }

    private var points: [Point] {
        data.months.enumerated().map { i, m in
            // income.spent carries a key only for months complete enough to
            // have a record, which makes it the test for whether this month
            // happened. Summing the categories cannot tell you: an absent month
            // and a month of nothing both sum to zero.
            let earned = data.income.spent[m]
            let spent = data.categories.reduce(0) { $0 + ($1.spent[m] ?? 0) }
            return Point(
                month: m,
                label: data.labels.indices.contains(i)
                    ? String(data.labels[i].prefix(3)) : m,
                income: earned ?? data.plannedIncome(m),
                expense: earned == nil ? data.plannedExpense(m) : spent,
                projected: earned == nil
            )
        }
    }

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("Income and spending over time")
                        .font(Theme.tileLabel)
                        .foregroundStyle(Theme.quietText)
                    Spacer()
                    if hasLastYear {
                        Toggle("Last year", isOn: $showLastYear)
                            .toggleStyle(.button)
                            .font(Theme.tileLabel)
                            .buttonStyle(.bordered)
                            .controlSize(.mini)
                    }
                }

                legend

                Chart {
                    ForEach(points) { p in
                        // Unstacked, or Swift Charts puts one on top of the
                        // other and the pair reads as a total neither of them
                        // is. Both start at zero so their heights compare.
                        BarMark(
                            x: .value("Month", p.label),
                            y: .value("Income", Double(p.income) / 100),
                            width: .ratio(0.94),
                            stacking: .unstacked
                        )
                        .foregroundStyle(Theme.incomeTint.opacity(p.projected ? 0.16 : 0.3))
                        .cornerRadius(2)

                        BarMark(
                            x: .value("Month", p.label),
                            y: .value("Spending", Double(p.expense) / 100),
                            width: .ratio(0.44),
                            stacking: .unstacked
                        )
                        .foregroundStyle(Theme.expenseTint.opacity(p.projected ? 0.4 : 0.95))
                        .cornerRadius(2)
                    }

                    // Last year over the top, and only when asked for. Lines
                    // rather than more bars: three bars per month would be a
                    // picket fence, and the question these answer is "higher or
                    // lower than then", which is a shape rather than a size.
                    if showLastYear {
                        ForEach(points) { p in
                            // Both lines, and no threshold on either. A month
                            // present in the record earned what it earned, and
                            // a year in which nothing came in is a finding
                            // rather than missing data — suppressing the zero
                            // deleted the income line entirely and made the
                            // chart look like it only tracked spending.
                            if let before = lastYear[p.month] {
                                LineMark(
                                    x: .value("Month", p.label),
                                    y: .value("Amount", Double(before.expense) / 100),
                                    series: .value("Series", "Spending last year")
                                )
                                .foregroundStyle(Theme.expenseTint)
                                .lineStyle(.init(lineWidth: 2, dash: [5, 3]))
                                .interpolationMethod(.monotone)
                                .symbol(.circle)
                                .symbolSize(20)

                                LineMark(
                                    x: .value("Month", p.label),
                                    y: .value("Amount", Double(before.income) / 100),
                                    series: .value("Series", "Income last year")
                                )
                                .foregroundStyle(Theme.incomeTint)
                                .lineStyle(.init(lineWidth: 2, dash: [2, 3]))
                                .interpolationMethod(.monotone)
                                .symbol(.square)
                                .symbolSize(20)
                            }
                        }
                    }
                }
                .chartYAxis {
                    AxisMarks(format: .currency(code: "USD").precision(.fractionLength(0)))
                }
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 6)) { value in
                        AxisGridLine()
                        AxisValueLabel { if let s = value.as(String.self) { Text(s) } }
                    }
                }
                .frame(height: showLastYear ? 220 : 190)
                .animation(.snappy(duration: 0.25), value: showLastYear)

                Text(showLastYear
                     ? "Faded months are the plan; solid months already happened. Where the narrow bar rises above the wide one, the month spent more than it earned. Dashed lines are the same months a year ago."
                     : "Faded months are the plan; solid months already happened. Where the narrow bar rises above the wide one, the month spent more than it earned.")
                    .font(.caption2)
                    .foregroundStyle(Theme.quietText)
            }
        }
    }

    private var legend: some View {
        HStack(spacing: 12) {
            swatch(Theme.incomeTint.opacity(0.3), "Income", wide: true)
            swatch(Theme.expenseTint.opacity(0.95), "Spending", wide: false)
            if showLastYear {
                // Dashes rather than blocks, because that is what is drawn —
                // and one for each, because there are two lines and they are
                // not the same measurement.
                dash(Theme.incomeTint, "Income LY")
                dash(Theme.expenseTint, "Spending LY")
            }
            Spacer(minLength: 0)
        }
    }

    private func dash(_ colour: Color, _ label: String) -> some View {
        HStack(spacing: 4) {
            Rectangle()
                .fill(colour)
                .frame(width: 12, height: 2)
            Text(label)
                .font(.caption2)
                .foregroundStyle(Theme.quietText)
        }
    }

    private func swatch(_ colour: Color, _ label: String, wide: Bool) -> some View {
        HStack(spacing: 4) {
            RoundedRectangle(cornerRadius: 1)
                .fill(colour)
                .frame(width: wide ? 12 : 5, height: 10)
            Text(label)
                .font(.caption2)
                .foregroundStyle(Theme.quietText)
        }
    }
}
