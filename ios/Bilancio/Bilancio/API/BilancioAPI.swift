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

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw APIError.transport(error.localizedDescription)
        }

        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if status == 401, let body = try? JSONDecoder().decode(APIErrorBody.self, from: data) {
                throw APIError.unauthorized(reason: body.reason ?? body.error)
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
