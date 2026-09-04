//
//  OverviewView.swift
//  Bilancio
//
//  Where things stand: this period at a glance, then the same four figures
//  twice over — against the period before, and against what the period was
//  expected to cost.
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
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Sign out") { Task { try? await clerk.auth.signOut() } }
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
                Picker("Period", selection: Bindable(model).range) {
                    ForEach(SummaryRange.allCases, id: \.self) { r in
                        Text(r.label).tag(r)
                    }
                }
                .pickerStyle(.segmented)
                .onChange(of: model.range) { Task { await model.load() } }

                StandingCard(summary: s)
                ActualTiles(summary: s, spark: model.sparklines)
                BudgetTiles(summary: s)

                if let note = budgetNote(s.budget) {
                    Text(note)
                        .font(Theme.note)
                        .foregroundStyle(Theme.quietText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                // Zero accounts is not zero spending. Without saying so, an
                // untouched install looks identical to a broken one.
                if s.accountsCounted == 0 {
                    Label(
                        "No bank accounts linked yet, so every figure here is zero.",
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

    private func budgetNote(_ b: SummaryResponse.Budget?) -> String? {
        guard let b else { return nil }
        guard b.available else {
            return "Not enough history yet to say what this period should have cost."
        }
        guard let months = b.monthsOfHistory else { return nil }
        return "Budget shaped from \(months) month\(months == 1 ? "" : "s") of history."
    }
}

// MARK: - The headline

/// The answer first: what was kept, or what was overspent, and the two figures
/// it is worked out from.
private struct StandingCard: View {
    let summary: SummaryResponse

    private var net: Int { summary.totals.net }
    private var overspent: Bool { net < 0 }

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(summary.range.label)
                        .font(Theme.body)
                        .foregroundStyle(Theme.quietText)

                    // The sign is kept and the colour follows it, rather than
                    // the figure being made absolute and the meaning moved
                    // into a word beside it.
                    Text(net.asMoney)
                        .font(Theme.figure(40))
                        .monospacedDigit()
                        .foregroundStyle(Theme.tint(forNet: net))
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)

                    Text(overspent ? "More went out than came in" : "Kept")
                        .font(Theme.body)
                        .foregroundStyle(Theme.quietText)
                }

                // Both bars are drawn against the larger of the two, so their
                // lengths can be compared with each other rather than each
                // filling its own row and looking equal.
                let scale = max(summary.totals.income, summary.totals.expense)
                VStack(spacing: 10) {
                    ProportionBar(label: "Money in", amount: summary.totals.income,
                                  of: scale, tint: Theme.incomeTint)
                    ProportionBar(label: "Money out", amount: summary.totals.expense,
                                  of: scale, tint: Theme.expenseTint)
                }

                if let status = budgetStatus {
                    Label(status.text, systemImage: status.icon)
                        .font(Theme.note)
                        .foregroundStyle(status.tint)
                }
            }
        }
    }

    /// Reported against the budget, not against elapsed days.
    ///
    /// A straight-line pace assumes money leaves evenly and it does not — rent
    /// clears on the 1st, and an indicator that cries wolf for a week every
    /// month teaches people to ignore it. The budget is an actual limit with no
    /// prediction attached.
    private var budgetStatus: (text: String, icon: String, tint: Color)? {
        guard let b = summary.budget, b.available, b.expense > 0 else { return nil }
        let over = summary.totals.expense - b.expense
        return over > 0
            ? ("\(over.asMoney) over budget", "exclamationmark.triangle.fill", Theme.negative)
            : ("\((-over).asMoney) left in budget", "checkmark.circle.fill", Theme.positive)
    }
}

// MARK: - The four figures

/// In the order the ledger reads: what came in, what went out, what is left,
/// and what that is as a share.
private struct ActualTiles: View {
    let summary: SummaryResponse
    let spark: TrendResponse.Sparklines?

