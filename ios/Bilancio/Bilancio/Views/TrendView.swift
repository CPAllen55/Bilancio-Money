//
//  TrendView.swift
//  Bilancio
//
//  Month by month: what came in, what went out, and the gap between them.
//  A bad month inside a good year is not the same thing as a bad year, which
//  is the whole reason this screen exists separately from the Overview.
//

import Charts
import ClerkKit
import SwiftUI

@MainActor
@Observable
final class TrendModel {
    enum State {
        case loading
        case loaded(TrendResponse)
        case failed(String)
    }

    private(set) var state: State = .loading
    var months: Int = 12

    private let client = APIClient(baseURL: Bilancio.apiBaseURL) {
        guard let session = Clerk.shared.session else { return nil }
        return try await session.getToken()
    }

    func load() async {
        do {
            state = .loaded(try await client.trend(months: months))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}

struct TrendView: View {
    @State private var model = TrendModel()
    /// The parent category being looked inside, or nil for all of them.
    @State private var drilled: String?

    var body: some View {
        NavigationStack {
            Group {
                switch model.state {
                case .loading:
                    ProgressView("Loading…")

                case .failed(let message):
                    ContentUnavailableView {
                        Label("Could not load the trend", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Try again") { Task { await model.load() } }
                            .buttonStyle(.borderedProminent)
                    }

                case .loaded(let data):
                    content(data)
                }
            }
            .navigationTitle("Trend")
            .owlMark()
            .refreshable { await model.load() }
        }
        .tint(Theme.accent)
        .task { await model.load() }
    }

    /// The dashboard, the same way up or on its side.
    ///
    /// Turning the phone used to replace this whole screen with the category
    /// chart, on the reasoning that everything below it is the same data said
    /// again and not worth two hundred of the three hundred points landscape
    /// leaves. That reasoning was fine while there was no way to ask for a
    /// chart — it stopped being fine the moment there was, because tilting
    /// then answered a question the reader had already answered differently,
    /// and answered it with whichever chart happened to be at the top.
    ///
    /// Expanding a card is how a chart gets the screen now. Landscape makes an
    /// expanded one wider, which is all it should ever have decided.
    private func content(_ data: TrendResponse) -> some View {
        dashboard(data)
    }

    private func dashboard(_ data: TrendResponse) -> some View {
        ScrollView {
            VStack(spacing: Theme.sectionGap) {
                Picker("Months", selection: Bindable(model).months) {
                    Text("6").tag(6)
                    Text("12").tag(12)
                    Text("24").tag(24)
                }
                .pickerStyle(.segmented)
                .onChange(of: model.months) { Task { await model.load() } }
                .onChange(of: model.months) { drilled = nil }

                CategoryTrendChart(series: data.series,
                                   prior: data.priorSeries,
                                   categories: data.categories,
                                   drilled: $drilled)
                NetChart(series: data.series, prior: data.priorSeries)
                RunningTotalChart(series: data.series)
                YearAgoCard(now: data.series, before: data.priorSeries)
            }
            .padding()
        }
        .background(Theme.background)
    }
}

// MARK: - Spend, stacked by category

/// Monthly spend stacked by category, against the same month last year.
///
/// Parents by default and subcategories on drilling in, which is the only way
/// this fits on a phone: thirty-one leaves in a stack is a band of colour with
/// no readable segments, and the question "what is big" is answered by the
/// parents anyway. The leaves answer the next question, which is "big because
/// of what".
///
/// Three ways in, because a chart this dense earns them: pinch to narrow the
/// window onto fewer months, touch a segment for its own figure, and turn the
/// phone to give the whole thing the screen.
private struct CategoryTrendChart: View {
    let series: [TrendResponse.Month]
    let prior: [TrendResponse.Month]
    let categories: [TransactionsResponse.Category]
    @Binding var drilled: String?

    /// How many months are on screen at once. Pinching changes it; the chart
    /// scrolls through the rest rather than squeezing them in.
    ///
    /// Starts at whatever was asked for. It used to start at twelve whatever
    /// was asked for, so choosing 24 fetched two years and showed one — and
    /// because the columns were collapsing two Januaries into one at the time,
    /// twelve columns of doubled spending looked like the answer rather than
    /// like half of it. Asking for twenty-four months and being shown twelve is
    /// the chart disagreeing with the control above it.
    @State private var window: Int?
    /// What the window was when the current pinch started, so the gesture is
    /// measured from where it began rather than compounding each frame.
    @State private var windowAtPinchStart: Int?

    /// Shared with every other chart that can draw last year — see
    /// `LastYearToggle`. This one used to draw the rules unconditionally,
    /// which is the same busyness the Budgeting chart already offered a way
    /// out of.
    @AppStorage("showLastYear") private var showLastYear = false

    /// The month at the left edge of what is on screen.
    ///
    /// Bound rather than left to the chart, for two reasons. A scrollable chart
    /// with no position starts at the beginning of its data, which here is the
    /// oldest month — so zooming in walked you to two years ago and left you
    /// there. And holding the value means a pinch can keep the months you were
    /// looking at on screen instead of throwing the view somewhere else.
    @State private var scrollAnchor: String = ""

    /// The segment under the last touch: a month, and one category within it.
    @State private var picked: Picked?

    struct Picked: Equatable {
        let month: String
        let slug: String
        let label: String
        let cents: Int
        /// What the whole month came to, so the part has something to be a
        /// part of. A figure on its own says nothing about whether it was a
        /// lot, and that is the question a stacked bar invites.
        let ofTotal: Int
    }

    /// Slug to label and colour for whichever level is being drawn.
    private var visible: [TransactionsResponse.Category] {
        if let drilled {
            return categories.filter { $0.parentSlug == drilled }
        }
        return categories.filter { $0.kind == "spend" && $0.parentSlug == nil }
    }

    /// One bar segment: a month, a category, and the money in it.
    private struct Segment: Identifiable {
        let id = UUID()
        let month: String
        let slug: String
        let label: String
        let colour: Color
        let cents: Int
    }

    /// Built by walking `visible` rather than the response dictionary.
    ///
    /// A dictionary has no order, and Swift Charts assigns a colour scale
    /// positionally against whatever order the marks arrive in — so building
    /// these from `byCategory` directly gave Groceries a different colour on
    /// every launch, and never the colour the category itself carries
    /// everywhere else in the app.
    private var segments: [Segment] {
        series.flatMap { m -> [Segment] in
            let source = drilled == nil ? (m.byParent ?? [:]) : (m.byCategory ?? [:])
            return visible.compactMap { cat in
                guard let cents = source[cat.slug], cents > 0 else { return nil }
                return Segment(month: m.month, slug: cat.slug, label: cat.label,
                               colour: Color(hex: cat.colour), cents: cents)
            }
        }
    }

    /// What each month came to, across whatever is on screen.
    ///
    /// The chart is a stack, and a stack shows the parts at the cost of the
    /// whole: the eye can compare two months' worth of Groceries and cannot
    /// read what either month cost. Held here so both the readout and the
    /// annotation say the same figure.
    private var monthTotals: [String: Int] {
        segments.reduce(into: [:]) { out, seg in
            out[seg.month, default: 0] += seg.cents
        }
    }

    /// The same months a year earlier, summed over whatever is on screen — so
    /// drilling in compares like with like rather than against the whole year.
    private var yearAgo: [(label: String, cents: Int)] {
        let slugs = Set(visible.map(\.slug))
        return zip(series, prior).map { now, before in
            let source = drilled == nil ? (before.byParent ?? [:]) : (before.byCategory ?? [:])
            let total = source.filter { slugs.contains($0.key) }.values.reduce(0, +)
            return (now.month, total)
        }
    }

    /// The tallest month on screen, in whole currency, with a little headroom.
    ///
    /// Swift Charts scales y to every value it was given, not to the window
    /// being shown, so one enormous month set the axis for all of them: a
    /// hundred thousand in a single month left two years of ordinary ten
    /// thousands drawn as slivers along the floor, and zooming in did not help
    /// because the outlier was still in the data.
    ///
    /// Scaling to the window is not hiding it. Scroll onto that month and the
    /// axis grows to meet it; scroll away and the months either side become
    /// legible again, which is the entire reason for being able to scroll.
    private var visibleCeiling: Double? {
        let keys = Set(visibleMonths)
        guard !keys.isEmpty else { return nil }
        var tallest = 0
        for m in series where keys.contains(m.month) {
            let source = drilled == nil ? (m.byParent ?? [:]) : (m.byCategory ?? [:])
            let slugs = Set(visible.map(\.slug))
            tallest = max(tallest, source.filter { slugs.contains($0.key) }.values.reduce(0, +))
        }
        // The year-ago rule is drawn on the same axis, so an axis that cannot
        // reach it would draw it along the top edge and call that a comparison.
        // Only when it is drawn: an axis making room for a line that is turned
        // off is the outlier problem again, with nothing on screen to explain
        // the empty space.
        if showLastYear {
            for point in yearAgo where keys.contains(point.label) {
                tallest = max(tallest, point.cents)
            }
        }
        guard tallest > 0 else { return nil }
        return Double(tallest) / 100 * 1.12
    }

    /// The months the window is currently showing.
    private var visibleMonths: [String] {
        guard let leading = labels.firstIndex(of: scrollAnchor) else {
            return Array(labels.suffix(clampedWindow))
        }
        return Array(labels[leading..<min(labels.count, leading + clampedWindow)])
    }

    private var domain: [String] { visible.map(\.label) }
    private var range: [Color] { visible.map { Color(hex: $0.colour) } }

    /// Never wider than the data, never narrower than three — one month on
    /// screen is a single bar with nothing to compare it to. Unset means the
    /// whole of what was asked for.
    private var clampedWindow: Int {
        min(max(3, window ?? series.count), max(3, series.count))
    }

    /// The plotted values, which are the month keys — see `Month.shortLabel`
    /// for why they cannot be the labels.
    private var labels: [String] { series.map(\.month) }

    /// The month to put at the left edge so that `width` months are on screen
    /// and the last of them is `end` — clamped so neither edge runs off the
    /// data and leaves a band of empty chart.
    private func anchor(endingAt end: Int, width: Int) -> String {
        guard !labels.isEmpty else { return "" }
        let last = max(0, labels.count - width)
        return labels[min(max(0, end - width + 1), last)]
    }

    /// Opens on the most recent months. A trend is read from the near end.
    private func anchorAtLatest() {
        scrollAnchor = anchor(endingAt: labels.count - 1, width: clampedWindow)
    }

    /// Zooming keeps the right-hand edge where it was, so months leave and
    /// arrive at the far end rather than the view jumping to a different part
    /// of the year every time the window changes.
    private func rescale(from previous: Int) {
        guard let leading = labels.firstIndex(of: scrollAnchor) else {
            anchorAtLatest()
            return
        }
        let trailing = min(labels.count - 1, leading + previous - 1)
        scrollAnchor = anchor(endingAt: trailing, width: clampedWindow)
    }

    var body: some View {
        Maximisable(title: drilled == nil ? "Spend by category" : "Inside \(drilledLabel)") { maximised in
            // Opened on its own, the chart gets the screen: it is the only
            // thing being looked at, so everything around it is chrome and
            // chrome is what there is no room for.
            //
            // Turning the phone on the dashboard does NOT do this any more.
            // This chart used to expand on its own whenever the phone went
            // sideways, which meant tilting always emphasised whichever chart
            // happened to be at the top — including when the reader had just
            // expanded a different one. Choosing a chart and then being given
            // another is worse than not being able to choose. Landscape is
            // still what makes an expanded chart wide; it simply no longer
            // decides which chart that is.
            let big = maximised

            VStack(alignment: .leading, spacing: 10) {
                subheader

                let marks = segments
                let ago = yearAgo

                if marks.isEmpty {
                    Text("Nothing recorded in these months.")
                        .font(Theme.note)
                        .foregroundStyle(Theme.quietText)
                        .frame(maxWidth: .infinity, minHeight: 120)
                } else {
                    chart(marks: marks, ago: ago, big: big)

                    if let picked {
                        PickedSegment(picked: picked) { self.picked = nil }
                    } else if !big {
                        Text("Pinch to zoom, drag to scroll through the months. Touch a segment for its figure, or hold and slide across them. Turn the phone, or open this on its own, for a wider view.")
                            .font(Theme.note)
                            .foregroundStyle(Theme.quietText)
                    }
                }

                if !big {
                    if drilled == nil {
                        DrillStrip(parents: visible, onPick: { drilled = $0 })
                    } else {
                        MonthBreakdown(series: series, subcategories: visible)
                    }
                }
            }
        }
    }

    /// What is left of the header once the card owns the title: how much of
    /// the run is on screen, and the way back up out of a drill.
    private var subheader: some View {
        HStack {
            LastYearToggle(on: $showLastYear, available: yearAgo.contains { $0.cents > 0 })
            Spacer()
            if clampedWindow < series.count {
                Text("\(clampedWindow) of \(series.count) months")
                    .font(Theme.tileLabel)
                    .foregroundStyle(Theme.quietText)
            }
            if drilled != nil {
                Button {
                    drilled = nil
                    picked = nil
                } label: {
                    Label("All categories", systemImage: "chevron.left")
                        .font(Theme.tileLabel)
                }
            }
        }
    }

    private func chart(marks: [Segment], ago: [(label: String, cents: Int)], big: Bool) -> some View {
        Chart {
            ForEach(marks) { seg in
                BarMark(
                    x: .value("Month", seg.month),
                    y: .value("Spend", Double(seg.cents) / 100)
                )
                .foregroundStyle(by: .value("Category", seg.label))
                // Everything else steps back rather than the chosen segment
                // stepping forward — a segment already at full strength has
                // nowhere brighter to go, and this is a stack where the
                // neighbours are the thing obscuring it.
                .opacity(picked == nil
                         || (picked?.month == seg.month && picked?.slug == seg.slug) ? 1 : 0.25)
            }

            /* What each month came to, written over its stack.
             *
             * Only when the chart has the screen. Twelve months across a phone
             * gives each bar about thirty points, which is narrower than a
             * five figure sum — the labels would overlap into a band and say
             * less than nothing. Opened or turned sideways there is room, and
             * the total is the first thing anybody looks for.
             *
             * Drawn as a point with no symbol rather than annotated onto a
             * bar: an annotation on a stacked mark attaches to that segment,
             * and the topmost segment is not the top of the stack.
             */
            if big {
                ForEach(Array(monthTotals), id: \.key) { month, cents in
                    PointMark(
                        x: .value("Month", month),
                        y: .value("Spend", Double(cents) / 100)
                    )
                    .symbolSize(0)
                    .annotation(position: .top, spacing: 2) {
                        Text(cents.asShortMoney)
                            .font(.system(size: 9, weight: .semibold))
                            .monospacedDigit()
                            .foregroundStyle(Theme.quietText)
                    }
                }
            }

            /* Last year as one line running through the bars, rather than a
             * dash sitting on each of them.
             *
             * A dash per month says what that month was and nothing about the
             * months either side, which leaves the reader doing the joining up
             * — and the joining up is the whole question. A line has a shape,
             * and the shape is the answer: this year is above it, below it, or
             * following it.
             *
             * A second stack would say the same thing and double the ink, so
             * it is still a line and not more bars.
             *
             * Months with nothing recorded a year ago are left out rather than
             * drawn at zero. A line dropping to the floor reads as a year that
             * spent nothing, which is a much stronger claim than "we were not
             * keeping records yet".
             */
            if showLastYear {
                ForEach(ago.filter { $0.cents > 0 }, id: \.label) { point in
                    LineMark(
                        x: .value("Month", point.label),
                        y: .value("Last year", Double(point.cents) / 100),
                        series: .value("Series", "last year")
                    )
                    .lineStyle(.init(lineWidth: 1.6, dash: [4, 3]))
                    .foregroundStyle(Theme.quietText)
                    .interpolationMethod(.monotone)

                    PointMark(
                        x: .value("Month", point.label),
                        y: .value("Last year", Double(point.cents) / 100)
                    )
                    .symbolSize(14)
                    .foregroundStyle(Theme.quietText)
                }
            }
        }
        .chartXAxis {
            // The tick is written from the key, because the key is what the
            // bars are plotted against. Automatic count, so twenty-four months
            // thin the labels rather than overlapping them into a band.
            AxisMarks(values: .automatic(desiredCount: 6)) { value in
                AxisGridLine()
                AxisTick()
                AxisValueLabel {
                    if let key = value.as(String.self) {
                        Text(TrendResponse.Month.shortLabel(of: key))
                    }
                }
            }
        }
        .chartForegroundStyleScale(domain: domain, range: range)
        .chartLegend(position: .bottom, alignment: .leading, spacing: 8)
        .chartYAxis {
            AxisMarks(format: .currency(code: "USD").precision(.fractionLength(0)))
        }
        .chartYScale(domain: visibleCeiling.map { 0...$0 } ?? 0...1, type: .linear)
        .chartScrollableAxes(.horizontal)
        .chartXVisibleDomain(length: clampedWindow)
        .chartScrollPosition(x: $scrollAnchor)
        .onAppear { if scrollAnchor.isEmpty { anchorAtLatest() } }
        // Drilling into a parent rebuilds the marks but not the months, so the
        // anchor still names a month that exists — unless the range itself
        // changed underneath, which is what this catches.
        // A new range is a new question, so the window goes back to showing all
        // of it rather than keeping a zoom that belonged to the last one.
        .onChange(of: series.count) {
            window = nil
            anchorAtLatest()
        }
        .onChange(of: clampedWindow) { previous, _ in rescale(from: previous) }
        // Portrait gets a fixed height so the cards below it keep their
        // rhythm. Landscape takes whatever is left, because a fixed 300 is
        // taller than an iPhone has once the navigation and tab bars have
        // taken theirs — and a chart that overflows is worse than a short one.
        .modifier(ChartHeight(fill: big, fixed: 260))
        .chartOverlay { proxy in
            // Swift Charts' own selection reports the x value only, which for a
            // stack names the month and not the segment inside it. Both
            // coordinates are needed to say which category was touched, so the
            // hit test is done here against the plot's own scales rather than
            // against pixels.
            GeometryReader { geo in
                Rectangle().fill(.clear).contentShape(Rectangle())
                    .onTapGesture { location in
                        hit(location, proxy: proxy, geo: geo)
                    }
                    // Long enough that it cannot be reached by accident on
                    // the way to a scroll. At 0.2s it could: a finger that
                    // rests for a moment before sliding — which is how most
                    // people start a drag — had already become a scrub, and
                    // the chart would not move sideways at all.
                    .gesture(
                        LongPressGesture(minimumDuration: 0.45)
                            .sequenced(before: DragGesture(minimumDistance: 0))
                            .onChanged { value in
                                if case .second(_, let drag?) = value {
                                    hit(drag.location, proxy: proxy, geo: geo)
                                }
                            }
                    )
            }
        }
        .simultaneousGesture(
            MagnifyGesture()
                .onChanged { value in
                    let base = windowAtPinchStart ?? clampedWindow
                    if windowAtPinchStart == nil { windowAtPinchStart = base }
                    // Pinching out shows fewer months, which is what zooming in
                    // means for a time axis.
                    window = Int((Double(base) / value.magnification).rounded())
                }
                .onEnded { _ in windowAtPinchStart = nil }
        )
        .animation(.snappy(duration: 0.2), value: picked)
    }

    /// Which segment a point lands on.
    ///
    /// The x scale gives the month directly. The y scale gives a figure, and
    /// the segment is found by stacking that month's categories in draw order
    /// until the running total passes it — the same order the bars were built
    /// in, or the answer would name a different band than the finger was on.
    private func hit(_ location: CGPoint, proxy: ChartProxy, geo: GeometryProxy) {
        guard let plot = proxy.plotFrame else { return }
        let origin = geo[plot].origin
        guard let month: String = proxy.value(atX: location.x - origin.x),
              let value: Double = proxy.value(atY: location.y - origin.y),
              value >= 0
        else { return }

        var running = 0.0
        for seg in segments where seg.month == month {
            running += Double(seg.cents) / 100
            if value <= running {
                picked = Picked(month: month, slug: seg.slug,
                                label: seg.label, cents: seg.cents,
                                ofTotal: monthTotals[month] ?? seg.cents)
                return
            }
        }
        // Above the stack is empty space, not the top segment.
        picked = nil
    }

    private var drilledLabel: String {
        categories.first { $0.slug == drilled }?.label ?? drilled ?? ""
    }
}

/// What one segment came to.
private struct PickedSegment: View {
    let picked: CategoryTrendChart.Picked
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Text(TrendResponse.Month.shortLabel(of: picked.month))
                .font(Theme.tileLabel)
                .foregroundStyle(Theme.quietText)
            Text(picked.label)
                .font(Theme.note)
                .lineLimit(1)
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 0) {
                Text(picked.cents.asMoney)
                    .font(.system(.subheadline, design: .rounded).weight(.semibold))
                    .monospacedDigit()
                // The month behind the part. A stack shows what something was
                // made of at the cost of what it came to, and "of" is the word
                // that puts the two back together.
                Text("of \(picked.ofTotal.asMoney)")
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(Theme.quietText)
            }
            Button(action: dismiss) {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(Theme.quietText)
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 10)
        .background(Theme.background, in: .rect(cornerRadius: 8))
    }
}


/// What one touch on a chart came to.
///
/// The same shape as `PickedSegment`, for charts whose bars are a month rather
/// than a category within one. Said in a row under the chart rather than in a
/// label over the bar: an annotation has to be small enough to sit in the gap
/// above a bar, which on a phone means an abbreviated figure that vanishes the
/// moment the finger lifts — legible only if you already knew what it said.
private struct ChartReadout: View {
    let month: String
    let value: Int
    let caption: String
    let tint: Color
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Text(TrendResponse.Month.shortLabel(of: month))
                .font(Theme.tileLabel)
                .foregroundStyle(Theme.quietText)
            Text(caption)
                .font(Theme.note)
                .lineLimit(1)
            Spacer(minLength: 8)
            Text(value.asMoney)
                .font(.system(.subheadline, design: .rounded).weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(tint)
            Button(action: dismiss) {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(Theme.quietText)
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 10)
        .background(Theme.background, in: .rect(cornerRadius: 8))
    }
}

/// A month, a subcategory within it, and the way through to its transactions.
///
/// Two steps rather than one screen per combination: picking the month first
/// keeps the list short, and a month with nothing in a subcategory simply does
/// not offer it.
private struct MonthBreakdown: View {
    let series: [TrendResponse.Month]
    let subcategories: [TransactionsResponse.Category]
    @State private var month: String?

