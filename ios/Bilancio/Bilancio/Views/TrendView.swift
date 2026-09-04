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

                InOutChart(series: data.series)
                NetChart(series: data.series)
                RunningTotalChart(series: data.series)
                YearAgoCard(now: data.series, before: data.priorSeries)
            }
            .padding()
        }
        .background(Theme.background)
    }
}

// MARK: - What came in against what went out

private struct InOutChart: View {
    let series: [TrendResponse.Month]

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                Text("Income and expenses")
                    .font(Theme.tileLabel)
                    .foregroundStyle(Theme.quietText)

                Chart {
                    ForEach(series) { m in
                        // Paired rather than stacked: the question is which of
                        // the two was larger in a given month, and a stack
                        // answers a different one.
                        BarMark(
                            x: .value("Month", m.shortLabel),
                            y: .value("Amount", Double(m.income) / 100)
                        )
                        .foregroundStyle(by: .value("Side", "Income"))
                        .position(by: .value("Side", "Income"))

                        BarMark(
                            x: .value("Month", m.shortLabel),
                            y: .value("Amount", Double(m.expense) / 100)
                        )
                        .foregroundStyle(by: .value("Side", "Expenses"))
                        .position(by: .value("Side", "Expenses"))
                    }
                }
                .chartForegroundStyleScale([
                    "Income": Theme.incomeTint,
                    "Expenses": Theme.expenseTint,
                ])
                .chartLegend(position: .top, alignment: .leading)
                .chartYAxis { AxisMarks(format: .currency(code: "USD").precision(.fractionLength(0))) }
                .frame(height: 220)
            }
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
                        Label(
                            change >= 0
                                ? "\(change.formatted(.number.precision(.fractionLength(0))))% more than a year ago"
                                : "\((-change).formatted(.number.precision(.fractionLength(0))))% less than a year ago",
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
