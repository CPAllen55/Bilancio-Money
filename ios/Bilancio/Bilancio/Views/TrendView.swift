//
//  TrendView.swift
//  Bilancio
//
//  Month by month: what came in, what went out, and the gap between them.
//  A bad month inside a good year is not the same thing as a bad year, which
//  is the whole reason this screen exists separately from the Overview.
//

import Charts
import ClerkKit
import SwiftUI

@MainActor
@Observable
final class TrendModel {
    enum State {
        case loading
        case loaded(TrendResponse)
        case failed(String)
    }

    private(set) var state: State = .loading
    var months: Int = 12

    private let client = APIClient(baseURL: Bilancio.apiBaseURL) {
        guard let session = Clerk.shared.session else { return nil }
        return try await session.getToken()
    }

    func load() async {
        do {
            state = .loaded(try await client.trend(months: months))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}

struct TrendView: View {
    @State private var model = TrendModel()
    /// The parent category being looked inside, or nil for all of them.
    @State private var drilled: String?

    var body: some View {
        NavigationStack {
            Group {
                switch model.state {
                case .loading:
                    ProgressView("Loading…")

                case .failed(let message):
                    ContentUnavailableView {
                        Label("Could not load the trend", systemImage: "exclamationmark.triangle")
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
            .navigationTitle("Trend")
            .owlMark()
            .refreshable { await model.load() }
        }
        .tint(Theme.accent)
        .task { await model.load() }
    }

    private func content(_ data: TrendResponse) -> some View {
        ScrollView {
            VStack(spacing: Theme.sectionGap) {
                Picker("Months", selection: Bindable(model).months) {
                    Text("6").tag(6)
                    Text("12").tag(12)
                    Text("24").tag(24)
                }
                .pickerStyle(.segmented)
                .onChange(of: model.months) { Task { await model.load() } }
                .onChange(of: model.months) { drilled = nil }

                CategoryTrendChart(series: data.series,
                                   prior: data.priorSeries,
                                   categories: data.categories,
                                   drilled: $drilled)
                NetChart(series: data.series)
                RunningTotalChart(series: data.series)
                YearAgoCard(now: data.series, before: data.priorSeries)
            }
            .padding()
        }
        .background(Theme.background)
    }
}

// MARK: - Spend, stacked by category

/// Monthly spend stacked by category, against the same month last year.
///
/// Parents by default and subcategories on drilling in, which is the only way
/// this fits on a phone: thirty-one leaves in a stack is a band of colour with
/// no readable segments, and the question "what is big" is answered by the
/// parents anyway. The leaves answer the next question, which is "big because
/// of what".
private struct CategoryTrendChart: View {
    let series: [TrendResponse.Month]
    let prior: [TrendResponse.Month]
    let categories: [TransactionsResponse.Category]
    @Binding var drilled: String?

    /// Slug to label and colour for whichever level is being drawn.
    private var visible: [TransactionsResponse.Category] {
        if let drilled {
            return categories.filter { $0.parentSlug == drilled }
        }
        return categories.filter { $0.kind == "spend" && $0.parentSlug == nil }
    }

    /// One bar segment: a month, a category, and the money in it.
    private struct Segment: Identifiable {
        let id = UUID()
        let month: String
        let label: String
        let colour: Color
        let cents: Int
    }

    /// Built by walking `visible` rather than the response dictionary.
    ///
    /// A dictionary has no order, and Swift Charts assigns a colour scale
    /// positionally against whatever order the marks arrive in — so building
    /// these from `byCategory` directly gave Groceries a different colour on
    /// every launch, and never the colour the category itself carries
    /// everywhere else in the app.
    private var segments: [Segment] {
        series.flatMap { m -> [Segment] in
            let source = drilled == nil ? (m.byParent ?? [:]) : (m.byCategory ?? [:])
            return visible.compactMap { cat in
                guard let cents = source[cat.slug], cents > 0 else { return nil }
                return Segment(month: m.shortLabel, label: cat.label,
                               colour: Color(hex: cat.colour), cents: cents)
            }
        }
    }

    /// The scale, stated rather than inferred: each category's own colour,
    /// against its own name.
    private var domain: [String] { visible.map(\.label) }
    private var range: [Color] { visible.map { Color(hex: $0.colour) } }

    /// The same months a year earlier, summed over whatever is on screen — so
    /// drilling in compares like with like rather than against the whole year.
    private var yearAgo: [(label: String, cents: Int)] {
        let slugs = Set(visible.map(\.slug))
        return zip(series, prior).map { now, before in
            let source = drilled == nil ? (before.byParent ?? [:]) : (before.byCategory ?? [:])
            let total = source.filter { slugs.contains($0.key) }.values.reduce(0, +)
            return (now.shortLabel, total)
        }
    }

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(drilled == nil ? "Spend by category" : "Inside \(drilledLabel)")
                        .font(Theme.tileLabel)
                        .foregroundStyle(Theme.quietText)
                    Spacer()
                    if drilled != nil {
                        Button {
                            drilled = nil
                        } label: {
                            Label("All categories", systemImage: "chevron.left")
                                .font(Theme.tileLabel)
                        }
                    }
                }

                let marks = segments
                let ago = yearAgo

                if marks.isEmpty {
                    Text("Nothing recorded in these months.")
                        .font(Theme.note)
                        .foregroundStyle(Theme.quietText)
                        .frame(maxWidth: .infinity, minHeight: 120)
                } else {
                    Chart {
                        ForEach(marks) { seg in
                            BarMark(
                                x: .value("Month", seg.month),
                                y: .value("Spend", Double(seg.cents) / 100)
                            )
                            .foregroundStyle(by: .value("Category", seg.label))
                        }

                        // Last year as a rule across each month rather than a
                        // second stack: the comparison is one number, and a
                        // second stack beside the first doubles the ink to say
                        // something a line already says.
                        ForEach(ago, id: \.label) { point in
                            if point.cents > 0 {
                                RuleMark(
                                    x: .value("Month", point.label),
                                    yStart: .value("Last year", Double(point.cents) / 100),
                                    yEnd: .value("Last year", Double(point.cents) / 100)
                                )
                                .lineStyle(.init(lineWidth: 1.5, dash: [3, 2]))
                                .foregroundStyle(Theme.quietText)
                            }
                        }
                    }
                    .chartForegroundStyleScale(domain: domain, range: range)
                    .chartLegend(position: .bottom, alignment: .leading, spacing: 8)
                    .chartYAxis {
                        AxisMarks(format: .currency(code: "USD").precision(.fractionLength(0)))
                    }
                    .frame(height: 260)

                    Text("Dashed rule is the same month a year earlier.")
                        .font(Theme.note)
                        .foregroundStyle(Theme.quietText)
                }

                if drilled == nil {
                    DrillStrip(parents: visible, onPick: { drilled = $0 })
                } else {
                    // A stack says Groceries was heavy in February; the only
                    // useful next question is which rows made it heavy. Rows
                    // rather than the bars themselves, for the same reason the
                    // way in was one: a segment this size is not a tap target.
                    MonthBreakdown(series: series, subcategories: visible)
                }
            }
        }
    }

    private var drilledLabel: String {
        categories.first { $0.slug == drilled }?.label ?? drilled ?? ""
    }
}

/// A month, a subcategory within it, and the way through to its transactions.
///
/// Two steps rather than one screen per combination: picking the month first
/// keeps the list short, and a month with nothing in a subcategory simply does
/// not offer it.
private struct MonthBreakdown: View {
    let series: [TrendResponse.Month]
    let subcategories: [TransactionsResponse.Category]
    @State private var month: String?

