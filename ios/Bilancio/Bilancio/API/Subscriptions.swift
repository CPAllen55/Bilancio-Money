//
//  Subscriptions.swift
//  Bilancio
//
//  StoreKit, and the rule that the server decides who has paid.
//
//  Two auto-renewable subscriptions in one group, so somebody moving between
//  monthly and yearly changes plan rather than ending up holding both.
//

import ClerkKit
import Foundation
import StoreKit

@MainActor
@Observable
final class SubscriptionStore {
    /// The identifiers as created in App Store Connect. They have to match
    /// exactly, and there is no way to find that out at runtime other than
    /// getting nothing back.
    static let productIDs = [
        "com.bilanciomoney.Bilancio.monthly",
        "com.bilanciomoney.Bilancio.yearly",
    ]

    private(set) var products: [Product] = []
    private(set) var loading = false
    private(set) var purchasing: String?
    private(set) var problem: String?
    /// Set once a purchase has been handed over and the server has answered,
    /// so the caller knows to re-read the plan.
    private(set) var changed = false

    /// Written in init, read in deinit, and nowhere else — `deinit` runs
    /// outside the actor, which is the whole reason this needs saying.
    nonisolated(unsafe) private var updates: Task<Void, Never>?

    private let client = APIClient(baseURL: Bilancio.apiBaseURL) {
        guard let session = Clerk.shared.session else { return nil }
        return try await session.getToken()
    }

    init() {
        /* Renewals, refunds, upgrades and anything bought on another device all
           arrive here rather than as the result of a purchase call. Started at
           birth and never cancelled while the screen lives: a transaction that
           arrives while nothing is listening is delivered again next launch,
           but "next launch" is a long time to be told you have not paid. */
        updates = Task { [weak self] in
            for await update in Transaction.updates {
                await self?.hand(over: update)
            }
        }
    }

    deinit { updates?.cancel() }

    func load() async {
        loading = true
        problem = nil
        defer { loading = false }
        do {
            // Sorted by price so monthly comes before yearly without this
            // having to know which is which.
            products = try await Product.products(for: Self.productIDs)
                .sorted { $0.price < $1.price }
        } catch {
            problem = error.localizedDescription
        }
    }

    func buy(_ product: Product) async {
        purchasing = product.id
        problem = nil
        defer { purchasing = nil }
        do {
            switch try await product.purchase() {
            case .success(let verification):
                await hand(over: verification)
            case .userCancelled:
                break
            case .pending:
                // Ask to Buy, or a payment needing approval. Saying so beats a
                // screen that looks like the tap did nothing.
                problem = "That purchase is waiting on approval. It will appear here once it goes through."
            @unknown default:
                break
            }
        } catch {
            problem = error.localizedDescription
        }
    }

    /// Apple rejects subscription apps without one, and it is the only way back
    /// for somebody who reinstalled or changed phone.
    func restore() async {
        purchasing = "restore"
        problem = nil
        defer { purchasing = nil }
        do {
            try await AppStore.sync()
            for await entitlement in Transaction.currentEntitlements {
                await hand(over: entitlement)
            }
            if !changed {
                problem = "No subscription to restore on this Apple Account."
            }
        } catch {
            problem = error.localizedDescription
        }
    }

    /// Send the signed transaction to the server and let it decide.
    ///
    /// `jwsRepresentation` is handed over whether or not StoreKit says it
    /// verified: the phone's opinion is not evidence, and the server checks the
    /// signature against Apple's chain regardless. Finishing only after the
    /// server has taken it means a transaction survives a failed request and is
    /// delivered again rather than being dropped on the floor.
    private func hand(over result: VerificationResult<Transaction>) async {
        do {
            _ = try await client.sendAppleTransaction(result.jwsRepresentation)
            changed = true
            if case .verified(let transaction) = result {
                await transaction.finish()
            }
        } catch {
            problem = error.localizedDescription
        }
    }
}