    /// Newest first. Somebody drilling in is far more often asking about the
    /// month just gone than about one eleven months back.
    private var months: [TrendResponse.Month] { series.reversed() }

    /// The newest month that actually has something in it, until one is
    /// picked. Opening on the newest month full stop lands on "Nothing in
    /// Sep." four days into September — an empty state as the first thing a
    /// drill-down shows reads as a broken screen rather than as a quiet month.
    private var chosen: TrendResponse.Month? {
        if let month { return series.first { $0.month == month } }
        let slugs = Set(subcategories.map(\.slug))
        return months.first { m in
            (m.byCategory ?? [:]).contains { slugs.contains($0.key) && $0.value > 0 }
        } ?? months.first
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Divider()

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(months) { m in
                        let isOn = (chosen?.month == m.month)
                        Button {
                            month = m.month
                        } label: {
                            Text(m.shortLabel)
                                .font(Theme.note)
                                .padding(.horizontal, 11)
                                .padding(.vertical, 6)
                                .background(isOn ? Theme.accent : Theme.background, in: .capsule)
                                .foregroundStyle(isOn ? Color.white : Theme.text)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 1)
            }

            if let chosen {
                let rows = subcategories
                    .compactMap { cat -> (TransactionsResponse.Category, Int)? in
                        let cents = chosen.byCategory?[cat.slug] ?? 0
                        return cents > 0 ? (cat, cents) : nil
                    }
                    .sorted { $0.1 > $1.1 }

                if rows.isEmpty {
                    Text("Nothing in \(chosen.shortLabel).")
                        .font(Theme.note)
                        .foregroundStyle(Theme.quietText)
                } else {
                    ForEach(rows, id: \.0.id) { cat, cents in
                        NavigationLink {
                            CategoryMonthView(slug: cat.slug, range: .month(chosen.month),
                                              title: cat.label, monthLabel: chosen.shortLabel)
                        } label: {
                            HStack(spacing: 8) {
                                RoundedRectangle(cornerRadius: 1.5)
                                    .fill(Color(hex: cat.colour))
                                    .frame(width: 3, height: 18)
                                Text(cat.label).font(Theme.note).lineLimit(1)
                                Spacer(minLength: 8)
                                Text(cents.asShortMoney)
                                    .font(Theme.note)
                                    .monospacedDigit()
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundStyle(Theme.quietText)
                            }
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }
}

/// Tapping a chart segment on a phone is a coin toss at this size, so the way
/// in is a row of names rather than the bars themselves.
private struct DrillStrip: View {
    let parents: [TransactionsResponse.Category]
    let onPick: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(parents) { cat in
                    Button {
                        onPick(cat.slug)
                    } label: {
                        HStack(spacing: 5) {
                            Circle()
                                .fill(Color(hex: cat.colour))
                                .frame(width: 7, height: 7)
                            Text(cat.label)
                            Image(systemName: "chevron.right")
                                .font(.system(size: 8, weight: .bold))
                                .foregroundStyle(Theme.quietText)
                        }
                        .font(Theme.note)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Theme.background, in: .capsule)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 1)
        }
    }
}

// MARK: - The gap

private struct NetChart: View {
    let series: [TrendResponse.Month]
    /// The same months a year earlier, in the same order.
    let prior: [TrendResponse.Month]
    @State private var picked: String?
    @AppStorage("showLastYear") private var showLastYear = false

    /// Last year's net, by the month it is drawn under.
    private var lastYear: [String: Int] {
        Dictionary(uniqueKeysWithValues: zip(series, prior).map { ($0.month, $1.net) })
    }

    var body: some View {
        Maximisable(title: "Net, month by month") { maximised in
            VStack(alignment: .leading, spacing: 10) {
                LastYearToggle(on: $showLastYear,
                               available: lastYear.values.contains { $0 != 0 })

                Chart {
                    ForEach(series) { m in
                    // Coloured per bar rather than per series: a run of months
                    // is not all one thing, and the months that went backwards
                    // are the ones worth finding at a glance.
                    BarMark(
                        x: .value("Month", m.month),
                        y: .value("Net", Double(m.net) / 100)
                    )
                    .foregroundStyle(Theme.tint(forNet: m.net))
                    // Everything else steps back rather than the chosen bar
                    // stepping forward: a bar already at full strength has
                    // nowhere brighter to go.
                    .opacity(picked == nil || picked == m.month ? 1 : 0.3)
                    }

                    /* Last year as one line through the bars, the same way
                     * the category chart draws it. Every month is plotted
                     * whatever its sign, and zero is plotted too: a net can be
                     * negative, a month that lost money last year is exactly
                     * the comparison worth having, and a year that broke even
                     * is a finding rather than a gap.
                     */
                    if showLastYear {
                        ForEach(series) { m in
                            if let before = lastYear[m.month] {
                                LineMark(
                                    x: .value("Month", m.month),
                                    y: .value("Last year", Double(before) / 100),
                                    series: .value("Series", "last year")
                                )
                                .lineStyle(.init(lineWidth: 1.6, dash: [4, 3]))
                                .foregroundStyle(Theme.quietText)
                                .interpolationMethod(.monotone)
                            }
                        }
                    }
                }
                .chartXSelection(value: $picked)
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 6)) { value in
                        AxisGridLine()
                        AxisTick()
                        AxisValueLabel {
                            if let key = value.as(String.self) {
                                Text(TrendResponse.Month.shortLabel(of: key))
                            }
                        }
                    }
                }
                .chartYAxis { AxisMarks(format: .currency(code: "USD").precision(.fractionLength(0))) }
                .modifier(ChartHeight(fill: maximised, fixed: 180))
                .animation(.snappy(duration: 0.2), value: picked)

                if let month = picked, let m = series.first(where: { $0.month == month }) {
                    ChartReadout(month: month,
                                 value: m.net,
                                 caption: showLastYear && lastYear[month] != nil
                                     ? "against \((lastYear[month] ?? 0).asShortMoney) a year ago"
                                     : (m.net < 0 ? "more out than in" : "more in than out"),
                                 tint: Theme.tint(forNet: m.net)) { picked = nil }
                } else {
                    Text("Touch a month for what it came to.")
                        .font(Theme.note)
                        .foregroundStyle(Theme.quietText)
                }
            }
        }
    }
}

