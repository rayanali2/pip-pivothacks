import SwiftUI

// Building blocks for DayTimelineView: the row views, the canvas layout that places them,
// and the small effects (ring pulse, tray shake, reduce-motion-aware matched geometry).

enum TimelineStyle {
    static let cornerRadius: CGFloat = 16

    static func symbol(for category: TaskCategory?) -> String {
        switch category ?? .unknown {
        case .classSession: return "graduationcap"
        case .assignment: return "doc.text"
        case .errand: return "bag"
        case .meal: return "fork.knife"
        case .money: return "dollarsign.circle"
        case .work: return "briefcase"
        case .club: return "person.3"
        case .social: return "person.2"
        case .rest: return "moon.stars"
        case .unknown: return "circle.dotted"
        }
    }
}

// MARK: - Canvas

/// Where a row sits on the canvas, in points from the top of the timeline.
struct TimelineSlot: Equatable {
    enum Lane: Equatable {
        /// hour labels, centered on `y`
        case gutter
        /// cards and gap rows, top at `y`
        case content
    }

    var y: CGFloat
    var designHeight: CGFloat
    var lane: Lane
}

struct TimelineSlotKey: LayoutValueKey {
    static let defaultValue = TimelineSlot(y: 0, designHeight: 0, lane: .content)
}

/// Places rows at their slot's y. When Dynamic Type makes a row taller than its design height,
/// every row below it moves down by the difference, so text never clips or overlaps.
struct TimelineCanvasLayout: Layout {
    var gutterWidth: CGFloat
    var laneSpacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = Self.finiteWidth(proposal.width)
        let frames = placements(width: width, subviews: subviews)
        let height = frames.reduce(CGFloat(0)) { max($0, $1.maxY) }
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let frames = placements(width: bounds.width, subviews: subviews)
        for (index, subview) in subviews.enumerated() where index < frames.count {
            let frame = frames[index]
            subview.place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                anchor: .topLeading,
                proposal: ProposedViewSize(width: frame.width, height: frame.height)
            )
        }
    }

    private func placements(width: CGFloat, subviews: Subviews) -> [CGRect] {
        let contentX = gutterWidth + laneSpacing
        let contentWidth = max(0, width - contentX)
        var frames: [CGRect] = []
        var pushes: [(designBottom: CGFloat, extra: CGFloat)] = []

        for subview in subviews {
            let slot = subview[TimelineSlotKey.self]
            let shift = pushes.reduce(CGFloat(0)) { total, push in
                slot.y >= push.designBottom - 0.5 ? total + push.extra : total
            }
            switch slot.lane {
            case .gutter:
                let size = subview.sizeThatFits(ProposedViewSize(width: gutterWidth, height: nil))
                let top = max(0, slot.y + shift - size.height / 2)
                frames.append(CGRect(x: 0, y: top, width: gutterWidth, height: size.height))
            case .content:
                let size = subview.sizeThatFits(ProposedViewSize(width: contentWidth, height: nil))
                let height = max(size.height, slot.designHeight)
                frames.append(CGRect(x: contentX, y: slot.y + shift, width: contentWidth, height: height))
                if height > slot.designHeight + 0.5 {
                    pushes.append((designBottom: slot.y + slot.designHeight, extra: height - slot.designHeight))
                }
            }
        }
        return frames
    }

    private static func finiteWidth(_ width: CGFloat?) -> CGFloat {
        guard let width, width.isFinite else { return 320 }
        return width
    }
}

// MARK: - Rows

struct TimelineTickLabel: View {
    let tick: TimelineLayout.Tick

