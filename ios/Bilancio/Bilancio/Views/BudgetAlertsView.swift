//
//  BudgetAlertsView.swift
//  Bilancio
//
//  More → Budget alerts. Every subcategory with a budget this month, under its
//  category, with where it stands — and a switch for whether it alerts.
//
//  Two requests, side by side: /api/summary for the figures, because it
//  already computes exactly them for the Overview, and /api/notifications for
//  which are chosen. Working the plan out a second time for this screen would
//  double the most expensive query in the app for nothing.
//

import ClerkKit
import SwiftUI
import UIKit
import UserNotifications

@MainActor
@Observable
final class BudgetAlertsModel {
    enum State {
        case loading
        case failed(String)
        case loaded
    }

    struct Line: Identifiable {
        /// The category id, which is what a choice is stored against.
        let id: String
        let label: String
        let colour: String
        let spent: Int
        let planned: Int
    }

    struct Group: Identifiable {
        /// The parent's slug.
        let id: String
        let label: String
        let lines: [Line]
    }

    var state: State = .loading
    var groups: [Group] = []
    /// `YYYY-MM`.
    var month = ""
    /// False before the server can send anything: the switches still show,
    /// disabled, so the dashboard is readable while alerts are being set up.
    var available = false
    var selected: Set<String> = []
    var alerts: [String: NotificationSettingsResponse.Alert] = [:]
    var permission: UNAuthorizationStatus = .notDetermined
    var busy: Set<String> = []
    var problem: String?

    private let client = APIClient(baseURL: Bilancio.apiBaseURL) {
        guard let session = Clerk.shared.session else { return nil }
        return try await session.getToken()
    }

    func load() async {
        permission = await BudgetAlerts.shared.permission()

        async let summaryCall = client.summary(range: .thisMonth)
        async let settingsCall = client.notificationSettings()

        let summary: SummaryResponse
        do {
            summary = try await summaryCall
        } catch {
            state = .failed(error.localizedDescription)
            return
        }
        month = String(summary.range.start.prefix(7))

        do {
            let settings = try await settingsCall
            available = settings.configured
            month = settings.month
            selected = Set(settings.selected)
            alerts = Dictionary(uniqueKeysWithValues: settings.alerts.map { ($0.categoryId, $0) })
        } catch APIError.http(let status, _) where status == 503 {
            /* The Worker is up and alerts are not set up behind it yet. The
               figures are still worth showing; the switches wait. */
            available = false
            selected = []
            alerts = [:]
        } catch {
            state = .failed(error.localizedDescription)
            return
        }

        groups = Self.group(summary, keeping: selected)
        state = .loaded
    }

    /// Parents in the order the server lists them, each with the subcategories
    /// that have a budget this month — plus any already chosen, so a choice is
    /// never hidden just because this month happens to plan nothing for it.
    private static func group(_ summary: SummaryResponse, keeping chosen: Set<String>) -> [Group] {
        let categories = summary.categoryList
        let spent = summary.totals.byCategory ?? [:]
        let planned = summary.budget?.available == true ? (summary.budget?.byCategory ?? [:]) : [:]

        return categories
            .filter { $0.parentSlug == nil && $0.kind == "spend" }
            .compactMap { parent in
                let lines = categories
                    .filter { $0.parentSlug == parent.slug && $0.kind == "spend" }
                    .map { Line(id: $0.id, label: $0.label, colour: $0.colour,
                                spent: spent[$0.slug] ?? 0, planned: planned[$0.slug] ?? 0) }
                    .filter { $0.planned > 0 || chosen.contains($0.id) }
                guard !lines.isEmpty else { return nil }
                return Group(id: parent.slug, label: parent.label, lines: lines)
            }
    }

    func set(_ ids: [String], on: Bool) async {
        guard !ids.isEmpty else { return }
        problem = nil

        if on {
            /* Permission before the choice. A subcategory marked as alerting on
               a phone that will never show a notification is a switch that
               lies. Asks only the first time; after that iOS just answers. */
            let allowed = await BudgetAlerts.shared.requestPermission()
            permission = await BudgetAlerts.shared.permission()
            guard allowed else { return }
        }

        // The switch moves when it is touched, and moves back if the server refuses.
        let before = selected
        if on { selected.formUnion(ids) } else { selected.subtract(ids) }
        busy.formUnion(ids)
        defer { busy.subtract(ids) }

        do {
            try await client.setAlerts(categoryIds: ids, enabled: on)
        } catch {
            selected = before
            problem = error.localizedDescription
        }
    }

    func mute(_ id: String) async {
        busy.insert(id)
        defer { busy.remove(id) }
        do {
            try await BudgetAlerts.shared.mute(categoryId: id, month: month)
            await load()
        } catch {
            problem = error.localizedDescription
        }
    }
}

