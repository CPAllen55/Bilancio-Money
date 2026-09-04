//
//  Theme.swift
//  Bilancio
//
//  Every colour, font and measurement the app draws with, in one place.
//
//  The app currently looks like an iPhone app rather than like the web
//  dashboard, and that is a choice rather than a limitation. It is kept a
//  choice by this file: screens ask for `Theme.positive` and
//  `Theme.figure(48)`, never for `Color.green` or `.system(size: 48)`. Deciding
//  later that the two should match means changing the values here and the
//  handful of components beside it, rather than editing every view.
//
//  What that does not cover is structure — a tab bar is not a horizontal view
//  switcher, and no amount of retokenising turns one into the other. Layout
//  stays deliberately plain for the same reason.
//

import SwiftUI

enum Theme {

    // MARK: Surfaces

    /// Behind everything. The grouped variants are what iOS uses for screens
    /// built out of cards, which is what every screen here is.
    static var background: Color { Color(.systemGroupedBackground) }
    static var surface: Color { Color(.secondarySystemGroupedBackground) }
    static var hairline: Color { Color(.separator) }

    // MARK: Text

    static var text: Color { .primary }
    static var quietText: Color { .secondary }

    // MARK: Meaning
    //
    // Named for what they mean, not for what colour they are. A tile asks for
    // `positive`, so the day green stops meaning "good" it changes once.

    static var positive: Color { Color(.systemGreen) }
    static var negative: Color { Color(.systemRed) }
    static var caution: Color { Color(.systemOrange) }

    /// The one piece of the brand that survives into a native look. Gold on
    /// the web; here it tints controls and nothing else.
    static var accent: Color { Color(red: 0.63, green: 0.44, blue: 0.15) }

    /// Money in and money out, wherever the two appear side by side.
    static var incomeTint: Color { positive }
    static var expenseTint: Color { negative }

    /// The colour a signed figure should be drawn in. Zero is not a loss.
    static func tint(forNet cents: Int) -> Color {
        cents < 0 ? negative : positive
    }

    // MARK: Type
    //
    // System fonts, so the app inherits Dynamic Type and looks native. The web
    // uses Space Grotesk and IBM Plex; matching it means bundling those files
    // and changing these three functions.

    /// The one big number on a screen.
    static func figure(_ size: CGFloat) -> Font {
        .system(size: size, weight: .semibold, design: .rounded)
    }

    static var tileValue: Font { .system(.title2, design: .rounded).weight(.semibold) }
    static var tileLabel: Font { .caption }
    static var body: Font { .subheadline }
    static var note: Font { .footnote }

    // MARK: Metrics

    static let cardRadius: CGFloat = 12
    static let cardPadding: CGFloat = 14
    static let gutter: CGFloat = 12
    static let sectionGap: CGFloat = 20
}
