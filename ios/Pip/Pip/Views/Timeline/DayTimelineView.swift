import SwiftUI

/// The plan's day as one timeline under a Now line. What doesn't fit waits in a tray at the top;
/// everything else sits at its slot. Entries share one matched-geometry namespace, so a rerank
/// glides them to their new places (and in or out of the tray) instead of redrawing a list.
struct DayTimelineView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @Namespace private var namespace
    let plan: Plan

    @ScaledMetric(relativeTo: .footnote) private var gutterWidth: CGFloat = 50
    @ScaledMetric(relativeTo: .subheadline) private var doNowMinHeight: CGFloat = 80
    @ScaledMetric(relativeTo: .subheadline) private var cardMinHeight: CGFloat = 76
    @ScaledMetric(relativeTo: .subheadline) private var markerMinHeight: CGFloat = 52
    @ScaledMetric(relativeTo: .footnote) private var gapRowHeight: CGFloat = 30
    /// Bumped per item id to shake a card once when it newly lands in the tray.
    @State private var shakes: [String: Int] = [:]

    private static let laneSpacing: CGFloat = 14
    /// Center of the Now dot and the rail, measured from the gutter's trailing edge.
    private static let railOffset: CGFloat = 5

    private var metrics: TimelineLayout.Metrics {
        TimelineLayout.Metrics(
            gapRowHeight: gapRowHeight,
            doNowMinHeight: doNowMinHeight,
            cardMinHeight: cardMinHeight,
            markerMinHeight: markerMinHeight
        )
    }

    var body: some View {
        let layout = TimelineLayout.make(plan: plan, metrics: metrics)
        VStack(alignment: .leading, spacing: 14) {
            header

            VStack(alignment: .leading, spacing: 14) {
                nowLine(layout.nowText)

                VStack(alignment: .leading, spacing: 14) {
                    if !layout.tray.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(layout.tray) { entry in
                                trayView(entry)
                            }
                        }
                        .padding(.leading, gutterWidth + Self.laneSpacing)
                    }

                    if !layout.rows.isEmpty {
                        canvas(layout)
                    } else if layout.tray.isEmpty {
                        Text("Nothing else is booked today.")
                            .font(.footnote)
                            .foregroundStyle(PipDesign.secondary)
                            .padding(.leading, gutterWidth + Self.laneSpacing)
                    }
                }
                // Reduce Motion: a new identity per plan, so the whole day cross-fades.
                .id(reduceMotion ? plan.planId : "timeline")
                .transition(.opacity)
            }
            .background(alignment: .topLeading) {
                rail
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.25) : .spring(response: 0.5, dampingFraction: 0.82), value: plan.planId)
        .onChange(of: layout.tray.map(\.id)) { oldIDs, newIDs in
            shakeArrivals(from: oldIDs, to: newIDs)
        }
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("YOUR DAY")
                .font(.caption2.weight(.bold))
                .tracking(1)
                .foregroundStyle(PipDesign.secondary)
                .accessibilityAddTraits(.isHeader)
            if typeSize.isAccessibilitySize {
                minutesPicker.pickerStyle(.menu)
            } else {
                minutesPicker.pickerStyle(.segmented)
            }
        }
    }

    private var minutesPicker: some View {
        Picker(
            "Free time",
            selection: Binding(
                get: { model.availableMinutesPreset },
                set: { model.setAvailableMinutes($0) }
            )
        ) {
            ForEach(ContextPreset.allCases) { preset in
                Text(preset.label).tag(preset)
            }
        }
        .disabled(model.isBusy)
        .accessibilityLabel("Free time before class")
    }

    private func nowLine(_ time: String) -> some View {
        HStack(spacing: 0) {
            Text("NOW")
                .font(.caption2.weight(.bold))
                .tracking(1)
                .padding(.trailing, 8)
                .frame(width: gutterWidth, alignment: .trailing)
            Circle()
                .fill(PipDesign.accent)
                .frame(width: Self.railOffset * 2, height: Self.railOffset * 2)
            Text(time)
                .font(.footnote.weight(.semibold).monospacedDigit())
                .padding(.leading, 8)
            Capsule()
                .fill(PipDesign.accent.opacity(0.6))
                .frame(height: 2)
                .padding(.leading, 8)
        }
        .foregroundStyle(PipDesign.accent)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Now, \(time)")
    }

    private var rail: some View {
        Rectangle()
            .fill(PipDesign.line)
            .frame(width: 1)
            .frame(maxHeight: .infinity)
            .padding(.top, 8)
            .padding(.leading, gutterWidth + Self.railOffset - 0.5)
            .accessibilityHidden(true)
    }

    // MARK: Timeline

    private func canvas(_ layout: TimelineLayout) -> some View {
        TimelineCanvasLayout(gutterWidth: gutterWidth, laneSpacing: Self.laneSpacing) {
            ForEach(layout.rows) { row in
                rowView(row)
                    .layoutValue(key: TimelineSlotKey.self, value: slot(for: row))
            }
        }
    }

    @ViewBuilder
    private func rowView(_ row: TimelineLayout.Row) -> some View {
        switch row {
        case .tick(let tick):
            TimelineTickLabel(tick: tick)
        case .gap(let gap):
            TimelineGapRow(gap: gap)
        case .entry(let entry):
            entryView(entry)
        }
    }

    private func slot(for row: TimelineLayout.Row) -> TimelineSlot {
        switch row {
        case .tick(let tick):
            return TimelineSlot(y: tick.y, designHeight: 0, lane: .gutter)
        case .gap(let gap):
            return TimelineSlot(y: gap.y, designHeight: gap.height, lane: .content)
        case .entry(let entry):
            return TimelineSlot(y: entry.y, designHeight: entry.height, lane: .content)
        }
    }

    private func entryView(_ entry: TimelineLayout.Entry) -> some View {
        detailLink(for: entry.item) { showsChevron in
            TimelineEntryCard(
                entry: entry,
                highlighted: model.highlightedItemIDs.contains(entry.id),
                showsChevron: showsChevron
            )
        }
        .modifier(TimelineMatchedGeometry(id: entry.id, namespace: namespace, enabled: !reduceMotion))
    }

    private func trayView(_ entry: TimelineLayout.TrayEntry) -> some View {
        detailLink(for: entry.item) { showsChevron in
            TimelineTrayCard(
                entry: entry,
                planNow: plan.reasoning.now,
                highlighted: model.highlightedItemIDs.contains(entry.id),
                showsChevron: showsChevron
            )
            .modifier(TimelineShake(travel: CGFloat(shakes[entry.id] ?? 0)))
        }
        .modifier(TimelineMatchedGeometry(id: entry.id, namespace: namespace, enabled: !reduceMotion))
    }

    /// Tasks push TaskDetailView like the plan lists do; fixed blocks aren't tappable.
    @ViewBuilder
    private func detailLink<Content: View>(for item: PlanItem, @ViewBuilder content: (Bool) -> Content) -> some View {
        let opensDetail = item.opensDetail
        let label = content(opensDetail)
        if opensDetail {
            NavigationLink {
                TaskDetailView(item: item, task: model.task(for: item), planNow: plan.reasoning.now)
            } label: {
                label
            }
            .buttonStyle(.plain)
            .accessibilityHint("Shows why it's here")
        } else {
            label
        }
    }

    private func shakeArrivals(from oldIDs: [String], to newIDs: [String]) {
        guard !reduceMotion else { return }
        let arrivals = newIDs.filter { !oldIDs.contains($0) }
        guard !arrivals.isEmpty else { return }
        Task { @MainActor in
            // Let the glide into the tray land first.
            try? await Task.sleep(nanoseconds: 450_000_000)
            withAnimation(.linear(duration: 0.4)) {
                for id in arrivals {
                    shakes[id, default: 0] += 1
                }
            }
        }
    }
}

