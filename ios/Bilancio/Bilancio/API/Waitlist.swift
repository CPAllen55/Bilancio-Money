//
//  Waitlist.swift
//  Bilancio
//
//  POST /api/waitlist — the one call in the app that needs no session.
//

import Foundation

extension APIClient {
    /// Ask to be let in.
    ///
    /// Unauthenticated by necessity: somebody joining a waitlist has no account
    /// to sign in with, which is the whole reason they are asking. So this does
    /// not go through `send`, which requires a token and would refuse before
    /// the request left the phone.
    ///
    /// The Worker answers the same way whether the address was new or already
    /// there — otherwise anyone could test whether a given person had signed
    /// up — so there is no "you are already on the list" to report, and this
    /// returns nothing rather than pretending to know.
    static func joinWaitlist(email: String) async throws {
        var request = URLRequest(url: Bilancio.apiBaseURL.appendingPathComponent("/api/waitlist"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        /* Which of the two front doors this came through. The list is read by
           somebody deciding who to invite, and "asked from the app" and "asked
           from the website" are not the same signal. */
        request.httpBody = try JSONSerialization.data(
            withJSONObject: ["email": email, "source": "ios"],
        )

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw APIError.transport(error.localizedDescription)
        }

        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            struct Body: Decodable { let error: String; let reason: String? }
            let body = try? JSONDecoder().decode(Body.self, from: data)
            throw APIError.http(status: status, body: body?.reason ?? body?.error ?? "")
        }
    }
}
