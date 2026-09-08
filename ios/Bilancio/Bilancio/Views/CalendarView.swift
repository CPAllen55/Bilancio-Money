//
//  CalendarView.swift
//  Bilancio
//
//  A month as days rather than as a total.
//
//  Every other screen answers "how much" and leaves "when" to be inferred from
//  a list. Rent, a car payment and three subscriptions falling in the same week
//  is a fact about a month that no total contains, and it is the fact that
//  decides whether the month is comfortable.
//

import ClerkKit
import SwiftUI

@MainActor
@Observable
final class CalendarModel {
    enum State { case loading, loaded(CalendarResponse), failed(String) }
    private(set) var state: State = .loading

    /// `YYYY-MM`, or nil for the month we are in.
    var month: String?

    private let client = APIClient(baseURL: Bilancio.apiBaseURL) {
        guard let session = Clerk.shared.session else { return nil }
        return try await session.getToken()
    }

    func load() async {
        do { state = .loaded(try await client.calendar(month: month)) }
        catch { state = .failed(error.localizedDescription) }
    }

    func step(_ months: Int, from current: String) async {
        month = Self.shift(current, by: months)
        state = .loading
        await load()
    }

    /// `2026-01` a month back is `2025-12`.
    static func shift(_ ym: String, by months: Int) -> String {
        let parts = ym.split(separator: "-")
        guard parts.count == 2, let y = Int(parts[0]), let m = Int(parts[1]) else { return ym }
        let total = y * 12 + (m - 1) + months
        return String(format: "%04d-%02d", total / 12, total % 12 + 1)
    }
}

struct CalendarView: View {
    @State private var model = CalendarModel()
    @State private var picked: CalendarResponse.Day?

