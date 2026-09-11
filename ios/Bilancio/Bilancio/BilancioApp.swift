//
//  BilancioApp.swift
//  Bilancio
//

import SwiftUI

@main
struct BilancioApp: App {
    /* For the two things SwiftUI still has no hook for: the push token Apple
       hands back after registering, and a notification being opened. */
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}
