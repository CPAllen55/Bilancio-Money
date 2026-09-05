//
//  TransactionsView.swift
//  Bilancio
//
//  The ledger: what actually went out, and to whom.
//

import ClerkKit
import SwiftUI

@MainActor
@Observable
final class TransactionsModel {
    enum State {
        case loading
        case loaded(TransactionsResponse)
        case failed(String)
    }

    private(set) var state: State = .loading
    var range: SummaryRange = .thisMonth

    private let client = APIClient(baseURL: Bilancio.apiBaseURL) {
        guard let session = Clerk.shared.session else { return nil }
        return try await session.getToken()
    }

    func load() async {
        do {
            state = .loaded(try await client.transactions(range: range))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}

struct TransactionsView: View {
    @State private var model = TransactionsModel()
    /// The row whose split editor is open. Held here rather than per row so
    /// only one sheet can ever exist.
    @State private var editing: TransactionsResponse.Row?

    var body: some View {
        NavigationStack {
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
                            "Nothing in this period",
                            systemImage: "tray",
                            description: Text("No transactions were recorded for \(model.range.label.lowercased()).")
                        )
                    } else {
                        list(data)
                    }
                }
            }
            .navigationTitle("Transactions")
            .owlMark()
            .refreshable { await model.load() }
        }
        .tint(Theme.accent)
        .task { await model.load() }
        .sheet(item: $editing) { row in
            SplitTransactionView(row: row, categories: allCategories) {
                Task { await model.load() }
            }
        }
    }

    /// The category tree arrives with every page of transactions, so the sheet
    /// reads it from whatever is already loaded rather than fetching its own.
    private var allCategories: [TransactionsResponse.Category] {
        if case .loaded(let data) = model.state { return data.categories }
        return []
    }

    private func list(_ data: TransactionsResponse) -> some View {
        // Slug to label and colour, built once rather than searched per row.
        let byslug = Dictionary(uniqueKeysWithValues: data.categories.map { ($0.slug, $0) })

        return ScrollView {
            VStack(spacing: Theme.sectionGap) {
                Picker("Period", selection: Bindable(model).range) {
                    ForEach(SummaryRange.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .onChange(of: model.range) { Task { await model.load() } }

                SumCard(sum: data.sum, count: data.total, shown: data.transactions.count)

                if !data.vendors.isEmpty {
                    VendorCard(vendors: Array(data.vendors.prefix(5)))
                }

                LedgerCard(rows: data.transactions, categories: byslug, editing: $editing)
            }
            .padding()
        }
        .background(Theme.background)
    }
}

// MARK: - What the period came to

private struct SumCard: View {
    let sum: TransactionsResponse.Sum
    let count: Int
    let shown: Int

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 0) {
                    figure("In", sum.in, Theme.incomeTint)
                    Divider().frame(height: 34)
                    figure("Out", sum.out, Theme.expenseTint)
                    Divider().frame(height: 34)
                    figure("Net", sum.net, Theme.tint(forNet: sum.net))
                }

                // The page is capped, and a count that silently means "the
                // first hundred" is worse than no count at all.
                Text(shown < count
                     ? "Showing \(shown) of \(count) transactions"
                     : "\(count) transaction\(count == 1 ? "" : "s")")
                    .font(Theme.note)
                    .foregroundStyle(Theme.quietText)
            }
        }
    }

    private func figure(_ label: String, _ cents: Int, _ tint: Color) -> some View {
        VStack(spacing: 2) {
            Text(label)
                .font(Theme.tileLabel)
                .foregroundStyle(Theme.quietText)
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

// MARK: - Where it went

/// Built from `vendors`, which the Worker rolls up over the whole filtered set
/// rather than the page — grouping the rows on screen would only ever describe
/// the first hundred of them.
private struct VendorCard: View {
    let vendors: [TransactionsResponse.Vendor]

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                Text("Where it went")
                    .font(Theme.tileLabel)
                    .foregroundStyle(Theme.quietText)

                let largest = vendors.map(\.cents).max() ?? 0
                ForEach(vendors) { v in
                    HStack(spacing: 10) {
                        MerchantLogo(file: v.logo, name: v.name, size: 30)

                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(v.name).lineLimit(1)
                                Spacer(minLength: 8)
                                Text(v.cents.asShortMoney).monospacedDigit()
                            }
                            .font(Theme.note)

                            GeometryReader { geo in
                                Capsule()
                                    .fill(Theme.accent.opacity(0.75))
                                    .frame(width: largest > 0
                                           ? max(2, geo.size.width * Double(v.cents) / Double(largest))
                                           : 2)
                            }
                            .frame(height: 4)
                        }
                    }
                }
            }
        }
    }
}