// MARK: - The running total

/// The same months summed left to right.
///
/// Deliberately its own chart rather than a line over the bars above. Twelve
/// months of around eight thousand each accumulate to eighty, and on one axis
/// the total flattens every bar it is made of into a sliver — the two are the
/// same data at an order of magnitude apart, and a shared axis can only ever
/// serve one of them.
private struct RunningTotalChart: View {
    let series: [TrendResponse.Month]
    @State private var picked: String?

    private var points: [(label: String, total: Int)] {
        var total = 0
        return series.map { m in
            total += m.net
            return (m.month, total)
        }
    }

    var body: some View {
        Maximisable(title: "Running total") { maximised in
            VStack(alignment: .leading, spacing: 10) {
                Chart {
                    ForEach(points, id: \.label) { p in
                        AreaMark(
                            x: .value("Month", p.label),
                            y: .value("Running", Double(p.total) / 100)
                        )
                        .foregroundStyle(Theme.tint(forNet: p.total).opacity(0.14))

                        LineMark(
                            x: .value("Month", p.label),
                            y: .value("Running", Double(p.total) / 100)
                        )
                        .foregroundStyle(Theme.tint(forNet: p.total))
                        .interpolationMethod(.monotone)
                    }

                    // The touched month, marked on the line itself. A running
                    // total has no bars to darken, so without this there is
                    // nothing to say which point the figure below belongs to.
                    if let picked, let p = points.first(where: { $0.label == picked }) {
                        PointMark(
                            x: .value("Month", p.label),
                            y: .value("Running", Double(p.total) / 100)
                        )
                        .symbolSize(70)
                        .foregroundStyle(Theme.tint(forNet: p.total))
                    }
                }
                .chartXSelection(value: $picked)
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 6)) { value in
                        AxisGridLine()
                        AxisTick()
                        AxisValueLabel {
                            if let key = value.as(String.self) {
                                Text(TrendResponse.Month.shortLabel(of: key))
                            }
                        }
                    }
                }
                .chartYAxis { AxisMarks(format: .currency(code: "USD").precision(.fractionLength(0))) }
                .modifier(ChartHeight(fill: maximised, fixed: 170))
                .animation(.snappy(duration: 0.2), value: picked)