    /// Newest first. Somebody drilling in is far more often asking about the
    /// month just gone than about one eleven months back.
    private var months: [TrendResponse.Month] { series.reversed() }

    /// The newest month that actually has something in it, until one is
    /// picked. Opening on the newest month full stop lands on "Nothing in
    /// Sep." four days into September — an empty state as the first thing a
    /// drill-down shows reads as a broken screen rather than as a quiet month.
    private var chosen: TrendResponse.Month? {
        if let month { return series.first { $0.month == month } }
        let slugs = Set(subcategories.map(\.slug))
        return months.first { m in
            (m.byCategory ?? [:]).contains { slugs.contains($0.key) && $0.value > 0 }
        } ?? months.first
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Divider()

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(months) { m in
                        let isOn = (chosen?.month == m.month)
                        Button {
                            month = m.month
                        } label: {
                            Text(m.shortLabel)
                                .font(Theme.note)
                                .padding(.horizontal, 11)
                                .padding(.vertical, 6)
                                .background(isOn ? Theme.accent : Theme.background, in: .capsule)
                                .foregroundStyle(isOn ? Color.white : Theme.text)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 1)
            }

            if let chosen {
                let rows = subcategories
                    .compactMap { cat -> (TransactionsResponse.Category, Int)? in
                        let cents = chosen.byCategory?[cat.slug] ?? 0
                        return cents > 0 ? (cat, cents) : nil
                    }
                    .sorted { $0.1 > $1.1 }

                if rows.isEmpty {
                    Text("Nothing in \(chosen.shortLabel).")
                        .font(Theme.note)
                        .foregroundStyle(Theme.quietText)
                } else {
                    ForEach(rows, id: \.0.id) { cat, cents in
                        NavigationLink {
                            CategoryMonthView(slug: cat.slug, range: .month(chosen.month),
                                              title: cat.label, monthLabel: chosen.shortLabel)
                        } label: {
                            HStack(spacing: 8) {
                                RoundedRectangle(cornerRadius: 1.5)
                                    .fill(Color(hex: cat.colour))
                                    .frame(width: 3, height: 18)
                                Text(cat.label).font(Theme.note).lineLimit(1)
                                Spacer(minLength: 8)
                                Text(cents.asShortMoney)
                                    .font(Theme.note)
                                    .monospacedDigit()
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundStyle(Theme.quietText)
                            }
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }
}

/// Tapping a chart segment on a phone is a coin toss at this size, so the way
/// in is a row of names rather than the bars themselves.
private struct DrillStrip: View {
    let parents: [TransactionsResponse.Category]
    let onPick: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(parents) { cat in
                    Button {
                        onPick(cat.slug)
                    } label: {
                        HStack(spacing: 5) {
                            Circle()
                                .fill(Color(hex: cat.colour))
                                .frame(width: 7, height: 7)
                            Text(cat.label)
                            Image(systemName: "chevron.right")
                                .font(.system(size: 8, weight: .bold))
                                .foregroundStyle(Theme.quietText)
                        }
                        .font(Theme.note)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Theme.background, in: .capsule)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 1)
        }
    }
}

// MARK: - The gap

private struct NetChart: View {
    let series: [TrendResponse.Month]

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                Text("Net, month by month")
                    .font(Theme.tileLabel)
                    .foregroundStyle(Theme.quietText)

                Chart(series) { m in
                    // Coloured per bar rather than per series: a run of months
                    // is not all one thing, and the months that went backwards
                    // are the ones worth finding at a glance.
                    BarMark(
                        x: .value("Month", m.shortLabel),
                        y: .value("Net", Double(m.net) / 100)
                    )
                    .foregroundStyle(Theme.tint(forNet: m.net))
                }
                .chartYAxis { AxisMarks(format: .currency(code: "USD").precision(.fractionLength(0))) }
                .frame(height: 180)

            }
        }
    }
}

