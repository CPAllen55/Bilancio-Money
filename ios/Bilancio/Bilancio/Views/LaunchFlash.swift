//
//  LaunchFlash.swift
//  Bilancio
//
//  The badge, large, and then chips falling onto the stacks already in front of
//  the owl.
//
//  It covers the moment the app is doing its least interesting work — fetching
//  the publishable key, configuring Clerk, restoring a session — so the wait
//  becomes the mark rather than a spinner. That it is also the brand arriving
//  is the point of it.
//
//  ── Why the badge is a badge here, and not the whole screen ─────────────────
//
//  The drawing is a beveled plate on a gold that varies in two directions, and
//  the owl reaches its edges. So there is no honest way to run it edge to edge
//  on a screen twice as tall as it is wide: carrying the outer rows outwards
//  drags the ears and the stacks into long vertical smears, and cropping to the
//  height cuts the owl in half. Both were tried and both look like a mistake.
//
//  What the drawing does have is a rim, which is a legible edge — so it is
//  shown as what it is, a plate, at the full width of the screen, on a field
//  that continues its own top-to-bottom fall past both ends. The two colours
//  below are the average of its first and last rows, extended linearly, so the
//  field meets the rim at the tone the rim already is.
//
//  ── Why the chips are photographs ──────────────────────────────────────────
//
//  `OwlChip1…5` are real chips lifted out of the drawing, one per stack at that
//  stack's own width, cut to a rounded rect so they carry no ground with them.
//  A chip that lands is the same object as the ones it lands on, down to the
//  highlight along its top edge — which drawing one in code could not manage
//  against artwork this shaded. Three land on every stack.
//

import SwiftUI

struct LaunchFlash: View {
    /// Set false to play the whole thing out and fade away.
    @Binding var showing: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme

    @State private var owlIn = false
    /// How many chips have been let go, in `Chip.all` order. A chip falls when
    /// the count passes its index, so the whole sequence is one integer.
    @State private var dropped = 0
    @State private var fading = false

