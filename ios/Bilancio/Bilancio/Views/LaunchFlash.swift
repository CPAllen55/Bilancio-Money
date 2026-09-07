//
//  LaunchFlash.swift
//  Bilancio
//
//  The owl, and chips stacking up in front of him, on the way to the dashboards.
//
//  It covers the moment the app is doing its least interesting work — fetching
//  the publishable key, configuring Clerk, restoring a session — so the wait
//  becomes the mark rather than a spinner. That it is also the brand arriving
//  is the point of it.
//
//  ── What `OwlLaunch` is ────────────────────────────────────────────────────
//
//  Not the app icon. The icon is a badge, and a badge shown large is a picture
//  of an icon rather than the owl himself — which is what this screen was, and
//  what it is not any more. `OwlLaunch` is generated from the same drawing with
//  the plate taken off: cropped inside its bevel, its corners rounded at the
//  bevel's own radius so no part of the rim survives, and its base faded out
//  because the stacks run to the bottom of the drawing and a hard edge there
//  reads as the chart being cut off rather than standing on the ground.
//
//  ── Why the chips are photographs ──────────────────────────────────────────
//
//  `OwlChip1…5` are real chips lifted out of the drawing, one per stack at that
//  stack's own width, cut to a rounded rect so they carry no ground with them.
//  A chip that lands is the same object as the ones it lands on, down to the
//  highlight along its top edge — which nothing drawn in code could match
//  against artwork this shaded. Three land on every stack.
//
//  ── What `OwlField` is ─────────────────────────────────────────────────────
//
//  The gold around it, and the reason it cannot be seen to end. The drawing's
//  ground varies across it as well as down it, so a flat colour is wrong at the
//  sides and a vertical gradient is wrong in the middle — both leave the owl
//  sitting in a visible rectangle of slightly different gold, which is exactly
//  what the first version did.
//
//  `OwlField` is the drawing itself blurred until nothing but its ground is
//  left, then carried out to a canvas tall enough for any phone. A blurred copy
//  matches the ground at every point of the drawing's own edge because it is
//  made of it, and clamping it outwards leaves no streaks because there is
//  nothing sharp left in it to streak.
//

import SwiftUI

struct LaunchFlash: View {
    /// Set false to play the whole thing out and fade away.
    @Binding var showing: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme

    @State private var settled = false
    /// How many chips have been let go, in `Chip.all` order. A chip falls when
    /// the count passes its index, so the whole sequence is one integer.
    @State private var dropped = 0
    @State private var fading = false

    var body: some View {
        GeometryReader { geo in
            let art = Art(size: geo.size)

            ZStack {
                Image("OwlField")
                    .resizable()
                    .frame(width: art.fieldWidth, height: art.fieldHeight)
                    .position(x: geo.size.width / 2, y: geo.size.height / 2)

                Image("OwlLaunch")
                    .resizable()
                    .interpolation(.high)
                    .frame(width: art.width, height: art.height)
                    .position(x: geo.size.width / 2, y: geo.size.height / 2)
                    .opacity(settled ? 1 : 0)

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
                        .opacity(settled ? 1 : 0)
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
            // A full screen of gold is a lot of gold at night.
            .overlay(scheme == .dark ? Color.black.opacity(0.18) : .clear)
            .opacity(fading ? 0 : 1)
        }
        .ignoresSafeArea()
        .task { await play() }
        .accessibilityHidden(true)
    }

    private func play() async {
        // Reduce Motion is a request not to be moved at, not a request to see
        // nothing: the stacks still end up taller, the chips simply arrive
        // rather than falling.
        guard !reduceMotion else {
            settled = true
            dropped = Chip.all.count
            try? await Task.sleep(for: .milliseconds(650))
            withAnimation(.easeOut(duration: 0.28)) { fading = true }
            try? await Task.sleep(for: .milliseconds(280))
            showing = false
            return
        }

        withAnimation(.easeOut(duration: 0.3)) { settled = true }
        try? await Task.sleep(for: .milliseconds(260))

        // `Chip.all` is ordered by level and then left to right, so the five
        // stacks rise together a course at a time. Bar by bar instead would
        // read as five separate events, and a chip cannot land on one that has
        // not arrived yet.
        for i in 1...Chip.all.count {
            withAnimation(.spring(duration: 0.38, bounce: 0.34)) { dropped = i }
            try? await Task.sleep(for: .milliseconds(36))
        }

        try? await Task.sleep(for: .milliseconds(400))
        withAnimation(.easeOut(duration: 0.3)) { fading = true }
        try? await Task.sleep(for: .milliseconds(300))
        showing = false
    }
}

// MARK: - Where the drawing sits

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

/// How the drawing meets the screen, and the gold behind it.
///
/// `OwlField` is generated from `OwlLaunch` at the same width, with the drawing
/// centred in it, so drawing both centred and at the same width puts every
/// point of the field exactly where it was blurred from.
private struct Art {
    /// `OwlLaunch`, in its own pixels.
    static let size = CGSize(width: 764, height: 824)
    /// `OwlField`, which is wider than any screen is tall relative to it.
    static let fieldSize = CGSize(width: 764, height: 1900)

    /// x range of each stack, left to right — its dark edges included, its
    /// drop shadow not. Measured against the outlines: the shadow beside each
    /// stack is close enough in tone to be taken for part of it, and taking it
    /// swells every stack and lands the chips visibly wide.
    static let stacks: [ClosedRange<CGFloat>] = [
        120...202, 219...315, 333...429, 450...549, 571...673,
    ]

    /// The top edge of each stack — where the next chip lands.
    static let tops: [CGFloat] = [743, 681, 613, 562, 515]

    /// One chip, divider to divider.
    static let pitch: CGFloat = 23.93

    let size: CGSize

    /// The drawing spans the width. Anything larger crops the owl's wings and
    /// the outer stack; anything smaller leaves him small on a field of gold.
    var width: CGFloat { size.width }
    var height: CGFloat { width * Art.size.height / Art.size.width }

    /// The field, at the same scale as the drawing so the two line up.
    var fieldWidth: CGFloat { width }
    var fieldHeight: CGFloat { width * Art.fieldSize.height / Art.fieldSize.width }

    /// Points per artwork pixel.
    var scale: CGFloat { width / Art.size.width }

    /// Where the drawing starts on screen.
    var originY: CGFloat { (size.height - height) / 2 }

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