// MARK: - The rows

private struct LedgerCard: View {
    let rows: [TransactionsResponse.Row]
    let categories: [String: TransactionsResponse.Category]
    @Binding var editing: TransactionsResponse.Row?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Transactions")
                .font(Theme.tileLabel)
                .foregroundStyle(Theme.quietText)

            Card(padding: 0) {
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        Button {
                            editing = row
                        } label: {
                            LedgerRow(row: row, category: row.category.flatMap { categories[$0] })
                        }
                        .buttonStyle(.plain)

                        if index < rows.count - 1 {
                            Divider().padding(.leading, 14)
                        }
                    }
                }
            }
        }
    }
}

struct LedgerRow: View {
    let row: TransactionsResponse.Row
    let category: TransactionsResponse.Category?

    private var categoryTint: Color {
        category.map { Color(hex: $0.colour) } ?? Theme.hairline
    }

    var body: some View {
        HStack(spacing: 10) {
            // The category down the left edge, as on the web: colour carries
            // the category so the row does not need a second line to say it.
            RoundedRectangle(cornerRadius: 1.5)
                .fill(categoryTint)
                .frame(width: 3)

            // Tinted to the row's category, so a merchant with no logo still
            // carries the same colour the stripe does rather than falling back
            // to a generic accent that means nothing.
            MerchantLogo(file: row.logo, name: row.name, tint: categoryTint)

            VStack(alignment: .leading, spacing: 2) {
                Text(row.name)
                    .font(Theme.body)
                    .lineLimit(1)

                HStack(spacing: 5) {
                    Text(row.date)
                    if let category {
                        Text("·")
                        Text(category.label).lineLimit(1)
                    }
                    if row.pending {
                        Text("·")
                        Text("Pending").foregroundStyle(Theme.caution)
                    }
                    if let parts = row.splits, !parts.isEmpty {
                        Text("·")
                        Label("Split \(parts.count)", systemImage: "arrow.triangle.branch")
                            .foregroundStyle(Theme.accent)
                    }
                }
                .font(.caption2)
                .foregroundStyle(Theme.quietText)
            }

            Spacer(minLength: 8)

            // Money in is the exception on this screen and is the only thing
            // coloured; an expense is the ordinary case and takes plain ink.
            Text(row.amount.asMoney)
                .font(Theme.body)
                .monospacedDigit()
                .foregroundStyle(row.amount > 0 ? Theme.positive : Theme.text)

            // A row that opens something has to look like it does. Without
            // this the whole editor is reachable only by guessing that the
            // list is tappable, which is the same as it not being there.
            Image(systemName: "chevron.right")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.quietText)
        }
        .padding(.vertical, 9)
        .padding(.trailing, 14)
        .contentShape(.rect)
    }
}

extension Color {
    /// The category colours arrive as `#rrggbb` strings from the database.
    /// An unparseable one falls back to grey rather than failing the row.
    init(hex: String) {
        let cleaned = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard cleaned.count == 6, let value = Int(cleaned, radix: 16) else {
            self = .gray
            return
        }
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}
