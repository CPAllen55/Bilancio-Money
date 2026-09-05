//
//  Components.swift
//  Bilancio
//
//  The pieces every screen is built from. They read their looks from Theme and
//  hold none of their own, so a change of appearance happens in one place.
//

import SwiftUI

// MARK: - Card

/// A rounded surface. Everything on a screen sits in one of these.
struct Card<Content: View>: View {
    var padding: CGFloat = Theme.cardPadding
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: .rect(cornerRadius: Theme.cardRadius))
    }
}

// MARK: - Comparison

/// Whether a figure going up is good news. Income rising is; expenses rising
/// is not, and the same arrow has to mean opposite things in the two tiles.
enum BetterWhen {
    case up, down
}

/// One figure measured against another — this period against the last, or
/// what was spent against what was planned.
struct Comparison {
    let current: Int
    let against: Int
    let betterWhen: BetterWhen
    /// How to say the difference.
    ///
    /// A percentage is the natural reading of one period against another. It
    /// stops being one when the denominator is small: a budget of $8,777
    /// against four days of spending is "1,006% more", which is arithmetic
    /// rather than information. Those read as money instead.
    var show: Display = .percent

    enum Display { case percent, amount }

    var change: Int { current - against }

    /// Nil when there is nothing to compare against. A period that did not
    /// exist is not a period of zero, and dividing by it would invent a
    /// percentage out of nothing.
    var percent: Double? {
        guard against != 0 else { return nil }
        return Double(change) / Double(abs(against)) * 100
    }

    var isGood: Bool {
        betterWhen == .up ? change >= 0 : change <= 0
    }

    var isFlat: Bool { change == 0 }

    /// What the tile prints under the figure, or nil when there is nothing
    /// honest to say. The period being compared against is named once, above
    /// the grid — repeating it in four narrow tiles only truncated it.
    var caption: String? {
        switch show {
        case .amount:
            return abs(change).asShortMoney
        case .percent:
            guard let pct = percent else { return nil }
            let digits = abs(pct) < 10 ? 1 : 0
            return pct.magnitude.formatted(.number.precision(.fractionLength(digits))) + "%"
        }
    }
}

// MARK: - Stat tile

/// A label, a figure, how it compares, and optionally its recent shape.
struct StatTile: View {
    let label: String
    let value: String
    var comparison: Comparison?
    var spark: [Int]?
    var sparkTint: Color = Theme.quietText
    /// Shown instead of a comparison when there is nothing to compare with.
    var emptyNote: String?

    var body: some View {
        Card(padding: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(label)
                    .font(Theme.tileLabel)
                    .foregroundStyle(Theme.quietText)
                    .lineLimit(1)

                Text(value)
                    .font(Theme.tileValue)
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)

                // Drawn whether or not there is a line to put in it. Four of
                // these sit in a grid, and a tile that omits a row it has no
                // data for is a tile shorter than the one beside it.
                Group {
                    if let spark, spark.contains(where: { $0 != 0 }) {
                        Sparkline(values: spark)
                            .stroke(sparkTint, style: .init(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
                    }
                }
                .frame(height: 20)
                .padding(.vertical, 1)

                caption
            }
            .frame(maxHeight: .infinity, alignment: .topLeading)
        }
        .frame(maxHeight: .infinity)
    }

    @ViewBuilder private var caption: some View {
        if let c = comparison, let text = c.caption {
            HStack(spacing: 3) {
                Image(systemName: c.isFlat ? "minus" : (c.change > 0 ? "arrow.up" : "arrow.down"))
                    .font(.system(size: 9, weight: .bold))
                Text(text).monospacedDigit()
            }
            .font(Theme.tileLabel)
            .foregroundStyle(c.isFlat ? Theme.quietText : (c.isGood ? Theme.positive : Theme.negative))
            .lineLimit(1)
        } else {
            Text(emptyNote ?? " ")
                .font(Theme.tileLabel)
                .foregroundStyle(Theme.quietText)
                .lineLimit(1)
        }
    }
}

// MARK: - Sparkline

/// Twelve months of a figure, drawn small.
///
/// Scaled across its own minimum and maximum rather than from zero: these sit
/// at caption size, and a line that never leaves the bottom eighth of the box
/// says nothing at all. It shows shape, never magnitude — the figure above it
/// is the magnitude.
struct Sparkline: Shape {
    let values: [Int]

    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard values.count > 1 else { return path }

        let low = values.min() ?? 0
        let high = values.max() ?? 0
        let span = high - low

        let step = rect.width / CGFloat(values.count - 1)

        for (i, v) in values.enumerated() {
            // A flat series has no span to scale by, and would divide by zero.
            // Drawn down the middle, which is what "it did not move" looks like.
            let ratio = span == 0 ? 0.5 : CGFloat(v - low) / CGFloat(span)
            let point = CGPoint(x: rect.minX + step * CGFloat(i),
                                y: rect.maxY - ratio * rect.height)
            i == 0 ? path.move(to: point) : path.addLine(to: point)
        }
        return path
    }
}

// MARK: - Proportion bar