    var body: some View {
        Text(tick.label)
            .font(.footnote.monospacedDigit())
            .foregroundStyle(PipDesign.secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .padding(.trailing, 8)
            .frame(maxWidth: .infinity, alignment: .trailing)
            .accessibilityHidden(true)
    }
}

struct TimelineGapRow: View {
    let gap: TimelineLayout.Gap

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "ellipsis")
                .font(.footnote.weight(.bold))
                .rotationEffect(.degrees(90))
                .frame(width: 32)
            Text(gap.label)
                .font(.footnote.monospacedDigit())
            Spacer(minLength: 0)
        }
        .foregroundStyle(PipDesign.secondary)
        .frame(maxWidth: .infinity, minHeight: gap.height, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(gap.label)
    }
}

struct TimelineChevron: View {
    var body: some View {
        Image(systemName: "chevron.right")
            .font(.caption.weight(.semibold))
            .foregroundStyle(PipDesign.secondary)
            .padding(.top, 2)
            .accessibilityHidden(true)
    }
}

/// One scheduled item. Its height follows the slot's duration, never less than the text needs.
struct TimelineEntryCard: View {
    let entry: TimelineLayout.Entry
    let highlighted: Bool
    let showsChevron: Bool

    private var item: PlanItem { entry.item }

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: TimelineStyle.cornerRadius, style: .continuous)
    }

    var body: some View {
        content
            .overlay {
                if highlighted {
                    shape
                        .strokeBorder(PipDesign.accent, lineWidth: 2)
                        .modifier(TimelinePulse())
                        .transition(.opacity)
                }
            }
            .contentShape(shape)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityText)
    }

    @ViewBuilder
    private var content: some View {
        if entry.style == .marker {
            markerContent
        } else {
            cardContent
        }
    }

    private var cardContent: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(PipDesign.accent)
                .frame(width: 32, height: 32)
                .background(iconBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 4) {
                Text(eyebrow)
                    .font(.caption2.weight(.bold))
                    .tracking(0.8)
                    .foregroundStyle(entry.style == .doNow ? PipDesign.accent : PipDesign.secondary)
                Text(item.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(PipDesign.ink)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Text(entry.timeText)
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(entry.style == .doNow ? PipDesign.accent : PipDesign.secondary)
                if entry.style == .fixedBlock, let location = item.location, !location.isEmpty {
                    Label(location, systemImage: "mappin.and.ellipse")
                        .font(.footnote)
                        .foregroundStyle(PipDesign.secondary)
                }
                if let flag = item.flag {
                    FlagPill(flag: flag)
                }
            }
            Spacer(minLength: 0)
            if showsChevron {
                TimelineChevron()
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, minHeight: entry.height, alignment: .topLeading)
        .background { cardBackground }
        .overlay(alignment: .leading) {
            if entry.style == .doNow {
                Capsule()
                    .fill(PipDesign.accent)
                    .frame(width: 3)
                    .padding(.vertical, 14)
            }
        }
        .shadow(color: PipDesign.ink.opacity(entry.style == .fixedBlock ? 0 : 0.035), radius: 10, y: 4)
    }

    private var markerContent: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(PipDesign.accent)
                .frame(width: 32, height: 32)
                .background(PipDesign.mist, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(PipDesign.ink)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Text(entry.timeText)
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(PipDesign.secondary)
            }
            Spacer(minLength: 8)
            if let flag = item.flag {
                FlagPill(flag: flag)
            }
            if showsChevron {
                TimelineChevron()
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: entry.height, alignment: .leading)
        .background { cardBackground }
    }

    @ViewBuilder
    private var cardBackground: some View {
        switch entry.style {
        case .doNow:
            shape.fill(Color.white)
                .overlay { shape.fill(PipDesign.accent.opacity(0.08)) }
                .overlay { shape.strokeBorder(PipDesign.accent.opacity(0.45), lineWidth: 1.5) }
        case .fixedBlock:
            shape.fill(PipDesign.mist)
                .overlay { shape.strokeBorder(PipDesign.line.opacity(0.7)) }
        case .continuation:
            shape.fill(Color.white)
                .overlay { shape.strokeBorder(PipDesign.accent.opacity(0.35), style: StrokeStyle(lineWidth: 1, dash: [5, 4])) }
        case .task, .marker:
            shape.fill(Color.white)
                .overlay { shape.strokeBorder(PipDesign.line) }
        }
    }

    private var iconBackground: Color {
        switch entry.style {
        case .doNow: return Color.white
        case .fixedBlock: return Color.white.opacity(0.7)
        case .task, .continuation, .marker: return PipDesign.mist
        }
    }

    private var symbol: String {
        switch entry.style {
        case .doNow: return "sparkle"
        case .fixedBlock: return "lock.fill"
        case .continuation: return "arrow.turn.down.right"
        case .marker: return item.category == .rest ? "moon.stars.fill" : "clock"
        case .task: return TimelineStyle.symbol(for: item.category)
        }
    }

    private var eyebrow: String {
        switch entry.style {
        case .doNow: return "NOW"
        case .fixedBlock: return "FIXED CLASS"
        case .continuation: return "CONTINUED"
        case .task, .marker: return (item.category ?? .unknown).label.uppercased()
        }
    }

    private var accessibilityText: String {
        var parts: [String] = []
        let time = entry.timeText.replacingOccurrences(of: "–", with: " to ")
        if !time.isEmpty {
            parts.append(time)
        }
        switch entry.style {
        case .doNow:
            parts.append("Do now: \(item.title)")
        case .fixedBlock:
            if let location = item.location, !location.isEmpty {
                parts.append("\(item.title), \(location)")
            } else {
                parts.append(item.title)
            }
        case .task, .continuation, .marker:
            parts.append(item.title)
        }
        if let flag = item.flag {
            parts.append(flag.label)
        }
        if !item.why.isEmpty {
            parts.append(item.why)
        }
        return parts.joined(separator: ". ")
    }
}

