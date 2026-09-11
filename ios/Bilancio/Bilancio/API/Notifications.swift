//
//  Notifications.swift
//  Bilancio
//
//  Budget alerts: the opt-in, the push token, and muting a category for the
//  rest of the month. What decides whether one is sent lives on the server, in
//  src/budget-alerts.ts — the phone only says where to send them.
//

import ClerkKit
import Foundation
import UIKit
import UserNotifications

struct NotificationSettingsResponse: Decodable {
    /// Whether the server can send anything at all. False until the APNs key
    /// is installed, and the switch is shown as unavailable until it is true.
    let configured: Bool
    let enabled: Bool
    /// `YYYY-MM`, the month the alerts below belong to.
    let month: String
    let alerts: [Alert]

    struct Alert: Decodable, Identifiable {
        let categoryId: String
        let label: String
        let colour: String
        /// "near", "over", or nothing for a category muted before it alerted.
        let level: String?
        let acknowledged: Bool

        var id: String { categoryId }
    }
}

private struct Accepted: Decodable { let ok: Bool }

extension APIClient {
    func notificationSettings() async throws -> NotificationSettingsResponse {
        try await get("/api/notifications")
    }

    func setBudgetAlerts(_ enabled: Bool) async throws {
        let _: Accepted = try await send("PUT", "/api/notifications", body: ["enabled": enabled])
    }

    func registerDevice(token: String, environment: String) async throws {
        let _: Accepted = try await send(
            "POST", "/api/notifications/devices",
            body: ["token": token, "environment": environment]
        )
    }

    func unregisterDevice(token: String) async throws {
        let _: Accepted = try await send("DELETE", "/api/notifications/devices/\(token)")
    }

    func acknowledgeAlert(categoryId: String, month: String) async throws {
        let _: Accepted = try await send(
            "POST", "/api/notifications/acknowledge",
            body: ["categoryId": categoryId, "month": month]
        )
    }
}

@MainActor
@Observable
final class BudgetAlerts {
    static let shared = BudgetAlerts()

    /// Must match the `category` the server puts on the payload.
    nonisolated static let categoryIdentifier = "BUDGET_ALERT"
    nonisolated static let muteAction = "MUTE_MONTH"

    /// Bumped each time an alert is opened, so the tab bar can go to the
    /// Overview and the Overview can reload.
    private(set) var opened = 0

    @ObservationIgnored private let tokenKey = "pushDeviceToken"
    @ObservationIgnored private let client = APIClient(baseURL: Bilancio.apiBaseURL) {
        guard let session = Clerk.shared.session else { return nil }
        return try await session.getToken()
    }

    /// Which APNs host the token belongs to. A build run from Xcode is given a
    /// sandbox token; TestFlight and the App Store are given production ones.
    nonisolated static var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    private init() {}

    /// The button on the notification itself. Registered at every launch.
    nonisolated static func registerCategories() {
        let mute = UNNotificationAction(
            identifier: muteAction,
            title: "Don't remind me this month",
            options: []
        )
        let category = UNNotificationCategory(
            identifier: categoryIdentifier,
            actions: [mute],
            intentIdentifiers: [],
            options: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([category])
    }

    /// Ask once, when somebody switches alerts on — never at launch, where a
    /// permission prompt with no context is a prompt people say no to.
    func requestPermission() async -> Bool {
        let granted = (try? await UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        if granted { UIApplication.shared.registerForRemoteNotifications() }
        return granted
    }

    func permission() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    /// At launch: refresh the token if permission already exists. Never prompts.
    func refreshIfAllowed() async {
        let status = await permission()
        guard status == .authorized || status == .provisional else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    func didRegister(_ deviceToken: Data) async {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(hex, forKey: tokenKey)
        /* Can run before the session has been restored on a cold launch, in
           which case it fails quietly — the signed-in screen registers again
           once there is somebody to register it to. */
        try? await client.registerDevice(token: hex, environment: Self.environment)
    }

    /// On sign-out, so this phone stops getting that account's alerts.
    func forgetDevice() async {
        guard let token = UserDefaults.standard.string(forKey: tokenKey) else { return }
        try? await client.unregisterDevice(token: token)
        UserDefaults.standard.removeObject(forKey: tokenKey)
    }

    func mute(categoryId: String, month: String) async throws {
        try await client.acknowledgeAlert(categoryId: categoryId, month: month)
    }

    func didOpen() { opened += 1 }
}