                if let month = picked, let p = points.first(where: { $0.label == month }) {
                    ChartReadout(month: month,
                                 value: p.total,
                                 caption: "by the end of it",
                                 tint: Theme.tint(forNet: p.total)) { picked = nil }
                } else if let last = points.last {
                    Text("\(last.total.asMoney) across the \(series.count) months shown")
                        .font(Theme.note)
                        .foregroundStyle(Theme.quietText)
                }
            }
        }
    }
}

// MARK: - Against the same months a year earlier

private struct YearAgoCard: View {
    let now: [TrendResponse.Month]
    let before: [TrendResponse.Month]

    var body: some View {
        // Absent rather than empty when the history does not reach back far
        // enough: a year-ago line drawn out of no data is a flat line that
        // looks like a year of nothing happening.
        if before.isEmpty || before.allSatisfy({ $0.income == 0 && $0.expense == 0 }) {
            EmptyView()
        } else {
            Card {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Against the year before")
                        .font(Theme.tileLabel)
                        .foregroundStyle(Theme.quietText)

                    let thisYear = now.map(\.expense).reduce(0, +)
                    let lastYear = before.map(\.expense).reduce(0, +)

                    HStack(spacing: 0) {
                        figure("Spent now", thisYear)
                        Divider().frame(height: 34)
                        figure("Same months before", lastYear)
                    }

                    if lastYear > 0 {
                        let change = Double(thisYear - lastYear) / Double(lastYear) * 100
                        // A tenth of a point below ten, whole numbers above.
                        // Rounding 0.46% to "0%" reports a real difference as
                        // no difference, which is the one thing the card exists
                        // to say either way.
                        let digits = abs(change) < 10 ? 1 : 0
                        let size = abs(change).formatted(.number.precision(.fractionLength(digits)))
                        Label(
                            change >= 0
                                ? "\(size)% more than a year ago"
                                : "\(size)% less than a year ago",
                            systemImage: change >= 0 ? "arrow.up.right" : "arrow.down.right"
                        )
                        .font(Theme.note)
                        .foregroundStyle(change >= 0 ? Theme.negative : Theme.positive)
                    }
                }
            }
        }
    }

    private func figure(_ label: String, _ cents: Int) -> some View {
        VStack(spacing: 2) {
            Text(label)
                .font(Theme.tileLabel)
                .foregroundStyle(Theme.quietText)
                .multilineTextAlignment(.center)
            Text(cents.asShortMoney)
                .font(.system(.headline, design: .rounded))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - The month under the finger

/// What one month is made of, for the month a finger is on.
///
/// The stack above already shows the proportions. What it cannot show is the
/// figures — reading a segment's height against an axis is guesswork, and the
/// question "how much was that" is the one a stacked bar always provokes.
private struct MonthDetail: View {
    let month: TrendResponse.Month
    let visible: [TransactionsResponse.Category]
    let drilled: String?

    private var rows: [(TransactionsResponse.Category, Int)] {
        let source = drilled == nil ? (month.byParent ?? [:]) : (month.byCategory ?? [:])
        return visible
            .compactMap { cat in
                guard let cents = source[cat.slug], cents > 0 else { return nil }
                return (cat, cents)
            }
            .sorted { $0.1 > $1.1 }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(month.shortLabel).font(Theme.tileLabel)
                Spacer()
                Text(month.expense.asShortMoney)
                    .font(Theme.tileLabel)
                    .monospacedDigit()
            }
            .foregroundStyle(Theme.quietText)

            ForEach(rows, id: \.0.id) { cat, cents in
                HStack(spacing: 7) {
                    Circle()
                        .fill(Color(hex: cat.colour))
                        .frame(width: 7, height: 7)
                    Text(cat.label).font(Theme.note).lineLimit(1)
                    Spacer(minLength: 8)
                    Text(cents.asShortMoney)
                        .font(Theme.note)
                        .monospacedDigit()
                }
            }
        }
        .padding(.top, 2)
    }
}

/// A fixed height, or all of what is going.
private struct ChartHeight: ViewModifier {
    let fill: Bool
    let fixed: CGFloat

    func body(content: Content) -> some View {
        if fill {
            content.frame(minHeight: 160, maxHeight: .infinity)
        } else {
            content.frame(height: fixed)
        }
    }
}
