//
//  NotificationsView.swift
//  Bilancio
//
//  More → Notifications. The opt-in for budget alerts, and this month's
//  categories that have alerted, each of which can be muted until the month
//  turns.
//

import ClerkKit
import SwiftUI
import UIKit
import UserNotifications

@MainActor
@Observable
final class NotificationsModel {
    enum State {
        case loading
        case failed(String)
        case loaded(NotificationSettingsResponse)
    }

    var state: State = .loading
    var permission: UNAuthorizationStatus = .notDetermined
    var saving = false
    var muting: String?
    var problem: String?

    private let client = APIClient(baseURL: Bilancio.apiBaseURL) {
        guard let session = Clerk.shared.session else { return nil }
        return try await session.getToken()
    }

    func load() async {
        permission = await BudgetAlerts.shared.permission()
        do {
            state = .loaded(try await client.notificationSettings())
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    func setEnabled(_ on: Bool) async {
        saving = true
        problem = nil
        defer { saving = false }

        if on {
            /* Permission before the preference. Saving "on" for a phone that
               will never show a notification would be a switch that lies. */
            let allowed = await BudgetAlerts.shared.requestPermission()
            permission = await BudgetAlerts.shared.permission()
            guard allowed else { return }
        }
        do {
            try await client.setBudgetAlerts(on)
            await load()
        } catch {
            problem = error.localizedDescription
        }
    }

    func mute(_ alert: NotificationSettingsResponse.Alert, month: String) async {
        muting = alert.categoryId
        problem = nil
        defer { muting = nil }
        do {
            try await BudgetAlerts.shared.mute(categoryId: alert.categoryId, month: month)
            await load()
        } catch {
            problem = error.localizedDescription
        }
    }
}

struct NotificationsView: View {
    @State private var model = NotificationsModel()
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

            case .loaded(let data):
                content(data)
            }
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .refreshable { await model.load() }
        // Back from Settings, where the permission may just have changed.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.load() } }
        }
    }

    @ViewBuilder
    private func content(_ data: NotificationSettingsResponse) -> some View {
        let denied = model.permission == .denied

        Section {
            Toggle(isOn: Binding(
                get: { data.enabled && !denied },
                set: { on in Task { await model.setEnabled(on) } }
            )) {
                HStack(spacing: 8) {
                    Text("Budget alerts")
                    if model.saving { ProgressView() }
                }
            }
            .disabled(!data.configured || model.saving || denied)
        } footer: {
            if !data.configured {
                Text("Budget alerts aren't available yet.")
            } else {
                Text("A notification when a category reaches 95% of its budget, and another if it goes over. Each can be muted for the rest of the month.")
            }
        }

        if denied {
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

        if !data.alerts.isEmpty {
            Section {
                ForEach(data.alerts) { alert in
                    row(alert, month: data.month)
                }
            } header: {
                Text(Self.monthName(data.month))
            } footer: {
                Text("Muting lasts until the month turns. Every category starts the next month fresh.")
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

    private func row(_ alert: NotificationSettingsResponse.Alert, month: String) -> some View {
        HStack(spacing: 10) {
            Circle()
                .fill(Color(hex: alert.colour))
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(alert.label)
                Text(status(alert, month: month))
                    .font(.caption)
                    .foregroundStyle(colour(alert))
            }
            Spacer(minLength: 8)
            if alert.acknowledged {
                Image(systemName: "bell.slash")
                    .foregroundStyle(Theme.quietText)
                    .accessibilityLabel("Muted")
            } else if model.muting == alert.categoryId {
                ProgressView()
            } else {
                Button("Mute") { Task { await model.mute(alert, month: month) } }
                    .buttonStyle(.bordered)
                    .disabled(model.muting != nil)
            }
        }
    }

    private func status(_ alert: NotificationSettingsResponse.Alert, month: String) -> String {
        if alert.acknowledged { return "Muted until \(Self.nextMonthName(month))" }
        return alert.level == "over" ? "Over budget" : "Nearly spent"
    }

    private func colour(_ alert: NotificationSettingsResponse.Alert) -> Color {
        if alert.acknowledged { return Theme.quietText }
        return alert.level == "over" ? Theme.negative : Theme.caution
    }

    private static let names = ["January", "February", "March", "April", "May", "June",
                                "July", "August", "September", "October", "November", "December"]

    private static func monthName(_ ym: String) -> String {
        let parts = ym.split(separator: "-")
        guard parts.count == 2, let m = Int(parts[1]), (1...12).contains(m) else { return ym }
        return names[m - 1]
    }

    private static func nextMonthName(_ ym: String) -> String {
        let parts = ym.split(separator: "-")
        guard parts.count == 2, let m = Int(parts[1]), (1...12).contains(m) else { return "next month" }
        return names[m % 12]
    }
}
