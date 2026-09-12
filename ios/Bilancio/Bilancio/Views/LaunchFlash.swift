//
//  LaunchFlash.swift
//  Bilancio
//
//  The owl, still, with the light moving across his chart.
//
//  It covers the moment the app is doing its least interesting work — fetching
//  the publishable key, configuring Clerk, restoring a session — so the wait
//  becomes the mark rather than a spinner. That it is also the brand arriving
//  is the point of it.
//
//  ── Why nothing moves but the light ────────────────────────────────────────
//
//  Chips used to fall onto the stacks, three to each. The idea was that the
//  brand assembled itself; what it looked like was a picture being built out of
//  parts, and every landing was one more chance to notice the join between a
//  chip and the drawing beneath it. A drawing that arrives whole has no joins
//  to notice.
//
//  So the drawing simply appears, and one band of lighter gold crosses the five
//  stacks from left to right. Each stack takes the light and hands it on, which
//  reads as the chart catching the light rather than as anything being built.
//  The band is masked to the stacks alone: sweeping the whole picture would
//  wash across the owl, and it is the money that should glint.
//
//  ── What `OwlLaunch` is ────────────────────────────────────────────────────
//
//  Not the app icon. The icon is a badge, and a badge shown large is a picture
//  of an icon rather than the owl himself. `OwlLaunch` is generated from the
//  same drawing with the plate taken off: cropped inside its bevel, its corners
//  rounded at the bevel's own radius so no part of the rim survives, and its
//  base faded out because the stacks run to the bottom of the drawing and a
//  hard edge there reads as the chart being cut off rather than standing on
//  the ground.
//
//  ── What `OwlField` is ─────────────────────────────────────────────────────
//
//  The gold around it, and the reason it cannot be seen to end. The drawing's
//  ground varies across it as well as down it, so a flat colour is wrong at the
//  sides and a vertical gradient is wrong in the middle — both leave the owl
//  sitting in a visible rectangle of slightly different gold.
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

    /// The drawing fades in; the gold behind it never does. Fading the whole
    /// screen let the "Starting…" label underneath show through it.
    @State private var settled = false
    /// How lit each stack is, left to right.
    ///
    /// One plain rectangle per stack, and its opacity animated: three earlier
    /// attempts drew the light as a travelling band -- masked, then clipped
    /// inside a Canvas -- and none of them put a single pixel on screen. A
    /// rectangle at a position with an animated opacity is the least SwiftUI
    /// can be asked to do, and it is what the drawing's own fade already uses.
    @State private var glow = [Double](repeating: 0, count: Art.stacks.count)
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

                glint(in: art, across: geo.size)
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

    /// The stacks, each taking the light and handing it on.
    @ViewBuilder
    private func glint(in art: Art, across screen: CGSize) -> some View {
        ForEach(Array(Art.stacks.indices), id: \.self) { index in
            let rect = art.stackRect(index)
            Rectangle()
                .fill(Self.sheen)
                .opacity(glow[index] * Self.peak)
                .frame(width: rect.width, height: rect.height)
                .position(x: rect.midX, y: rect.midY)
                .allowsHitTesting(false)
        }
    }

    /// How pale a stack goes at the top of its turn.
    private static let peak = 0.45

    /// Gold with the light on it, not white: white would grey the chart on its
    /// way past.
    private static let sheen = Color(red: 1.0, green: 0.94, blue: 0.74)

    private func play() async {
        // Reduce Motion is a request not to be moved at. The drawing still
        // arrives; the light simply does not travel across it.
        guard !reduceMotion else {
            settled = true
            try? await Task.sleep(for: .milliseconds(900))
            withAnimation(.easeOut(duration: 0.28)) { fading = true }
            try? await Task.sleep(for: .milliseconds(280))
            showing = false
            return
        }

        withAnimation(.easeOut(duration: 0.34)) { settled = true }

        /* Long enough for the drawing to actually be on screen.
         *
         * `task` runs when the view appears, which is before the launch screen
         * has finished handing over -- so a sweep started here played out while
         * the screen was still washing in from white, and was over by the time
         * there was anything to see it on. */
        try? await Task.sleep(for: .milliseconds(750))

        /* Left to right, each stack a breath behind the one before it. Up and
           down are scheduled together: the whole wave is set going in one pass
           and then simply waited out. */
        for index in Art.stacks.indices {
            let delay = Double(index) * 0.14
            withAnimation(.easeInOut(duration: 0.40).delay(delay)) { glow[index] = 1 }
            withAnimation(.easeInOut(duration: 0.45).delay(delay + 0.40)) { glow[index] = 0 }
        }
        try? await Task.sleep(for: .milliseconds(1_450))

        try? await Task.sleep(for: .milliseconds(260))
        withAnimation(.easeOut(duration: 0.3)) { fading = true }
        try? await Task.sleep(for: .milliseconds(300))
        showing = false
    }
}

// MARK: - Where the drawing sits

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
    /// swells every stack and lights the ground beside it.
    static let stacks: [ClosedRange<CGFloat>] = [
        120...202, 219...315, 333...429, 450...549, 571...673,
    ]

    /// The painted top of each stack. The light starts there rather than at the
    /// top of the picture, so it crosses the chart and not the air above it.
    static let tops: [CGFloat] = [743, 681, 613, 562, 515]

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

    /// One stack, in screen points.
    func stackRect(_ index: Int) -> CGRect {
        let stack = Art.stacks[index]
        let top = originY + Art.tops[index] * scale
        return CGRect(x: stack.lowerBound * scale,
                      y: top,
                      width: (stack.upperBound - stack.lowerBound) * scale,
                      height: originY + height - top)
    }
}
