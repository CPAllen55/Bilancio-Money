//
//  CategoryMonthView.swift
//  Bilancio
//
//  One category, one month, and the transactions behind the bar.
//
//  This is the drill-down the Trend chart exists to lead to: a stack says
//  Groceries was heavy in February, and the only useful next question is which
//  rows made it heavy.
//

import Charts
import ClerkKit
import SwiftUI

@MainActor
@Observable
final class CategoryMonthModel {
    enum State { case loading, loaded(TransactionsResponse), failed(String) }
    private(set) var state: State = .loading

    let slug: String
    /// Any range the API understands, not just a single month — the Tracker
    /// can be showing several months trailing, and a drill-down that silently
    /// narrowed to one of them would not add up to the bar it came from.
    let range: SummaryRange

    private let client = APIClient(baseURL: Bilancio.apiBaseURL) {
        guard let session = Clerk.shared.session else { return nil }
        return try await session.getToken()
    }

    init(slug: String, range: SummaryRange) {
        self.slug = slug
        self.range = range
    }

    func load() async {
        do {
            // `bucket` is the drill-down the Worker already understands, so the
            // filtering happens where the category is resolved rather than here
            // against rows that have already been paged.
            state = .loaded(try await client.transactions(
                range: range, bucket: slug, limit: 200
            ))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}

struct CategoryMonthView: View {
    @State private var model: CategoryMonthModel
    @State private var editing: TransactionsResponse.Row?
    let title: String
    let monthLabel: String

    init(slug: String, range: SummaryRange, title: String, monthLabel: String) {
        _model = State(initialValue: CategoryMonthModel(slug: slug, range: range))
        self.title = title
        self.monthLabel = monthLabel
    }

    var body: some View {
        Group {
            switch model.state {
            case .loading:
                ProgressView("Loading…")

            case .failed(let message):
                ContentUnavailableView {
                    Label("Could not load transactions", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try again") { Task { await model.load() } }
                        .buttonStyle(.borderedProminent)
                }

            case .loaded(let data):
                if data.transactions.isEmpty {
                    ContentUnavailableView(
                        "Nothing here",
                        systemImage: "tray",
                        description: Text("No \(title.lowercased()) was recorded in \(monthLabel).")
                    )
                } else {
                    content(data)
                }
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.load() }
        .task { await model.load() }
        .sheet(item: $editing) { row in
            SplitTransactionView(row: row, categories: categories) {
                Task { await model.load() }
            }
        }
    }

    private var categories: [TransactionsResponse.Category] {
        if case .loaded(let data) = model.state { return data.categories }
        return []
    }

    private func content(_ data: TransactionsResponse) -> some View {
        let byslug = Dictionary(uniqueKeysWithValues: data.categories.map { ($0.slug, $0) })

        return ScrollView {
            VStack(spacing: Theme.sectionGap) {
                Card {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(monthLabel)
                            .font(Theme.tileLabel)
                            .foregroundStyle(Theme.quietText)
                        Text(data.sum.out.asMoney)
                            .font(Theme.figure(30))
                            .monospacedDigit()
                            .lineLimit(1)
                            .minimumScaleFactor(0.6)
                        Text("\(data.total) transaction\(data.total == 1 ? "" : "s")")
                            .font(Theme.note)
                            .foregroundStyle(Theme.quietText)
                    }
                }

                // Filtered to a bucket, so the Worker returns the merchant
                // rollup over the whole set rather than the empty list it sends
                // for an unbucketed page.
                if !data.vendors.isEmpty {
                    VendorPie(vendors: data.vendors, total: data.sum.out)
                }

                Card(padding: 0) {
                    VStack(spacing: 0) {
                        ForEach(Array(data.transactions.enumerated()), id: \.element.id) { i, row in
                            Button {
                                editing = row
                            } label: {
                                LedgerRow(row: row, category: row.category.flatMap { byslug[$0] })
                            }
                            .buttonStyle(.plain)

                            if i < data.transactions.count - 1 {
                                Divider().padding(.leading, 14)
                            }
                        }
                    }
                }
            }
            .padding()
        }
        .background(Theme.background)
    }
}

// MARK: - Who it went to

/// Vendors inside one category and one month, as a share of the whole.
///
/// A donut rather than a bar list because the question this screen opens on is
/// proportion — was this month one big charge or forty small ones — and that is
/// the one question a pie answers better than a list. The list is underneath
/// anyway, because a pie cannot carry six exact figures.
private struct VendorPie: View {
    let vendors: [TransactionsResponse.Vendor]
    /// The category's own total for the month, so the middle of the ring agrees
    /// with the headline above it rather than with the sum of the slices drawn.
    let total: Int

    @State private var selectedAngle: Double?

    private var selected: Slice? { slice(at: selectedAngle) }

    /// Six named, then a remainder.
    ///
    /// Beyond about six the slices are thinner than their own borders and the
    /// legend is longer than the chart. The rest is one grey wedge, which is
    /// honest — "and forty others" is a real answer to where the money went.
    private static let named = 6

    private struct Slice: Identifiable {
        let name: String
        let cents: Int
        let colour: Color
        let logo: String?
        let isRest: Bool
        var id: String { name }
    }

    private var slices: [Slice] {
        let sorted = vendors.sorted { $0.cents > $1.cents }
        let head = sorted.prefix(Self.named).enumerated().map { i, v in
            Slice(name: v.name, cents: v.cents,
                  colour: Theme.series[i % Theme.series.count],
                  logo: v.logo, isRest: false)
        }
        let restCents = sorted.dropFirst(Self.named).reduce(0) { $0 + $1.cents }
        guard restCents > 0 else { return head }
        let restCount = sorted.count - head.count
        return head + [Slice(name: "\(restCount) other\(restCount == 1 ? "" : "s")",
                             cents: restCents, colour: Theme.seriesRest,
                             logo: nil, isRest: true)]
    }

    private var drawn: Int { slices.reduce(0) { $0 + $1.cents } }

    /// Which slice an angle lands in.
    ///
    /// Swift Charts reports the selection as a position along the summed
    /// values rather than as the mark itself, so the slices are walked and
    /// accumulated until the total passes it. Same order they were drawn in,
    /// or the answer would point at a different wedge than the finger did.
    private func slice(at angle: Double?) -> Slice? {
        guard let angle, angle >= 0 else { return nil }
        var running = 0.0
        for slice in slices {
            running += Double(slice.cents) / 100
            if angle <= running { return slice }
        }
        return nil
    }

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 14) {
                Text("Who it went to")
                    .font(Theme.tileLabel)
                    .foregroundStyle(Theme.quietText)

                let parts = slices

                Chart(parts) { slice in
                    SectorMark(
                        angle: .value("Spend", Double(slice.cents) / 100),
                        innerRadius: .ratio(0.60),
                        // The chosen wedge stands slightly proud of the rest,
                        // which is the whole feedback that a tap landed — a
                        // colour change alone is invisible on the slice you are
                        // covering with a finger.
                        outerRadius: selected?.id == slice.id ? .ratio(1.0) : .ratio(0.92),
                        angularInset: 1.5
                    )
                    .cornerRadius(3)
                    .foregroundStyle(by: .value("Vendor", slice.name))
                    .opacity(selected == nil || selected?.id == slice.id ? 1 : 0.35)
                }
                // Stated, never inferred. A scale built from the order marks
                // arrive in gives the same vendor a different colour on every
                // launch — which is a bug this app has already had once.
                .chartForegroundStyleScale(
                    domain: parts.map(\.name),
                    range: parts.map(\.colour)
                )
                .chartLegend(.hidden)
                .chartAngleSelection(value: $selectedAngle)
                .frame(height: 190)
                .overlay { centre }
                .animation(.snappy(duration: 0.2), value: selected?.id)

                VStack(spacing: 8) {
                    ForEach(parts) { slice in
                        HStack(spacing: 9) {
                            if slice.isRest {
                                // No logo to show, and a monogram of "3 others"
                                // would be a letter that means nothing.
                                Circle().fill(slice.colour).frame(width: 10, height: 10)
                                    .frame(width: 26)
                            } else {
                                MerchantLogo(file: slice.logo, name: slice.name,
                                             size: 26, tint: slice.colour)
                            }

                            Text(slice.name)
                                .font(Theme.note)
                                .foregroundStyle(slice.isRest ? Theme.quietText : Theme.text)
                                .lineLimit(1)

                            Spacer(minLength: 8)

                            Text(share(slice))
                                .font(.caption2)
                                .monospacedDigit()
                                .foregroundStyle(Theme.quietText)
                                .frame(width: 40, alignment: .trailing)

                            Text(slice.cents.asShortMoney)
                                .font(Theme.note)
                                .monospacedDigit()
                        }
                    }
                }
            }
        }
    }

