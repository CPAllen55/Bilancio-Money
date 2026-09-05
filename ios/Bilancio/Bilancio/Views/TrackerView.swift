//
//  TrackerView.swift
//  Bilancio
//
//  Against the plan: how much of each budget has gone.
//
//  The bar answers one question — is this past its budget — and a question with
//  two answers gets two colours. Green within, red past it, and a narrow amber
//  band before the line, because green straight to red says "fine" right up
//  until it says "too late", and the one moment a budget is useful is the
//  moment before it runs out.
//
//  The category's own colour goes in the swatch beside its name, never in the
//  bar. A magenta bar on Travel and a bottle-green one on Auto read as "red"
//  and "a different green" to anyone scanning the column, because that is what
//  a bar of that colour means on every other row.
//

import ClerkKit
import SwiftUI

@MainActor
@Observable
final class TrackerModel {
    enum State {
        case loading
        case loaded(SummaryResponse)
        case failed(String)
    }

    private(set) var state: State = .loading

    /// `YYYY-MM`, or nil for the month in progress.
    var month: String?
    /// How many months back from the chosen one to include, that one included.
    var trailing: Int = 1

    private let client = APIClient(baseURL: Bilancio.apiBaseURL) {
        guard let session = Clerk.shared.session else { return nil }
        return try await session.getToken()
    }

    /// The twelve months up to now, newest first.
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
    private var range: SummaryRange {
        let end = chosenMonth
        guard trailing > 1, let i = months.firstIndex(of: end),
              months.indices.contains(i + trailing - 1)
        else { return .month(end) }
        return .span(from: months[i + trailing - 1], to: end)
    }

    func load() async {
        do { state = .loaded(try await client.summary(range: range)) }
        catch { state = .failed(error.localizedDescription) }
    }
}

struct TrackerView: View {
    @State private var model = TrackerModel()

    var body: some View {
        NavigationStack {
            Group {
                switch model.state {
                case .loading:
                    ProgressView("Loading…")

                case .failed(let message):
                    ContentUnavailableView {
                        Label("Could not load the tracker", systemImage: "exclamationmark.triangle")
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
            .navigationTitle("Against the plan")
            .owlMark()
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        BudgetingView(embedded: true)
                    } label: {
                        Label("Edit the plan", systemImage: "slider.horizontal.3")
                    }
                }
            }
            .refreshable { await model.load() }
        }
        .tint(Theme.accent)
        .task { await model.load() }
    }

