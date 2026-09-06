//
//  LaunchFlash.swift
//  Bilancio
//
//  The owl, briefly, on the way to the dashboards.
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
        // There is nothing here Reduce Motion needs to suppress — the owl
        // fades in and out and does not move — so both paths are the same
        // except for the fade, which is what that setting is about.
        let arrive = reduceMotion ? 0.0 : 0.3

        withAnimation(.easeOut(duration: arrive)) { settled = true }
        try? await Task.sleep(for: .milliseconds(Int(arrive * 1000) + 450))
        withAnimation(.easeOut(duration: 0.28)) { fading = true }
        try? await Task.sleep(for: .milliseconds(280))
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

    let size: CGSize

    /// The drawing spans the width. Anything larger crops the owl's wings and
    /// the outer stack; anything smaller leaves him small on a field of gold.
    var width: CGFloat { size.width }
    var height: CGFloat { width * Art.size.height / Art.size.width }

    /// The field, at the same scale as the drawing so the two line up.
    var fieldWidth: CGFloat { width }
    var fieldHeight: CGFloat { width * Art.fieldSize.height / Art.fieldSize.width }
}
