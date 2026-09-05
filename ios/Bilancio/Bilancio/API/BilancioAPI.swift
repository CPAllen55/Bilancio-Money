//
//  BilancioAPI.swift
//  Bilancio
//
//  The Worker at bilanciomoney.com, as seen from the app. Every /api/* route
//  except the Plaid webhook wants `Authorization: Bearer <Clerk session token>`;
//  see docs/ios-app-api.md at the root of this repository.
//

import Foundation

enum Bilancio {
    /// The apex and www both serve the Worker. The apex is canonical.
    static let apiBaseURL = URL(string: "https://bilanciomoney.com")!
}

/// Why a call did not produce a body.
///
/// `unauthorized` is kept separate from the other failures because it is the
/// only one the UI can act on: it means sign in again, not try again.
enum APIError: LocalizedError {
    case notSignedIn
    case unauthorized(reason: String)
    case http(status: Int, body: String)
    case transport(String)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .notSignedIn:
            return "Not signed in."
        case .unauthorized(let reason):
            // The Worker's reasons are deliberately coarse — see requireUser in
            // src/auth.ts — but they are the difference between an expired
            // token and a key mismatch, which is worth seeing while building.
            return "The server rejected the session (\(reason))."
        case .http(let status, let body):
            return "The server returned \(status). \(body)"
        case .transport(let message):
            return message
        case .decoding(let message):
            return "The response did not have the expected shape. \(message)"
        }
    }
}

/// The shape of an error body from the Worker.
private struct APIErrorBody: Decodable {
    let error: String
    let reason: String?
}

/// A thin JSON GET client.
///
/// The token is injected rather than read from Clerk in here, so this type
/// knows nothing about how a session is obtained and can be pointed at a stub.
struct APIClient {
    let baseURL: URL
    let token: () async throws -> String?

    /// A write. The body is encoded as JSON; the response is decoded like any
    /// other. Kept beside `get` rather than folded into it because a caller
    /// that mistypes a verb should not silently send a GET with a body.
    func send<T: Decodable>(
        _ method: String,
        _ path: String,
        body: [String: Any]? = nil
    ) async throws -> T {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw APIError.transport("Could not build a URL for \(path).")
        }
        guard let bearer = try await token() else { throw APIError.notSignedIn }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        return try await run(request)
    }

    func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        guard var components = URLComponents(
            url: baseURL.appendingPathComponent(path),
            resolvingAgainstBaseURL: false
        ) else {
            throw APIError.transport("Could not build a URL for \(path).")
        }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else {
            throw APIError.transport("Could not build a URL for \(path).")
        }

        guard let bearer = try await token() else { throw APIError.notSignedIn }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        return try await run(request)
    }

    /// Send, check, decode. Shared so the error handling cannot drift between
    /// reads and writes.
    private func run<T: Decodable>(_ request: URLRequest) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw APIError.transport(error.localizedDescription)
        }

        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if let body = try? JSONDecoder().decode(APIErrorBody.self, from: data) {
                if status == 401 {
                    throw APIError.unauthorized(reason: body.reason ?? body.error)
                }
                // The Worker's 400s explain themselves — "the parts add up to
                // more than the transaction" is the whole message a person
                // needs, and burying it under a status code helps nobody.
                throw APIError.http(status: status, body: body.reason ?? body.error)
            }
            throw APIError.http(status: status, body: String(data: data, encoding: .utf8) ?? "")
        }

        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.decoding(error.localizedDescription)
        }
    }
}

// MARK: - Erasing the account

/// What DELETE /api/account answers.
struct AccountDeletion: Decodable {
    /// How many bank connections were revoked at Plaid on the way through.
    let banksRevoked: Int
}

extension APIClient {
    /// Deletes everything.
    ///
    /// Not a soft delete: the Worker revokes every bank at Plaid, removes the
    /// user row and everything cascading from it, and then deletes the Clerk
    /// identity. There is nothing to undo afterwards and nothing to sign back
    /// into.
    ///
    /// Every bank is revoked before anything local is touched, and if one fails
    /// the Worker deletes nothing and answers 502. That failure has to reach
    /// the reader rather than being swallowed into a cheerful confirmation:
    /// "your banks are disconnected" when they are still live at Plaid is the
    /// one wrong thing this screen could say.
    @discardableResult
    func deleteAccount() async throws -> AccountDeletion {
        try await send("DELETE", "/api/account")
    }
}
