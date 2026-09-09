//
//  Billing.swift
//  Bilancio
//
//  What the server knows about who has paid — see docs/billing.md, which is
//  the contract between Stripe on the web and StoreKit here.
//

import Foundation

struct BillingStatus: Decodable {
    /// "trial", "active", "free" or "lapsed".
    let plan: String
    /// When the current plan runs out. Null for one that does not.
    let planUntil: String?
    /// Which processor holds it: "apple", "stripe", or nothing yet.
    let source: String?
    /// Whether this device may sell. Read rather than decided locally, so the
    /// rule lives in one place if it ever changes.
    let canSubscribeHere: Bool
    /// Where a subscription is managed: "apple" or "stripe".
    let manageAt: String
    /// Whether billing is set up at all. Nothing about subscriptions is shown
    /// when it is not — an account screen offering to sell something it cannot
    /// sell is worse than one that says nothing.
    let configured: Bool

    var isActive: Bool { plan == "active" || plan == "trial" }
    var boughtOnApple: Bool { source == "apple" }

    /// The date, said the way a person says it.
    var runsOut: String? {
        guard let planUntil else { return nil }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = iso.date(from: planUntil)
            ?? ISO8601DateFormatter().date(from: planUntil)
        guard let date else { return nil }
        return date.formatted(.dateTime.day().month(.wide).year())
    }
}

/// What the server says after being handed a signed transaction.
struct AppleReceiptAccepted: Decodable {
    let plan: String
    let planUntil: String?
}

extension APIClient {
    func billingStatus() async throws -> BillingStatus {
        try await get("/api/billing/status")
    }

    /// Hand Apple's signed transaction to the server, which verifies the
    /// signature itself and decides what it means.
    ///
    /// The app deliberately does not read the payload and report what it found:
    /// anything the phone decodes it also could have written, and the question
    /// this answers is who has paid. The server verifies the JWS against
    /// Apple's chain and answers with the plan it has recorded.
    @discardableResult
    func sendAppleTransaction(_ jws: String) async throws -> AppleReceiptAccepted {
        try await send("POST", "/api/billing/apple", body: ["signedTransaction": jws])
    }
}