#if DEBUG
/// The bundled offline fixtures: the 1:13 PM capture and the "I only have 25 minutes" rerank.
private enum TimelinePreviewPlans {
    static var capture: Plan? {
        load(CaptureResponse.self, from: "capture_voice")?.plan ?? SampleData.plan
    }

    static var rerank: Plan? {
        load(RerankResponse.self, from: "rerank_25")?.plan
    }

    private static func load<T: Decodable>(_ type: T.Type, from name: String) -> T? {
        guard let url = Bundle.main.url(forResource: name, withExtension: "json"),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? PipCoding.makeDecoder().decode(type, from: data)
    }
}

/// Flips between the two plans with the app's spring, the way a real rerank lands.
private struct TimelineRerankPreview: View {
    let model: AppModel
    let capture: Plan
    let rerank: Plan
    @State private var showsRerank = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Button(showsRerank ? "Back to the full window" : "I only have 25 minutes") {
                        flip()
                    }
                    .buttonStyle(ChipButtonStyle())
                    DayTimelineView(plan: model.currentPlan ?? capture)
                }
                .padding(.horizontal, PipDesign.page)
                .padding(.vertical, 16)
            }
            .pipScreen()
        }
        .environment(model)
        .onAppear {
            model.currentPlan = capture
        }
    }

    private func flip() {
        showsRerank.toggle()
        let rerun = showsRerank
        withAnimation(.spring(response: 0.45, dampingFraction: 0.85)) {
            model.currentPlan = rerun ? rerank : capture
            model.availableMinutesPreset = rerun ? .twentyFive : .full
            model.highlightedItemIDs = rerun ? ["demo-assignment", "demo-return-headphones", "demo-assignment#cont"] : []
        }
    }
}

#Preview("Day timeline") {
    NavigationStack {
        ScrollView {
            if let plan = SampleData.plan {
                DayTimelineView(plan: plan)
                    .padding(.horizontal, PipDesign.page)
                    .padding(.vertical, 16)
            }
        }
        .pipScreen()
    }
    .environment(AppModel.preview())
}

#Preview("Rerank to 25 min") {
    if let capture = TimelinePreviewPlans.capture, let rerank = TimelinePreviewPlans.rerank {
        TimelineRerankPreview(model: AppModel.preview(), capture: capture, rerank: rerank)
    } else {
        Text("Offline fixtures are not in the bundle.")
    }
}
#endif
