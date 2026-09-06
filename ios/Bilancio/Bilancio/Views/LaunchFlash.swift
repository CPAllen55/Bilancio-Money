//
//  LaunchFlash.swift
//  Bilancio
//
//  The owl, and then the bars stacking up in front of it.
//
//  It covers the moment the app is doing its least interesting work — fetching
//  the publishable key, configuring Clerk, restoring a session — so the wait
//  becomes the mark rather than a spinner. That it is also the brand arriving
//  is the point of it.
//
//  Kept short on purpose. An animation somebody sees three times a day earns
//  about a second of their attention and no more; the second viewing is where
//  a launch flash stops being charming and starts being in the way.
//

import SwiftUI

struct LaunchFlash: View {
    /// Set false to play the whole thing out and fade away.
    @Binding var showing: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var owlIn = false
    @State private var risen = 0
    @State private var fading = false

    /// Five, ascending, the way the badge draws them. The launch bars echo the
    /// artwork rather than inventing a rhythm of their own.
    private let heights: [CGFloat] = [16, 26, 35, 46, 58]

    private let badge: CGFloat = 132

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            // Tight, because in the mark itself the bars stand in front of the
            // owl rather than beneath it at a distance. A gap here reads as two
            // logos rather than one.
            VStack(spacing: 2) {
                // The badge itself, the same artwork the home screen shows, so
                // launching the app and tapping its icon are recognisably the
                // same object. The outlined head is for navigation bars, where
                // a full badge would be a postage stamp of detail.
                Image("OwlBadge")
                    .resizable()
                    .scaledToFit()
                    .frame(width: badge, height: badge)
                    // The artwork is drawn on an opaque ground, so the corners
                    // are cut here rather than in the file — near enough the
                    // squircle iOS masks the icon with.
                    .clipShape(.rect(cornerRadius: badge * 0.23))
                    .opacity(owlIn ? 1 : 0)
                    .scaleEffect(owlIn ? 1 : 0.82)
                    // Gold rather than black, which reads as a glow on a dark
                    // ground and as depth on a light one without needing two
                    // treatments.
                    .shadow(color: Theme.accent.opacity(owlIn ? 0.4 : 0), radius: 22, y: 6)

                HStack(alignment: .bottom, spacing: 7) {
                    ForEach(heights.indices, id: \.self) { i in
                        Capsule()
                            .fill(Theme.accent)
                            .frame(width: 11, height: i < risen ? heights[i] : 3)
                            .opacity(i < risen ? 1 : 0.25)
                    }
                }
                .frame(height: 60, alignment: .bottom)
                .padding(.top, 6)
            }
            .opacity(fading ? 0 : 1)
            .scaleEffect(fading ? 1.06 : 1)
        }
        .task { await play() }
        .accessibilityHidden(true)
    }

    private func play() async {
        // Reduce Motion is a request not to be moved at, not a request to see
        // nothing: the mark still appears, it simply arrives rather than
        // animating in, and the bars are up from the start.
        guard !reduceMotion else {
            owlIn = true
            risen = heights.count
            try? await Task.sleep(for: .milliseconds(500))
            withAnimation(.easeOut(duration: 0.25)) { fading = true }
            try? await Task.sleep(for: .milliseconds(250))
            showing = false
            return
        }

        withAnimation(.spring(duration: 0.45, bounce: 0.35)) { owlIn = true }
        try? await Task.sleep(for: .milliseconds(220))

        // One at a time, left to right, the way a chart fills in.
        for i in 1...heights.count {
            withAnimation(.spring(duration: 0.34, bounce: 0.45)) { risen = i }
            try? await Task.sleep(for: .milliseconds(85))
        }

        try? await Task.sleep(for: .milliseconds(320))
        withAnimation(.easeOut(duration: 0.3)) { fading = true }
        try? await Task.sleep(for: .milliseconds(300))
        showing = false
    }
}