    var body: some View {
        let t = summary.totals
        let p = summary.previous

        VStack(alignment: .leading, spacing: 8) {
        Text("Compared with \(summary.comparison.label.lowercased())")
            .font(Theme.tileLabel)
            .foregroundStyle(Theme.quietText)
            .frame(maxWidth: .infinity, alignment: .leading)

        LazyVGrid(columns: [GridItem(.flexible(), spacing: Theme.gutter),
                            GridItem(.flexible(), spacing: Theme.gutter)],
                  spacing: Theme.gutter) {

            StatTile(label: "Income", value: t.income.asShortMoney,
                     comparison: .init(current: t.income, against: p.income,
                                       betterWhen: .up),
                     spark: spark?.income, sparkTint: Theme.incomeTint)

            StatTile(label: "Expenses", value: t.expense.asShortMoney,
                     comparison: .init(current: t.expense, against: p.expense,
                                       betterWhen: .down),
                     spark: spark?.expense, sparkTint: Theme.expenseTint)

            StatTile(label: "Net Balance", value: t.net.asShortMoney,
                     comparison: .init(current: t.net, against: p.net,
                                       betterWhen: .up),
                     spark: spark?.net, sparkTint: Theme.tint(forNet: t.net))

            StatTile(label: "Net Balance Rate",
                     value: t.savingsRate.map { $0.formatted(.number.precision(.fractionLength(1))) + "%" } ?? "—",
                     comparison: rateComparison,
                     emptyNote: t.income > 0 ? nil : "no income recorded")
        }
        }
    }

    /// Percentages are compared in tenths of a point, so they are carried as
    /// such and divided back out for display. Comparison speaks in integers
    /// because everything else it measures is cents.
    private var rateComparison: Comparison? {
        guard let now = summary.totals.savingsRate,
              let before = summary.previous.savingsRate else { return nil }
        return .init(current: Int((now * 10).rounded()),
                     against: Int((before * 10).rounded()),
                     betterWhen: .up)
    }
}

// MARK: - The same four, against the plan

/// Same order as the row above, and it has to stay that way: the two grids
/// read as one four-column table, each figure sitting under what it was
/// planned to be.
private struct BudgetTiles: View {
    let summary: SummaryResponse

    var body: some View {
        let b = summary.budget
        let t = summary.totals
        let available = b?.available ?? false

        // Three of the four need income to mean anything, and income only
        // exists if an account that receives it is linked. With cards alone the
        // honest answer is a dash: a budgeted income of $0 is not a plan to
        // earn nothing, it is the absence of the information.
        let haveIn = available && (b?.income ?? 0) > 0
        let haveOut = available && (b?.expense ?? 0) > 0
        let noHistory = available ? "nothing to compare" : "not enough history"

        VStack(alignment: .leading, spacing: 8) {
            Text("Against plan")
                .font(Theme.tileLabel)
                .foregroundStyle(Theme.quietText)
                .frame(maxWidth: .infinity, alignment: .leading)

            LazyVGrid(columns: [GridItem(.flexible(), spacing: Theme.gutter),
                                GridItem(.flexible(), spacing: Theme.gutter)],
                      spacing: Theme.gutter) {

                StatTile(label: "Income · budget",
                         value: haveIn ? (b?.income ?? 0).asShortMoney : "—",
                         comparison: haveIn ? .init(current: b?.income ?? 0, against: t.income,
                                                    betterWhen: .down, show: .amount) : nil,
                         emptyNote: haveIn ? nil : (available ? "no income linked" : noHistory))

                StatTile(label: "Expenses · budget",
                         value: haveOut ? (b?.expense ?? 0).asShortMoney : "—",
                         comparison: haveOut ? .init(current: b?.expense ?? 0, against: t.expense,
                                                     betterWhen: .up, show: .amount) : nil,
                         emptyNote: haveOut ? nil : noHistory)

                StatTile(label: "Net · budget",
                         value: haveIn ? (b?.net ?? 0).asShortMoney : "—",
                         comparison: haveIn ? .init(current: b?.net ?? 0, against: t.net,
                                                    betterWhen: .down, show: .amount) : nil,
                         emptyNote: haveIn ? nil : noHistory)

                StatTile(label: "Rate · budget",
                         value: (haveIn ? b?.savingsRate : nil)
                            .map { $0.formatted(.number.precision(.fractionLength(1))) + "%" } ?? "—",
                         emptyNote: haveIn ? nil : noHistory)
            }
        }
    }
}
