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

                StandingCard(summary: s)

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

// MARK: - Where things stand

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
                    // the figure being made absolute and the meaning moved into
                    // a word beside it.
                    Text(net.asMoney)
                        .font(Theme.figure(40))
                        .monospacedDigit()
                        .foregroundStyle(Theme.tint(forNet: net))
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)

                    Text(subline)
                        .font(Theme.body)
                        .foregroundStyle(Theme.quietText)
                }

                // Each bar runs to whichever is larger of its own figure and
                // its own plan, so passing the plan is what fills the track.
                // Only when neither has a plan do the two share a scale.
                let noPlanScale = max(summary.totals.income, summary.totals.expense)
                VStack(spacing: 12) {
                    ProportionBar(label: "Income", amount: summary.totals.income,
                                  planned: plannedIncome, fallbackScale: noPlanScale,
                                  tint: Theme.incomeTint, verb: "earned")
                    ProportionBar(label: "Expenses", amount: summary.totals.expense,
                                  planned: plannedExpense, fallbackScale: noPlanScale,
                                  tint: Theme.expenseTint, verb: "spent")
                }

                if let status = budgetStatus {
                    Label(status.text, systemImage: status.icon)
                        .font(Theme.note)
                        .foregroundStyle(status.tint)
                }
            }
        }
    }

    private var budget: SummaryResponse.Budget? {
        guard let b = summary.budget, b.available else { return nil }
        return b
    }

    /// 0 rather than nil for "no plan", which is how the Worker guards it too:
    /// a budget of zero is the absence of the information, not a plan to earn
    /// or spend nothing.
    private var plannedIncome: Int { max(0, budget?.income ?? 0) }
    private var plannedExpense: Int { max(0, budget?.expense ?? 0) }

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

    /// Reported against the budget, not against elapsed days.
    ///
    /// A straight-line pace assumes money leaves evenly and it does not — rent
    /// clears on the 1st, and an indicator that cries wolf for a week every
    /// month teaches people to ignore it. The budget is an actual limit with no
    /// prediction attached.
    private var budgetStatus: (text: String, icon: String, tint: Color)? {
        guard let b = budget, b.expense > 0 else { return nil }
        let over = summary.totals.expense - b.expense
        return over > 0
            ? ("\(over.asMoney) over budget", "exclamationmark.triangle.fill", Theme.negative)
            : ("\((-over).asMoney) left in budget", "checkmark.circle.fill", Theme.positive)
    }
}
