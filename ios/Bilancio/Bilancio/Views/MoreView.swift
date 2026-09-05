//
//  MoreView.swift
//  Bilancio
//
//  The fifth tab: everything that does not earn a permanent slot.
//
//  A tab bar holds five things. There are more dashboards than that, and the
//  ones that miss out are not lesser — they are the ones looked at less often.
//  Budgeting is read when the plan changes; Net Worth when somebody wonders
//  where they stand; Forecast when they are thinking about the year. The four
//  in the bar are the ones opened most days.
//

import ClerkKit
import SwiftUI

/// Whether the app follows the system, or is pinned to one appearance.
///
/// Stored rather than derived, because "follow the system" is itself a choice
/// and has to be distinguishable from never having chosen.
enum Appearance: String, CaseIterable, Identifiable {
    case system, light, dark

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: return "System"
        case .light:  return "Light"
        case .dark:   return "Dark"
        }
    }

    /// Nil means "whatever the phone is set to", which is what SwiftUI wants
    /// for the system case.
    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light:  return .light
        case .dark:   return .dark
        }
    }
}

struct MoreView: View {
    @AppStorage("appearance") private var appearance: Appearance = .system

    var body: some View {
        NavigationStack {
            List {
                Section {
                    row("Budgeting", "slider.horizontal.3",
                        "What each month is supposed to cost") {
                        BudgetingView(embedded: true)
                    }
                    row("The year ahead", "calendar",
                        "Where the year ends up, on the same plan") {
                        ForecastView()
                    }
                    row("Net Worth", "building.columns",
                        "What is owned, what is owed") {
                        NetWorthView(embedded: true)
                    }
                } header: {
                    Text("Dashboards")
                }

                Section {
                    row("Banks", "creditcard", "Connections, and signing out") {
                        BanksView()
                    }
                } header: {
                    Text("Account")
                }

                Section {
                    Picker("Appearance", selection: $appearance) {
                        ForEach(Appearance.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                } header: {
                    Text("Appearance")
                } footer: {
                    Text("System follows whatever your iPhone is set to, including its light and dark schedule.")
                }
            }
            .navigationTitle("More")
            .owlMark()
        }
        .tint(Theme.accent)
    }

    private func row<Destination: View>(
        _ title: String,
        _ icon: String,
        _ subtitle: String,
        @ViewBuilder destination: @escaping () -> Destination
    ) -> some View {
        NavigationLink {
            destination()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 16))
                    .foregroundStyle(Theme.accent)
                    .frame(width: 26)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                    Text(subtitle)
                        .font(.caption2)
                        .foregroundStyle(Theme.quietText)
                }
            }
        }
    }
}