    var body: some View {
        Group {
            switch model.state {
            case .loading:
                ProgressView("Loading…")

            case .failed(let message):
                ContentUnavailableView {
                    Label("Could not load the calendar", systemImage: "exclamationmark.triangle")
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
        .navigationTitle("Calendar")
        .navigationBarTitleDisplayMode(.large)
        .task { await model.load() }
        .refreshable { await model.load() }
    }

    private func content(_ data: CalendarResponse) -> some View {
        ScrollView {
            VStack(spacing: Theme.sectionGap) {
                Card {
                    VStack(alignment: .leading, spacing: 12) {
                        strip(data)
                        Grid(data: data) { picked = $0 }
                        totals(data)
                    }
                }

                if let day = picked, let match = data.days.first(where: { $0.date == day.date }) {
                    DayCard(day: match) { picked = nil }
                }
            }
            .padding(.horizontal)
            .padding(.bottom, Theme.sectionGap)
        }
        .background(Theme.background)
    }

    private func strip(_ data: CalendarResponse) -> some View {
        HStack {
            Button {
                picked = nil
                Task { await model.step(-1, from: data.month) }
            } label: {
                Image(systemName: "chevron.left")
            }
            Spacer()
            Text(Self.title(of: data.month))
                .font(Theme.tileLabel)
                .foregroundStyle(Theme.quietText)
            Spacer()
            Button {
                picked = nil
                Task { await model.step(1, from: data.month) }
            } label: {
                Image(systemName: "chevron.right")
            }
            // Forward past the month we are in would be an empty grid with a
            // total of nothing, which reads as a fault rather than as a month
            // that has not happened.
            .disabled(data.month >= String(data.today.prefix(7)))
        }
        .buttonStyle(.plain)
        .foregroundStyle(Theme.accent)
    }

    private func totals(_ data: CalendarResponse) -> some View {
        HStack(spacing: 16) {
            figure("Spent", data.total.spent, Theme.expenseTint)
            if data.total.subscriptions > 0 {
                figure("Of it, subscriptions", data.total.subscriptions, Theme.quietText)
            }
        }
    }

    private func figure(_ label: String, _ cents: Int, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(Theme.quietText)
            Text(cents.asMoney)
                .font(Theme.body)
                .monospacedDigit()
                .foregroundStyle(tint)
        }
    }

    static func title(of month: String) -> String {
        let parts = month.split(separator: "-")
        guard parts.count == 2, let m = Int(parts[1]), (1...12).contains(m) else { return month }
        let names = ["January","February","March","April","May","June",
                     "July","August","September","October","November","December"]
        return "\(names[m - 1]) \(parts[0])"
    }
}

// MARK: - The month

/// Seven columns, and a day that carries its weight rather than its figure.
///
/// A number in every cell is unreadable at this size and, worse, invites the
/// eye to compare figures that are two characters apart. Depth of colour
/// compares at a glance — and the days that matter are found before any of
/// them is read.
private struct Grid: View {
    let data: CalendarResponse
    let onPick: (CalendarResponse.Day) -> Void

    private static let weekdays = ["S", "M", "T", "W", "T", "F", "S"]

    /// Blank cells before the first, so the first lands on its weekday.
    private var lead: Int {
        guard let first = data.days.first else { return 0 }
        var c = Foundation.Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = c.timeZone
        guard let date = f.date(from: first.date) else { return 0 }
        return c.component(.weekday, from: date) - 1
    }

    /// The heaviest day, which sets the depth every other day is drawn at.
    /// Absolute money cannot: a quiet month would come out as a blank grid and
    /// a heavy one as a solid block.
    private var heaviest: Int {
        max(1, data.days.map(\.spent).max() ?? 1)
    }

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 4) {
                ForEach(Self.weekdays.indices, id: \.self) { i in
                    Text(Self.weekdays[i])
                        .font(.caption2)
                        .foregroundStyle(Theme.quietText)
                        .frame(maxWidth: .infinity)
                }
            }

            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 7),
                      spacing: 4) {
                ForEach(0..<lead, id: \.self) { _ in Color.clear.frame(height: 40) }

                ForEach(data.days) { day in
                    Button { onPick(day) } label: {
                        Cell(day: day,
                             weight: Double(day.spent) / Double(heaviest),
                             ahead: day.date > data.today)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

private struct Cell: View {
    let day: CalendarResponse.Day
    let weight: Double
    /// Later than today. Nothing has been spent on it and nothing can have
    /// been, so an empty cell is a fact rather than a quiet day.
    let ahead: Bool

    var body: some View {
        VStack(spacing: 2) {
            Text("\(day.dayOfMonth)")
                .font(.system(size: 12, weight: .medium))
                .monospacedDigit()
            // A dot rather than a figure: which days carry a subscription is
            // the question, and the amount is a tap away.
            if day.subs.isEmpty {
                Color.clear.frame(height: 4)
            } else {
                Circle()
                    .fill(Theme.accent)
                    .frame(width: 4, height: 4)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: 40)
        .background(
            (ahead ? Theme.quietText.opacity(0.05)
                   : Theme.expenseTint.opacity(0.10 + 0.55 * min(1, weight)))
                .clipShape(.rect(cornerRadius: 6))
        )
        .foregroundStyle(ahead ? Theme.quietText : Theme.text)
    }
}

// MARK: - One day

private struct DayCard: View {
    let day: CalendarResponse.Day
    let dismiss: () -> Void

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(CalendarView.title(of: String(day.date.prefix(7))).split(separator: " ").first.map(String.init) ?? "")
                        .font(Theme.tileLabel)
                        .foregroundStyle(Theme.quietText)
                    Text("\(day.dayOfMonth)")
                        .font(Theme.tileLabel)
                        .foregroundStyle(Theme.quietText)
                    Spacer()
                    Button(action: dismiss) {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(Theme.quietText)
                    }
                    .buttonStyle(.plain)
                }

                HStack(spacing: 16) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(day.count == 1 ? "1 transaction" : "\(day.count) transactions")
                            .font(.caption2)
                            .foregroundStyle(Theme.quietText)
                        Text(day.spent.asMoney)
                            .font(Theme.body)
                            .monospacedDigit()
                    }
                }

                if !day.subs.isEmpty {
                    Divider()
                    ForEach(day.subs) { sub in
                        HStack {
                            Text(sub.name)
                                .font(Theme.note)
                                .lineLimit(1)
                            // An expectation, said so. A charge that has not
                            // happened listed beside ones that have is the
                            // calendar inventing history.
                            if sub.projected {
                                Text("expected")
                                    .font(.caption2)
                                    .foregroundStyle(Theme.quietText)
                            }
                            Spacer(minLength: 8)
                            Text(sub.cents.asMoney)
                                .font(Theme.note)
                                .monospacedDigit()
                                .foregroundStyle(sub.projected ? Theme.quietText : Theme.text)
                        }
                    }
                }
            }
        }
    }
}
