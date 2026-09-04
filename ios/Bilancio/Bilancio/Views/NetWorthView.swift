//
//  NetWorthView.swift
//  Bilancio
//
//  What is owned, what is owed, and which way it has been going.
//

import Charts
import ClerkKit
import SwiftUI

@MainActor
@Observable
final class NetWorthModel {
    enum State {
        case loading
        case loaded(NetWorthResponse)
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
            state = .loaded(try await client.netWorth(months: months))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}

struct NetWorthView: View {
    @State private var model = NetWorthModel()

    var body: some View {
        NavigationStack {
            Group {
                switch model.state {
                case .loading:
                    ProgressView("Loading…")

                case .failed(let message):
                    ContentUnavailableView {
                        Label("Could not load net worth", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Try again") { Task { await model.load() } }
                            .buttonStyle(.borderedProminent)
                    }

                case .loaded(let data):
                    if data.series.isEmpty {
                        ContentUnavailableView(
                            "Nothing to value yet",
                            systemImage: "building.columns",
                            description: Text("Link an account and its balances will appear here.")
                        )
                    } else {
                        content(data)
                    }
                }
            }
            .navigationTitle("Net Worth")
            .refreshable { await model.load() }
        }
        .tint(Theme.accent)
        .task { await model.load() }
    }

    private func content(_ data: NetWorthResponse) -> some View {
        ScrollView {
            VStack(spacing: Theme.sectionGap) {
                Picker("Months", selection: Bindable(model).months) {
                    Text("6").tag(6)
                    Text("12").tag(12)
                    Text("24").tag(24)
                }
                .pickerStyle(.segmented)
                .onChange(of: model.months) { Task { await model.load() } }

                HeadlineCard(data: data)
                NetWorthChart(series: data.series)

                if data.credit.limit > 0 {
                    CreditCard(credit: data.credit)
                }

                GroupCard(title: "By kind", rows: data.byClass)
                GroupCard(title: "By institution", rows: data.byInstitution)

                // Balances are reconstructed backwards from transactions. An
                // account with no history is held flat, and a chart that mixes
                // the two without saying so presents an assumption as a record.
                if !data.coverage.exact {
                    Label(
                        "\(data.coverage.heldFlat) account\(data.coverage.heldFlat == 1 ? " has" : "s have") no history, so \(data.coverage.heldFlat == 1 ? "its balance is" : "their balances are") held flat across the chart.",
                        systemImage: "info.circle"
                    )
                    .font(Theme.note)
                    .foregroundStyle(Theme.quietText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding()
        }
        .background(Theme.background)
    }
}

private struct HeadlineCard: View {
    let data: NetWorthResponse

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Net worth")
                        .font(Theme.body)
                        .foregroundStyle(Theme.quietText)

                    Text(data.totals.netWorth.asMoney)
                        .font(Theme.figure(36))
                        .monospacedDigit()
                        .foregroundStyle(Theme.tint(forNet: data.totals.netWorth))
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)

                    HStack(spacing: 4) {
                        Image(systemName: data.change.netWorth >= 0 ? "arrow.up" : "arrow.down")
                            .font(.system(size: 10, weight: .bold))
                        Text(abs(data.change.netWorth).asMoney).monospacedDigit()
                        Text("since \(data.opening.label)")
                            .foregroundStyle(Theme.quietText)
                    }
                    .font(Theme.note)
                    .foregroundStyle(data.change.netWorth >= 0 ? Theme.positive : Theme.negative)
                }

                HStack(spacing: 0) {
                    figure("Assets", data.totals.assets, Theme.positive)
                    Divider().frame(height: 34)
                    figure("Liabilities", data.totals.liabilities, Theme.negative)
                    Divider().frame(height: 34)
                    // Reachable this week. A house is an asset and is not this.
                    figure("Liquid", data.totals.liquid, Theme.text)
                }
            }
        }
    }

    private func figure(_ label: String, _ cents: Int, _ tint: Color) -> some View {
        VStack(spacing: 2) {
            Text(label).font(Theme.tileLabel).foregroundStyle(Theme.quietText)
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

private struct NetWorthChart: View {
    let series: [NetWorthResponse.Point]

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                Text("Over time")
                    .font(Theme.tileLabel)
                    .foregroundStyle(Theme.quietText)

                Chart(series) { p in
                    AreaMark(
                        x: .value("Month", p.month),
                        y: .value("Net worth", Double(p.netWorth) / 100)
                    )
                    .foregroundStyle(Theme.accent.opacity(0.16))

                    LineMark(
                        x: .value("Month", p.month),
                        y: .value("Net worth", Double(p.netWorth) / 100)
                    )
                    .foregroundStyle(Theme.accent)
                    .interpolationMethod(.monotone)
                }
                // Labelled sparsely: twelve month names across a phone overlap
                // into an unreadable band, and the shape is the point here.
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 4)) { value in
                        AxisGridLine()
                        AxisValueLabel {
                            if let m = value.as(String.self) {
                                Text(m.suffix(2))
                            }
                        }
                    }
                }
                .chartYAxis { AxisMarks(format: .currency(code: "USD").precision(.fractionLength(0))) }
                .frame(height: 200)
            }
        }
    }
}

private struct CreditCard: View {
    let credit: NetWorthResponse.Credit

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Credit used")
                        .font(Theme.tileLabel)
                        .foregroundStyle(Theme.quietText)
                    Spacer()
                    if let u = credit.utilisation {
                        Text((u * 100).formatted(.number.precision(.fractionLength(0))) + "%")
                            .font(Theme.note)
                            .monospacedDigit()
                            // Thirty per cent is the conventional line at which
                            // utilisation starts to be read as a signal.
                            .foregroundStyle(u > 0.3 ? Theme.caution : Theme.positive)
                    }
                }

                ProportionBar(label: "of \(credit.limit.asShortMoney) limit",
                              amount: credit.used,
                              fallbackScale: credit.limit,
                              tint: credit.utilisation.map { $0 > 0.3 } == true
                                    ? Theme.caution : Theme.positive,
                              verb: "used")
            }
        }
    }
}

private struct GroupCard: View {
    let title: String
    let rows: [NetWorthResponse.Group]

    var body: some View {
        if rows.isEmpty {
            EmptyView()
        } else {
            Card {
                VStack(alignment: .leading, spacing: 10) {
                    Text(title)
                        .font(Theme.tileLabel)
                        .foregroundStyle(Theme.quietText)

                    ForEach(rows) { r in
                        HStack {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(r.label).font(Theme.body).lineLimit(1)
                                Text("\(r.accounts) account\(r.accounts == 1 ? "" : "s")")
                                    .font(.caption2)
                                    .foregroundStyle(Theme.quietText)
                            }
                            Spacer(minLength: 8)
                            Text(r.net.asMoney)
                                .font(Theme.body)
                                .monospacedDigit()
                                .foregroundStyle(Theme.tint(forNet: r.net))
                        }
                    }
                }
            }
        }
    }
}
