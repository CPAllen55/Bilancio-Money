//
//  SplitTransactionView.swift
//  Bilancio
//
//  Dividing one transaction between categories.
//
//  A merchant rule says where Central Market goes: Groceries, every time. That
//  is right for the merchant and wrong for the visit where a third of the
//  trolley was a birthday present. A split carves that third off without
//  arguing with the rule — the rule still governs the merchant, and this one
//  visit is divided.
//
//  Only the carved-off parts are sent. The remainder stays wherever the rule
//  put it and is never stored, because two numbers that have to agree
//  eventually do not.
//

import ClerkKit
import SwiftUI

@MainActor
@Observable
final class SplitEditor {
    /// One row in the editor. Amounts are held as positive magnitudes and given
    /// the transaction's sign on the way out — nobody types a minus sign to say
    /// how much of a purchase was groceries.
    struct Draft: Identifiable {
        let id = UUID()
        var categoryId: String?
        var magnitude: Int = 0
    }

    var drafts: [Draft] = []

    /// The category this transaction should be filed under. Changing it files
    /// every future transaction from the same merchant there too — which is
    /// what a merchant's category is for, and is why it is a separate control
    /// from the splits below it.
    var categoryId: String?
    /// What it was when the sheet opened, so an unchanged picker writes nothing.
    private let originalCategoryId: String?

    private(set) var saving = false
    private(set) var error: String?

    let row: TransactionsResponse.Row
    let categories: [TransactionsResponse.Category]

    private let client = APIClient(baseURL: Bilancio.apiBaseURL) {
        guard let session = Clerk.shared.session else { return nil }
        return try await session.getToken()
    }

    init(row: TransactionsResponse.Row, categories: [TransactionsResponse.Category]) {
        self.row = row
        self.categories = categories
        self.drafts = (row.splits ?? []).map {
            Draft(categoryId: $0.categoryId, magnitude: abs($0.amount))
        }
        // The row carries the resolved slug rather than an id, because a
        // category is settled per row at read time and is not a column.
        let current = categories.first { $0.slug == row.category }?.id
        self.categoryId = current
        self.originalCategoryId = current
    }

    var categoryChanged: Bool { categoryId != originalCategoryId }

    /// What the merchant will be filed under from now on, for the caption.
    var chosenCategoryLabel: String? {
        categories.first { $0.id == categoryId }?.label
    }

    /// The whole transaction, unsigned.
    var total: Int { abs(row.amount) }

    /// What has been carved off so far.
    var carved: Int { drafts.reduce(0) { $0 + $1.magnitude } }

    /// What is left on the original category. Never stored, always shown: it is
    /// the figure that tells someone whether they have finished.
    var remainder: Int { total - carved }

    /// The Worker refuses parts that add up to more than the transaction, and
    /// says so clearly. Catching it here means the reader is told before they
    /// press Save rather than after.
    var problem: String? {
        if carved > total { return "The parts add up to more than the transaction." }
        if drafts.contains(where: { $0.categoryId == nil && $0.magnitude > 0 }) {
            return "Every part needs a category."
        }
        return nil
    }

    var canSave: Bool { problem == nil && !saving && (categoryChanged || splitsChanged) }

    /// Whether the split rows differ from what was stored.
    var splitsChanged: Bool {
        let stored = (row.splits ?? [])
            .map { [$0.categoryId, String(abs($0.amount))].joined(separator: ":") }
            .sorted()
        let now = drafts
            .filter { $0.categoryId != nil && $0.magnitude > 0 }
            .map { [$0.categoryId!, String($0.magnitude)].joined(separator: ":") }
            .sorted()
        return stored != now
    }

    /// Leaves only, of the same side of the ledger as the transaction.
    ///
    /// A transaction belongs to a leaf: filing one on a parent would
    /// double-count it against its own children. And an expense carved into an
    /// income category would make the parts sum to more spending than the
    /// charge — arithmetic that holds while the meaning does not.
    var pickable: [TransactionsResponse.Category] {
        let side = row.amount > 0 ? "income" : "spend"
        return categories
            .filter { $0.isLeaf && $0.kind == side }
            .sorted { $0.label < $1.label }
    }

    /// The same leaves, under the parents they belong to.
    ///
    /// A flat list of thirty-one names is unusable, and the parent is the thing
    /// somebody navigates by — "it is a Food thing" comes before "it is
    /// Groceries". The parents are headings and carry no tag of their own, so
    /// they cannot be chosen: a transaction belongs to a leaf, and one filed on
    /// a parent would be counted twice against its own children.
    var groupedPickable: [(parent: TransactionsResponse.Category,
                           children: [TransactionsResponse.Category])] {
        let leaves = pickable
        let byParent = Dictionary(grouping: leaves) { $0.parentSlug ?? "" }
        let parents = categories.filter { $0.parentSlug == nil }

        return parents.compactMap { parent in
            guard let kids = byParent[parent.slug], !kids.isEmpty else { return nil }
            return (parent, kids)
        }
    }

    /// Leaves whose parent is missing from the tree. Shown rather than dropped:
    /// a category that cannot be chosen because of a gap in the hierarchy is a
    /// category somebody will hunt for and never find.
    var orphanPickable: [TransactionsResponse.Category] {
        let known = Set(categories.filter { $0.parentSlug == nil }.map(\.slug))
        return pickable.filter { !known.contains($0.parentSlug ?? "") }
    }

    func add() {
        drafts.append(Draft(categoryId: pickable.first?.id, magnitude: 0))
    }

    func remove(_ offsets: IndexSet) {
        drafts.remove(atOffsets: offsets)
    }

