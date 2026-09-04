//
//  ClerkBootstrap.swift
//  Bilancio
//
//  Clerk has to be configured before anything touches Clerk.shared — doing it
//  earlier trips an assertion in debug builds — and the publishable key comes
//  from the Worker rather than from source.
//
//  Fetching it costs one unauthenticated round trip at launch, and buys the
//  same property the web app has: the development and production instances
//  differ only in what /api/auth/config answers, never in what is built.
//

import ClerkKit
import Foundation

private struct AuthConfig: Decodable {
    let publishableKey: String
}

@MainActor
@Observable
final class ClerkBootstrap {
    enum State {
        case configuring
        case ready(Clerk)
        case failed(String)
    }

    private(set) var state: State = .configuring

    func start() async {
        // configure() is idempotent — it logs and returns the existing instance
        // if called twice — but re-entering on every view update would still be
        // wasted work, and would flicker the UI back through .configuring.
        if case .ready = state { return }

        state = .configuring
        do {
            let url = Bilancio.apiBaseURL.appendingPathComponent("/api/auth/config")
            let (data, response) = try await URLSession.shared.data(from: url)

            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(status) else {
                state = .failed("The server returned \(status) for /api/auth/config.")
                return
            }

            let config = try JSONDecoder().decode(AuthConfig.self, from: data)
            state = .ready(Clerk.configure(publishableKey: config.publishableKey))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