    /// Split out because the whole card was one expression the type checker
    /// would not finish, which it reports as a timeout rather than as a
    /// mistake — the fix is always to name a piece of it.
    private var centre: some View {
        let noun = vendors.count == 1 ? "merchant" : "merchants"
        return VStack(spacing: 1) {
            // The middle of a ring is the one place a detail can go without
            // covering the thing it describes, so the selection is shown there
            // rather than in a callout beside it.
            if let selected {
                Text(selected.name)
                    .font(.caption2)
                    .foregroundStyle(Theme.quietText)
                    .lineLimit(1)
                Text(selected.cents.asShortMoney)
                    .font(.system(.title3, design: .rounded).weight(.semibold))
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                Text(share(selected) + " of it")
                    .font(.caption2)
                    .foregroundStyle(Theme.quietText)
            } else {
                Text(total.asShortMoney)
                    .font(.system(.title3, design: .rounded).weight(.semibold))
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                Text("\(vendors.count) \(noun)")
                    .font(.caption2)
                    .foregroundStyle(Theme.quietText)
            }
        }
        .padding(.horizontal, 40)
    }

    /// Against what is drawn, not against the category total.
    ///
    /// Splits mean a transaction can sit partly in another category, so the
    /// vendor rollup for this bucket need not add up to the bucket's own total.
    /// Shares that do not sum to 100% on a pie look like an arithmetic error.
    private func share(_ slice: Slice) -> String {
        guard drawn > 0 else { return "" }
        let pct = Double(slice.cents) / Double(drawn) * 100
        return pct.formatted(.number.precision(.fractionLength(pct < 10 ? 1 : 0))) + "%"
    }
}
