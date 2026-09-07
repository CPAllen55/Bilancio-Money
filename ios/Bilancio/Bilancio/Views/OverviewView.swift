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

    /// `YYYY-MM`, or nil for the month in progress.
    var month: String?
    /// How many months back from the chosen one to include, that one included.
    var trailing: Int = 1

    /// The last twelve months, newest first.
    var months: [String] {
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

    var chosenMonth: String { month ?? months.first ?? "" }

    /// One month is `month:`; several is a `span:` ending at the one chosen.
    ///
    /// Derived rather than stored, so the two controls cannot drift out of
    /// step with the window actually being fetched.
    var range: SummaryRange {
        let end = chosenMonth
        guard trailing > 1, let i = months.firstIndex(of: end),
              months.indices.contains(i + trailing - 1)
        else { return .month(end) }
        return .span(from: months[i + trailing - 1], to: end)
    }

    /// What a drill-down calls the window it inherits.
    var periodLabel: String {
        trailing > 1
            ? "\(trailing) months to \(Self.monthName(chosenMonth))"
            : Self.monthName(chosenMonth)
    }

    static func monthName(_ ym: String) -> String {
        let parts = ym.split(separator: "-")
        guard parts.count == 2, let m = Int(parts[1]), (1...12).contains(m) else { return ym }
        let names = ["January","February","March","April","May","June",
                     "July","August","September","October","November","December"]
        return "\(names[m - 1]) \(parts[0])"
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
                // Bound to the resolved month rather than the optional behind
                // it: with a nil selection no option carries a matching tag and
                // the menu renders with no label at all — a bare chevron in the
                // corner, which is a control nobody can find.
                Picker("Month", selection: Binding(
                    get: { model.chosenMonth },
                    set: { model.month = $0; Task { await model.load() } }
                )) {
                    ForEach(model.months, id: \.self) { m in
                        Text(OverviewModel.monthName(m)).tag(m)
                    }
                }
                .pickerStyle(.menu)
                .frame(maxWidth: .infinity, alignment: .leading)

                Picker("Trailing", selection: Bindable(model).trailing) {
                    Text("1 month").tag(1)
                    Text("3 months").tag(3)
                    Text("6 months").tag(6)
                    Text("12 months").tag(12)
                }
                .pickerStyle(.segmented)
                .onChange(of: model.trailing) { Task { await model.load() } }

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
                                          periodLabel: model.periodLabel)
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

    /// Whether the window has actually finished, from its own end date rather
    /// than from a day count.
    ///
    /// safeToSpend cannot answer this for every range. A span reports
    /// `daysElapsed == daysInPeriod` by construction — months × 30 for both —
    /// because a span is normally historical, so "days left" is zero even for
    /// one ending in the month currently running. Trusting that produced "This
    /// period is complete." over a September that had three weeks to go.
    ///
    /// ISO dates compare correctly as strings, which is the whole reason the
    /// API speaks them.
    private var periodEnded: Bool {
        let today = Date().formatted(.iso8601.year().month().day()
            .dateSeparator(.dash).dateTimeSeparator(.space))
        return summary.range.end < String(today.prefix(10))
    }

    /// A finished period gets no daily rate: there are no days left to spread
    /// anything over, and "about $40 a day for the 0 days left" is what
    /// arithmetic says rather than what a person would.
    private var subline: String {
        let safe = summary.safeToSpend
        if periodEnded { return "This period is complete." }

        // Still running, but with no usable day count — a span, where the
        // Worker does not track one. Say the true half and leave out the
        // clause it cannot support.
        guard safe.daysLeft > 0 else {
            return overspent
                ? "\((-net).asMoney) more out than in so far."
                : "\(net.asMoney) kept so far."
        }

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