// MARK: - Tray

/// An item with no slot: at risk (warning outline, capacity bars, money) or waiting for a gap (neutral).
struct TimelineTrayCard: View {
    let entry: TimelineLayout.TrayEntry
    let planNow: String
    let highlighted: Bool
    let showsChevron: Bool

    private var item: PlanItem { entry.item }

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: TimelineStyle.cornerRadius, style: .continuous)
    }

    private var isAtRisk: Bool {
        if case .atRisk = entry.reason {
            return true
        }
        return false
    }

    private var dueText: String? {
        guard let time = DateFormatting.smartTime(item.dueAt, relativeTo: planNow) else { return nil }
        return "Due \(time)"
    }

    private var moneyText: String? {
        guard let money = item.moneyAtRisk, money > 0 else { return nil }
        return "\(MoneyFormatting.dollars(money)) at risk"
    }

    private var gapText: String {
        if case .needsGap(let minutes?) = entry.reason {
            return "Needs a gap · ~\(minutes) min"
        }
        return "Needs a gap"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: isAtRisk ? "exclamationmark.triangle.fill" : "calendar.badge.clock")
                    .font(.caption2.weight(.bold))
                Text(isAtRisk ? "DOESN'T FIT" : "NEEDS A GAP")
                    .font(.caption2.weight(.bold))
                    .tracking(0.8)
                Spacer(minLength: 8)
                if let moneyText {
                    Text(moneyText)
                        .font(.footnote.weight(.semibold).monospacedDigit())
                }
                if showsChevron {
                    TimelineChevron()
                }
            }
            .foregroundStyle(isAtRisk ? PipDesign.warning : PipDesign.secondary)

            Text(item.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(PipDesign.ink)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)

            if let dueText {
                Text(dueText)
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(PipDesign.secondary)
            }

            switch entry.reason {
            case .atRisk(let needed, let available):
                if let needed, needed > 0 {
                    TimelineCapacityBars(needed: needed, available: available)
                        .padding(.top, 2)
                }
            case .needsGap:
                Text(gapText)
                    .font(.footnote)
                    .foregroundStyle(PipDesign.secondary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white, in: shape)
        .overlay { outline }
        .overlay {
            if highlighted {
                shape
                    .strokeBorder(PipDesign.accent, lineWidth: 2)
                    .modifier(TimelinePulse())
                    .transition(.opacity)
            }
        }
        .shadow(color: PipDesign.ink.opacity(0.035), radius: 10, y: 4)
        .contentShape(shape)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    @ViewBuilder
    private var outline: some View {
        if isAtRisk {
            shape.strokeBorder(PipDesign.warning, lineWidth: 1.5)
        } else {
            shape.strokeBorder(PipDesign.secondary.opacity(0.45), style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
        }
    }

    private var accessibilityText: String {
        var parts: [String] = [isAtRisk ? "Doesn't fit" : "Needs a gap", item.title]
        if let dueText {
            parts.append(dueText)
        }
        switch entry.reason {
        case .atRisk(let needed, let available):
            if let needed, needed > 0 {
                parts.append("Needs \(needed) minutes, you have \(available)")
            }
        case .needsGap(let minutes):
            if let minutes {
                parts.append("About \(minutes) minutes")
            }
        }
        if let moneyText {
            parts.append(moneyText)
        }
        if !item.why.isEmpty {
            parts.append(item.why)
        }
        return parts.joined(separator: ". ")
    }
}

/// "needs 35 min" against "you have 25 min", as two bars on one scale.
struct TimelineCapacityBars: View {
    let needed: Int
    let available: Int

    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .footnote) private var labelWidth: CGFloat = 116

    private var scale: CGFloat {
        CGFloat(max(needed, available, 1))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            bar(label: "needs \(needed) min", minutes: needed, tint: PipDesign.warning)
            bar(label: "you have \(available) min", minutes: available, tint: PipDesign.accent)
        }
        // The card's label already speaks both numbers.
        .accessibilityHidden(true)
    }

    private func bar(label: String, minutes: Int, tint: Color) -> some View {
        let stacked = typeSize.isAccessibilitySize
        let layout = stacked
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
            : AnyLayout(HStackLayout(alignment: .center, spacing: 10))
        let fraction = CGFloat(max(0, minutes)) / scale
        return layout {
            Text(label)
                .font(.footnote.monospacedDigit())
                .foregroundStyle(PipDesign.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .frame(width: stacked ? nil : labelWidth, alignment: .leading)
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(PipDesign.line.opacity(0.7))
                    Capsule()
                        .fill(tint)
                        .frame(width: max(8, proxy.size.width * fraction))
                }
            }
            .frame(height: 8)
        }
    }
}

// MARK: - Effects

/// Matched geometry only when motion is allowed; with Reduce Motion the timeline cross-fades instead.
struct TimelineMatchedGeometry: ViewModifier {
    let id: String
    let namespace: Namespace.ID
    let enabled: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if enabled {
            content.matchedGeometryEffect(id: id, in: namespace)
        } else {
            content
        }
    }
}

/// Breathes a highlight ring while it is on screen; steady with Reduce Motion.
struct TimelinePulse: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @ViewBuilder
    func body(content: Content) -> some View {
        if reduceMotion {
            content
        } else {
            content.phaseAnimator([false, true]) { view, lit in
                view.opacity(lit ? 1 : 0.3)
            } animation: { _ in
                .easeInOut(duration: 0.55)
            }
        }
    }
}

/// Three quick side-to-side swings per whole step of `travel`.
struct TimelineShake: GeometryEffect {
    var travel: CGFloat

    var animatableData: CGFloat {
        get { travel }
        set { travel = newValue }
    }

    func effectValue(size: CGSize) -> ProjectionTransform {
        let offset = 7 * sin(Double(travel) * Double.pi * 6)
        return ProjectionTransform(CGAffineTransform(translationX: CGFloat(offset), y: 0))
    }
}