/// One figure against what it was planned to be, with its amount printed
/// inside the bar.
///
/// This is the web's `meter`, and the three rules it encodes are all ones that
/// look like details and are not:
///
/// **The scale is the bar's own.** A bar with a plan runs to whichever of the
/// two is larger, so passing the plan is what fills the track. Only when
/// neither side has a plan do both bars fall back to a shared scale.
///
/// **The mark appears only once the plan has been passed.** Below it, the end
/// of the track *is* the plan, and a mark sitting on the end marks nothing.
///
/// **The caption is rounded to the dollar.** The plan is a shaped estimate, so
/// quoting it to the penny claims a precision it does not have. The exact
/// figures, cents and all, are in the tiles below.
struct ProportionBar: View {
    let label: String
    let amount: Int
    /// What this figure was budgeted to be, or 0 when there is no plan.
    var planned: Int = 0
    /// Used only when there is no plan, so the two bars on a card can still be
    /// read against one another.
    var fallbackScale: Int = 0
    let tint: Color
    /// "earned" or "spent" — the caption reads "$793 spent of $8,777".
    var verb: String

    private static let corner: CGFloat = 3
    private static let inset: CGFloat = 9

    private var scale: Int { planned > 0 ? max(amount, planned) : fallbackScale }
    private var isOver: Bool { planned > 0 && amount > planned }

    private func fraction(_ value: Int) -> Double {
        guard scale > 0 else { return 0 }
        return min(1, Double(value) / Double(scale))
    }

    private var captionText: String {
        planned > 0
            ? "\(amount.asShortMoney) \(verb) of \(planned.asShortMoney)"
            : "\(amount.asShortMoney) \(verb)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            // Skipped when the caller has already named the row above the bar,
            // which the Tracker does — a heading and a label saying the same
            // word twice is one of them wasted.
            if !label.isEmpty {
                Text(label.uppercased())
                    .font(.system(size: 11, weight: .medium))
                    .tracking(0.8)
                    .foregroundStyle(Theme.quietText)
            }

            GeometryReader { geo in
                let fill = max(2, geo.size.width * fraction(amount))

                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: Self.corner).fill(tint.opacity(0.16))
                    RoundedRectangle(cornerRadius: Self.corner).fill(tint).frame(width: fill)

                    // Drawn twice: once on the track, once clipped to the fill,
                    // so the ink changes colour exactly where the colour under
                    // it does. That is what lets the figure sit inside a bar of
                    // any length rather than jumping outside when it is short.
                    caption(width: geo.size.width).foregroundStyle(Theme.text)
                    caption(width: geo.size.width)
                        .foregroundStyle(.white)
                        .frame(width: fill, alignment: .leading)
                        .clipped()

                    if isOver {
                        Rectangle()
                            .fill(Theme.text)
                            .frame(width: 2)
                            .overlay(Rectangle().stroke(Theme.surface, lineWidth: 1))
                            .offset(x: geo.size.width * fraction(planned) - 1)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: Self.corner))
            }
            .frame(height: 21)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label), \(captionText)")
    }

    private func caption(width: CGFloat) -> some View {
        Text(captionText)
            .font(.system(size: 12, weight: .medium))
            .monospacedDigit()
            .lineLimit(1)
            .padding(.leading, Self.inset)
            .frame(width: width, alignment: .leading)
    }
}

// MARK: - Merchant logo

/// A merchant's logo, fetched from our own origin.
///
/// The API sends a filename, never a URL, and it has to stay that way. Plaid
/// returns a logo_url pointing at its own CDN; loading that directly would work
/// and would quietly break something written down in SECURITY.md and in the
/// published privacy policy — that the application makes no third-party
/// requests. Forty logos is forty requests to Plaid, each carrying the reader's
/// IP address and, by the filename, the name of a merchant they bank with.
/// Plaid already has the transaction; what they would gain is when it is being
/// looked at and from where.
///
/// `/api/logo/:file` needs no bearer token — it serves public merchant art
/// behind a strict filename allowlist — so this can be an ordinary AsyncImage
/// and gets URLSession's caching for free.
struct MerchantLogo: View {
    let file: String?
    let name: String
    var size: CGFloat = 28
    var tint: Color = Theme.accent

    private var url: URL? {
        guard let file, !file.isEmpty else { return nil }
        return Bilancio.apiBaseURL.appendingPathComponent("/api/logo/\(file)")
    }

    var body: some View {
        Group {
            if let url {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFit()
                    default:
                        // Covers loading, and covers the 404 the Worker caches
                        // for merchants Plaid has no art for — which is many of
                        // them, so this is the ordinary case and not an error.
                        monogram
                    }
                }
            } else {
                monogram
            }
        }
        .frame(width: size, height: size)
        .background(Theme.background)
        .clipShape(.rect(cornerRadius: size * 0.24))
        .overlay(
            RoundedRectangle(cornerRadius: size * 0.24)
                .stroke(Theme.hairline.opacity(0.5), lineWidth: 0.5)
        )
    }

    /// The first letter, which is what a person uses to find a row in a list
    /// they are scanning rather than reading.
    private var monogram: some View {
        ZStack {
            tint.opacity(0.14)
            Text(String(name.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased())
                .font(.system(size: size * 0.45, weight: .semibold, design: .rounded))
                .foregroundStyle(tint)
        }
    }
}