    var body: some View {
        GeometryReader { geo in
            let art = Art(size: geo.size)

            ZStack {
                art.field.ignoresSafeArea()

                Image("OwlLaunch")
                    .resizable()
                    .interpolation(.high)
                    .frame(width: art.side, height: art.side)
                    .position(x: geo.size.width / 2, y: geo.size.height / 2)
                    .scaleEffect(owlIn ? 1 : 0.94)
                    .opacity(owlIn ? 1 : 0)

                ForEach(Chip.all) { chip in
                    let frame = art.frame(of: chip)
                    Image("OwlChip\(chip.stack + 1)")
                        .resizable()
                        .interpolation(.high)
                        .frame(width: frame.width, height: frame.height)
                        .position(x: frame.midX, y: frame.midY)
                        // Off the top of the screen until its turn, so every
                        // chip enters from outside rather than materialising
                        // over the owl.
                        .offset(y: dropped > chip.order ? 0 : -(frame.maxY + 60))
                        .opacity(owlIn ? 1 : 0)
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
            // A full screen of gold is a lot of gold at night. Laid over the
            // field and the chips at once, so it dims the flash uniformly.
            .overlay(scheme == .dark ? Color.black.opacity(0.18) : .clear)
            .opacity(fading ? 0 : 1)
        }
        .ignoresSafeArea()
        .task { await play() }
        .accessibilityHidden(true)
    }

    private func play() async {
        // Reduce Motion is a request not to be moved at, not a request to see
        // nothing: the mark still appears, it simply arrives whole rather than
        // being assembled.
        guard !reduceMotion else {
            owlIn = true
            dropped = Chip.all.count
            try? await Task.sleep(for: .milliseconds(600))
            withAnimation(.easeOut(duration: 0.28)) { fading = true }
            try? await Task.sleep(for: .milliseconds(280))
            showing = false
            return
        }

        withAnimation(.spring(duration: 0.42, bounce: 0.28)) { owlIn = true }
        try? await Task.sleep(for: .milliseconds(300))

        // `Chip.all` is ordered by level and then left to right, so the five
        // stacks rise together a course at a time. Bar by bar instead would
        // read as five separate events, and a chip cannot land on one that has
        // not arrived yet.
        for i in 1...Chip.all.count {
            withAnimation(.spring(duration: 0.40, bounce: 0.34)) { dropped = i }
            try? await Task.sleep(for: .milliseconds(38))
        }

        try? await Task.sleep(for: .milliseconds(420))
        withAnimation(.easeOut(duration: 0.3)) { fading = true }
        try? await Task.sleep(for: .milliseconds(300))
        showing = false
    }
}

// MARK: - Where everything is

/// A chip's slot: which stack, and how far above that stack's painted top.
private struct Chip: Identifiable, Equatable {
    /// Index into `Art.stacks`.
    let stack: Int
    /// 0 is the chip that lands directly on the painted stack.
    let level: Int
    /// Position in the drop order.
    let order: Int

    var id: Int { order }

    /// Three courses across all five stacks, bottom course first.
    static let all: [Chip] = {
        var chips: [Chip] = []
        for level in 0..<3 {
            for stack in 0..<Art.stacks.count {
                chips.append(Chip(stack: stack, level: level, order: chips.count))
            }
        }
        return chips
    }()
}

/// The drawing's own geometry, in the pixels of `OwlLaunch` — which is the app
/// icon, so these are the icon's own coordinates and nothing is converted.
///
/// None of it is guessed. The stacks were found by reading a row of pixels
/// straight through all five and taking the bright chip bodies between their
/// dark edges: the drop shadow to the right of each one is close enough in tone
/// to be mistaken for the chip, and taking it swelled every stack by ten pixels
/// and landed the first chips visibly wide. The tops and the pitch came from
/// the divider rows inside each stack, the pitch agreeing to a third of a pixel
/// across all five.
///
/// Replacing the artwork means regenerating the five chips from it and
/// measuring all of this again.
private struct Art {
    /// The side of `OwlLaunch`, in its own pixels.
    static let badge: CGFloat = 1024

    /// x range of each stack, left to right — its dark edges included, its
    /// shadow not.
    static let stacks: [ClosedRange<CGFloat>] = [
        186...288, 309...428, 451...570, 596...719, 746...873,
    ]

    /// The top edge of each stack — where the next chip lands.
    static let tops: [CGFloat] = [923, 846, 762, 699, 640]

    /// One chip, divider to divider.
    static let pitch: CGFloat = 29.7

    /// The average of the drawing's first and last rows. The field is these
    /// two extended past the badge at the same rate, so it arrives at the rim
    /// already the colour of the rim.
    static let edgeTop = (r: 0.988, g: 0.835, b: 0.396)      // #FCD565
    static let edgeBottom = (r: 0.871, g: 0.643, b: 0.208)   // #DEA435

    let size: CGSize

    /// The badge spans the width. Anything larger crops the owl; anything
    /// smaller wastes the screen.
    var side: CGFloat { size.width }
    var scale: CGFloat { side / Art.badge }

    /// Where the badge starts, and so where the field's own scale is anchored.
    var originY: CGFloat { (size.height - side) / 2 }

    /// The drawing's fall, continued to the top and bottom of the screen.
    var field: LinearGradient {
        LinearGradient(colors: [colour(at: -originY / side),
                                colour(at: (size.height - originY) / side)],
                       startPoint: .top, endPoint: .bottom)
    }

    /// `t` is measured in badge heights from the badge's own top row, so 0 and
    /// 1 are the two sampled rows and anything outside is the extension.
    private func colour(at t: CGFloat) -> Color {
        func mix(_ a: Double, _ b: Double) -> Double {
            min(1, max(0, a + (b - a) * Double(t)))
        }
        return Color(red: mix(Art.edgeTop.r, Art.edgeBottom.r),
                     green: mix(Art.edgeTop.g, Art.edgeBottom.g),
                     blue: mix(Art.edgeTop.b, Art.edgeBottom.b))
    }

    /// Where a chip lands, in screen points.
    ///
    /// A chip's bottom edge sits on the edge it lands against, so the two
    /// outlines fall on the same line — which is how the painted chips meet
    /// each other, and the only way the join does not show.
    func frame(of chip: Chip) -> CGRect {
        let stack = Art.stacks[chip.stack]
        let top = Art.tops[chip.stack] - CGFloat(chip.level + 1) * Art.pitch
        return CGRect(x: stack.lowerBound * scale,
                      y: originY + top * scale,
                      width: (stack.upperBound - stack.lowerBound) * scale,
                      height: Art.pitch * scale)
    }
}
