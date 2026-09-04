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

/// One figure drawn as a share of a larger one, with its amount printed inside
/// the bar and, optionally, the figure it was planned to be marked on it.
///
/// Both bars on a card are drawn against one scale, so the difference in their
/// lengths is the money kept — visible without reading either number.
///
/// The amount is drawn twice: once on the track, once clipped to the fill. The
/// ink then changes colour exactly where the colour under it does, which is
/// what lets the number sit inside the bar at any length instead of jumping
/// outside it when the bar gets short.
struct ProportionBar: View {
    let label: String
    let amount: Int
    let of: Int
    let tint: Color
    /// What this figure was budgeted to be, drawn as a tick. Nil when there is
    /// no plan to draw — a mark at zero would read as a budget of nothing
    /// rather than as the absence of one.
    var marker: Int?

    private static let corner: CGFloat = 3
    private static let inset: CGFloat = 9

    private func fraction(_ value: Int) -> Double {
        guard of > 0 else { return 0 }
        return min(1, Double(value) / Double(of))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label.uppercased())
                .font(.system(size: 11, weight: .medium))
                .tracking(0.8)
                .foregroundStyle(Theme.quietText)

            GeometryReader { geo in
                let fill = max(2, geo.size.width * fraction(amount))

                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: Self.corner).fill(tint.opacity(0.16))
                    RoundedRectangle(cornerRadius: Self.corner).fill(tint).frame(width: fill)

                    caption(width: geo.size.width).foregroundStyle(Theme.text)
                    caption(width: geo.size.width)
                        .foregroundStyle(.white)
                        .frame(width: fill, alignment: .leading)
                        .clipped()

                    if let marker, marker > 0, marker < of {
                        // Outlined, because it crosses both the filled and
                        // unfilled parts of the track and has to stay visible
                        // against either.
                        Rectangle()
                            .fill(Theme.text)
                            .frame(width: 2)
                            .overlay(Rectangle().stroke(Theme.surface, lineWidth: 1))
                            .offset(x: geo.size.width * fraction(marker) - 1)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: Self.corner))
            }
            .frame(height: 21)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label) \(amount.asMoney)")
    }

    private func caption(width: CGFloat) -> some View {
        Text(amount.asMoney)
            .font(.system(size: 12, weight: .medium))
            .monospacedDigit()
            .padding(.leading, Self.inset)
            .frame(width: width, alignment: .leading)
    }
}
