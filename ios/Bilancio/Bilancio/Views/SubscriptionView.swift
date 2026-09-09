//
//  SubscriptionView.swift
//  Bilancio
//
//  What somebody is on, and how to be on it.
//
//  Everything sold here is sold through Apple. That is not a preference — a
//  digital subscription in an iOS app has to go through in-app purchase, and
//  docs/billing.md records the two things that follow from it: prices come from
//  StoreKit rather than from us, and an Apple subscription is cancelled at
//  Apple rather than by anything this app can offer.
//

import ClerkKit
import StoreKit
import SwiftUI

@MainActor
@Observable
final class SubscriptionModel {
    enum State { case loading, loaded(BillingStatus), failed(String) }
    private(set) var state: State = .loading

    private let client = APIClient(baseURL: Bilancio.apiBaseURL) {
        guard let session = Clerk.shared.session else { return nil }
        return try await session.getToken()
    }

    func load() async {
        do { state = .loaded(try await client.billingStatus()) }
        catch { state = .failed(error.localizedDescription) }
    }
}

struct SubscriptionView: View {
    @State private var model = SubscriptionModel()
    @State private var store = SubscriptionStore()

    var body: some View {
        Group {
            switch model.state {
            case .loading:
                ProgressView("Loading…")

            case .failed(let message):
                ContentUnavailableView {
                    Label("Could not load your plan", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try again") { Task { await model.load() } }
                        .buttonStyle(.borderedProminent)
                }

            case .loaded(let status):
                content(status)
            }
        }
        .navigationTitle("Subscription")
        .navigationBarTitleDisplayMode(.large)
        .task {
            await model.load()
            await store.load()
        }
        // A purchase, a renewal, or something restored: the server has just
        // been told, so what it says about the plan has changed.
        .onChange(of: store.changed) { _, changed in
            if changed { Task { await model.load() } }
        }
    }

    @ViewBuilder
    private func content(_ status: BillingStatus) -> some View {
        List {
            Section {
                LabeledContent("Plan", value: plan(status))
                if let runsOut = status.runsOut {
                    LabeledContent(status.plan == "lapsed" ? "Ended" : "Runs until", value: runsOut)
                }
            } footer: {
                if status.plan == "lapsed" {
                    // What lapsing does, said plainly: it is not a lockout, and
                    // somebody deciding whether to pay should know that before
                    // they decide.
                    Text("Everything you had is still here to read. What stops is adding to it — new banks, re-filing, and changes to the plan.")
                }
            }

            if !status.configured {
                // Nothing to sell, so nothing about selling. An account screen
                // offering something it cannot deliver is worse than silence.
                EmptyView()
            } else if status.boughtOnApple {
                Section {
                    Text("Your subscription is through Apple.")
                        .font(Theme.note)
                } footer: {
                    // No button. Apple requires that an App Store subscription
                    // is cancelled at Apple, so anything offered here could
                    // only fail — the server answers 409 for exactly this, and
                    // the app should not have to find that out by trying.
                    Text("Change or cancel it in Settings, under your Apple Account, then Subscriptions.")
                }
            } else if status.source == "stripe" {
                Section {
                    Text("Your subscription was not started on this device, and is managed where it was.")
                        .font(Theme.note)
                }
            } else if status.canSubscribeHere {
                offer(status)
            }

            Section {
                Button {
                    Task { await store.restore() }
                } label: {
                    HStack(spacing: 8) {
                        if store.purchasing == "restore" { ProgressView() }
                        Text("Restore purchases")
                    }
                }
                .disabled(store.purchasing != nil)
            } footer: {
                Text("If you have subscribed before on this Apple Account — on another phone, or before reinstalling — this brings it back.")
            }

            if let problem = store.problem {
                Section {
                    Label(problem, systemImage: "exclamationmark.triangle")
                        .font(Theme.note)
                        .foregroundStyle(Theme.negative)
                }
            }
        }
    }

    @ViewBuilder
    private func offer(_ status: BillingStatus) -> some View {
        Section {
            if store.loading {
                ProgressView().frame(maxWidth: .infinity)
            } else if store.products.isEmpty {
                // Almost always the products not being ready in App Store
                // Connect rather than anything the reader did.
                Text("Subscriptions are not available just now.")
                    .font(Theme.note)
                    .foregroundStyle(Theme.quietText)
            } else {
                ForEach(store.products, id: \.id) { product in
                    Button {
                        Task { await store.buy(product) }
                    } label: {
                        HStack(spacing: 8) {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(product.displayName)
                                    .font(Theme.body)
                                if !product.description.isEmpty {
                                    Text(product.description)
                                        .font(.caption2)
                                        .foregroundStyle(Theme.quietText)
                                }
                            }
                            Spacer(minLength: 8)
                            if store.purchasing == product.id {
                                ProgressView()
                            } else {
                                // From StoreKit, never from us: Apple localises
                                // and converts these, and a price written here
                                // would be wrong in most of the world.
                                Text(product.displayPrice)
                                    .font(Theme.body)
                                    .monospacedDigit()
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .disabled(store.purchasing != nil)
                }
            }
        } header: {
            Text(status.plan == "trial" ? "When the trial ends" : "Subscribe")
        } footer: {
            Text("Billed through your Apple Account. It renews until you cancel, which you can do in Settings at any time.")
        }
    }

    private func plan(_ status: BillingStatus) -> String {
        switch status.plan {
        case "trial":  return "Free month"
        case "active": return "Subscribed"
        case "lapsed": return "Ended"
        default:       return "Free"
        }
    }
}
