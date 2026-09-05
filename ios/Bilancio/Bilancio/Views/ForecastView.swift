//
//  ForecastView.swift
//  Bilancio
//
//  The year ahead, on the same plan every other screen reads.
//

import Charts
import ClerkKit
import SwiftUI

@MainActor
@Observable
final class ForecastModel {
    enum State { case loading, loaded(ForecastResponse), failed(String) }
    private(set) var state: State = .loading

    private let client = APIClient(baseURL: Bilancio.apiBaseURL) {
        guard let session = Clerk.shared.session else { return nil }
        return try await session.getToken()
    }

    func load() async {
        do { state = .loaded(try await client.forecast()) }
        catch { state = .failed(error.localizedDescription) }
    }
}

struct ForecastView: View {
    @State private var model = ForecastModel()
    @State private var picked: String?

    var body: some View {
        Group {
            switch model.state {
            case .loading:
                ProgressView("Loading…")

            case .failed(let message):
                ContentUnavailableView {
                    Label("Could not load the forecast", systemImage: "exclamationmark.triangle")
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
        .navigationTitle("The year ahead")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
    }

    private func content(_ data: ForecastResponse) -> some View {
        ScrollView {
            VStack(spacing: Theme.sectionGap) {
                Card {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Where \(String(data.year)) ends up")
                            .font(Theme.tileLabel)
                            .foregroundStyle(Theme.quietText)

                        Text(data.totals.projectedYearEndNet.asMoney)
                            .font(Theme.figure(34))
                            .monospacedDigit()
                            .foregroundStyle(Theme.tint(forNet: data.totals.projectedYearEndNet))
                            .lineLimit(1)
                            .minimumScaleFactor(0.5)

                        HStack(spacing: 0) {
                            figure("Kept so far", data.totals.savedSoFar)
                            Divider().frame(height: 34)
                            figure("Still to come", data.totals.projectedRemainingNet)
                        }
                    }
                }

                Card {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Net by month")
                            .font(Theme.tileLabel)
                            .foregroundStyle(Theme.quietText)

                        Chart(data.months) { m in
                            BarMark(
                                x: .value("Month", m.shortLabel),
                                y: .value("Net", Double(m.net) / 100)
                            )
                            .annotation(position: .top, spacing: 2) {
                                if picked == m.shortLabel {
                                    VStack(spacing: 0) {
                                        Text(m.net.asShortMoney)
                                        if m.projected { Text("projected").opacity(0.7) }
                                    }
                                    .font(.system(size: 9, weight: .semibold))
                                    .monospacedDigit()
                                    .foregroundStyle(Theme.tint(forNet: m.net))
                                }
                            }
                            // Projected months are drawn faintly. A forecast
                            // that looks exactly like a record invites being
                            // read as one.
                            .foregroundStyle(
                                Theme.tint(forNet: m.net).opacity(m.projected ? 0.4 : 1)
                            )
                        }
                        .chartXSelection(value: $picked)
                        .chartYAxis {
                            AxisMarks(format: .currency(code: "USD").precision(.fractionLength(0)))
                        }
                        .frame(height: 210)
                        .animation(.snappy(duration: 0.2), value: picked)

                        if data.firstProjectedMonth != nil {
                            Text("Faded months are projected from the plan, not recorded.")
                                .font(Theme.note)
                                .foregroundStyle(Theme.quietText)
                        }
                    }
                }
            }
            .padding()
        }
        .background(Theme.background)
    }

    private func figure(_ label: String, _ cents: Int) -> some View {
        VStack(spacing: 2) {
            Text(label).font(Theme.tileLabel).foregroundStyle(Theme.quietText)
            Text(cents.asShortMoney)
                .font(.system(.headline, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(Theme.tint(forNet: cents))
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity)
    }
}
