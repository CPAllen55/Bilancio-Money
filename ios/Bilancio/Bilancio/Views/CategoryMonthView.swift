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

import ClerkKit
import SwiftUI

@MainActor
@Observable
final class CategoryMonthModel {
    enum State { case loading, loaded(TransactionsResponse), failed(String) }
    private(set) var state: State = .loading

    let slug: String
    let month: String

    private let client = APIClient(baseURL: Bilancio.apiBaseURL) {
        guard let session = Clerk.shared.session else { return nil }
        return try await session.getToken()
    }

    init(slug: String, month: String) {
        self.slug = slug
        self.month = month
    }

    func load() async {
        do {
            // `bucket` is the drill-down the Worker already understands, so the
            // filtering happens where the category is resolved rather than here
            // against rows that have already been paged.
            state = .loaded(try await client.transactions(
                range: .month(month), bucket: slug, limit: 200
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

    init(slug: String, month: String, title: String, monthLabel: String) {
        _model = State(initialValue: CategoryMonthModel(slug: slug, month: month))
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
                    Card {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Who it went to")
                                .font(Theme.tileLabel)
                                .foregroundStyle(Theme.quietText)

                            ForEach(data.vendors.prefix(6)) { v in
                                HStack(spacing: 10) {
                                    MerchantLogo(file: v.logo, name: v.name, size: 26)
                                    Text(v.name).font(Theme.note).lineLimit(1)
                                    Spacer(minLength: 8)
                                    Text(v.cents.asShortMoney)
                                        .font(Theme.note)
                                        .monospacedDigit()
                                }
                            }
                        }
                    }
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
