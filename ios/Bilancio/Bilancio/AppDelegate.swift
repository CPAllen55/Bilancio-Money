//
//  AppDelegate.swift
//  Bilancio
//
//  The push token, and what happens when a notification is opened. SwiftUI has
//  no hook for either, so this is the one UIKit delegate the app keeps.
//

import UIKit
import UserNotifications

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        /* Set before launch finishes, or a notification that launched the app
           is delivered before anything is listening for it. */
        UNUserNotificationCenter.current().delegate = self
        BudgetAlerts.registerCategories()
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { await BudgetAlerts.shared.didRegister(deviceToken) }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // The simulator without a paired device, or no network. The next
        // launch asks again; there is nothing useful to show anybody.
    }

    /// Shown even with the app open. Somebody looking at Trend still wants to
    /// know Groceries has just gone over.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        let categoryId = info["categoryId"] as? String
        let month = info["month"] as? String

        switch response.actionIdentifier {
        case BudgetAlerts.muteAction:
            // Straight from the lock screen, without opening the app.
            if let categoryId, let month {
                try? await BudgetAlerts.shared.mute(categoryId: categoryId, month: month)
            }
        case UNNotificationDefaultActionIdentifier:
            await BudgetAlerts.shared.didOpen()
        default:
            break
        }
    }
}
