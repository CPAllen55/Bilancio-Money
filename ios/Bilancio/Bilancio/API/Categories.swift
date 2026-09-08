//
//  Categories.swift
//  Bilancio
//
//  Making a subcategory, and removing one nothing is using.
//

import Foundation

struct CategoryListResponse: Decodable {
    let categories: [TransactionsResponse.Category]
}

struct CategoryCreated: Decodable {
    /// False when one of that name already existed — the Worker hands back the
    /// existing one rather than making a private duplicate that would split
    /// the same spending in two.
    let created: Bool
    let category: Made
    let reason: String?

    struct Made: Decodable {
        let id: String
        let slug: String
    }
}

extension APIClient {
    func categoryList() async throws -> CategoryListResponse {
        try await get("/api/categories")
    }

    @discardableResult
    func createCategory(label: String, parentSlug: String) async throws -> CategoryCreated {
        try await send("POST", "/api/categories",
                       body: ["label": label, "parent": parentSlug])
    }

    /// Answers 409 with a reason when something is still filed under it, which
    /// arrives as the message on the thrown error.
    func deleteCategory(id: String) async throws {
        struct Gone: Decodable { let ok: Bool }
        let _: Gone = try await send("DELETE", "/api/categories/\(id)")
    }
}