    /// True once saved, so the caller knows to reload and dismiss.
    func save() async -> Bool {
        guard canSave else { return false }
        saving = true
        error = nil
        defer { saving = false }

        // The category first. It is the coarser change of the two — it moves
        // the merchant as well as this row — and a split written against a
        // category that then failed to save would be parts of something filed
        // somewhere nobody chose.
        if categoryChanged, let categoryId {
            do {
                try await client.setCategory(transactionId: row.id,
                                             categoryId: categoryId,
                                             applyToMerchant: true)
            } catch {
                self.error = error.localizedDescription
                return false
            }
        }

        guard splitsChanged else { return true }

        // The sign comes from the transaction, and a zero row is somebody
        // clearing a line rather than a fact about anything.
        let sign = row.amount < 0 ? -1 : 1
        let parts = drafts.compactMap { d -> TransactionsResponse.Row.Part? in
            guard let id = d.categoryId, d.magnitude > 0 else { return nil }
            return .init(categoryId: id, amount: d.magnitude * sign)
        }

        do {
            _ = try await client.saveSplits(transactionId: row.id, parts: parts)
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }
}

struct SplitTransactionView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var editor: SplitEditor
    let onSaved: () -> Void

    init(row: TransactionsResponse.Row,
         categories: [TransactionsResponse.Category],
         onSaved: @escaping () -> Void) {
        _editor = State(initialValue: SplitEditor(row: row, categories: categories))
        self.onSaved = onSaved
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Merchant", value: editor.row.name)
                    LabeledContent("Date", value: editor.row.date)
                    LabeledContent("Amount", value: editor.row.amount.asMoney)
                }

                Section {
                    Picker("Category", selection: $editor.categoryId) {
                        Text("Unset").tag(String?.none)

                        ForEach(editor.groupedPickable, id: \.parent.id) { group in
                            Section(group.parent.label) {
                                ForEach(group.children) { cat in
                                    Text(cat.label).tag(String?.some(cat.id))
                                }
                            }
                        }

                        if !editor.orphanPickable.isEmpty {
                            Section("Other") {
                                ForEach(editor.orphanPickable) { cat in
                                    Text(cat.label).tag(String?.some(cat.id))
                                }
                            }
                        }
                    }
                    .pickerStyle(.navigationLink)
                } header: {
                    Text("Filed under")
                } footer: {
                    // Said plainly because it is the surprising half: this
                    // control does not only change the row in front of you.
                    if editor.categoryChanged, let label = editor.chosenCategoryLabel {
                        Text("Saving files this transaction under \(label), and every future one from \(editor.row.name) too. Splits below are separate and leave that alone.")
                    } else {
                        Text("Changing this files every future transaction from \(editor.row.name) the same way. To move only this one, split it below instead.")
                    }
                }

                Section {
                    ForEach($editor.drafts) { $draft in
                        VStack(alignment: .leading, spacing: 8) {
                            Picker("Category", selection: $draft.categoryId) {
                                Text("Choose…").tag(String?.none)
                                ForEach(editor.groupedPickable, id: \.parent.id) { group in
                                    Section(group.parent.label) {
                                        ForEach(group.children) { cat in
                                            Text(cat.label).tag(String?.some(cat.id))
                                        }
                                    }
                                }
                                if !editor.orphanPickable.isEmpty {
                                    Section("Other") {
                                        ForEach(editor.orphanPickable) { cat in
                                            Text(cat.label).tag(String?.some(cat.id))
                                        }
                                    }
                                }
                            }
                            .pickerStyle(.navigationLink)

                            HStack {
                                Text("Amount")
                                Spacer()
                                CentsField(cents: $draft.magnitude)
                            }
                        }
                    }
                    .onDelete { editor.remove($0) }

                    Button {
                        editor.add()
                    } label: {
                        Label("Add a part", systemImage: "plus.circle")
                    }
                    .disabled(editor.pickable.isEmpty)
                } header: {
                    Text("Split into")
                } footer: {
                    Text("Only this transaction, and only the parts you carve off. Whatever is left stays where it is, and the merchant keeps whatever category it already had.")
                }

                Section {
                    LabeledContent("Carved off", value: editor.carved.asMoney)
                    LabeledContent("Left where it is") {
                        Text(editor.remainder.asMoney)
                            .foregroundStyle(editor.remainder < 0 ? Theme.negative : Theme.text)
                    }
                }

                if let problem = editor.problem {
                    Section {
                        Label(problem, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(Theme.negative)
                    }
                }

                if let error = editor.error {
                    Section {
                        Label(error, systemImage: "xmark.octagon")
                            .foregroundStyle(Theme.negative)
                    }
                }
            }
            .navigationTitle("Transaction")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            if await editor.save() {
                                onSaved()
                                dismiss()
                            }
                        }
                    }
                    .disabled(!editor.canSave)
                }
            }
        }
    }
}

/// Money entry in cents.
///
/// The field holds an integer and formats it, rather than parsing a decimal
/// string back into one. Money is an integer everywhere in this app, and a
/// text field that accepts "12.3" and has to decide what that means is where
/// a rounding argument starts.
private struct CentsField: View {
    @Binding var cents: Int

    var body: some View {
        TextField(
            "0.00",
            value: Binding(
                get: { Decimal(cents) / 100 },
                set: { cents = NSDecimalNumber(decimal: $0 * 100).intValue }
            ),
            format: .currency(code: "USD")
        )
        .keyboardType(.decimalPad)
        .multilineTextAlignment(.trailing)
        .monospacedDigit()
    }
}
