//
//  OverviewView.swift
//  Bilancio
//
//  Where things stand — the first screen, and the one that has to answer the
//  whole question before anything else is read.
//
//  Two figures lead it, and they are the same figure twice: what the period
//  actually came to, and what it was supposed to. Each is measured against the
//  other and against the period before, so three of the four comparisons a
//  person makes are already made. Everything below is the working.
//
//  The headline is totals.net. It is NOT safeToSpend.remaining, which is
//  floored at zero and so reads a month that spent more than it earned as 0
//  rather than as a loss — the web app's headline had that bug and had to be
//  changed. See docs/ios-app-api.md.
//

import ClerkKit
import SwiftUI

@MainActor
@Observable
final class OverviewModel {
    enum State {
        case loading
        case loaded(SummaryResponse)
        case failed(String)
    }

    private(set) var state: State = .loading
    /// Kept apart from the summary because it is decoration: the screen is
    /// complete without it, and a failure to fetch it must not empty the page.
    private(set) var sparklines: TrendResponse.Sparklines?

    var range: SummaryRange = .thisMonth

    /// The last twelve months, newest first, for the period menu.
    var recentMonths: [String] {
        let cal = Calendar(identifier: .gregorian)
        var out: [String] = []
        var date = Date()
        for _ in 0..<12 {
            let c = cal.dateComponents([.year, .month], from: date)
            if let y = c.year, let m = c.month {
                out.append(String(format: "%04d-%02d", y, m))
            }
            date = cal.date(byAdding: .month, value: -1, to: date) ?? date
        }
        return out
    }

    private let client = APIClient(baseURL: Bilancio.apiBaseURL) {
        // Optional-chaining `session?.getToken()` would give a String?? here,
        // and a nil session is a different thing from a session that returned
        // no token, so the two are unwrapped separately.
        guard let session = Clerk.shared.session else { return nil }
        return try await session.getToken()
    }

    func load() async {
        do {
            state = .loaded(try await client.summary(range: range))
        } catch {
            state = .failed(error.localizedDescription)
            return
        }
        // After the figures, and never in their way.
        sparklines = try? await client.trend().sparklines
    }
}

struct OverviewView: View {
    @Environment(Clerk.self) private var clerk
    @State private var model = OverviewModel()

    var body: some View {
        NavigationStack {
            Group {
                switch model.state {
                case .loading:
                    ProgressView("Loading…")

                case .failed(let message):
                    ContentUnavailableView {
                        Label("Could not load the summary", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Try again") { Task { await model.load() } }
                            .buttonStyle(.borderedProminent)
                    }

                case .loaded(let summary):
                    content(summary)
                }
            }
            .navigationTitle("Overview")
            .owlMark()
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    // Banks is where sign-out lives too. Both are about the
                    // account rather than about the money, and a destructive
                    // action sitting permanently beside the figures is one
                    // mis-tap from a sign-out nobody wanted.
                    NavigationLink {
                        BanksView()
                    } label: {
                        Label("Banks", systemImage: "building.columns")
                    }
                }
            }
            .refreshable { await model.load() }
        }
        .tint(Theme.accent)
        .task { await model.load() }
    }

    private func content(_ s: SummaryResponse) -> some View {
        ScrollView {
            VStack(spacing: Theme.sectionGap) {
                PeriodMenu(range: Bindable(model).range,
                           months: model.recentMonths) {
                    Task { await model.load() }
                }

                HeadlineCard(summary: s, spark: model.sparklines?.net)
                PlanCard(summary: s)

                // Nothing linked is not an error, but it is the one state where
                // the whole screen is zeros and the only useful thing on it is
                // the way out.
                if s.accountsCounted == 0 {
                    Card {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("No banks connected yet")
                                .font(Theme.body)
                            Text("Every figure here is zero until an account is linked.")
                                .font(Theme.note)
                                .foregroundStyle(Theme.quietText)
                            ConnectBankButton(onConnected: { Task { await model.load() } })
                                .padding(.top, 2)
                        }
                    }
                } else {
                    AgainstThePlanSection(data: s,
                                          range: model.range,
                                          periodLabel: s.range.label)
                }

                if let note = budgetNote(s.budget) {
                    Text(note)
                        .font(Theme.note)
                        .foregroundStyle(Theme.quietText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding()
        }
        .background(Theme.background)
    }

    private func budgetNote(_ b: SummaryResponse.Budget?) -> String? {
        guard let b else { return nil }
        guard b.available else {
            return "Not enough history yet to say what this period should have cost."
        }
        guard let months = b.monthsOfHistory else { return nil }
        return "The plan is shaped from \(months) month\(months == 1 ? "" : "s") of history."
    }
}

// MARK: - What the period came to

/// Net Balance: the answer, and the two things worth measuring it against.
private struct HeadlineCard: View {
    let summary: SummaryResponse
    let spark: [Int]?

    private var net: Int { summary.totals.net }
    private var overspent: Bool { net < 0 }

    /// Absent rather than zero when there is no plan. A budgeted net of nothing
    /// is the absence of a plan, not a plan to break even, and comparing
    /// against it would invent a target.
    private var plannedNet: Int? {
        guard let b = summary.budget, b.available, b.income > 0 || b.expense > 0 else { return nil }
        return b.net
    }

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Net Balance")
                        .font(Theme.tileLabel)
                        .foregroundStyle(Theme.quietText)

                    Text(summary.range.label)
                        .font(Theme.note)
                        .foregroundStyle(Theme.quietText)

                    // The sign is kept and the colour follows it, rather than
                    // the figure being made absolute and the meaning moved into
                    // a word beside it.
                    Text(net.asMoney)
                        .font(Theme.figure(46))
                        .monospacedDigit()
                        .foregroundStyle(Theme.tint(forNet: net))
                        .lineLimit(1)
                        .minimumScaleFactor(0.4)

                    Text(subline)
                        .font(Theme.body)
                        .foregroundStyle(Theme.quietText)
                }

                if let spark, spark.contains(where: { $0 != 0 }) {
                    Sparkline(values: spark)
                        .stroke(Theme.tint(forNet: net),
                                style: .init(lineWidth: 2, lineCap: .round, lineJoin: .round))
                        .frame(height: 30)
                }

                Divider()

                HStack(spacing: 0) {
                    Metric(caption: "vs budget",
                           value: plannedNet.map { net - $0 },
                           betterWhen: .up,
                           empty: "no plan yet")
                    Divider().frame(height: 38)
                    Metric(caption: "vs \(summary.comparison.label.lowercased())",
                           value: net - summary.previous.net,
                           betterWhen: .up)
                }

                // Both bars, and both marks, on the scale each deserves — see
                // ProportionBar for why a bar with a plan runs to its own.
                let noPlanScale = max(summary.totals.income, summary.totals.expense)
                VStack(spacing: 12) {
                    ProportionBar(label: "Income", amount: summary.totals.income,
                                  planned: plannedIncome, fallbackScale: noPlanScale,
                                  tint: Theme.incomeTint, verb: "earned")
                    ProportionBar(label: "Expenses", amount: summary.totals.expense,
                                  planned: plannedExpense, fallbackScale: noPlanScale,
                                  tint: Theme.expenseTint, verb: "spent")
                }
            }
        }
    }

    /// 0 rather than nil for "no plan", which is how the Worker guards it too.
    private var plannedIncome: Int { max(0, summary.budget?.income ?? 0) }
    private var plannedExpense: Int { max(0, summary.budget?.expense ?? 0) }

    /// A finished period gets no daily rate: there are no days left to spread
    /// anything over, and "about $40 a day for the 0 days left" is what
    /// arithmetic says rather than what a person would.
    private var subline: String {
        let safe = summary.safeToSpend
        if safe.daysLeft <= 0 { return "This period is complete." }
        if overspent {
            return "\((-net).asMoney) more out than in, with \(safe.daysLeft) day\(safe.daysLeft == 1 ? "" : "s") still to go."
        }
        return "About \(safe.perDay.asMoney) a day for the \(safe.daysLeft) day\(safe.daysLeft == 1 ? "" : "s") left."
    }
}