// MARK: - The running total

/// The same months summed left to right.
///
/// Deliberately its own chart rather than a line over the bars above. Twelve
/// months of around eight thousand each accumulate to eighty, and on one axis
/// the total flattens every bar it is made of into a sliver — the two are the
/// same data at an order of magnitude apart, and a shared axis can only ever
/// serve one of them.
private struct RunningTotalChart: View {
    let series: [TrendResponse.Month]

    private var points: [(label: String, total: Int)] {
        var total = 0
        return series.map { m in
            total += m.net
            return (m.shortLabel, total)
        }
    }

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                Text("Running total")
                    .font(Theme.tileLabel)
                    .foregroundStyle(Theme.quietText)

                Chart {
                    ForEach(points, id: \.label) { p in
                        AreaMark(
                            x: .value("Month", p.label),
                            y: .value("Running", Double(p.total) / 100)
                        )
                        .foregroundStyle(Theme.tint(forNet: p.total).opacity(0.14))

                        LineMark(
                            x: .value("Month", p.label),
                            y: .value("Running", Double(p.total) / 100)
                        )
                        .foregroundStyle(Theme.tint(forNet: p.total))
                        .interpolationMethod(.monotone)
                    }
                }
                .chartYAxis { AxisMarks(format: .currency(code: "USD").precision(.fractionLength(0))) }
                .frame(height: 170)

                if let last = points.last {
                    Text("\(last.total.asMoney) across the \(series.count) months shown")
                        .font(Theme.note)
                        .foregroundStyle(Theme.quietText)
                }
            }
        }
    }
}

// MARK: - Against the same months a year earlier

private struct YearAgoCard: View {
    let now: [TrendResponse.Month]
    let before: [TrendResponse.Month]

    var body: some View {
        // Absent rather than empty when the history does not reach back far
        // enough: a year-ago line drawn out of no data is a flat line that
        // looks like a year of nothing happening.
        if before.isEmpty || before.allSatisfy({ $0.income == 0 && $0.expense == 0 }) {
            EmptyView()
        } else {
            Card {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Against the year before")
                        .font(Theme.tileLabel)
                        .foregroundStyle(Theme.quietText)

                    let thisYear = now.map(\.expense).reduce(0, +)
                    let lastYear = before.map(\.expense).reduce(0, +)

                    HStack(spacing: 0) {
                        figure("Spent now", thisYear)
                        Divider().frame(height: 34)
                        figure("Same months before", lastYear)
                    }

                    if lastYear > 0 {
                        let change = Double(thisYear - lastYear) / Double(lastYear) * 100
                        // A tenth of a point below ten, whole numbers above.
                        // Rounding 0.46% to "0%" reports a real difference as
                        // no difference, which is the one thing the card exists
                        // to say either way.
                        let digits = abs(change) < 10 ? 1 : 0
                        let size = abs(change).formatted(.number.precision(.fractionLength(digits)))
                        Label(
                            change >= 0
                                ? "\(size)% more than a year ago"
                                : "\(size)% less than a year ago",
                            systemImage: change >= 0 ? "arrow.up.right" : "arrow.down.right"
                        )
                        .font(Theme.note)
                        .foregroundStyle(change >= 0 ? Theme.negative : Theme.positive)
                    }
                }
            }
        }
    }

    private func figure(_ label: String, _ cents: Int) -> some View {
        VStack(spacing: 2) {
            Text(label)
                .font(Theme.tileLabel)
                .foregroundStyle(Theme.quietText)
                .multilineTextAlignment(.center)
            Text(cents.asShortMoney)
                .font(.system(.headline, design: .rounded))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity)
    }
}
