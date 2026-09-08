//
//  CategoriesView.swift
//  Bilancio
//
//  The tree everything is filed into, and the two things a reader can do to it.
//
//  Adding is the useful half. The standard categories are a guess at what most
//  people spend on, and the first thing anybody finds is the spending that does
//  not fit — a hobby, a second property, a business line. Filing that under
//  Other is filing it nowhere.
//
//  Removing is the half that has to be careful. A category with spending behind
//  it cannot go without deciding where that spending went, and the Worker
//  refuses rather than guessing — see the delete route. This screen's job is to
//  say what is in the way in a sentence somebody can act on.
//

import ClerkKit
import SwiftUI

@MainActor
@Observable
final class CategoriesModel {
    enum State { case loading, loaded([TransactionsResponse.Category]), failed(String) }
    private(set) var state: State = .loading
    private(set) var working = false
    /// The last refusal, kept until the next thing happens. A delete that is
    /// declined has to say why, and the reason is the whole message.
    private(set) var problem: String?

    private let client = APIClient(baseURL: Bilancio.apiBaseURL) {
        guard let session = Clerk.shared.session else { return nil }
        return try await session.getToken()
    }

    func load() async {
        do { state = .loaded(try await client.categoryList().categories) }
        catch { state = .failed(error.localizedDescription) }
    }

    func add(label: String, under parentSlug: String) async {
        working = true
        problem = nil
        defer { working = false }
        do {
            let made = try await client.createCategory(label: label, parentSlug: parentSlug)
            if !made.created {
                // Not an error: the Worker handed back the one that already
                // covers this rather than making a duplicate. Saying so beats
                // a silent no-op that looks like the button failed.
                problem = made.reason ?? "That one already exists."
            }
            await load()
        } catch {
            problem = error.localizedDescription
        }
    }

    func remove(_ category: TransactionsResponse.Category) async {
        working = true
        problem = nil
        defer { working = false }
        do {
            try await client.deleteCategory(id: category.id)
            await load()
        } catch {
            // The Worker's reason arrives as the message: "transactions are
            // filed under it", and so on. Prefixed with the name because the
            // list has just closed over the row it was about.
            problem = "\(category.label): \(error.localizedDescription)"
        }
    }
}

struct CategoriesView: View {
    @State private var model = CategoriesModel()
    @State private var adding: TransactionsResponse.Category?

    var body: some View {
        Group {
            switch model.state {
            case .loading:
                ProgressView("Loading…")

            case .failed(let message):
                ContentUnavailableView {
                    Label("Could not load your categories", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try again") { Task { await model.load() } }
                        .buttonStyle(.borderedProminent)
                }

            case .loaded(let all):
                list(all)
            }
        }
        .navigationTitle("Categories")
        .navigationBarTitleDisplayMode(.large)
        .task { await model.load() }
        .refreshable { await model.load() }
        .sheet(item: $adding) { parent in
            AddSubcategory(parent: parent) { name in
                Task { await model.add(label: name, under: parent.slug) }
            }
        }
    }

    private func list(_ all: [TransactionsResponse.Category]) -> some View {
        List {
            if let problem = model.problem {
                Section {
                    Label(problem, systemImage: "exclamationmark.triangle")
                        .font(Theme.note)
                        .foregroundStyle(Theme.negative)
                }
            }

            ForEach(all.filter { $0.parentSlug == nil }) { parent in
                Section {
                    ForEach(all.filter { $0.parentSlug == parent.slug }) { child in
                        row(child)
                    }

                    Button {
                        adding = parent
                    } label: {
                        Label("Add a subcategory", systemImage: "plus")
                            .font(Theme.note)
                    }
                    .disabled(model.working)
                } header: {
                    HStack(spacing: 8) {
                        Circle()
                            .fill(Color(hex: parent.colour))
                            .frame(width: 8, height: 8)
                        Text(parent.label)
                    }
                }
            }
        }
    }

    private func row(_ category: TransactionsResponse.Category) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(Color(hex: category.colour))
                .frame(width: 8, height: 8)
            Text(category.label)
            Spacer(minLength: 8)
            // Said rather than left to be discovered by swiping and finding
            // nothing there. The standard ones are shared by every account and
            // the classifier maps Plaid's taxonomy onto their slugs.
            if !category.isMine {
                Text("standard")
                    .font(.caption2)
                    .foregroundStyle(Theme.quietText)
            }
        }
        .swipeActions(edge: .trailing) {
            if category.isMine {
                Button(role: .destructive) {
                    Task { await model.remove(category) }
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
        }
    }
}

// MARK: - Adding one

private struct AddSubcategory: View {
    let parent: TransactionsResponse.Category
    let onAdd: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                        .textInputAutocapitalization(.words)
                } header: {
                    Text("New subcategory")
                } footer: {
                    // The two things that are decided for them, said before
                    // they happen rather than noticed afterwards.
                    Text("It sits under \(parent.label), takes its colour, and counts on the same side of the ledger.")
                }
            }
            .navigationTitle(parent.label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        onAdd(name.trimmingCharacters(in: .whitespaces))
                        dismiss()
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .tint(Theme.accent)
    }
}