// MARK: - What it was supposed to come to

/// Net Balance Budget: the same figure the plan expected, against what actually
/// happened and against the period before.
private struct PlanCard: View {
    let summary: SummaryResponse

    private var available: Bool {
        guard let b = summary.budget else { return false }
        return b.available && (b.income > 0 || b.expense > 0)
    }

    private var plannedNet: Int { summary.budget?.net ?? 0 }

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 14) {
                Text("Net Balance Budget")
                    .font(Theme.tileLabel)
                    .foregroundStyle(Theme.quietText)

                if available {
                    Text(plannedNet.asMoney)
                        .font(Theme.figure(32))
                        .monospacedDigit()
                        .foregroundStyle(Theme.tint(forNet: plannedNet))
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)

                    Divider()

                    HStack(spacing: 0) {
                        // The plan sitting above what actually happened means
                        // the period is behind it, which is the bad direction —
                        // so a positive gap here is not good news.
                        Metric(caption: "vs actual",
                               value: plannedNet - summary.totals.net,
                               betterWhen: .down)
                        Divider().frame(height: 38)
                        // Deliberately uncoloured. A plan above last period's
                        // actual is more ambitious, which is neither good nor
                        // bad without knowing why it moved.
                        Metric(caption: "vs \(summary.comparison.label.lowercased())",
                               value: plannedNet - summary.previous.net,
                               betterWhen: nil)
                    }
                } else {
                    Text("Not enough history yet to say what this period should have cost.")
                        .font(Theme.note)
                        .foregroundStyle(Theme.quietText)
                }
            }
        }
    }
}

// MARK: - One comparison

/// A difference, its direction, and whether that direction is good news.
///
/// `betterWhen` is optional because some comparisons genuinely have no better
/// direction, and colouring one anyway asserts a judgement the figure does not
/// support.
private struct Metric: View {
    let caption: String
    let value: Int?
    let betterWhen: BetterWhen?
    var empty: String = "—"

    private var tint: Color {
        guard let value, let betterWhen else { return Theme.text }
        if value == 0 { return Theme.quietText }
        return (betterWhen == .up ? value > 0 : value < 0) ? Theme.positive : Theme.negative
    }

    var body: some View {
        VStack(spacing: 3) {
            if let value {
                HStack(spacing: 3) {
                    if betterWhen != nil, value != 0 {
                        Image(systemName: value > 0 ? "arrow.up" : "arrow.down")
                            .font(.system(size: 10, weight: .bold))
                    }
                    Text(abs(value).asShortMoney)
                        .font(.system(.headline, design: .rounded))
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                }
                .foregroundStyle(tint)
            } else {
                Text(empty)
                    .font(.system(.headline, design: .rounded))
                    .foregroundStyle(Theme.quietText)
            }

            Text(caption)
                .font(Theme.tileLabel)
                .foregroundStyle(Theme.quietText)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity)
    }
}