struct BudgetAlertsView: View {
    @State private var model = BudgetAlertsModel()
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        List {
            switch model.state {
            case .loading:
                ProgressView().frame(maxWidth: .infinity)

            case .failed(let message):
                Section {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .font(Theme.note)
                        .foregroundStyle(Theme.negative)
                    Button("Try again") { Task { await model.load() } }
                }

            case .loaded:
                content
            }
        }
        .navigationTitle("Budget alerts")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .refreshable { await model.load() }
        // Back from Settings, where the permission may just have changed.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.load() } }
        }
    }

    private var locked: Bool { !model.available || model.permission == .denied }

    @ViewBuilder
    private var content: some View {
        Section {
            Text(model.available
                 ? "Choose the subcategories to hear about. Each one alerts when it reaches 95% of its budget, and again if it goes over. Swipe one to mute it for the rest of the month."
                 : "Budget alerts aren't available yet.")
                .font(Theme.note)
                .foregroundStyle(Theme.quietText)
        }

        if model.permission == .denied {
            Section {
                Text("Notifications are turned off for Bilancio in Settings.")
                    .font(Theme.note)
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
                        openURL(url)
                    }
                }
            }
        }

        if model.groups.isEmpty {
            Section {
                Text("Nothing has a budget this month yet.")
                    .font(Theme.note)
                    .foregroundStyle(Theme.quietText)
            }
        }

        ForEach(model.groups) { group in
            Section {
                ForEach(group.lines) { line in
                    row(line)
                }
            } header: {
                header(group)
            }
        }

        if let problem = model.problem {
            Section {
                Label(problem, systemImage: "exclamationmark.triangle")
                    .font(Theme.note)
                    .foregroundStyle(Theme.negative)
            }
        }
    }

    private func header(_ group: BudgetAlertsModel.Group) -> some View {
        let ids = group.lines.map(\.id)
        let allOn = ids.allSatisfy(model.selected.contains)
        return HStack {
            Text(group.label)
            Spacer()
            Button(allOn ? "None" : "All") {
                Task { await model.set(ids, on: !allOn) }
            }
            .font(Theme.note)
            .textCase(nil)
            .disabled(locked || !model.busy.isDisjoint(with: ids))
        }
    }

    private func row(_ line: BudgetAlertsModel.Line) -> some View {
        let on = model.selected.contains(line.id)
        let alert = model.alerts[line.id]
        let working = model.busy.contains(line.id)

        return HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 1.5)
                .fill(Color(hex: line.colour))
                .frame(width: 3, height: 30)

            VStack(alignment: .leading, spacing: 3) {
                Text(line.label).lineLimit(1)
                Text(standing(line, alert: alert, on: on))
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(tone(line, alert: alert))
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            if working { ProgressView() }

            Toggle(line.label, isOn: Binding(
                get: { on },
                set: { value in Task { await model.set([line.id], on: value) } }
            ))
            .labelsHidden()
            .disabled(locked || working)
        }
        .swipeActions(edge: .trailing) {
            if on, model.available, alert?.acknowledged != true {
                Button("Mute") { Task { await model.mute(line.id) } }
                    .tint(Theme.accent)
            }
        }
    }

    /// Spent of planned, and what has already been said about it.
    private func standing(_ line: BudgetAlertsModel.Line,
                          alert: NotificationSettingsResponse.Alert?,
                          on: Bool) -> String {
        if alert?.acknowledged == true { return "Muted until \(Self.nextMonthName(model.month))" }
        guard line.planned > 0 else { return "No budget this month" }
        // Floored, as the alert itself is, so a row never reads 100% while under.
        let percent = Int((Double(line.spent) / Double(line.planned) * 100).rounded(.down))
        let figures = "\(line.spent.asShortMoney) of \(line.planned.asShortMoney) · \(percent)%"
        guard on, let level = alert?.level else { return figures }
        return figures + (level == "over" ? " · over, alerted" : " · alerted")
    }

    /// The Overview's colours for a subcategory: amber from 95%, red past 100%.
    private func tone(_ line: BudgetAlertsModel.Line,
                      alert: NotificationSettingsResponse.Alert?) -> Color {
        if alert?.acknowledged == true || line.planned <= 0 { return Theme.quietText }
        if line.spent > line.planned { return Theme.negative }
        if Double(line.spent) >= Double(line.planned) * 0.95 { return Theme.caution }
        return Theme.quietText
    }

    private static let monthNames = ["January", "February", "March", "April", "May", "June",
                                     "July", "August", "September", "October", "November", "December"]

    private static func nextMonthName(_ ym: String) -> String {
        let parts = ym.split(separator: "-")
        guard parts.count == 2, let m = Int(parts[1]), (1...12).contains(m) else { return "next month" }
        return monthNames[m % 12]
    }
}
