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

    /* ── Why these take completion handlers rather than being async ───────────
     *
     * This target sets SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor, so this whole
     * class is main-actor isolated unless a member says otherwise. The async
     * versions of these two methods crashed the app when a notification was
     * opened: iOS waits on the completion handler the async bridge synthesises,
     * and that handler was called from whichever thread the async body happened
     * to finish on -- not the main thread UIKit requires when a notification
     * launches or foregrounds the app.
     *
     * So: nonisolated, so no main-actor assumption is checked on entry whatever
     * thread iOS calls from; the values needed are copied out immediately; the
     * work hops to the main actor; and the completion handler is called there,
     * last, once the work is done.
     */

    /// Shown even with the app open. Somebody looking at Trend still wants to
    /// know Groceries has just gone over.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        // Copied out now: the response is not Sendable and is not ours to hold.
        let info = response.notification.request.content.userInfo
        let categoryId = info["categoryId"] as? String
        let month = info["month"] as? String
        let action = response.actionIdentifier
        nonisolated(unsafe) let finish = completionHandler

        Task { @MainActor in
            switch action {
            case BudgetAlerts.muteAction:
                // Straight from the lock screen, without opening the app. The
                // handler waits for the request, so iOS keeps the app alive
                // long enough for it to reach the server.
                if let categoryId, let month {
                    try? await BudgetAlerts.shared.mute(categoryId: categoryId, month: month)
                }
            case UNNotificationDefaultActionIdentifier:
                BudgetAlerts.shared.didOpen()
            default:
                break
            }
            finish()
        }
    }
}
