//
//  LaunchFlash.swift
//  Bilancio
//
//  The owl arriving: far too big for the screen, settling into it.
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
//  What the rounding takes away, and everything above and below the drawing, is
//  filled by the field below — the drawing's own first and last rows, extended
//  at the rate they fall. So the corners cannot be seen, and neither can the
//  join.
//

import SwiftUI

struct LaunchFlash: View {
    /// Set false to play the whole thing out and fade away.
    @Binding var showing: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme

    @State private var settled = false
    @State private var fading = false

    var body: some View {
        GeometryReader { geo in
            let art = Art(size: geo.size)

            ZStack {
                art.field.ignoresSafeArea()

                Image("OwlLaunch")
                    .resizable()
                    .interpolation(.high)
                    .frame(width: art.width, height: art.height)
                    .position(x: geo.size.width / 2, y: geo.size.height / 2)
                    // Arriving from far too close and settling back, rather
                    // than growing into place: the owl comes to meet you.
                    .scaleEffect(settled ? 1 : 2.6)
                    .opacity(settled ? 1 : 0)
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
        // nothing: the owl still appears, he simply arrives rather than flying
        // in at the reader.
        guard !reduceMotion else {
            settled = true
            try? await Task.sleep(for: .milliseconds(700))
            withAnimation(.easeOut(duration: 0.28)) { fading = true }
            try? await Task.sleep(for: .milliseconds(280))
            showing = false
            return
        }

        // Long enough to read as deceleration rather than a snap, with just
        // enough bounce to land rather than stop.
        withAnimation(.spring(duration: 0.75, bounce: 0.22)) { settled = true }
        try? await Task.sleep(for: .milliseconds(950))
        withAnimation(.easeOut(duration: 0.32)) { fading = true }
        try? await Task.sleep(for: .milliseconds(320))
        showing = false
    }
}

// MARK: - Where the drawing sits

/// How the drawing meets the screen, and the gold either side of it.
///
/// The two colours are the average of the artwork's own first and last rows,
/// measured off it rather than chosen, so the field arrives at the drawing at
/// the tone the drawing already is.
private struct Art {
    /// `OwlLaunch`, in its own pixels.
    static let size = CGSize(width: 764, height: 824)

    static let edgeTop = (r: 0.992, g: 0.812, b: 0.325)      // #FDCF53
    static let edgeBottom = (r: 0.878, g: 0.616, b: 0.145)   // #E09D25

    let size: CGSize

    /// The drawing spans the width. Anything larger crops the owl's wings and
    /// the outer stack; anything smaller leaves him small on a field of gold.
    var width: CGFloat { size.width }
    var height: CGFloat { width * Art.size.height / Art.size.width }

    /// Where the drawing starts, and so where the field's scale is anchored.
    var originY: CGFloat { (size.height - height) / 2 }

    /// The drawing's own fall, continued to the top and bottom of the screen.
    var field: LinearGradient {
        LinearGradient(colors: [colour(at: -originY / height),
                                colour(at: (size.height - originY) / height)],
                       startPoint: .top, endPoint: .bottom)
    }

    /// `t` is measured in artwork heights from its own first row, so 0 and 1
    /// are the two sampled rows and anything outside is the extension.
    private func colour(at t: CGFloat) -> Color {
        func mix(_ a: Double, _ b: Double) -> Double {
            min(1, max(0, a + (b - a) * Double(t)))
        }
        return Color(red: mix(Art.edgeTop.r, Art.edgeBottom.r),
                     green: mix(Art.edgeTop.g, Art.edgeBottom.g),
                     blue: mix(Art.edgeTop.b, Art.edgeBottom.b))
    }
}
