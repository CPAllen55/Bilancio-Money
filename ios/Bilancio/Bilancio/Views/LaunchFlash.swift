//
//  LaunchFlash.swift
//  Bilancio
//
//  The owl, full screen, and then the chips falling onto the stacks already in
//  front of him.
//
//  It covers the moment the app is doing its least interesting work — fetching
//  the publishable key, configuring Clerk, restoring a session — so the wait
//  becomes the mark rather than a spinner. That it is also the brand arriving
//  is the point of it.
//
//  Two things make it work, and both are measurements rather than guesses.
//
//  The first is the crop. The artwork is a rounded badge on a gold ground, and
//  a badge shown edge to edge is a gold box with a line around it — which is
//  the one thing this mark has already been asked not to be. So the image is
//  cropped to the inside of that border and the rest of the screen is filled
//  with the same gold the crop edge is made of, sampled off the artwork itself.
//  There is no frame because the frame is off-screen, and no seam because the
//  ground on both sides of it is the same colour.
//
//  The second is the chip grid. The bars in the artwork are not solid: they are
//  stacks of chips, five stacks of 3, 6, 9, 12 and 15, on a ten-pixel pitch.
//  Those numbers were read out of the pixels, so the chips that fall land on
//  the pitch the painted ones are already on and the join is invisible. Three
//  land on every stack, which keeps the step between them at three and leaves
//  the mark's own arithmetic intact — it grows without becoming a different
//  shape.
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

            ZStack(alignment: .topLeading) {
                Art.ground

                owl(art)

                ForEach(Chip.all) { chip in
                    let frame = art.frame(of: chip)
                    ChipMark(stroke: art.stroke)
                        .frame(width: frame.width, height: frame.height)
                        .position(x: frame.midX, y: frame.midY)
                        // Off the top of the screen until its turn, so every
                        // chip enters from outside rather than materialising
                        // over the owl.
                        .offset(y: dropped > chip.order ? 0 : -(frame.maxY + 40))
                        .opacity(owlIn ? 1 : 0)
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
            // A full screen of gold is a lot of gold at night. Laid over both
            // the ground and the artwork at once, so it dims the flash without
            // reopening the seam between them.
            .overlay(scheme == .dark ? Color.black.opacity(0.18) : .clear)
            .opacity(fading ? 0 : 1)
        }
        .ignoresSafeArea()
        .task { await play() }
        .accessibilityHidden(true)
    }

    private func owl(_ art: Art) -> some View {
        Image("OwlBadge")
            .resizable()
            .interpolation(.high)
            .frame(width: art.imageSide, height: art.imageSide)
            .offset(x: -Art.crop.minX * art.scale, y: -Art.crop.minY * art.scale)
            // Sized to the crop and clipped to it: everything outside is the
            // badge's border, which is what is being got rid of.
            .frame(width: art.band.width, height: art.band.height, alignment: .topLeading)
            .clipShape(RoundedRectangle(cornerRadius: Art.cropRadius * art.scale, style: .circular))
            .offset(x: art.band.minX, y: art.band.minY)
            .scaleEffect(owlIn ? 1 : 0.92)
            .opacity(owlIn ? 1 : 0)
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

// MARK: - One chip

/// A single chip: the artwork's fill with its outline, so a chip that has
/// landed is indistinguishable from one that was always painted there.
private struct ChipMark: View {
    let stroke: CGFloat

    var body: some View {
        Rectangle()
            .fill(Art.chipFill)
            .overlay(Rectangle().strokeBorder(Art.chipStroke, lineWidth: stroke))
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

/// The artwork's own geometry, in the pixels of the 512pt badge.
///
/// Every number here was read off `owl-badge.png` rather than eyeballed: the
/// stacks by tracing their outlines, the pitch and the tops by finding the
/// divider rows inside them, the frame by following its stroke around a corner,
/// the colours by sampling. If the artwork is ever redrawn these all have to be
/// measured again, which is why they are together in one place rather than
/// spread through the view.
private struct Art {
    /// The inside of the badge's border, which is all of it that is shown.
    ///
    /// Rounded, because the badge is. A rectangle cut just inside the frame's
    /// straight edges still catches the four corner arcs, which is what the
    /// first attempt did — the owl arrived full screen with the corners of a
    /// box around him. The corners are squircles rather than circles, so this
    /// was fitted against the stroke's measured inner edge rather than derived:
    /// at this radius nothing of the frame survives the clip and nothing of the
    /// bars is lost to it.
    static let crop = CGRect(x: 76, y: 54, width: 352, height: 410)
    static let cropRadius: CGFloat = 56

    /// Where the badge is drawn on the sheet the crop is taken from.
    static let side: CGFloat = 512

    /// x range of each painted stack, left to right — outline included.
    ///
    /// Measured across the stacks' side outlines rather than their striped
    /// fill. The fill is the obvious thing to find and it is four or five
    /// pixels narrower on each side, which is enough to see: the first chips
    /// landed visibly inset, sitting on the stacks rather than continuing them.
    /// The stacks are not all the same width, and are not meant to be.
    static let stacks: [ClosedRange<CGFloat>] = [118...163, 171...218, 228...276, 287...336, 349...399]

    /// The top edge of each painted stack — where the next chip lands.
    static let tops: [CGFloat] = [421, 391, 361, 330, 295]

    /// One chip, divider to divider.
    static let pitch: CGFloat = 10.1

    /// Sampled from the artwork so the fill behind and around the crop is the
    /// colour the crop edge already is, and the join cannot be seen.
    static let ground = Color(hex: "#EFBD54")
    static let chipFill = Color(hex: "#F4CD60")
    static let chipStroke = Color(hex: "#9D6D23")

    let size: CGSize

    /// Points per artwork pixel.
    ///
    /// Whichever axis runs out first. On a phone held upright that is the
    /// width, and the crop then runs edge to edge with no seam down either
    /// side. Turned on its side — or on an iPad — it is the height instead,
    /// and the artwork is inset rather than cropped through the owl. Either
    /// way what is beside it is the same gold as its edge.
    var scale: CGFloat {
        min(size.width / Art.crop.width, size.height / Art.crop.height)
    }

    var imageSide: CGFloat { Art.side * scale }

    /// The part of the screen the artwork occupies, centred.
    var band: CGRect {
        let width = Art.crop.width * scale
        let height = Art.crop.height * scale
        return CGRect(x: (size.width - width) / 2, y: (size.height - height) / 2,
                      width: width, height: height)
    }

    /// A divider in the artwork is about five pixels, and two chips meeting
    /// each contribute half of it — `strokeBorder` draws inwards.
    var stroke: CGFloat { max(1.5, 3 * scale) }

    /// Where a chip lands, in screen points.
    ///
    /// A chip's bottom edge sits on the edge it lands against, so the two
    /// outlines fall on the same line — which is how the painted chips meet
    /// each other, and the only way the join does not show.
    func frame(of chip: Chip) -> CGRect {
        let stack = Art.stacks[chip.stack]
        let top = Art.tops[chip.stack] - CGFloat(chip.level + 1) * Art.pitch
        return CGRect(
            x: band.minX + (stack.lowerBound - Art.crop.minX) * scale,
            y: band.minY + (top - Art.crop.minY) * scale,
            width: (stack.upperBound - stack.lowerBound) * scale,
            height: Art.pitch * scale
        )
    }
}