    private func content(_ data: SummaryResponse) -> some View {
        let categories = Dictionary(
            uniqueKeysWithValues: data.categoryList.map { ($0.slug, $0) }
        )
        let actual = data.totals.byParent ?? [:]
        let planned = data.budget?.byParent ?? [:]

        // Ordered by what it cost, because the question here is where the money
        // went. Income is pinned above rather than sorted in: it is not
        // competing in that ordering and would move around inside it as the
        // months changed, which is the opposite of what a fixed reference is for.
        let rows = Set(actual.keys).union(planned.keys)
            .compactMap { slug -> (TransactionsResponse.Category, Int, Int)? in
                let spent = actual[slug] ?? 0
                let plan = planned[slug] ?? 0
                guard spent > 0 || plan > 0, let cat = categories[slug] else { return nil }
                return (cat, spent, plan)
            }
            .sorted { $0.1 > $1.1 }

        return ScrollView {
            VStack(spacing: Theme.gutter) {
                // Bound to the resolved month rather than the optional behind
                // it. With a nil selection no option carried a matching tag, so
                // the menu rendered with no label at all — a bare chevron in
                // the corner, which is a control nobody can find.
                Picker("Month", selection: Binding(
                    get: { model.chosenMonth },
                    set: { model.month = $0; Task { await model.load() } }
                )) {
                    ForEach(model.months, id: \.self) { m in
                        Text(monthName(m)).tag(m)
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

                // Income first, and fixed there. "Against the plan" that showed
                // only what every category cost would say nothing about the
                // other half of the plan — a month can be inside every spending
                // budget it has and still be a bad month.
                if data.totals.income > 0 || (data.budget?.income ?? 0) > 0 {
                    TrackerCard(
                        label: "Income",
                        colour: categories["income"].map { Color(hex: $0.colour) } ?? Theme.positive,
                        actual: data.totals.income,
                        budget: data.budget?.available == true ? (data.budget?.income ?? 0) : 0,
                        isIncome: true
                    )
                }

                ForEach(rows, id: \.0.id) { cat, spent, plan in
                    TrackerCard(
                        label: cat.label,
                        colour: Color(hex: cat.colour),
                        actual: spent,
                        budget: data.budget?.available == true ? plan : 0,
                        isIncome: false
                    )
                }

                if rows.isEmpty && data.totals.income == 0 {
                    ContentUnavailableView(
                        "Nothing in this period",
                        systemImage: "tray",
                        description: Text("No spending or income was recorded.")
                    )
                    .padding(.top, 40)
                }
            }
            .padding()
        }
        .background(Theme.background)
    }

    private func monthName(_ ym: String) -> String {
        let parts = ym.split(separator: "-")
        guard parts.count == 2, let m = Int(parts[1]), (1...12).contains(m) else { return ym }
        let names = ["January","February","March","April","May","June",
                     "July","August","September","October","November","December"]
        return "\(names[m - 1]) \(parts[0])"
    }
}

// MARK: - One category against its budget

private struct TrackerCard: View {
    let label: String
    let colour: Color
    let actual: Int
    /// 0 when nothing is planned for this category.
    let budget: Int
    let isIncome: Bool

    /// The last twentieth of a budget gets its own colour.
    private static let nearBudget = 0.95

    private var hasBudget: Bool { budget > 0 }
    private var over: Bool { hasBudget && actual > budget }
    private var near: Bool {
        // Only spending can be "nearly at" a limit worth colouring. Arriving is
        // the point of income, and a bar turning amber at 95% of expected
        // earnings would be warning about good news.
        hasBudget && !isIncome && !over && Double(actual) >= Double(budget) * Self.nearBudget
    }

    /// Coral means "past a limit". Income has no limit to be past, so it stays
    /// mint however it lands.
    private var tone: Color {
        if over && !isIncome { return Theme.negative }
        if near { return Theme.caution }
        return Theme.positive
    }

    private var percent: Int {
        guard hasBudget else { return 0 }
        return Int((Double(actual) / Double(budget) * 100).rounded())
    }

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: 8) {
                    // Identity belongs next to the label, not inside the
                    // measurement.
                    RoundedRectangle(cornerRadius: 2)
                        .fill(colour)
                        .frame(width: 10, height: 10)

                    Text(label).font(Theme.body).lineLimit(1)

                    Spacer(minLength: 8)

                    Text(verdict)
                        .font(Theme.note)
                        .monospacedDigit()
                        .foregroundStyle(verdictTint)
                        .lineLimit(1)
                }

                HStack(spacing: 10) {
                    ProportionBar(
                        label: "",
                        amount: actual,
                        planned: budget,
                        fallbackScale: actual,
                        tint: tone,
                        verb: isIncome ? "earned" : "spent"
                    )

                    if hasBudget {
                        Text("\(percent)%")
                            .font(Theme.note)
                            .monospacedDigit()
                            .foregroundStyle(tone)
                            .frame(width: 44, alignment: .trailing)
                    }
                }
            }
        }
    }

    /// Income past its plan is the good case, so "above plan" is not a warning
    /// and "to go" is not a shortfall — being partway through a month is
    /// neither, and takes plain ink.
    private var verdict: String {
        guard hasBudget else { return "no budget yet" }
        let gap = abs(actual - budget).asMoney
        if isIncome { return over ? "\(gap) above plan" : "\(gap) to go" }
        return over ? "\(gap) over" : "\(gap) left"
    }

    private var verdictTint: Color {
        guard hasBudget else { return Theme.quietText }
        if isIncome { return over ? Theme.positive : Theme.quietText }
        return tone
    }
}
