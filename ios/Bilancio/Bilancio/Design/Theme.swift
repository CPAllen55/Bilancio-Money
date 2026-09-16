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

    /// The one piece of the brand that survives into a native look.
    ///
    /// Two golds, not one. The deep gold that reads as gold on paper goes
    /// muddy on black, and the pale gold that glows on black is illegible on
    /// white — this is the same split the web makes between --gold-1 in each
    /// theme, and a single value cannot serve both.
    static var accent: Color {
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.79, green: 0.64, blue: 0.15, alpha: 1)
                : UIColor(red: 0.63, green: 0.44, blue: 0.15, alpha: 1)
        })
    }

    /// Money in and money out, wherever the two appear side by side.
    static var incomeTint: Color { positive }
    static var expenseTint: Color { negative }

    /// The colour a signed figure should be drawn in. Zero is not a loss.
    static func tint(forNet cents: Int) -> Color {
        cents < 0 ? negative : positive
    }

    // MARK: Budget marks
    //
    // Where a plan sat on a bar. Green on the income side and red on the
    // spending side — the side, not the state: a spending bar turns amber near
    // its limit and red past it, and its mark stays red throughout, because
    // what the mark means is "this is the plan" and not "this is how it went".
    //
    // Brighter than the bar they cut, so they cannot be taken for the fill. The
    // old marks were `Theme.text` at two points wide, which read as a scratch on
    // the bar rather than as a plan.
    //
    // Two pairs, because where a mark stands proud it is read against the card
    // rather than against the bar. The values are the web app's, measured there
    // rather than guessed here: on cream the bright shades are faint on their
    // own and carry a dark ring; on the near-black card they carry the card's
    // own colour.

    static var markIn: Color {
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.357, green: 0.941, blue: 0.710, alpha: 1)  // #5BF0B5
                : UIColor(red: 0.247, green: 0.878, blue: 0.561, alpha: 1)  // #3FE08F
        })
    }

    static var markOut: Color {
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 1.000, green: 0.604, blue: 0.659, alpha: 1)  // #FF9AA8
                : UIColor(red: 1.000, green: 0.498, blue: 0.576, alpha: 1)  // #FF7F93
        })
    }

    /// The hairline around a mark, so it separates from the fill on one side
    /// and from the card on the other.
    static var markRing: Color {
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor.secondarySystemGroupedBackground
                : UIColor(red: 0.071, green: 0.145, blue: 0.247, alpha: 0.62)
        })
    }

    /// The owl, in whichever colour the theme calls for.
    ///
    /// One shape, tinted, rather than two pieces of artwork. The gold mark is
    /// drawn on an opaque gold ground, so cropping the head out of it leaves a
    /// gold box with a face in it — obvious the moment you look. The outlined
    /// mark is drawn on transparency, so it is the one that can be any colour
    /// at all, and template rendering makes it both.
    ///
    /// Mint in the dark, which is the green the web app uses for the same mark.
    static var markTint: Color {
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.00, green: 0.94, blue: 0.66, alpha: 1)
                : UIColor(red: 0.63, green: 0.44, blue: 0.15, alpha: 1)
        })
    }

    /// Colours for slices of one thing — vendors inside a category, and
    /// anything else where the parts have no colour of their own.
    ///
    /// Ordered and fixed, never generated. A chart whose colours depend on the
    /// order data happens to arrive in gives the same vendor a different colour
    /// on every launch, which is a bug this app has already had once.
    ///
    /// Not shades of the category's own colour, tempting as that is: six tints
    /// of one hue are elegant in a legend and indistinguishable in a slice.
    static let series: [Color] = [
        Color(red: 0.20, green: 0.47, blue: 0.85),
        Color(red: 0.85, green: 0.45, blue: 0.15),
        Color(red: 0.16, green: 0.63, blue: 0.45),
        Color(red: 0.62, green: 0.35, blue: 0.78),
        Color(red: 0.83, green: 0.25, blue: 0.38),
        Color(red: 0.42, green: 0.55, blue: 0.20),
        Color(red: 0.45, green: 0.45, blue: 0.50),
    ]

    /// What is left after the named slices. Deliberately the quietest colour
    /// on the wheel: it is a remainder, not a finding.
    static var seriesRest: Color { Color(.systemGray3) }

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

    /// How wide a dashboard's column is allowed to get.
    ///
    /// Every card here is a label against a figure, and stretched across an
    /// iPad the two end up a hand's width apart with nothing between them —
    /// which is not a wider card, it is the same card with the answer moved
    /// away from the question. 700 is close to the widest an iPhone Pro Max
    /// reads at, so the phone is unaffected and the iPad gets the layout the
    /// cards were drawn for, centred, rather than one stretched to fit.
    static let column: CGFloat = 700
}
